// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-metrics.ts — MVP 8B.5
 *
 * Aggregates `ReplayRowResult[]` into global metrics + per-task-type
 * breakdown. Pure function.
 */

import type {
  ReplayMetrics,
  ReplayMetricsByTaskType,
  ReplayRowResult,
} from './historical-replay-types';

export interface ComputeMetricsInput {
  readonly rows: readonly ReplayRowResult[];
  readonly totalHoldoutRows: number;
  readonly excludedDueToMissingBaseline: number;
}

export function computeReplayMetrics(input: ComputeMetricsInput): ReplayMetrics {
  const { rows, totalHoldoutRows, excludedDueToMissingBaseline } = input;
  const n = rows.length;

  if (n === 0) {
    return Object.freeze(emptyMetrics(totalHoldoutRows, excludedDueToMissingBaseline));
  }

  let qualityCount = 0;
  let costCount = 0;
  let bothCount = 0;
  let fallbackCount = 0;
  let unjustifiedCollectiveAvoided = 0;
  let harmAvoided = 0;
  let modalityAvoided = 0;
  let multiMiniAvoided = 0;
  let expensiveConsensusAvoided = 0;
  let cheapGoodPreserved = 0;
  let pairWinnerSelected = 0;
  let insufficientDataRejected = 0;
  const judgeDeltas: number[] = [];
  const costDeltas: number[] = [];
  const judgeErrors: number[] = [];
  const costErrors: number[] = [];

  for (const r of rows) {
    if (r.pareto_meets_quality_thesis) qualityCount += 1;
    if (r.pareto_meets_cost_thesis) costCount += 1;
    if (r.pareto_meets_both) bothCount += 1;
    if (r.pareto_single_fallback) fallbackCount += 1;
    if (r.harmful_model_avoided) harmAvoided += 1;
    if (r.modality_mismatch_avoided) modalityAvoided += 1;

    // Multi-mini: structural picked ≥2 candidates, all marked "avoid"
    // OR the harm avoidance also fired (proxy).
    if (r.harmful_model_avoided) multiMiniAvoided += 1;

    // Pareto-aware fell back AND actual historical was a paid collective
    // → optimizer correctly avoided an unjustified collective.
    const actualWasCollective =
      r.selectors.actual_historical.selectedModelIds.length > 1;
    const paretoFallback = r.pareto_single_fallback;
    if (paretoFallback && actualWasCollective) {
      unjustifiedCollectiveAvoided += 1;
    }
    // Expensive consensus avoidance: actual cost was high AND pareto
    // chose single_fallback.
    if (
      paretoFallback &&
      r.baseline.actualHistoricalCostUsd !== undefined &&
      r.baseline.actualHistoricalCostUsd > r.baseline.singleCostUsd * 2
    ) {
      expensiveConsensusAvoided += 1;
    }

    // Cheap-good preservation: Pareto selected at least one candidate
    // with cost < single baseline AND quality >= single baseline.
    if (
      !paretoFallback &&
      r.selectors.pareto_aware.expectedCostUsd <
        r.baseline.singleCostUsd * 0.5 &&
      r.selectors.pareto_aware.expectedJudge >= r.baseline.singleJudge
    ) {
      cheapGoodPreserved += 1;
    }

    // Pair winner: Pareto selected >= 2 models AND beats baseline.
    if (
      !paretoFallback &&
      r.selectors.pareto_aware.selectedModelIds.length >= 2 &&
      r.selectors.pareto_aware.expectedJudge >= r.baseline.singleJudge
    ) {
      pairWinnerSelected += 1;
    }

    // Insufficient data rejection: Pareto fell back, actual was single.
    if (paretoFallback && !actualWasCollective) {
      insufficientDataRejected += 1;
    }

    const judgeDelta =
      r.selectors.pareto_aware.expectedJudge -
      r.selectors.structural_naive.expectedJudge;
    const costDelta =
      r.selectors.pareto_aware.expectedCostUsd -
      r.selectors.structural_naive.expectedCostUsd;
    judgeDeltas.push(judgeDelta);
    costDeltas.push(costDelta);

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

  const paretoQpd = average(
    rows.map((r) =>
      r.selectors.pareto_aware.expectedCostUsd > 1e-9
        ? r.selectors.pareto_aware.expectedJudge /
          r.selectors.pareto_aware.expectedCostUsd
        : 0,
    ),
  );
  const structuralQpd = average(
    rows.map((r) =>
      r.selectors.structural_naive.expectedCostUsd > 1e-9
        ? r.selectors.structural_naive.expectedJudge /
          r.selectors.structural_naive.expectedCostUsd
        : 0,
    ),
  );

  return Object.freeze({
    totalHoldoutRows,
    evaluatedRows: n,
    excludedDueToMissingBaseline,

    pareto_win_rate: bothCount / n,
    quality_ge_single_rate: qualityCount / n,
    cost_le_single_rate: costCount / n,
    quality_and_cost_success_rate: bothCount / n,

    avg_expected_judge_delta: average(judgeDeltas),
    avg_expected_cost_delta: average(costDeltas),
    median_expected_judge_delta: median(judgeDeltas),
    median_expected_cost_delta: median(costDeltas),
    expected_quality_per_dollar_delta: paretoQpd - structuralQpd,

    single_fallback_rate: fallbackCount / n,
    unjustified_collective_avoided_total: unjustifiedCollectiveAvoided,
    modality_mismatch_avoided_total: modalityAvoided,
    harmful_model_avoided_total: harmAvoided,
    multi_mini_pool_avoided_total: multiMiniAvoided,
    expensive_consensus_avoided_total: expensiveConsensusAvoided,

    cheap_good_preserved_total: cheapGoodPreserved,
    pair_winner_selected_total: pairWinnerSelected,
    insufficient_data_rejected_total: insufficientDataRejected,

    expected_vs_observed_judge_error: average(judgeErrors),
    cost_prediction_error: average(costErrors),
    coverage_rate: totalHoldoutRows > 0 ? n / totalHoldoutRows : 0,
  });
}

// ─── Per-taskType breakdown ─────────────────────────────────────────────

export function computeMetricsByTaskType(
  rows: readonly ReplayRowResult[],
): readonly ReplayMetricsByTaskType[] {
  const buckets = new Map<string, ReplayRowResult[]>();
  for (const r of rows) {
    let b = buckets.get(r.taskType);
    if (!b) {
      b = [];
      buckets.set(r.taskType, b);
    }
    b.push(r);
  }
  const out: ReplayMetricsByTaskType[] = [];
  for (const [taskType, items] of [...buckets.entries()].sort()) {
    const successCount = items.filter((r) => r.pareto_meets_both).length;
    const fallbackCount = items.filter((r) => r.pareto_single_fallback).length;
    out.push(
      Object.freeze({
        taskType,
        holdoutCount: items.length,
        structuralExpectedJudgeMean: average(
          items.map((r) => r.selectors.structural_naive.expectedJudge),
        ),
        paretoExpectedJudgeMean: average(
          items.map((r) => r.selectors.pareto_aware.expectedJudge),
        ),
        singleBaselineJudgeMean: average(
          items.map((r) => r.baseline.singleJudge),
        ),
        structuralExpectedCostMean: average(
          items.map((r) => r.selectors.structural_naive.expectedCostUsd),
        ),
        paretoExpectedCostMean: average(
          items.map((r) => r.selectors.pareto_aware.expectedCostUsd),
        ),
        singleBaselineCostMean: average(
          items.map((r) => r.baseline.singleCostUsd),
        ),
        quality_and_cost_success_rate: successCount / items.length,
        single_fallback_rate: fallbackCount / items.length,
        harmful_model_avoided_total: items.filter((r) => r.harmful_model_avoided)
          .length,
        modality_mismatch_avoided_total: items.filter(
          (r) => r.modality_mismatch_avoided,
        ).length,
      }),
    );
  }
  return Object.freeze(out);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function emptyMetrics(
  totalHoldoutRows: number,
  excludedDueToMissingBaseline: number,
): ReplayMetrics {
  return {
    totalHoldoutRows,
    evaluatedRows: 0,
    excludedDueToMissingBaseline,
    pareto_win_rate: 0,
    quality_ge_single_rate: 0,
    cost_le_single_rate: 0,
    quality_and_cost_success_rate: 0,
    avg_expected_judge_delta: 0,
    avg_expected_cost_delta: 0,
    median_expected_judge_delta: 0,
    median_expected_cost_delta: 0,
    expected_quality_per_dollar_delta: 0,
    single_fallback_rate: 0,
    unjustified_collective_avoided_total: 0,
    modality_mismatch_avoided_total: 0,
    harmful_model_avoided_total: 0,
    multi_mini_pool_avoided_total: 0,
    expensive_consensus_avoided_total: 0,
    cheap_good_preserved_total: 0,
    pair_winner_selected_total: 0,
    insufficient_data_rejected_total: 0,
    expected_vs_observed_judge_error: 0,
    cost_prediction_error: 0,
    coverage_rate: totalHoldoutRows > 0 ? 0 : 0,
  };
}

function average(arr: readonly number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function median(arr: readonly number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}
