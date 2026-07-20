// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ConsensusStrategy artifact contract.
 *
 * The shape that gets embedded in `OrchestrationResult.metadata.consensusArtifacts`
 * so operators / observability / experiment infrastructure can read the
 * decision trail without re-doing the math.
 *
 * Critical fields:
 *   - `scoringMode` — which evaluator made the calls (mock / structural /
 *      llm_judge / unavailable / etc.)
 *   - `validationStatus` — derived from scoringMode; tells consumers
 *      whether the synthesis-vs-best comparison was meaningful.
 *   - `evaluatorId` — stable identifier of the implementation, so
 *      shifts in scoring quality can be correlated to evaluator changes.
 */
import type {
  ScoringMode,
  ValidationStatus,
} from '../evaluation/strategy-output-evaluator';

export interface ConsensusParticipantArtifact {
  readonly modelId: string;
  readonly modelName?: string;
  readonly success: boolean;
  readonly error?: string;
  readonly latencyMs?: number;
  readonly costUsd?: number;
  /** Quality score in [0, 1], or `undefined` when evaluator did not score. */
  readonly individualScore?: number;
  readonly evaluatorVerdict?: 'pass' | 'fail' | 'uncertain';
  readonly outlier?: boolean;
  readonly outlierReason?: string;
  readonly outputLength?: number;
}

export type ConsensusEffectiveStrategyId =
  | 'consensus'
  | 'consensus_fallback_best_individual'
  | 'consensus_degraded_best_individual'
  | 'consensus_verified_individual'
  | 'consensus_agreement_individual';

/**
 * Strategy 01C.0.1 — planned-vs-executed parity record.
 *
 * - `planSource='dynamic_role_resolver'` → plan came from
 *   `ModelRoleResolver` via the dry-run service (or in-flight planner)
 * - `planSource='legacy_selection'` → strategy used its own
 *   `selectDiverseModels` (no plan attached to the request)
 * - `planSource='none'` → no plan was offered to execute() at all
 *
 * Any `*MatchesPlan === false` field on this artifact disqualifies the
 * run for SOTA validation downstream — operators should treat it as a
 * blocker, not a warning.
 */
export type PlanSource = 'dynamic_role_resolver' | 'legacy_selection' | 'none';
export type JudgeSelectionSource =
  | 'dynamic_role_resolver'
  | 'env_fallback'
  | 'unavailable';

/**
 * Strategy 01C.0.2 — synthesizer-selection source. Where the model
 * used by `synthesisAggregation` came from. `dynamic_role_resolver`
 * means the plan was honored; `legacy_aggregator` means the aggregator
 * picked its own coordinator (legacy path with no plan-driven override);
 * `mismatch` means a plan said X but the aggregator emitted Y;
 * `unavailable` means we couldn't observe what was used.
 */
export type SynthesizerSelectionSource =
  | 'dynamic_role_resolver'
  | 'legacy_aggregator'
  | 'mismatch'
  | 'unavailable'
  /** Synthesis was deliberately skipped by a pre-synthesis short-circuit
   *  (checker-verified voter or unanimous agreement) — NOT a degradation. */
  | 'skipped_short_circuit';

/**
 * Strategy 01C.0.2 — Hybrid parity (option C from 01C.0.1 design
 * question). Distinguishes "plan was CALLED as intended" from "plan
 * EXECUTED with success". Required fields:
 *   - `plannedParticipantExecutionSuccess[i]` aligns with
 *     `plannedParticipantModelIds[i]` 1:1 — `true` means the planned
 *     voter ran AND returned a usable response (success && !outlier).
 *   - `successfulParticipantCount` = count of trues in the array above.
 *   - `failedParticipantCount` = count of falses.
 *   - `effectiveParticipantCount` = participants that passed
 *     outlier-filter (drives whether synthesis is viable).
 *   - `planExecutionDegraded` = true when SOTA gate doesn't hold:
 *     either too few successful or too few effective.
 *   - `planExecutionDegradationReason` = classified reason
 *     ('insufficient_successful_participants' | 'synthesizer_mismatch' |
 *      'judge_unavailable' | etc.).
 */
export type ParticipantFailureReason =
  | 'provider_error'
  | 'auth_failed'
  | 'no_credits'
  | 'rate_limited'
  | 'timeout'
  | 'model_not_found'
  | 'unsupported_model'
  | 'empty_response'
  | 'invalid_response'
  | 'exception'
  | 'outlier_rejected'
  | 'unknown';

export interface ConsensusPlanParityArtifact {
  readonly planSource: PlanSource;

