// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Image candidate judge — Package B (2026-09-09).
 *
 * The problem this closes: `ImagesOrchestrationService.generateImages`'s
 * `parallel`/`debate`/`quality_multipass` strategies were cosmetic — all
 * three collapsed to the exact same behavior as plain `quality` (sort the
 * candidate pool by a static quality score, then let `executeWithFallback`'s
 * `Promise.any` race the top N and return whichever answers FIRST). Nothing
 * ever generated multiple REAL candidates and compared their actual output;
 * "debate" never debated anything.
 *
 * This module is the judge half of the real fix (see
 * `images-orchestration-service.ts`'s best-of-N driver for the generation
 * half): given N successfully generated candidate images and the ORIGINAL
 * prompt, score each candidate's actual prompt-adherence + visual quality
 * using a real vision-capable model, so the BEST one (not the fastest one)
 * is what gets returned.
 *
 * Design: this deliberately reuses the established text-judge PATTERN
 * (`llm-judge-evaluator.ts` / `provider-llm-judge-client.ts`) rather than
 * inventing a new one — same safety gates (enabled flag, timeout, fail-soft
 * to "unavailable" rather than throwing), and the EXACT SAME tolerant JSON
 * parsing (`provider-llm-judge-client.ts#coerceRawResult`, which itself
 * routes through the shared `normalizeJudgeOutput`) so a judge model's score
 * gets the same salvage-on-malformed-output handling every other judge call
 * in this codebase already gets. What's necessarily different: the judge
 * call itself. `LLMJudgeClient`/`ProviderLLMJudgeClient` issue a plain-text
 * `chatCompletion` — there is no image to show the judge. Scoring a
 * generated IMAGE against a prompt needs a vision-capable model call, which
 * this platform already has a real, dynamically-model-selecting driver for:
 * `VisionOrchestrationService.analyzeImage({task: 'vision', image, prompt})`
 * (the same one `capabilities-routes.ts`'s `vision`/`image_captioning`/
 * `visual_question_answering` capabilities already use). Reusing it here
 * means the judge model is chosen the SAME dynamic way any other vision
 * request picks one — no hardcoded judge model, no new selection logic.
 */

import { logger } from '@/utils/logger';
import type { OrchestrationContext } from '@/types';
import {
  getVisionOrchestrationService,
  type VisionOrchestrationService,
} from '@/services/vision-orchestration-service';
import { coerceRawResult } from '@/core/orchestration/strategies/evaluation/provider-llm-judge-client';

const log = logger.child({ component: 'image-candidate-judge' });

export interface ImageJudgeConfig {
  /** Master switch. When false, `score()` returns `available: false`
   *  immediately — no vision call is made. */
  readonly enabled: boolean;
  /** Explicit judge model override. When absent, `VisionOrchestrationService`
   *  auto-selects a vision-capable model the same dynamic way any other
   *  vision request does — no hardcoded judge model. */
  readonly judgeModelId?: string;
  readonly timeoutMs: number;
}

export interface ImageCandidateInput {
  /** Buffer, http(s) URL, or base64/data-URL string — passed straight
   *  through to `VisionOrchestrationService.analyzeImage`, which normalizes
   *  all three. */
  readonly image: Buffer | string;
  /** The ORIGINAL user request text the image was meant to satisfy. */
  readonly prompt: string;
}

