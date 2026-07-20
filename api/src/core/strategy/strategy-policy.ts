// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-policy.ts — MVP 5B
 *
 * Pure config + defaults. No I/O.
 */

export interface StrategyPolicy {
  /** Min candidates required to plan `consensus`. */
  readonly minCandidatesForConsensus: number;
  /** Min candidates required to plan `debate`. */
  readonly minCandidatesForDebate: number;
  /** Min candidates required to plan `expert_panel`. */
  readonly minCandidatesForExpertPanel: number;
  /** Default `maxParallelism` for collective strategies. */
  readonly maxParallelismDefault: number;
  /** When false, collective strategies are NEVER planned. */
  readonly allowCollectiveForHighRisk: boolean;
  /** Hard invariant: when privacy is `local_required`, cloud routes are forbidden. */
  readonly allowCloudWhenLocalRequired: false;
  /** When false, an explicit pin's fallback chain is empty. */
  readonly allowFallbackForExplicitPin: boolean;
  /** Min candidates required to plan `cost_cascade`. */
  readonly costCascadeMinCandidates: number;
  /** Min candidates required to plan `quality_cascade`. */
  readonly qualityCascadeMinCandidates: number;
  /** Min DISTINCT canonical models required to plan `parallel_diverse`. */
  readonly parallelDiverseMinCanonicals: number;
  /**
   * Score ratio threshold for `local_first` in `local_preferred` mode:
   * if `topLocalScore / topAnyScore >= ratio`, prefer local.
   * Defaults to 0.7 — a "local within 30% of cloud is good enough".
   */
  readonly localFirstScoreRatio: number;
}

/**
 * Conservative defaults. Production deployments can override.
 */
export const DEFAULT_STRATEGY_POLICY: StrategyPolicy = Object.freeze({
  minCandidatesForConsensus: 3,
  minCandidatesForDebate: 3,
  minCandidatesForExpertPanel: 4,
  maxParallelismDefault: 3,
  allowCollectiveForHighRisk: true,
  allowCloudWhenLocalRequired: false as const,
  allowFallbackForExplicitPin: false,
  costCascadeMinCandidates: 2,
  qualityCascadeMinCandidates: 2,
  parallelDiverseMinCanonicals: 3,
  localFirstScoreRatio: 0.7,
});

/**
 * Merges a partial override onto the default. Field by field — no
 * deep merge needed since `StrategyPolicy` is flat.
 */
export function resolveStrategyPolicy(
  override?: Partial<StrategyPolicy>,
): StrategyPolicy {
  if (!override) return DEFAULT_STRATEGY_POLICY;
  return {
    minCandidatesForConsensus:
      override.minCandidatesForConsensus ?? DEFAULT_STRATEGY_POLICY.minCandidatesForConsensus,
    minCandidatesForDebate:
      override.minCandidatesForDebate ?? DEFAULT_STRATEGY_POLICY.minCandidatesForDebate,
    minCandidatesForExpertPanel:
      override.minCandidatesForExpertPanel ?? DEFAULT_STRATEGY_POLICY.minCandidatesForExpertPanel,
    maxParallelismDefault:
      override.maxParallelismDefault ?? DEFAULT_STRATEGY_POLICY.maxParallelismDefault,
    allowCollectiveForHighRisk:
      override.allowCollectiveForHighRisk ??
      DEFAULT_STRATEGY_POLICY.allowCollectiveForHighRisk,
    allowCloudWhenLocalRequired: false,
    allowFallbackForExplicitPin:
      override.allowFallbackForExplicitPin ??
      DEFAULT_STRATEGY_POLICY.allowFallbackForExplicitPin,
    costCascadeMinCandidates:
      override.costCascadeMinCandidates ??
      DEFAULT_STRATEGY_POLICY.costCascadeMinCandidates,
    qualityCascadeMinCandidates:
      override.qualityCascadeMinCandidates ??
      DEFAULT_STRATEGY_POLICY.qualityCascadeMinCandidates,
    parallelDiverseMinCanonicals:
      override.parallelDiverseMinCanonicals ??
      DEFAULT_STRATEGY_POLICY.parallelDiverseMinCanonicals,
    localFirstScoreRatio:
      override.localFirstScoreRatio ?? DEFAULT_STRATEGY_POLICY.localFirstScoreRatio,
  };
}
