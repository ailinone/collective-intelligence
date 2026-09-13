// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MediaConsensusStrategy — the media-generation sibling of `ConsensusStrategy`.
 *
 * Per the published architecture: "every generation-heavy step (a video, an
 * image, a document draft) is produced by a MediaConsensusStrategy — N
 * candidates, judged independently, best selected — a direct sibling of
 * ConsensusStrategy". Unlike `ConsensusStrategy`, there is no synthesis step
 * — media candidates aren't combined into one, so the pipeline is strictly
 * generate → deterministic-gate → independent critics → outlier-filter →
 * pick-best, reusing `detectOutlier` from the SAME module `ConsensusStrategy`
 * uses for its own voters.
 *
 * This class does NOT extend `BaseStrategy` and is NOT registered with the
 * orchestration engine's strategy dispatch — per the phased build plan, it
 * is a callable invoked BY `MediaPlannerStrategy`'s generate-type actions
 * (a later LOTE), not a top-level strategy a request routes to directly.
 * It therefore carries none of `BaseStrategy`'s chat-model machinery
 * (adapters, `ModelExecution`, prompt-slot bandits) — its unit of work is a
 * media-generation call, not a chat completion.
 *
 * Generation: calls the EXISTING `VideoOrchestrationService.generateVideo()`
 * / `ImagesOrchestrationService.generateImages()` methods N times
 * independently (never reimplemented here). Each result is wrapped as an
 * `AilinArtifact`, exactly the shape `orchestration-engine.ts`'s
 * `executeMediaGenerationStage` already produces.
 *
 * Judging: role-differentiated, ASYMMETRIC-VISIBILITY critics
 * (`spec_compliance`, `artifact_quality`, `tone`) evaluate each candidate
 * INDEPENDENTLY via `MediaJudgeEvaluator` — never live debate ("debate-style
 * convergence measurably collapses diversity for subjective creative
 * judgment", per the architecture). Their verdicts are reconciled after the
 * fact by `reconcileCriticResults`, a pure function producing one
 * `composite` `EvaluationResult` per candidate.
 *
 * Gating: `runDeterministicMediaGate` (objective, ffprobe-backed) runs
 * BEFORE any critic call — a candidate that fails an objective constraint
 * never reaches the (paid) judge step.
 */
import type { AilinArtifact, OrchestrationContext } from '@/types';
import { logger } from '@/utils/logger';
import {
  type VideoOrchestrationService,
  type VideoGenerationOptions,
  type VideoResult,
} from '@/services/video-orchestration-service';
import {
  type ImagesOrchestrationService,
  type ImageGenerationOptions,
  type ImageResult,
} from '@/services/images-orchestration-service';
import {
  extractFrames,
  MediaProcessingError,
  MediaToolkitUnavailableError,
} from '@/services/media/ffmpeg-media-toolkit';
import {
  runDeterministicMediaGate,
  type DeterministicGateResult,
  type MediaConstraintSet,
} from './media-deterministic-gate';
import { detectOutlier, type OutlierDetectionResult } from './consensus/consensus-outlier-detector';
import type {
  EvaluationResult,
  EvaluationVerdict,
  MediaCandidateArtifact,
  StrategyEvaluationTask,
  StrategyOutputEvaluator,
} from './evaluation/strategy-output-evaluator';
import type { MediaCriticRole } from './evaluation/media-judge-evaluator.types';

const log = logger.child({ component: 'media-consensus-strategy' });

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Provisional default, needs a real product/cost decision before raising.
 * Per the LOTE AT architecture (§8, decisions applied for this build):
 * "MediaConsensusStrategy candidate count N: default 2." Configurable via
 * `MEDIA_CONSENSUS_CANDIDATE_COUNT` and/or the constructor/request override
 * below so it can be tuned without a code change.
 */
export const MEDIA_CONSENSUS_DEFAULT_CANDIDATE_COUNT = positiveIntFromEnv(
  'MEDIA_CONSENSUS_CANDIDATE_COUNT',
  2
);

/**
 * Provisional default, needs a real product/cost decision before raising.
 * How many frames a video candidate is sampled down to before a vision
 * critic sees it — independent of `MEDIA_CONSENSUS_CANDIDATE_COUNT`.
 */
export const MEDIA_CONSENSUS_DEFAULT_JUDGE_FRAME_COUNT = positiveIntFromEnv(
  'MEDIA_CONSENSUS_JUDGE_FRAME_COUNT',
  4
);

export type MediaGenerationCapability = 'video_generation' | 'image_generation';

/**
 * One role-differentiated critic. Each critic gets its OWN evaluator
 * instance (typically a `MediaJudgeEvaluator` configured with a distinct
 * `criticRole`) so critics never share state — the asymmetric-visibility
 * property is structural, not just a convention: critic B's `evaluate()`
 * call has no way to see critic A's `EvaluationResult`.
 */
export interface MediaCriticConfig {
  readonly role: MediaCriticRole;
  readonly evaluator: StrategyOutputEvaluator;
  /** Reconciliation weight. Default 1 (equal weighting across critics). */
  readonly weight?: number;
}

export interface MediaConsensusRequest {
  readonly capability: MediaGenerationCapability;
  readonly prompt: string;
  /** Mirrors `AilinArtifact.stage_name` / `stage_index` — this strategy is
   *  meant to be invoked from within a (planner) stage, not standalone. */
  readonly stageName: string;
  readonly stageIndex: number;
  readonly videoOptions?: Omit<VideoGenerationOptions, 'n' | 'prompt' | 'userContext' | 'requestId'>;
  readonly imageOptions?: Partial<
    Omit<ImageGenerationOptions, 'n' | 'prompt' | 'userContext' | 'requestId'>
  >;
  /** Objective constraints checked by the deterministic gate BEFORE any
   *  critic runs. Absent/partial is fine — the gate fails open on what it
   *  can't check (see `media-deterministic-gate.ts`). */
  readonly constraints?: MediaConstraintSet;
  /** Per-call override of the constructor's candidate count. */
  readonly candidateCount?: number;
  readonly userContext: OrchestrationContext;
  readonly requestId: string;
  readonly evaluationTask?: StrategyEvaluationTask;
}

export interface MediaCandidateRecord {
  readonly index: number;
  readonly artifact: AilinArtifact;
  readonly generationDurationMs: number;
  readonly gate: DeterministicGateResult;
  readonly criticResults: ReadonlyArray<{
    readonly role: MediaCriticRole;
    readonly result: EvaluationResult;
  }>;
  readonly reconciledEvaluation: EvaluationResult;
  readonly outlierDetection: OutlierDetectionResult;
}

export interface MediaConsensusResult {
  readonly bestCandidateIndex: number | undefined;
  readonly bestArtifact: AilinArtifact | undefined;
  /** Full audit trail — every candidate generated, gated, and judged. Feeds
   *  the persisted plan artifact described in the architecture's §3.3. */
  readonly candidates: readonly MediaCandidateRecord[];
  /** Billable judge-call cost across all critics and all candidates.
   *  Generation cost is not tracked here — every media-generation result in
   *  this codebase reports `cost_usd=0` uniformly today (see
   *  `AilinArtifact.cost_usd` doc comment); this is a pre-existing gap, not
   *  one introduced by this strategy. */
  readonly totalJudgeCostUsd: number;
  readonly totalDurationMs: number;
  /** True when every candidate was an outlier (gate failure, generation
   *  failure, or a `fail` verdict) and the "best" pick is a degraded
   *  fallback rather than a validated winner. */
  readonly degraded: boolean;
  readonly degradedReason?: string;
}

export class MediaConsensusStrategy {
  private readonly critics: readonly MediaCriticConfig[];
  private readonly candidateCount: number;

  constructor(
    private readonly deps: {
      readonly videoService?: VideoOrchestrationService;
      readonly imagesService?: ImagesOrchestrationService;
      readonly critics?: readonly MediaCriticConfig[];
      readonly candidateCount?: number;
    } = {}
  ) {
    this.critics = deps.critics ?? [];
    this.candidateCount = deps.candidateCount ?? MEDIA_CONSENSUS_DEFAULT_CANDIDATE_COUNT;
  }

  async execute(request: MediaConsensusRequest): Promise<MediaConsensusResult> {
    const startTime = Date.now();
    const n = Math.max(1, request.candidateCount ?? this.candidateCount);

    if (request.capability === 'video_generation' && !this.deps.videoService) {
      throw new Error(
        'MediaConsensusStrategy: video_generation requested but no VideoOrchestrationService was injected'
      );
    }
    if (request.capability === 'image_generation' && !this.deps.imagesService) {
      throw new Error(
        'MediaConsensusStrategy: image_generation requested but no ImagesOrchestrationService was injected'
      );
    }

    log.info(
      {
        requestId: request.requestId,
        capability: request.capability,
        candidateCount: n,
        criticCount: this.critics.length,
      },
      'MediaConsensusStrategy executing'
    );

    const generations = await Promise.all(
      Array.from({ length: n }, (_, index) => this.generateCandidate(request, index))
    );

    const evalTask: StrategyEvaluationTask = request.evaluationTask ?? {
      userMessageExcerpt: request.prompt.slice(0, 200),
    };

    const candidates: MediaCandidateRecord[] = await Promise.all(
      generations.map((gen) => this.evaluateCandidate(gen, request.constraints, evalTask))
    );

    const totalJudgeCostUsd = candidates.reduce(
      (sum, c) => sum + c.criticResults.reduce((s, cr) => s + (cr.result.judgeCostUsd ?? 0), 0),
      0
    );

    const nonOutliers = candidates.filter((c) => !c.outlierDetection.outlier);
    const pool = nonOutliers.length > 0 ? nonOutliers : candidates;
    const best = pickBestCandidate(pool);
    const degraded = nonOutliers.length === 0 && candidates.length > 0;

    log.info(
      {
        requestId: request.requestId,
        candidateCount: candidates.length,
        validCandidateCount: nonOutliers.length,
        bestCandidateIndex: best?.index,
        degraded,
        totalJudgeCostUsd,
      },
      'MediaConsensusStrategy completed'
    );

    return {
      bestCandidateIndex: best?.index,
      bestArtifact: best?.artifact,
      candidates,
      totalJudgeCostUsd,
      totalDurationMs: Date.now() - startTime,
      degraded,
      degradedReason: degraded ? 'all_candidates_outliers' : undefined,
    };
  }

  // ─── Generation ─────────────────────────────────────────────────────

  private async generateCandidate(
    request: MediaConsensusRequest,
    index: number
  ): Promise<{ index: number; artifact: AilinArtifact; durationMs: number }> {
    const startedAt = Date.now();
    const candidateRequestId = `${request.requestId}-cand-${index}`;
    try {
      if (request.capability === 'video_generation') {
        const result = await this.deps.videoService!.generateVideo({
          ...request.videoOptions,
          prompt: request.prompt,
          n: 1,
          userContext: request.userContext,
          requestId: candidateRequestId,
        });
        const durationMs = Date.now() - startedAt;
        return { index, artifact: videoResultToArtifact(result, request, durationMs), durationMs };
      }

      const result = await this.deps.imagesService!.generateImages({
        size: '1024x1024',
        quality: 'standard',
        responseFormat: 'url',
        style: 'vivid',
        ...request.imageOptions,
        prompt: request.prompt,
        n: 1,
        userContext: request.userContext,
        requestId: candidateRequestId,
      });
      const durationMs = Date.now() - startedAt;
      return { index, artifact: imageResultToArtifact(result, request, durationMs), durationMs };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { requestId: candidateRequestId, index, error: message },
        'MediaConsensusStrategy: candidate generation failed'
      );
      return {
        index,
        artifact: {
          modality: request.capability === 'video_generation' ? 'video' : 'image',
          stage_name: request.stageName,
          stage_index: request.stageIndex,
          error: message,
          duration_ms: durationMs,
        },
        durationMs,
      };
    }
  }

  // ─── Gate + judge ───────────────────────────────────────────────────

  private async evaluateCandidate(
    gen: { index: number; artifact: AilinArtifact; durationMs: number },
    constraints: MediaConstraintSet | undefined,
    evalTask: StrategyEvaluationTask
  ): Promise<MediaCandidateRecord> {
    const gate = await runDeterministicMediaGate(gen.artifact, constraints);
    const executionFailed = Boolean(gen.artifact.error);

    // Deterministic gate outranks the (paid, subjective) judge for objective
    // constraints — a candidate that fails it never reaches a critic call.
    if (executionFailed || gate.status === 'fail') {
      const reconciled: EvaluationResult = {
        scoringMode: 'composite',
        evaluatorId: 'media-consensus-reconciler',
        score: 0,
        verdict: 'fail',
        structural: {
          nonEmpty: !executionFailed,
          meetsMinLength: true,
          executionError: executionFailed,
        },
        notes: executionFailed
          ? `generation failed: ${gen.artifact.error}`
          : `deterministic gate failed: ${gate.violations
              .map((v) => `${v.constraint} expected ${v.expected}, got ${v.actual}`)
              .join('; ')}`,
        validationStatus: 'fully_validated',
      };
      const outlierDetection = detectOutlier({
        executionFailed,
        evaluation: reconciled,
        modelId: `candidate-${gen.index}`,
      });
      return {
        index: gen.index,
        artifact: gen.artifact,
        generationDurationMs: gen.durationMs,
        gate,
        criticResults: [],
        reconciledEvaluation: reconciled,
        outlierDetection,
      };
    }

    const sampledFrames = await sampleFramesForCandidate(gen.artifact);
    const candidateArtifact: MediaCandidateArtifact = {
      kind: 'media',
      artifact: gen.artifact,
      sampledFrames,
    };

    // Independent critic calls — asymmetric visibility is structural: each
    // `evaluate()` call receives only the candidate, never sibling verdicts.
    const criticResults = await Promise.all(
      this.critics.map(async (critic) => ({
        role: critic.role,
        result: await critic.evaluator.evaluate({
          task: evalTask,
          output: '',
          strategyName: 'media-consensus',
          role: 'voter' as const,
          candidate: candidateArtifact,
        }),
      }))
    );

    const reconciled = reconcileCriticResults(criticResults, this.critics);
    const outlierDetection = detectOutlier({
      executionFailed: false,
      evaluation: reconciled,
      modelId: `candidate-${gen.index}`,
    });

    return {
      index: gen.index,
      artifact: gen.artifact,
      generationDurationMs: gen.durationMs,
      gate,
      criticResults,
      reconciledEvaluation: reconciled,
      outlierDetection,
    };
  }
}