export interface ImageJudgeVerdict {
  readonly score: number;
  readonly verdict: 'pass' | 'fail' | 'uncertain';
  readonly rationale?: string;
  readonly judgeModelId?: string;
  /** `false` when the judge did not actually run (disabled, or the vision
   *  call itself failed/timed out) — callers must NOT treat `score` as
   *  meaningful when this is `false`. */
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface ImageCandidateJudge {
  score(
    input: ImageCandidateInput,
    ctx: { requestId: string; userContext: OrchestrationContext }
  ): Promise<ImageJudgeVerdict>;
}

/**
 * Env var names mirror the existing `STRATEGY_EVALUATOR_*` text-judge
 * convention (`evaluator-config.ts`) as closely as the different blast
 * radius allows. Unlike that judge (which can fire on EVERY text strategy
 * and defaults OFF for cost safety), this judge only ever runs when a
 * caller explicitly requests `parallel`/`debate`/`quality_multipass` image
 * generation — a strategy name that is ALREADY an opt-in to extra
 * generation cost (N candidate images instead of one). Defaulting the judge
 * itself to enabled means that opt-in actually buys real comparison, not
 * just N images generated and one arbitrarily returned; `IMAGE_JUDGE_ENABLED=false`
 * opts back out for operators who want the cheaper best-of-N-without-judging
 * behavior.
 */
export function loadImageJudgeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ImageJudgeConfig {
  const enabled = env.IMAGE_JUDGE_ENABLED !== 'false';
  const judgeModelId = (env.IMAGE_JUDGE_MODEL_ID ?? '').trim() || undefined;
  const timeoutMsRaw = Number(env.IMAGE_JUDGE_TIMEOUT_MS ?? 20_000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 20_000;
  return { enabled, judgeModelId, timeoutMs };
}

function buildImageJudgeRubricPrompt(originalPrompt: string): string {
  return [
    'You are an impartial image-generation judge. You are shown ONE generated image and must score how well it satisfies the request below.',
    'Judge BOTH prompt adherence (does the image actually depict what was requested — subjects, setting, style, count, text if any) and basic visual quality (coherent, not garbled/corrupted, no obvious rendering artifacts, no mangled anatomy or text).',
    '',
    `Requested image: ${originalPrompt}`,
    '',
    'Return ONLY a single JSON object with these fields, no markdown, no commentary:',
    '  score: number in [0, 1] — overall quality (prompt adherence + visual quality combined)',
    '  verdict: "pass" | "fail" | "uncertain"',
    '  rationale: short string (under 200 chars)',
    'A "pass" requires the image genuinely depicts the request with acceptable visual quality. A "fail" means it is off-topic, badly garbled, or missing key requested elements. Use "uncertain" only when you genuinely cannot tell from the image alone.',
  ].join('\n');
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`image_judge_timeout_after_${ms}ms`)), ms);
  });
  return Promise.race([
    p.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeout,
  ]);
}

/**
 * Real judge implementation: routes through `VisionOrchestrationService`.
 * Deliberately does NOT tell the judge which model generated the candidate
 * (avoids brand/model-name bias) — only the image and the original prompt.
 */
export class VisionImageCandidateJudge implements ImageCandidateJudge {
  constructor(
    private readonly config: ImageJudgeConfig,
    private readonly visionService: Pick<
      VisionOrchestrationService,
      'analyzeImage'
    > = getVisionOrchestrationService()
  ) {}

  async score(
    input: ImageCandidateInput,
    ctx: { requestId: string; userContext: OrchestrationContext }
  ): Promise<ImageJudgeVerdict> {
    if (!this.config.enabled) {
      return { score: 0, verdict: 'uncertain', available: false, unavailableReason: 'image_judge_disabled' };
    }

    try {
      const result = await withTimeout(
        this.visionService.analyzeImage({
          task: 'vision',
          image: input.image,
          prompt: buildImageJudgeRubricPrompt(input.prompt),
          model: this.config.judgeModelId,
          userContext: ctx.userContext,
          requestId: ctx.requestId,
        }),
        this.config.timeoutMs
      );

      // Reuses the SAME tolerant judge-output parsing every text judge call
      // in this codebase already goes through — see module doc.
      const raw = coerceRawResult(result.content);

      return {
        score: clamp01(raw.score),
        verdict: raw.verdict,
        rationale: raw.shortRationale,
        judgeModelId: result.modelUsed,
        available: true,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn({ requestId: ctx.requestId, reason }, 'image judge call failed or timed out');
      return { score: 0, verdict: 'uncertain', available: false, unavailableReason: reason };
    }
  }
}

let sharedJudge: ImageCandidateJudge | null = null;

/** Shared instance, built from env config on first use — mirrors
 *  `getVisionOrchestrationService`'s singleton pattern. */
export function getImageCandidateJudge(): ImageCandidateJudge {
  if (!sharedJudge) {
    sharedJudge = new VisionImageCandidateJudge(loadImageJudgeConfigFromEnv());
  }
  return sharedJudge;
}

/** Test seam — resets the singleton between suites. */
export function resetImageCandidateJudgeForTesting(): void {
  sharedJudge = null;
}
