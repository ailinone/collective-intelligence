// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-strategy-planner-adapter.ts — MVP 8B
 *
 * Combines the original `StrategyPlanner` result with the
 * `ParetoEnsembleOptimizer`'s `EnsemblePlan` and decides the FINAL
 * offline plan. The adapter does NOT alter either input; it produces
 * a `finalOfflinePlan` describing which one wins, with a reason and
 * a `source` tag.
 *
 * Decision precedence (deterministic, top-down):
 *   1. Explicit pin (from input): preserve the ORIGINAL plan unchanged.
 *      The Pareto layer NEVER substitutes a pinned route.
 *   2. Pareto `beats_baseline`: use the Pareto plan.
 *   3. Pareto `cost_tradeoff` AND policy explicitly permits cost
 *      overruns (allowConsensusWhenCostExceedsBaseline /
 *      allowCritiqueRepairWhenCostExceedsBaseline / maxCostRatioVsSingle>1):
 *      use the Pareto plan.
 *   4. Pareto `single_fallback`: use the Pareto plan's fallback.
 *   5. Otherwise (Pareto `dominated` or `quality_tradeoff`): keep the
 *      original plan but downgrade to `single_best` if the original
 *      was a non-strict collective that did not beat the thesis.
 *
 * Invariants:
 *   - Pure. No I/O. No mutation. Deterministic.
 *   - Does NOT execute models or call providers/DB/Redis/TEI/HNSW.
 *   - Never branches on model/provider NAMES.
 */

import type { ExplicitPinInfo } from '../registry/types';
import type {
  ContributionAwareRetrieverResult,
  ContributionAwareRejectionRecord,
} from '../retrieval/contribution-aware-retriever';
import type { EnsemblePlan } from '../pareto/ensemble-plan-types';
import {
  resolveCollectiveSelectionPolicy,
  type CollectiveSelectionPolicy,
} from '../pareto/collective-selection-policy';
import type { TaskProfile } from '../task-profile/task-profile-types';
import type { StrategyPlannerResult } from './strategy-types';

// ─── Public types ───────────────────────────────────────────────────────

export interface ParetoStrategyPlannerAdapterInput {
  readonly originalStrategyResult: StrategyPlannerResult;
  readonly contributionResult: ContributionAwareRetrieverResult;
  readonly paretoPlan: EnsemblePlan;
  readonly taskProfile: TaskProfile;
  readonly explicitModelPin?: ExplicitPinInfo | null;
  readonly policy?: Partial<CollectiveSelectionPolicy>;
}

export type FinalPlanSource = 'pareto' | 'single_fallback' | 'original_strategy';

export interface FinalOfflinePlan {
  readonly strategy: string;
  readonly selectedRouteIds: readonly string[];
  readonly selectedModelIds: readonly string[];
  readonly reason: string;
  readonly source: FinalPlanSource;
  readonly expectedJudge: number;
  readonly expectedCostUsd: number;
}

export interface ParetoStrategyPlannerResult {
  readonly originalStrategyPlan: StrategyPlannerResult;
  readonly paretoEnsemblePlan: EnsemblePlan;
  readonly finalOfflinePlan: FinalOfflinePlan;
}

// ─── Main entry ─────────────────────────────────────────────────────────

