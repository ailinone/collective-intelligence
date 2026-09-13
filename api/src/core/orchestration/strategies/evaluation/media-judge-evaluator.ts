// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MediaJudgeEvaluator
 *
 * The media-capable sibling of `LLMJudgeEvaluator`. Implements the SAME
 * `StrategyOutputEvaluator` contract, unmodified — a caller that doesn't
 * know about `EvaluatorInput.candidate` gets exactly the text-judging
 * behaviour of `LLMJudgeEvaluator` (this class delegates to an internal
 * instance for that path).
 *
 * Dispatch, per the published architecture ("for a text/document candidate,
 * degrades to the existing text-judging path unchanged"):
 *   - no `candidate`, or `candidate.kind === 'text'` → delegate to the
 *     internal `LLMJudgeEvaluator` untouched.
 *   - `candidate.kind === 'media'`, modality `'audio'` → judge the
 *     `transcript` text through the SAME text-judging path (a transcript
 *     IS text; there is no real-audio-bytes judge client in this repo yet).
 *   - `candidate.kind === 'media'`, modality `'video' | 'image'` → build a
 *     real multi-part vision prompt from `sampledFrames` (reusing whatever
 *     the caller already sampled via `services/media/ffmpeg-media-toolkit.ts`
 *     — this class never samples frames itself) and dispatch through the
 *     injected `MediaJudgeClient`.
 *   - `candidate.kind === 'media'`, modality `'file'`, or a media candidate
 *     with no artifact/frames at all → `unavailable` (never fabricated).
 *
 * Safety gates mirror `LLMJudgeEvaluator` exactly: disabled config, missing
 * judge model id, zero/invalid budget, or no injected client all short-
 * circuit to `unavailable` BEFORE any provider call.
 */
import type {
  EvaluationResult,
  EvaluatorInput,
  MediaCandidateArtifact,
  StrategyOutputEvaluator,
} from './strategy-output-evaluator';
import { LLMJudgeEvaluator } from './llm-judge-evaluator';
import type { LLMJudgeClient, LLMJudgeRawResult } from './llm-judge-evaluator.types';
import type { MediaJudgeClient, MediaJudgeEvaluatorConfig } from './media-judge-evaluator.types';
import type { MessageContent } from '@/types';

export class MediaJudgeEvaluator implements StrategyOutputEvaluator {
  readonly mode = 'llm_judge' as const;
  readonly id: string;
  private readonly criticRole: MediaJudgeEvaluatorConfig['criticRole'];
  private readonly textJudge: LLMJudgeEvaluator;

  constructor(
    private readonly config: MediaJudgeEvaluatorConfig,
    private readonly mediaClient?: MediaJudgeClient,
    textClient?: LLMJudgeClient
  ) {
    this.criticRole = config.criticRole ?? 'artifact_quality';
    this.id = `media-judge-${this.criticRole}-${config.rubricVersion}`;
    // Text-judging degrade path reuses LLMJudgeEvaluator VERBATIM — same
    // config shape (MediaJudgeEvaluatorConfig is additive over
    // LLMJudgeEvaluatorConfig), same safety gates, same output contract.
    this.textJudge = new LLMJudgeEvaluator(config, textClient);
  }

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    const candidate = input.candidate;

    // ─── No candidate, or an explicit text candidate: unchanged text path ──
    if (!candidate || candidate.kind === 'text') {
      const effectiveInput: EvaluatorInput =
        candidate?.kind === 'text' ? { ...input, output: candidate.content } : input;
      const delegated = await this.textJudge.evaluate(effectiveInput);
      return { ...delegated, evaluatorId: this.id };
    }

    // candidate.kind === 'media' from here on.
    if (candidate.artifact.modality === 'audio') {
      return this.evaluateAudio(input, candidate);
    }
    if (candidate.artifact.modality === 'video' || candidate.artifact.modality === 'image') {
      return this.evaluateVisualMedia(input, candidate);
    }

    // 'file' modality (or any future modality) — no visual/audio judging
    // path exists for it. Never fabricate a score.
    return this.unavailable(`media_judge_unsupported_modality:${candidate.artifact.modality}`);
  }

  private async evaluateAudio(
    input: EvaluatorInput,
    candidate: MediaCandidateArtifact
  ): Promise<EvaluationResult> {
    if (candidate.artifact.error) {
      return this.failedGeneration(candidate.artifact.error);
    }
    const transcript = candidate.transcript?.trim();
    if (!transcript) {
      return this.unavailable('audio_transcript_missing');
    }
    const delegated = await this.textJudge.evaluate({ ...input, output: transcript });
    return {
      ...delegated,
      evaluatorId: this.id,
      notes: joinNotes(delegated.notes, 'audio candidate judged via transcript'),
    };
  }

  private async evaluateVisualMedia(
    input: EvaluatorInput,
    candidate: MediaCandidateArtifact
  ): Promise<EvaluationResult> {
    if (candidate.artifact.error) {
      return this.failedGeneration(candidate.artifact.error);
    }
    if (!candidate.sampledFrames || candidate.sampledFrames.length === 0) {
      return this.unavailable('no_sampled_frames');
    }
    const sampledFrames = candidate.sampledFrames;

    // ─── Safety gates (same order as LLMJudgeEvaluator) ──────────────────
    if (!this.config.enabled) {
      return this.unavailable('media_judge_disabled');
    }
    const effectiveJudgeModelId =
      input.judgeModelOverride && input.judgeModelOverride.trim().length > 0
        ? input.judgeModelOverride.trim()
        : this.config.judgeModelId;
    if (!effectiveJudgeModelId || effectiveJudgeModelId.trim().length === 0) {
      return this.unavailable('judge_model_id_missing');
    }
    if (!Number.isFinite(this.config.maxCostUsd) || this.config.maxCostUsd <= 0) {
      return this.unavailable('budget_zero_or_invalid');
    }
    if (!this.mediaClient) {
      return this.unavailable('media_judge_client_unavailable');
    }

    const content = buildMediaJudgeContent(input, candidate, sampledFrames);

    let raw: LLMJudgeRawResult;
    try {
      raw = await withTimeout(
        this.mediaClient.judgeMedia({
          judgeModelId: effectiveJudgeModelId,
          rubricVersion: this.config.rubricVersion,
          criticRole: this.criticRole ?? 'artifact_quality',
          task: {
            taskType: input.task.taskType,
            userMessageExcerpt: input.task.userMessageExcerpt,
            expectedFormat: input.task.expectedFormat,
          },
          content,
          role: input.role,
          maxCostUsd: this.config.maxCostUsd,
          timeoutMs: this.config.timeoutMs,
        }),
        this.config.timeoutMs
      );
    } catch (err) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: undefined,
        verdict: 'uncertain',
        structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
        notes: `media judge call failed: ${errorMessage(err)}`,
        validationStatus: 'unavailable',
      };
    }

    if (!isValidRaw(raw)) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: undefined,
        verdict: 'uncertain',
        structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
        notes: 'media judge returned malformed result',
        validationStatus: 'unavailable',
      };
    }

    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score: clamp01(raw.score),
      verdict: raw.verdict,
      structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
      confidence: raw.confidence,
      // Cost-accounting integrity (TIER 0), same as LLMJudgeEvaluator.
      judgeCostUsd: raw.costUsd ?? 0,
      notes: `${raw.shortRationale ?? ''} (critic=${this.criticRole}, rubric=${this.config.rubricVersion}, judgeModel=${effectiveJudgeModelId})`.trim(),
      validationStatus: 'fully_validated',
      subScores: raw.subScores
        ? {
            taskCorrectness: raw.subScores.correctness,
            rubricJudge: raw.subScores.reasoningQuality,
            safetyFormat: raw.subScores.safety,
          }
        : undefined,
    };
  }

  private failedGeneration(error: string): EvaluationResult {
    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score: 0,
      verdict: 'fail',
      structural: { nonEmpty: false, meetsMinLength: false, executionError: true },
      notes: `artifact generation failed: ${error}`,
      validationStatus: 'fully_validated',
    };
  }

  private unavailable(reason: string): EvaluationResult {
    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score: undefined,
      verdict: 'uncertain',
      structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
      notes: `Media judge unavailable: ${reason}`,
      validationStatus: 'unavailable',
    };
  }
}

