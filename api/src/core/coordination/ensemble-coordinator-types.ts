// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ensemble Coordinator Types — F4.1 audit-flow extension.
 *
 * These types mirror the Python data shapes in
 * `model-stack/serving/aggregation/tiered_voter.py`. The contract
 * between the two sides is owned by `coordinator-stable.yaml` —
 * any change there MUST be reflected in BOTH this file and the
 * Python module.
 *
 * The shapes are designed to round-trip through:
 *   1. JSON over HTTP (CI gateway → model-stack serving)
 *   2. Audit substrate persistence in `collective_signals.decision_value`
 *      (no remap needed — fields here match what the F4.1 substrate
 *      already accepts as JSONB)
 *   3. F3.3 export pipeline (downstream consumers parse the same shape)
 *
 * Type-safety rules (per project lint baseline = 0):
 *   - Zero `as unknown as` / `as any`
 *   - All boundary conversions go through narrowAs<T> helpers
 *   - Errors are serialized via serializeError before logging
 */

/**
 * Cascade tier ordering. Numeric values match the YAML registry so
 * cross-language comparison is identical (1-6 in both runtimes).
 */
export type EnsembleTier = 1 | 2 | 3 | 4 | 5 | 6;

export const ENSEMBLE_TIERS: ReadonlyArray<{ id: EnsembleTier; name: string; description: string }> = [
  { id: 1, name: 'encoder', description: 'Encoders ≤200M, latency <10ms, hot' },
  { id: 2, name: 'dense_tiny', description: 'Dense ≤1B, latency ~50ms, hot' },
  { id: 3, name: 'dense_small', description: 'Dense 1-3B, latency ~150ms, hot' },
  { id: 4, name: 'dense_anchor', description: 'Dense 3-9B, latency ~400ms, warm — ensemble anchor' },
  { id: 5, name: 'moe_light', description: 'MoE active ≤3B, latency ~600ms, warm' },
  { id: 6, name: 'moe_heavy', description: 'MoE active ≥6B, latency ~1500ms, cold — ambiguity floor' },
] as const;

/**
 * One vote from one coordinator model. Maps 1:1 to
 * `CoordinatorVote` in `model-stack/serving/aggregation/tiered_voter.py`.
 */
export interface CoordinatorVote {
  /** e.g. "m01" through "m24" — primary key in coordinator-stable.yaml */
  modelId: string;
  /** e.g. "coord-m01-modernbert" — lands in scheduler audit field */
  scheduler: string;
  tier: EnsembleTier;
  /** The chosen RoleDecision.role value (strategy-specific vocabulary) */
  role: string;
  /**
   * Stable token from the reason vocabulary in
   * coord-stable/_shared.yaml (e.g. "task-type-match", "ensemble-dissent").
   */
  reason: string;
  /** Self-reported probability ∈ [0, 1] */
  confidence: number;
  /** Optional free-form rationale (already PII-redacted upstream) */
  rationale?: string;
  /** Optional features the model used; useful for debugging */
  features?: Record<string, unknown>;
}

/**
 * All votes from one tier plus tier-level statistics.
 */
export interface TierResult {
  tier: EnsembleTier;
  votes: ReadonlyArray<CoordinatorVote>;
  /** Models that errored / timed out — kept for audit completeness */
  failedModels: ReadonlyArray<string>;
  /** Computed: most common role across the tier's votes (null if empty) */
  majorityRole: string | null;
  /** Computed: count of votes disagreeing with the tier majority */
  dissentCount: number;
  /** Computed: mean of all votes' confidences */
  averageConfidence: number;
}

/**
 * Final aggregated decision. This is what the strategy persists in
 * `collective_signals.decision_value` (JSONB) and what F3.3 export
 * forwards to downstream training pipelines.
 *
 * Every field is captured for auditability — when a learned coordinator
 * is later trained on this data, the trainer can reconstruct exactly
 * which models voted, how the cascade unfolded, and what tier carried
 * each decision over the line.
 */
export interface AggregatedEnsembleDecision {
  /** Final chosen role */
  role: string;
  /** Aggregator's reason token (typically the most common reason among winners) */
  reason: string;
  /** Identity of this aggregator — distinguishes from learned-coordinator runs later */
  scheduler: 'ensemble-24-tiered-bayesian' | 'ensemble-24-llm-synthesis' | string;
  /** Confidence ∈ [0, 1] computed from weighted vote share of the winner */
  confidence: number;
  /**
   * Aggregation algorithm used. Currently:
   *   - "weighted_bayesian_majority" (default cascade)
   *   - "dissent_aware_synthesis" (LLM-synthesis when dissent high)
   */
  aggregationMethod: string;
  /** All tier results in the order they ran */
  tierResults: ReadonlyArray<TierResult>;
  /** role → count of votes that picked that role (across all tiers) */
  voteDistribution: Readonly<Record<string, number>>;
  /** Total votes counted (sum across tier_results.votes lengths) */
  totalVotes: number;
  /** How many votes disagreed with the final winner */
  dissentCount: number;
  /** Tiers that actually ran (may be a prefix of all 6 if cascade short-circuited) */
  tiersActivated: ReadonlyArray<EnsembleTier>;
  /** Last tier that ran (or null when no tier executors registered) */
  finalTier: EnsembleTier | null;
  /** True when Tier 1-3 confidence threshold ended the cascade early */
  shortCircuited: boolean;
}

