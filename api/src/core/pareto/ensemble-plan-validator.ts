// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-plan-validator.ts — MVP 8A
 *
 * Pure verifier for EnsemblePlan objects. Used by tests and by the
 * optimizer's smoke check; production callers can run this against any
 * plan to confirm it satisfies the structural invariants:
 *
 *   1. selectedModelIds and selectedRouteIds have equal length
 *   2. counts are within the policy's [minModels, maxModels]
 *      (single_fallback exempted — it has exactly 1 model)
 *   3. expected* values are finite and within [0..1]/[0..∞)
 *   4. paretoStatus is consistent with judge/cost vs baseline
 *   5. marginalContributions list is non-empty for collective strategies
 *   6. no duplicate model ids
 *
 * No I/O. No randomness. No clock.
 */

import type { CollectiveSelectionPolicy } from './collective-selection-policy';
import type { EnsemblePlan, EnsembleParetoStatus } from './ensemble-plan-types';

export interface EnsemblePlanValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function validateEnsemblePlan(
  plan: EnsemblePlan,
  policy: CollectiveSelectionPolicy,
): EnsemblePlanValidationResult {
  const errors: string[] = [];

  // 1. Routes/models length consistency.
  if (plan.selectedRouteIds.length !== plan.selectedModelIds.length) {
    errors.push(
      `route_model_length_mismatch:${plan.selectedRouteIds.length}!=${plan.selectedModelIds.length}`,
    );
  }

  // 2. Model count vs policy.
  const n = plan.selectedModelIds.length;
  if (plan.strategyId === 'single_fallback') {
    if (n !== 1) errors.push(`single_fallback_expects_1_model:${n}`);
  } else {
    if (n < policy.minModels) errors.push(`below_minModels:${n}<${policy.minModels}`);
    if (n > policy.maxModels) errors.push(`above_maxModels:${n}>${policy.maxModels}`);
  }

  // 3. Numeric ranges.
  if (!Number.isFinite(plan.expectedJudge) || plan.expectedJudge < 0 || plan.expectedJudge > 1) {
    errors.push(`expectedJudge_out_of_range:${plan.expectedJudge}`);
  }
  if (!Number.isFinite(plan.expectedCostUsd) || plan.expectedCostUsd < 0) {
    errors.push(`expectedCostUsd_invalid:${plan.expectedCostUsd}`);
  }
  if (!Number.isFinite(plan.expectedQualityPerDollar) || plan.expectedQualityPerDollar < 0) {
    errors.push(`expectedQualityPerDollar_invalid:${plan.expectedQualityPerDollar}`);
  }

  // 4. paretoStatus consistency.
  const expectedStatus = classifyPareto(plan, policy);
  if (
    expectedStatus &&
    plan.paretoStatus !== 'single_fallback' &&
    plan.paretoStatus !== expectedStatus
  ) {
    errors.push(`paretoStatus_mismatch:${plan.paretoStatus}!=${expectedStatus}`);
  }

  // 5. Marginal contributions for collective.
  if (plan.strategyId !== 'single_fallback' && plan.marginalContributions.length === 0) {
    errors.push('collective_plan_missing_marginal_records');
  }

  // 6. Duplicate model ids.
  const seen = new Set<string>();
  for (const m of plan.selectedModelIds) {
    if (seen.has(m)) {
      errors.push(`duplicate_model_id:${m}`);
    }
    seen.add(m);
  }
  // Same for route ids.
  const seenR = new Set<string>();
  for (const r of plan.selectedRouteIds) {
    if (seenR.has(r)) {
      errors.push(`duplicate_route_id:${r}`);
    }
    seenR.add(r);
  }

  return {
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  };
}

function classifyPareto(
  plan: EnsemblePlan,
  policy: CollectiveSelectionPolicy,
): EnsembleParetoStatus | null {
  if (plan.strategyId === 'single_fallback') return 'single_fallback';
  const baselineJudge = plan.baselineJudge;
  const baselineCost = plan.baselineCostUsd;
  const judgeOk =
    plan.expectedJudge >= baselineJudge * policy.minExpectedJudgeRatioVsSingle;
  const costOk = plan.expectedCostUsd <= baselineCost * policy.maxCostRatioVsSingle;
  if (judgeOk && costOk) return 'beats_baseline';
  if (judgeOk && !costOk) return 'cost_tradeoff';
  if (!judgeOk && costOk) return 'quality_tradeoff';
  return 'dominated';
}
