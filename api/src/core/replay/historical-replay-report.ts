// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-report.ts — MVP 8B.5
 *
 * Assembles the full `ReplayReport` from a split + metrics + per-task
 * breakdown + approval verdict.
 *
 * The approval gate is deterministic: it applies the §12 criteria from
 * the MVP 8B.5 spec. The verdict is a boolean + ordered reasons list
 * suitable for inclusion in human-readable output.
 */

import type {
  HistoricalReplaySplit,
  ReplayExportMetadata,
  ReplayMetrics,
  ReplayMetricsByTaskType,
  ReplayReport,
} from './historical-replay-types';

export interface BuildReplayReportInput {
  readonly exportMetadata: ReplayExportMetadata;
  readonly split: HistoricalReplaySplit;
  readonly globalMetrics: ReplayMetrics;
  readonly metricsByTaskType: readonly ReplayMetricsByTaskType[];
  readonly nowIso: string;
}

export function buildReplayReport(
  input: BuildReplayReportInput,
): ReplayReport {
  const approval = decideApproval(input);
  return Object.freeze({
    exportMetadata: input.exportMetadata,
    split: {
      strategy: input.split.splitStrategy,
      trainCount: input.split.train.length,
      holdoutCount: input.split.holdout.length,
      trainExperimentIds: input.split.trainExperimentIds,
      holdoutExperimentIds: input.split.holdoutExperimentIds,
      leakageWarnings: input.split.leakageWarnings,
    },
    globalMetrics: input.globalMetrics,
    metricsByTaskType: input.metricsByTaskType,
    approval,
    generatedAt: input.nowIso,
  });
}

// ─── Approval verdict ───────────────────────────────────────────────────

interface ApprovalArgs {
  readonly globalMetrics: ReplayMetrics;
  readonly split: HistoricalReplaySplit;
}

function decideApproval(args: ApprovalArgs): ReplayReport['approval'] {
  const m = args.globalMetrics;
  const reasons: string[] = [];
  let approved = true;

  // 1. Train/holdout sem vazamento.
  if (args.split.leakageWarnings.length > 0) {
    approved = false;
    reasons.push(
      `leakage_detected:${args.split.leakageWarnings.slice(0, 3).join(',')}`,
    );
  }

  // 2. Holdout amostra suficiente.
  if (m.totalHoldoutRows < 20) {
    approved = false;
    reasons.push(`holdout_too_small:${m.totalHoldoutRows}`);
  }
  if (m.evaluatedRows < 10) {
    approved = false;
    reasons.push(`too_few_evaluated_rows:${m.evaluatedRows}`);
  }

  // 3. quality_and_cost_success_rate é o sinal central.
  if (m.quality_and_cost_success_rate < 0.5) {
    approved = false;
    reasons.push(
      `quality_and_cost_success_rate_below_0_5:${m.quality_and_cost_success_rate.toFixed(3)}`,
    );
  } else {
    reasons.push(
      `quality_and_cost_success_rate_ok:${m.quality_and_cost_success_rate.toFixed(3)}`,
    );
  }

  // 4. Não degrada qualidade no modo strict.
  if (m.quality_ge_single_rate < 0.5) {
    approved = false;
    reasons.push(
      `quality_ge_single_rate_below_0_5:${m.quality_ge_single_rate.toFixed(3)}`,
    );
  }

  // 5. Cost <= single na maioria.
  if (m.cost_le_single_rate < 0.5) {
    approved = false;
    reasons.push(`cost_le_single_rate_below_0_5:${m.cost_le_single_rate.toFixed(3)}`);
  }

  // 6. expected_vs_observed_judge_error aceitável.
  // Threshold: 0.30 (judge scale is 0..1).
  if (m.expected_vs_observed_judge_error > 0.3) {
    approved = false;
    reasons.push(
      `expected_vs_observed_judge_error_high:${m.expected_vs_observed_judge_error.toFixed(3)}`,
    );
  }

  // 7. cost_prediction_error razoável (em USD).
  if (m.cost_prediction_error > 0.1) {
    approved = false;
    reasons.push(
      `cost_prediction_error_high:${m.cost_prediction_error.toFixed(4)}`,
    );
  }

  // 8. coverage_rate. Mín 0.30 — se Pareto não conseguiu rodar em pelo
  //    menos 30 % do holdout, calibrar candidate set.
  if (m.coverage_rate < 0.3) {
    approved = false;
    reasons.push(`coverage_rate_below_0_3:${m.coverage_rate.toFixed(3)}`);
  }

  // 9. single_fallback_rate não excessivo. Aceitamos até 60 %.
  if (m.single_fallback_rate > 0.6) {
    approved = false;
    reasons.push(`single_fallback_rate_excessive:${m.single_fallback_rate.toFixed(3)}`);
  }

  return Object.freeze({
    approved,
    reasons: Object.freeze(reasons),
  });
}