// ─── Module-level pure helpers (exported for tests) ────────────────────

/**
 * Reconcile independent critic verdicts into a single `composite`
 * `EvaluationResult`, AFTER THE FACT — never via live debate (see module
 * doc). Score is a weight-average of critics that emitted one; verdict is
 * conservative (`fail` beats `uncertain` beats `pass`) since a generated
 * media candidate is comparatively expensive to have gotten wrong.
 */
export function reconcileCriticResults(
  criticResults: ReadonlyArray<{ readonly role: MediaCriticRole; readonly result: EvaluationResult }>,
  critics: readonly MediaCriticConfig[]
): EvaluationResult {
  if (criticResults.length === 0) {
    return {
      scoringMode: 'unavailable',
      evaluatorId: 'media-consensus-reconciler',
      score: undefined,
      verdict: 'uncertain',
      structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
      notes: 'no critics configured',
      validationStatus: 'unavailable',
    };
  }

  const weightByRole = new Map(critics.map((c) => [c.role, c.weight ?? 1] as const));
  let weightedSum = 0;
  let weightTotal = 0;
  let anyFail = false;
  let anyUncertain = false;

  for (const { role, result } of criticResults) {
    if (result.verdict === 'fail') anyFail = true;
    else if (result.verdict === 'uncertain') anyUncertain = true;
    if (result.score !== undefined) {
      const weight = weightByRole.get(role) ?? 1;
      weightedSum += result.score * weight;
      weightTotal += weight;
    }
  }

  const score = weightTotal > 0 ? weightedSum / weightTotal : undefined;
  const verdict: EvaluationVerdict = anyFail ? 'fail' : anyUncertain ? 'uncertain' : 'pass';
  const validationStatus = criticResults.some((c) => c.result.validationStatus === 'fully_validated')
    ? 'fully_validated'
    : 'unavailable';

  return {
    scoringMode: 'composite',
    evaluatorId: 'media-consensus-reconciler',
    score,
    verdict,
    structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
    subResults: criticResults.map((c) => ({ name: c.role, result: c.result })),
    validationStatus,
    notes: `reconciled from ${criticResults.length} independent critic(s)`,
  };
}