/**
 * Request payload sent to `model-stack/serving/aggregation` HTTP endpoint.
 * Wraps the strategy-specific decision context the coordinator needs to
 * predict the next role/scheduler.
 */
export interface EnsembleDecisionRequest {
  /** Strategy that's asking for a decision */
  strategy:
    | 'tri-role-collective'
    | 'debate'
    | 'expert-panel'
    | 'consensus'
    | 'parallel-race'
    | 'sensitivity-consensus';
  /** What kind of decision is needed (matches the F4.1 audit substrate) */
  decisionType:
    | 'role-for-turn'              // tri-role: planner / solver / auditor
    | 'moderator-selection'        // debate: which model moderates
    | 'panel-composition'          // expert-panel: which experts + coordinator
    | 'synthesis-coordinator'      // consensus: which model synthesizes
    | 'race-candidates'            // parallel-race: which models race
    | 'aggregation-method';        // sensitivity-consensus: numeric vs llm-synthesis
  /** Strategy-specific context (turn number, prior decisions, etc.) */
  context: Record<string, unknown>;
  /**
   * Override flags for this single decision — typically null. Operators
   * can force a tier or aggregation method via these for debugging.
   */
  overrides?: {
    forceTier?: EnsembleTier;
    forceAggregation?: 'weighted_bayesian_majority' | 'dissent_aware_synthesis';
    skipTiers?: ReadonlyArray<EnsembleTier>;
  };
}

/**
 * Response payload from the ensemble HTTP endpoint. The decision IS the
 * value that should be passed back through the F4.1 audit substrate
 * (the strategy lifts `role` / `reason` / `scheduler` / `confidence`
 * out of `decision` and writes them into the existing RoleDecision shape;
 * the rest of the AggregatedEnsembleDecision lands in JSONB metadata).
 */
export interface EnsembleDecisionResponse {
  decision: AggregatedEnsembleDecision;
  /** Server-side latency breakdown for observability */
  latencyBreakdown: {
    totalMs: number;
    tierLatencies: ReadonlyArray<{ tier: EnsembleTier; ms: number }>;
  };
  /** Echo of the request id for correlation in logs */
  requestId: string;
}

/**
 * Configuration knobs read from `coordinator-stable.yaml` at boot.
 * Lives in the strategy layer so a feature flag can disable the
 * ensemble and fall back to the existing `decideRoleForTurn` /
 * `assignModeratorRole` / `selectPanel` heuristics.
 */
export interface EnsembleClientConfig {
  /** Master switch — env: CI_ENSEMBLE_COORDINATOR_ENABLED */
  enabled: boolean;
  /** Endpoint URL — env: CI_ENSEMBLE_COORDINATOR_URL */
  endpoint: string;
  /** Bearer token (optional) — env: CI_ENSEMBLE_COORDINATOR_TOKEN */
  authToken?: string;
  /** Timeout in ms — env: CI_ENSEMBLE_COORDINATOR_TIMEOUT_MS */
  timeoutMs: number;
  /**
   * If true, the ensemble decision is shadow-evaluated alongside the
   * existing heuristic but the heuristic still drives execution. Both
   * decisions are persisted so we can compare offline before flipping.
   * env: CI_ENSEMBLE_COORDINATOR_SHADOW_MODE
   */
  shadowMode: boolean;
  /**
   * If true, fall back to the heuristic when the ensemble call fails.
   * If false, surface the error. Default true (safety).
   * env: CI_ENSEMBLE_COORDINATOR_FALLBACK_ON_ERROR
   */
  fallbackOnError: boolean;
}

/**
 * Type-guards — used at the HTTP boundary in the client implementation
 * to narrow the JSON response without `as` casts.
 */

export function isEnsembleTier(value: unknown): value is EnsembleTier {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6;
}

export function isCoordinatorVote(value: unknown): value is CoordinatorVote {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.modelId === 'string' &&
    typeof v.scheduler === 'string' &&
    isEnsembleTier(v.tier) &&
    typeof v.role === 'string' &&
    typeof v.reason === 'string' &&
    typeof v.confidence === 'number'
  );
}

export function isAggregatedEnsembleDecision(value: unknown): value is AggregatedEnsembleDecision {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.role === 'string' &&
    typeof v.reason === 'string' &&
    typeof v.scheduler === 'string' &&
    typeof v.confidence === 'number' &&
    typeof v.aggregationMethod === 'string' &&
    Array.isArray(v.tierResults) &&
    typeof v.totalVotes === 'number' &&
    typeof v.dissentCount === 'number' &&
    Array.isArray(v.tiersActivated) &&
    typeof v.shortCircuited === 'boolean'
  );
}
