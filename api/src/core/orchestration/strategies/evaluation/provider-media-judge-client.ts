// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderMediaJudgeClient
 *
 * Concrete `MediaJudgeClient` that runs a multi-part (rubric + sampled
 * frames) judge prompt through one of the project's existing provider
 * adapters — same single responsibility as `ProviderLLMJudgeClient`, for
 * the media path. It does NOT decide whether to call the judge — that
 * gate lives in `MediaJudgeEvaluator` (enabled, budget, model id, client
 * present). This class assumes all gates have already passed when its
 * `judgeMedia()` method is invoked.
 *
 * Content normalization: `MediaJudgeInput.content` may carry the ADDITIVE
 * `video_frame` / `audio_transcript` part types (see `types/index.ts`).
 * Every existing provider adapter's content mapper only recognises
 * `'text' | 'image_url'` (verified: none of them exhaustively `switch` on
 * `part.type` with a `never` fallthrough — they all use non-exhaustive
 * `if/else if` chains, so an unrecognised part is silently dropped rather
 * than rejected). Dropping a video frame instead of showing it to the judge
 * would silently blind a vision judge, so this client normalizes
 * `video_frame` → a `text` timestamp caption + a plain `image_url`, and
 * `audio_transcript` → a labeled `text` block, BEFORE building the
 * `ChatRequest` — guaranteeing the judge actually sees the frames on every
 * adapter today, with zero adapter changes required.
 *
 * Parsing contract: reuses the SAME tolerant `coerceRawResult` /
 * `extractJsonContent` the text judge path uses (`./provider-llm-judge-client`)
 * — one salvage/parsing contract for both judge paths, not a second one.
 *
 * Hard safety properties (same as ProviderLLMJudgeClient):
 *   - No prompt text/image bytes are logged. Only rubric version, critic
 *     role, judge model id, latency, and parsed numeric outputs.
 *   - No DB writes.
 *   - Temperature pinned to 0 for determinism. max_tokens capped at 600.
 */
import { logger } from '@/utils/logger';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ChatRequest, ChatResponse, MessageContent } from '@/types';
import type { LLMJudgeRawResult } from './llm-judge-evaluator.types';
import { coerceRawResult, extractJsonContent } from './provider-llm-judge-client';
import type { MediaCriticRole, MediaJudgeClient, MediaJudgeInput } from './media-judge-evaluator.types';

const log = logger.child({ component: 'provider-media-judge-client' });

const RUBRIC_HEADER =
  'You are an impartial media-generation judge. Score the candidate media (shown as sampled frames, ' +
  'or described via its transcript) on a strict rubric. Return ONLY a single JSON object with these ' +
  'fields, no markdown, no commentary:\n' +
  '  score: number in [0, 1] — overall quality on THIS critic axis\n' +
  '  verdict: "pass" | "fail" | "uncertain"\n' +
  '  confidence: number in [0, 1]\n' +
  '  rationale: short string (under 200 chars)\n' +
  '  subScores: { correctness, completeness, instructionAdherence, formatAdherence, grounding, safety, reasoningQuality } — each in [0, 1]\n' +
  'Use "uncertain" only when the sampled frames genuinely don\'t let you tell.';

/** Per-critic rubric focus, appended to the shared header. Asymmetric
 *  visibility: each critic only ever sees this one framing, never the
 *  other critics' verdicts. */
const CRITIC_RUBRIC_FOCUS: Record<MediaCriticRole, string> = {
  spec_compliance:
    'Focus axis: SPEC COMPLIANCE. Does the media match the user\'s explicit request (subject, action, ' +
    'style, any stated constraint you can visually verify)? Ignore aesthetic polish; a plain but ' +
    'compliant result outscores a beautiful but off-brief one.',
  artifact_quality:
    'Focus axis: ARTIFACT QUALITY. Visual/technical fidelity — coherence, artifacts, distortion, ' +
    'temporal consistency across frames (for video), composition. Ignore whether it matches the brief.',
  tone:
    'Focus axis: TONE. Does the mood, style, and framing feel appropriate for the stated use case ' +
    '(e.g. not tonally jarring, not unintentionally comic/unsettling)? Ignore technical fidelity.',
};