/** Pick the highest-`reconciledEvaluation.score` candidate from `pool`. An
 *  `undefined` score ranks last (treated as `-Infinity`), so a scored
 *  candidate always beats an unscored one; the first survivor wins when
 *  none is scored — stable, deterministic for a given generation order. */
export function pickBestCandidate(
  pool: readonly MediaCandidateRecord[]
): MediaCandidateRecord | undefined {
  if (pool.length === 0) return undefined;
  return pool.reduce((acc, cur) => {
    const a = acc.reconciledEvaluation.score ?? -Infinity;
    const b = cur.reconciledEvaluation.score ?? -Infinity;
    return b > a ? cur : acc;
  });
}

/**
 * Sample frames for a visual candidate, reusing
 * `services/media/ffmpeg-media-toolkit.ts` — NEVER reimplemented here. An
 * image candidate's single "frame" is the image itself (no ffmpeg needed);
 * a video candidate is sampled down to
 * `MEDIA_CONSENSUS_DEFAULT_JUDGE_FRAME_COUNT` frames. Returns `undefined`
 * (never throws) when there are no bytes to sample or the ffmpeg toolchain
 * is unavailable — `MediaJudgeEvaluator` degrades to `unavailable` rather
 * than fabricating a verdict without frames.
 */
export async function sampleFramesForCandidate(
  artifact: AilinArtifact
): Promise<readonly string[] | undefined> {
  if (!artifact.b64_json) return undefined;
  if (artifact.modality === 'image') {
    return [artifact.b64_json];
  }
  if (artifact.modality !== 'video') return undefined;

  try {
    const buffer = Buffer.from(artifact.b64_json, 'base64');
    if (buffer.length === 0) return undefined;
    const filename = artifact.filename ?? 'candidate.mp4';
    const frames = await extractFrames(buffer, filename, {
      maxFrames: MEDIA_CONSENSUS_DEFAULT_JUDGE_FRAME_COUNT,
    });
    return frames.map((f) => f.buffer.toString('base64'));
  } catch (err) {
    if (err instanceof MediaToolkitUnavailableError || err instanceof MediaProcessingError) {
      log.warn(
        { error: err.message },
        'MediaConsensusStrategy: frame sampling unavailable, judging without frames'
      );
      return undefined;
    }
    // An unexpected error (e.g. invalid base64) — degrade rather than crash
    // the whole candidate evaluation.
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ error: message }, 'MediaConsensusStrategy: unexpected frame-sampling failure');
    return undefined;
  }
}

