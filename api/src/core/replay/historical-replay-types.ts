// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-types.ts — MVP 8B.5
 *
 * Pure types for the historical-replay backtest. The shape is a
 * sanitised projection of `experiment_executions` rows — no prompts,
 * no responses, no raw context.
 */

export type ReplayModality = 'text' | 'image' | 'audio' | 'video' | 'mixed';
export type ReplayComplexity = 'low' | 'medium' | 'high' | 'extreme';

export interface HistoricalReplayExecution {
  readonly executionId: string;
  readonly experimentId: string;
  readonly taskId: string;
  readonly createdAt?: string;

  readonly taskType: string;
  readonly complexity?: ReplayComplexity;

  readonly strategyId: string;
  readonly effectiveStrategyId?: string;

  readonly modelsUsed: readonly string[];
  readonly providerRoutes?: readonly string[];

  readonly judgeScore: number | null;
  readonly costUsd: number | null;
  readonly latencyMs?: number | null;

  readonly success: boolean;
  readonly failureMode?: string | null;
  readonly degraded?: boolean;
  readonly degradationReason?: string | null;

  readonly modality?: ReplayModality;
}

// ─── Export metadata ────────────────────────────────────────────────────

export interface ReplayExportMetadata {
  readonly exportedAt: string;
  readonly source: 'read_only_db_export' | 'fixture';
  readonly rowCounts: {
    readonly executions: number;
    readonly experiments: number;
    readonly tasks?: number;
  };
  readonly filters: {
    readonly onlyWithJudgeScore: boolean;
    readonly onlyCompletedExecutions: boolean;
  };
  readonly schemaVersion: string;
}

// ─── Split ──────────────────────────────────────────────────────────────

export type SplitStrategy = 'by_experiment_id' | 'by_time';

export interface HistoricalReplaySplit {
  readonly train: readonly HistoricalReplayExecution[];
  readonly holdout: readonly HistoricalReplayExecution[];
  readonly splitStrategy: SplitStrategy;
  readonly trainExperimentIds: readonly string[];
  readonly holdoutExperimentIds: readonly string[];
  readonly leakageWarnings: readonly string[];
}

// ─── Baselines ──────────────────────────────────────────────────────────

export interface ReplayBaseline {
  readonly taskId: string;
  readonly taskType: string;

  readonly singleJudge: number;
  readonly singleCostUsd: number;

  readonly singleBudgetJudge?: number;
  readonly singleBudgetCostUsd?: number;

  readonly actualHistoricalJudge?: number;
  readonly actualHistoricalCostUsd?: number;

  readonly comparableExecutions: number;
}

// ─── Selector projections ───────────────────────────────────────────────

/**
 * Compact projection of a selector's choice for ONE holdout row.
 * Used uniformly across structural, Pareto-aware, single, single-budget
 * and actual-historical so the comparison stays apples-to-apples.
 */
export interface SelectorProjection {
  readonly selectorId: SelectorId;
  readonly selectedModelIds: readonly string[];
  readonly expectedJudge: number;
  readonly expectedCostUsd: number;
  readonly fallback: boolean;
  readonly reason?: string;
}

export type SelectorId =
  | 'actual_historical'
  | 'single_top'
  | 'single_budget'
  | 'structural_naive'
  | 'pareto_aware';

// ─── Per-row replay record ──────────────────────────────────────────────

export interface ReplayRowResult {
  readonly executionId: string;
  readonly taskId: string;
  readonly taskType: string;
  readonly complexity?: ReplayComplexity;

  readonly baseline: ReplayBaseline;

  readonly selectors: {
    readonly actual_historical: SelectorProjection;
    readonly single_top: SelectorProjection;
    readonly single_budget?: SelectorProjection;
    readonly structural_naive: SelectorProjection;
    readonly pareto_aware: SelectorProjection;
  };

  /** Comparison verdicts for Pareto-aware vs single baseline. */
  readonly pareto_meets_quality_thesis: boolean;
  readonly pareto_meets_cost_thesis: boolean;
  readonly pareto_meets_both: boolean;

  /** Pareto-aware caught a harmful candidate the structural would pick. */
  readonly harmful_model_avoided: boolean;
  /** Pareto-aware caught a modality mismatch the structural would pick. */
  readonly modality_mismatch_avoided: boolean;
  /** Pareto-aware fell back to single_fallback (collective not justified). */
  readonly pareto_single_fallback: boolean;
}

// ─── Aggregated metrics ─────────────────────────────────────────────────

export interface ReplayMetrics {
  readonly totalHoldoutRows: number;
  readonly evaluatedRows: number;
  readonly excludedDueToMissingBaseline: number;

  // Thesis success rates
  readonly pareto_win_rate: number;
  readonly quality_ge_single_rate: number;
  readonly cost_le_single_rate: number;
  readonly quality_and_cost_success_rate: number;

  // Deltas vs structural
  readonly avg_expected_judge_delta: number;
  readonly avg_expected_cost_delta: number;
  readonly median_expected_judge_delta: number;
  readonly median_expected_cost_delta: number;
  readonly expected_quality_per_dollar_delta: number;

  // Fallback / avoidance counters
  readonly single_fallback_rate: number;
  readonly unjustified_collective_avoided_total: number;
  readonly modality_mismatch_avoided_total: number;
  readonly harmful_model_avoided_total: number;
  readonly multi_mini_pool_avoided_total: number;
  readonly expensive_consensus_avoided_total: number;

  // Pareto preservations
  readonly cheap_good_preserved_total: number;
  readonly pair_winner_selected_total: number;
  readonly insufficient_data_rejected_total: number;

  // Calibration errors
  readonly expected_vs_observed_judge_error: number;
  readonly cost_prediction_error: number;
  readonly coverage_rate: number;
}

export interface ReplayMetricsByTaskType {
  readonly taskType: string;
  readonly holdoutCount: number;
  readonly structuralExpectedJudgeMean: number;
  readonly paretoExpectedJudgeMean: number;
  readonly singleBaselineJudgeMean: number;
  readonly structuralExpectedCostMean: number;
  readonly paretoExpectedCostMean: number;
  readonly singleBaselineCostMean: number;
  readonly quality_and_cost_success_rate: number;
  readonly single_fallback_rate: number;
  readonly harmful_model_avoided_total: number;
  readonly modality_mismatch_avoided_total: number;
}

// ─── Final report ───────────────────────────────────────────────────────

export interface ReplayReport {
  readonly exportMetadata: ReplayExportMetadata;
  readonly split: {
    readonly strategy: SplitStrategy;
    readonly trainCount: number;
    readonly holdoutCount: number;
    readonly trainExperimentIds: readonly string[];
    readonly holdoutExperimentIds: readonly string[];
    readonly leakageWarnings: readonly string[];
  };
  readonly globalMetrics: ReplayMetrics;
  readonly metricsByTaskType: readonly ReplayMetricsByTaskType[];
  readonly approval: {
    readonly approved: boolean;
    readonly reasons: readonly string[];
  };
  readonly generatedAt: string;
}