// ─── pure helpers (exported for tests) ─────────────────────────────────────

/**
 * Build the logical multi-part judge prompt for a visual media candidate:
 * a text rubric header, followed by one `video_frame` part per sampled
 * frame (base64 already produced by the caller — this module never calls
 * ffmpeg). Uses the ADDITIVE `video_frame` content type so the parts are
 * distinguishable from plain rubric prose; `MediaJudgeClient` implementations
 * normalize these to plain `text`/`image_url` parts before dispatch.
 */
export function buildMediaJudgeContent(
  input: EvaluatorInput,
  candidate: MediaCandidateArtifact,
  sampledFrames: readonly string[]
): MessageContent[] {
  const header = [
    input.task.taskType ? `task_type=${input.task.taskType}` : '',
    `modality=${candidate.artifact.modality}`,
    input.role ? `role=${input.role}` : '',
    input.task.userMessageExcerpt
      ? `user_request_excerpt:\n${input.task.userMessageExcerpt}`
      : '',
    `${sampledFrames.length} sampled frame(s) follow.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const parts: MessageContent[] = [{ type: 'text', text: header }];
  const mime = candidate.artifact.mime_type?.startsWith('image/')
    ? candidate.artifact.mime_type
    : 'image/jpeg';
  sampledFrames.forEach((frameB64, index) => {
    parts.push({
      type: 'video_frame',
      image_url: { url: `data:${mime};base64,${frameB64}`, detail: 'low' },
      // Exact per-frame timestamps are not part of the `sampledFrames: string[]`
      // contract (see MediaCandidateArtifact) — the index is reported as an
      // UNMEASURED estimate, never presented as a fact.
      timestamp_sec: index,
      timestamp_measured: false,
    });
  });
  return parts;
}

function joinNotes(existing: string | undefined, addition: string): string {
  return existing && existing.length > 0 ? `${existing} (${addition})` : addition;
}

function isValidRaw(r: unknown): r is LLMJudgeRawResult {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as { score?: unknown; verdict?: unknown };
  if (typeof o.score !== 'number' || !Number.isFinite(o.score)) return false;
  if (o.score < 0 || o.score > 1) return false;
  if (o.verdict !== 'pass' && o.verdict !== 'fail' && o.verdict !== 'uncertain') return false;
  return true;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`media_judge_timeout_after_${ms}ms`)), ms);
  });
  return Promise.race([
    p.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeout,
  ]);
}