export function adaptStrategyPlan(
  input: ParetoStrategyPlannerAdapterInput,
): ParetoStrategyPlannerResult {
  const policy = resolveCollectiveSelectionPolicy(input.policy);
  const original = input.originalStrategyResult.plan;
  const pareto = input.paretoPlan;

  // 1. Explicit pin → preserve original.
  if (input.explicitModelPin) {
    const modelIds = deriveModelIdsForRoutes(
      input.contributionResult,
      original.selectedRouteIds,
    );
    return Object.freeze({
      originalStrategyPlan: input.originalStrategyResult,
      paretoEnsemblePlan: pareto,
      finalOfflinePlan: Object.freeze({
        strategy: original.strategy,
        selectedRouteIds: original.selectedRouteIds,
        selectedModelIds: modelIds,
        reason: 'explicit_pin_preserved',
        source: 'original_strategy',
        expectedJudge: original.confidence,
        expectedCostUsd: 0,
      }),
    });
  }

  // 2. Pareto beats baseline → use Pareto.
  if (pareto.paretoStatus === 'beats_baseline') {
    return wrapPareto(input, pareto, 'pareto_beats_baseline', 'pareto');
  }

  // 3. Pareto cost_tradeoff with explicit policy permission → use Pareto.
  if (pareto.paretoStatus === 'cost_tradeoff' && policyPermitsCostTradeoff(policy)) {
    return wrapPareto(input, pareto, 'pareto_cost_tradeoff_policy_permits', 'pareto');
  }

  // 4. Pareto single_fallback → adopt fallback explanation.
  if (pareto.strategyId === 'single_fallback' || pareto.paretoStatus === 'single_fallback') {
    return Object.freeze({
      originalStrategyPlan: input.originalStrategyResult,
      paretoEnsemblePlan: pareto,
      finalOfflinePlan: Object.freeze({
        strategy: 'single_fallback',
        selectedRouteIds: pareto.selectedRouteIds,
        selectedModelIds: pareto.selectedModelIds,
        reason: 'collective_not_economically_justified',
        source: 'single_fallback',
        expectedJudge: pareto.expectedJudge,
        expectedCostUsd: pareto.expectedCostUsd,
      }),
    });
  }

  // 5. Otherwise: keep original.
  const modelIds = deriveModelIdsForRoutes(
    input.contributionResult,
    original.selectedRouteIds,
  );
  const reason =
    pareto.paretoStatus === 'dominated'
      ? 'pareto_dominated_kept_original'
      : pareto.paretoStatus === 'quality_tradeoff'
      ? 'pareto_quality_tradeoff_kept_original'
      : 'pareto_did_not_beat_thesis';
  return Object.freeze({
    originalStrategyPlan: input.originalStrategyResult,
    paretoEnsemblePlan: pareto,
    finalOfflinePlan: Object.freeze({
      strategy: original.strategy,
      selectedRouteIds: original.selectedRouteIds,
      selectedModelIds: modelIds,
      reason,
      source: 'original_strategy',
      expectedJudge: original.confidence,
      expectedCostUsd: 0,
    }),
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

function wrapPareto(
  input: ParetoStrategyPlannerAdapterInput,
  pareto: EnsemblePlan,
  reason: string,
  source: FinalPlanSource,
): ParetoStrategyPlannerResult {
  return Object.freeze({
    originalStrategyPlan: input.originalStrategyResult,
    paretoEnsemblePlan: pareto,
    finalOfflinePlan: Object.freeze({
      strategy: pareto.strategyId,
      selectedRouteIds: pareto.selectedRouteIds,
      selectedModelIds: pareto.selectedModelIds,
      reason,
      source,
      expectedJudge: pareto.expectedJudge,
      expectedCostUsd: pareto.expectedCostUsd,
    }),
  });
}

function policyPermitsCostTradeoff(policy: CollectiveSelectionPolicy): boolean {
  return (
    policy.allowConsensusWhenCostExceedsBaseline ||
    policy.allowCritiqueRepairWhenCostExceedsBaseline ||
    policy.maxCostRatioVsSingle > 1
  );
}

function deriveModelIdsForRoutes(
  contribution: ContributionAwareRetrieverResult,
  routeIds: readonly string[],
): readonly string[] {
  const byRoute = new Map<string, string>();
  for (const s of contribution.contributionScores) byRoute.set(s.routeId, s.modelId);
  const out: string[] = [];
  for (const id of routeIds) {
    const m = byRoute.get(id);
    if (m) out.push(m);
  }
  return Object.freeze(out);
}

// ─── Re-export for consumers ────────────────────────────────────────────

export type {
  ContributionAwareRejectionRecord,
};