  // ── Participants ───────────────────────────────────────────────
  readonly plannedParticipantModelIds: readonly string[];
  readonly executedParticipantModelIds: readonly string[];
  /** True when every planned id appears in executed ids (call-time parity). */
  readonly participantModelsMatchPlan: boolean;
  /** Strategy 01C.0.2 — per-planned success flags, aligned 1:1 with
   *  `plannedParticipantModelIds`. */
  readonly plannedParticipantExecutionSuccess: readonly boolean[];
  /** Strategy 01C.0.2 — per-planned failure reason (when success=false). */
  readonly plannedParticipantFailureReasons: readonly (ParticipantFailureReason | undefined)[];
  readonly successfulParticipantCount: number;
  readonly failedParticipantCount: number;
  readonly effectiveParticipantCount: number;

  // ── Synthesizer ────────────────────────────────────────────────
  readonly plannedSynthesizerModelId?: string;
  readonly executedSynthesizerModelId?: string;
  readonly synthesizerMatchesPlan: boolean;
  /** Strategy 01C.0.2 — explicit source classification. */
  readonly synthesizerSelectionSource: SynthesizerSelectionSource;

  // ── Judge ──────────────────────────────────────────────────────
  readonly plannedJudgeModelId?: string;
  readonly executedJudgeModelId?: string;
  readonly judgeModelMatchesPlan: boolean;
  readonly judgeSelectionSource: JudgeSelectionSource;

  // ── Fallback single ────────────────────────────────────────────
  readonly plannedFallbackModelId?: string;
  readonly executedFallbackModelId?: string;
  readonly fallbackMatchesPlan: boolean;

  // ── SOTA gate ──────────────────────────────────────────────────
  /** Strategy 01C.0.2 — true when the plan was called as intended
   *  but did NOT execute well enough for SOTA validation. */
  readonly planExecutionDegraded: boolean;
  readonly planExecutionDegradationReason?: string;
}

export interface ConsensusStrategyArtifacts {
  readonly strategyName: 'consensus';
  readonly effectiveStrategyId: ConsensusEffectiveStrategyId;

  /** Which evaluator class produced the scores in this run. */
  readonly scoringMode: ScoringMode;
  /** Stable id of the evaluator implementation. */
  readonly evaluatorId: string;
  /** Derived from scoringMode — see `validationStatusForMode`. */
  readonly validationStatus: ValidationStatus;

  readonly participantOutputs: readonly ConsensusParticipantArtifact[];

  readonly synthesis: {
    readonly synthesizerModelId?: string;
    readonly inputParticipantCount: number;
    readonly score?: number;
    readonly verdict?: 'pass' | 'fail' | 'uncertain';
    readonly confidence?: number;
    readonly outputLength?: number;
  };

  readonly bestIndividual: {
    readonly modelId: string;
    readonly score: number | undefined;
    readonly outputLength: number;
  } | null;

  readonly finalSelection: {
    readonly source: 'synthesis' | 'best_individual' | 'verified_individual' | 'agreement_individual';
    readonly fallbackTriggered: boolean;
    readonly fallbackReason?: string;
    readonly finalScore?: number;
    readonly deltaVsBestIndividual?: number;
    /** `false` when scores were undefined / non-numeric or when the
     *  evaluator could not be compared (unavailable / structural). */
    readonly comparable: boolean;
  };

  /**
   * Agreement short-circuit telemetry (2026-07-03) — present only when synthesis
   * was skipped because every parseable voter answer agreed at or above
   * CONSENSUS_AGREEMENT_EXIT_THRESHOLD (default 1.0 = unanimity). Synthesizing N
   * copies of the same answer adds latency and cost, not quality.
   */
  readonly agreementShortCircuit?: {
    readonly agreement: number;
    readonly parseableCount: number;
    readonly voterCount: number;
  };

  /**
   * Best-of-N verification telemetry (#2) — present only when the request carried
   * an objective `answerVerifier`. Records what the checker saw and whether it
   * overrode the judge-driven selection (source='verified_individual' when it did).
   */
  readonly verification?: {
    readonly decision: 'keep_synthesis' | 'override_to_voter' | 'no_signal';
    readonly method: 'checker' | 'self_consistency' | 'none';
    readonly confidence: number;
    readonly verifiedCount: number;
    readonly totalCount: number;
    readonly synthesisVerified: boolean;
    readonly verifiedModelId?: string;
  };

  readonly partialDegradation?: boolean;
  readonly partialDegradationReason?: string;

  /**
   * Strategy 01C.0.1 — plan parity. Always present (planSource='none'
   * when no plan was attached to the request).
   */
  readonly planParity: ConsensusPlanParityArtifact;
}
