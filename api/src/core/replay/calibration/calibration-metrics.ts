// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * calibration-metrics.ts — MVP 8B.6
 *
 * Calibration-specific metrics, computed on the replay row set after
 * the calibrated estimator has been applied. These complement (and
 * partially duplicate) `historical-replay-metrics.ts`; the new
 * `expected_vs_observed_judge_median_error` and `…_p80_error` come
 * from this module.
 */

import type { ReplayRowResult } from '../historical-replay-types';

export interface CalibrationMetrics {
  readonly evaluatedRows: number;

  readonly expected_vs_observed_judge_error: number;
  readonly expected_vs_observed_judge_median_error: number;
  readonly expected_vs_observed_judge_p80_error: number;
  readonly cost_prediction_error: number;

  readonly quality_ge_single_rate: number;
  readonly cost_le_single_rate: number;
  readonly quality_and_cost_success_rate: number;
  readonly single_fallback_rate: number;
  readonly coverage_rate: number;

  readonly unjustified_collective_avoided_total: number;
  readonly expensive_consensus_avoided_total: number;
  readonly harmful_model_avoided_total: number;
  readonly modality_mismatch_avoided_total: number;
  readonly multi_mini_pool_avoided_total: number;
  readonly cheap_good_preserved_total: number;
  readonly pair_winner_selected_total: number;
  readonly insufficient_data_rejected_total: number;
}

export interface ComputeCalibrationMetricsInput {
  readonly rows: readonly ReplayRowResult[];
  readonly totalHoldoutRows: number;
}

export function computeCalibrationMetrics(
  input: ComputeCalibrationMetricsInput,
): CalibrationMetrics {
  const { rows, totalHoldoutRows } = input;
  const n = rows.length;
  if (n === 0) {
    return Object.freeze({
      evaluatedRows: 0,
      expected_vs_observed_judge_error: 0,
      expected_vs_observed_judge_median_error: 0,
      expected_vs_observed_judge_p80_error: 0,
      cost_prediction_error: 0,
      quality_ge_single_rate: 0,
      cost_le_single_rate: 0,
      quality_and_cost_success_rate: 0,
      single_fallback_rate: 0,
      coverage_rate: 0,
      unjustified_collective_avoided_total: 0,
      expensive_consensus_avoided_total: 0,
      harmful_model_avoided_total: 0,
      modality_mismatch_avoided_total: 0,
      multi_mini_pool_avoided_total: 0,
      cheap_good_preserved_total: 0,
      pair_winner_selected_total: 0,
      insufficient_data_rejected_total: 0,
    });
  }

  let qualityCount = 0;
  let costCount = 0;
  let bothCount = 0;
  let fallbackCount = 0;
  let unjustifiedCollective = 0;
  let expensiveConsensus = 0;
  let harm = 0;
  let modality = 0;
  let multiMini = 0;
  let cheapGood = 0;
  let pairWinner = 0;
  let insufficientData = 0;

  const judgeErrors: number[] = [];
  const costErrors: number[] = [];

  for (const r of rows) {
    if (r.pareto_meets_quality_thesis) qualityCount += 1;
    if (r.pareto_meets_cost_thesis) costCount += 1;
    if (r.pareto_meets_both) bothCount += 1;
    if (r.pareto_single_fallback) fallbackCount += 1;
    if (r.harmful_model_avoided) {
      harm += 1;
      multiMini += 1;
    }
    if (r.modality_mismatch_avoided) modality += 1;

    const actualWasCollective =
      r.selectors.actual_historical.selectedModelIds.length > 1;
    if (r.pareto_single_fallback && actualWasCollective) unjustifiedCollective += 1;
    if (
      r.pareto_single_fallback &&
      r.baseline.actualHistoricalCostUsd !== undefined &&
      r.baseline.actualHistoricalCostUsd > r.baseline.singleCostUsd * 2
    ) {
      expensiveConsensus += 1;
    }
    if (
      !r.pareto_single_fallback &&
      r.selectors.pareto_aware.expectedCostUsd <
        r.baseline.singleCostUsd * 0.5 &&
      r.selectors.pareto_aware.expectedJudge >= r.baseline.singleJudge
    ) {
      cheapGood += 1;
    }
    if (
      !r.pareto_single_fallback &&
      r.selectors.pareto_aware.selectedModelIds.length >= 2 &&
      r.selectors.pareto_aware.expectedJudge >= r.baseline.singleJudge
    ) {
      pairWinner += 1;
    }
    if (r.pareto_single_fallback && !actualWasCollective) insufficientData += 1;

    if (r.baseline.actualHistoricalJudge !== undefined) {
      judgeErrors.push(
        Math.abs(
          r.selectors.pareto_aware.expectedJudge -
            r.baseline.actualHistoricalJudge,
        ),
      );
    }
    if (r.baseline.actualHistoricalCostUsd !== undefined) {
      costErrors.push(
        Math.abs(
          r.selectors.pareto_aware.expectedCostUsd -
            r.baseline.actualHistoricalCostUsd,
        ),
      );
    }
  }

  judgeErrors.sort((a, b) => a - b);
  costErrors.sort((a, b) => a - b);

  return Object.freeze({
    evaluatedRows: n,
    expected_vs_observed_judge_error: mean(judgeErrors),
    expected_vs_observed_judge_median_error: percentile(judgeErrors, 0.5),
    expected_vs_observed_judge_p80_error: percentile(judgeErrors, 0.8),
    cost_prediction_error: mean(costErrors),
    quality_ge_single_rate: qualityCount / n,
    cost_le_single_rate: costCount / n,
    quality_and_cost_success_rate: bothCount / n,
    single_fallback_rate: fallbackCount / n,
    coverage_rate: totalHoldoutRows > 0 ? n / totalHoldoutRows : 0,
    unjustified_collective_avoided_total: unjustifiedCollective,
    expensive_consensus_avoided_total: expensiveConsensus,
    harmful_model_avoided_total: harm,
    modality_mismatch_avoided_total: modality,
    multi_mini_pool_avoided_total: multiMini,
    cheap_good_preserved_total: cheapGood,
    pair_winner_selected_total: pairWinner,
    insufficient_data_rejected_total: insufficientData,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

function mean(arr: readonly number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * Math.max(0, Math.min(1, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