function videoResultToArtifact(
  result: VideoResult,
  request: MediaConsensusRequest,
  durationMs: number
): AilinArtifact {
  const video = result.videos[0];
  if (!video || (!video.url && !video.b64_json)) {
    return {
      modality: 'video',
      stage_name: request.stageName,
      stage_index: request.stageIndex,
      error: 'video generation returned no usable output',
      duration_ms: durationMs,
      provider: result.provider,
      model: result.modelUsed,
    };
  }
  return {
    modality: 'video',
    stage_name: request.stageName,
    stage_index: request.stageIndex,
    url: video.url,
    b64_json: video.b64_json,
    provider: result.provider,
    model: result.modelUsed,
    duration_ms: durationMs,
  };
}

function imageResultToArtifact(
  result: ImageResult,
  request: MediaConsensusRequest,
  durationMs: number
): AilinArtifact {
  const image = result.images[0];
  if (!image || (!image.url && !image.b64_json)) {
    return {
      modality: 'image',
      stage_name: request.stageName,
      stage_index: request.stageIndex,
      error: 'image generation returned no usable output',
      duration_ms: durationMs,
      provider: result.provider,
      model: result.modelUsed,
    };
  }
  return {
    modality: 'image',
    stage_name: request.stageName,
    stage_index: request.stageIndex,
    url: image.url,
    b64_json: image.b64_json,
    revised_prompt: image.revised_prompt,
    provider: result.provider,
    model: result.modelUsed,
    duration_ms: durationMs,
  };
}