export interface ProviderMediaJudgeClientOptions {
  readonly registry: ProviderRegistry;
  /** Pinned temperature for judge calls. Default 0. */
  readonly temperature?: number;
  /** Max tokens for the JSON response. Default 600. */
  readonly maxTokens?: number;
}

export class ProviderMediaJudgeClient implements MediaJudgeClient {
  constructor(private readonly opts: ProviderMediaJudgeClientOptions) {}

  async judgeMedia(input: MediaJudgeInput): Promise<LLMJudgeRawResult> {
    const resolved = await this.opts.registry.findModel(input.judgeModelId);
    if (!resolved) {
      throw new Error(`media_judge_model_not_found:${input.judgeModelId}`);
    }

    const systemPrompt = `${RUBRIC_HEADER}\n${CRITIC_RUBRIC_FOCUS[input.criticRole]}\nrubric_version=${input.rubricVersion}`;
    const userContent = toProviderCompatibleContent(input.content);

    const judgeRequest: ChatRequest = {
      model: resolved.model.id,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: this.opts.temperature ?? 0,
      max_tokens: this.opts.maxTokens ?? 600,
      stream: false,
    };

    const t0 = Date.now();
    let response: ChatResponse;
    try {
      response = await resolved.adapter.chatCompletion(judgeRequest);
    } catch (err) {
      log.warn(
        {
          judgeModelId: input.judgeModelId,
          rubricVersion: input.rubricVersion,
          criticRole: input.criticRole,
          latencyMs: Date.now() - t0,
          error: errorMessage(err),
        },
        'media judge provider call failed'
      );
      throw err;
    }
    const latencyMs = Date.now() - t0;

    const rawContent = extractJsonContent(response);
    if (!rawContent) {
      log.warn(
        {
          judgeModelId: input.judgeModelId,
          rubricVersion: input.rubricVersion,
          criticRole: input.criticRole,
          latencyMs,
        },
        'media judge returned no parseable content'
      );
      throw new Error('media_judge_response_empty');
    }

    const result = coerceRawResult(rawContent);

    let costUsd = 0;
    try {
      const usage = response.usage;
      costUsd =
        Math.max(
          0,
          resolved.adapter.calculateCost(
            resolved.model,
            usage?.prompt_tokens || 0,
            usage?.completion_tokens || 0
          )
        ) || 0;
    } catch {
      costUsd = 0;
    }
    const resultWithCost: LLMJudgeRawResult = { ...result, costUsd };

    log.info(
      {
        judgeModelId: input.judgeModelId,
        rubricVersion: input.rubricVersion,
        criticRole: input.criticRole,
        latencyMs,
        verdict: result.verdict,
        score: result.score,
        confidence: result.confidence,
        costUsd,
      },
      'media judge completed'
    );
    return resultWithCost;
  }
}

// ─── pure helpers (exported for tests) ──────────────────────────────────

/**
 * Normalize the additive `video_frame` / `audio_transcript` part types down
 * to plain `text` / `image_url` — the two part types every provider
 * adapter's content mapper already understands. See module doc for why this
 * runs HERE (at dispatch time) rather than requiring every adapter to learn
 * the new types first.
 */
export function toProviderCompatibleContent(
  parts: readonly MessageContent[]
): MessageContent[] {
  const out: MessageContent[] = [];
  for (const part of parts) {
    if (part.type === 'video_frame') {
      const label = part.timestamp_measured
        ? `Frame at ${part.timestamp_sec.toFixed(1)}s:`
        : `Frame ${part.timestamp_sec} (approximate offset):`;
      out.push({ type: 'text', text: label });
      out.push({ type: 'image_url', image_url: part.image_url });
    } else if (part.type === 'audio_transcript') {
      out.push({ type: 'text', text: `Audio transcript:\n${part.text}` });
    } else {
      out.push(part);
    }
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
