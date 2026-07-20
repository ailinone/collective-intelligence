// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-results-quality-gate.ts — MVP 8B.6
 *
 * Classifies each normalised row's `usage` for downstream consumers.
 * Pure function.
 *
 * Decision tree (top-down, first match wins):
 *
 *   excluded
 *     ← no executionId / no experimentId / no modelsUsed
 *     ← judgeScale === 'unknown' AND no costUsd AND no failureMode
 *
 *   usable_for_failure_analysis_only
 *     ← failureMode OR degradationReason present
 *     AND no usable judgeScore
 *
 *   usable_for_cost_only
 *     ← costUsd present AND modelsUsed non-empty
 *     AND no judgeScoreNormalized
 *
 *   usable_for_training / usable_for_holdout
 *     ← judgeScoreNormalized in [0,1]
 *     AND costUsd numeric
 *     AND taskType present
 *     AND strategy or effectiveStrategy present
 *     (The split between "training" and "holdout" is made later by
 *      the split policy — the gate just flags eligible rows.)
 *
 * Output: per-row `HistoricalRowQualityDecision`.
 */

import type {
  HistoricalRowQualityDecision,
  NormalisedRow,
} from './historical-results-schema';

export function classifyRow(row: NormalisedRow): HistoricalRowQualityDecision {
  const reasons: string[] = [];

  // ── HARD-EXCLUDE checks ─────────────────────────────────────────────
  if (!row.executionId) {
    reasons.push('missing_execution_id');
    return decision(row, 'excluded', reasons);
  }
  if (!row.experimentId) {
    reasons.push('missing_experiment_id');
    return decision(row, 'excluded', reasons);
  }
  if (row.modelsUsed.length === 0) {
    reasons.push('missing_models_used');
    return decision(row, 'excluded', reasons);
  }
  if (
    row.judgeScaleDetected === 'unknown' &&
    (row.costUsd === null || !Number.isFinite(row.costUsd)) &&
    !row.failureMode &&
    !row.degradationReason
  ) {
    reasons.push('no_usable_signal');
    return decision(row, 'excluded', reasons);
  }

  // ── Training-and-holdout candidates ─────────────────────────────────
  const judgeOk =
    typeof row.judgeScoreNormalized === 'number' &&
    Number.isFinite(row.judgeScoreNormalized) &&
    row.judgeScoreNormalized >= 0 &&
    row.judgeScoreNormalized <= 1;
  const costOk = row.costUsd !== null && Number.isFinite(row.costUsd) && row.costUsd >= 0;
  const taskOk = !!row.taskType;
  const strategyOk = !!(row.strategy || row.effectiveStrategy);

  if (judgeOk && costOk && taskOk && strategyOk) {
    reasons.push('judge_normalised_ok');
    reasons.push('cost_present');
    reasons.push('task_type_present');
    reasons.push('strategy_present');
    // Split between training and holdout happens later — the gate
    // marks every eligible row as "usable_for_training"; downstream
    // promotes some to "usable_for_holdout" per the split policy.
    return decision(row, 'usable_for_training', reasons);
  }

  // ── Cost-only fallback ──────────────────────────────────────────────
  if (costOk && row.modelsUsed.length > 0) {
    reasons.push('cost_present_no_judge');
    return decision(row, 'usable_for_cost_only', reasons);
  }

  // ── Failure-analysis-only ───────────────────────────────────────────
  if ((row.failureMode || row.degradationReason) && !judgeOk) {
    reasons.push('failure_signal_only');
    return decision(row, 'usable_for_failure_analysis_only', reasons);
  }

  // ── Default exclude (covers missing judge, missing task, etc.) ──────
  if (!judgeOk) reasons.push('missing_or_invalid_judge');
  if (!costOk) reasons.push('missing_cost');
  if (!taskOk) reasons.push('missing_task_type');
  if (!strategyOk) reasons.push('missing_strategy');
  return decision(row, 'excluded', reasons);
}

function decision(
  row: NormalisedRow,
  usage: HistoricalRowQualityDecision['usage'],
  reasons: string[],
): HistoricalRowQualityDecision {
  return Object.freeze({
    executionId: row.executionId,
    usage,
    reasons: Object.freeze(reasons),
  });
}

// ─── Bulk classifier ────────────────────────────────────────────────────

export interface QualityGateResult {
  readonly decisions: readonly HistoricalRowQualityDecision[];
  readonly counts: Record<HistoricalRowQualityDecision['usage'], number>;
}

export function classifyRows(rows: readonly NormalisedRow[]): QualityGateResult {
  const decisions: HistoricalRowQualityDecision[] = [];
  const counts: QualityGateResult['counts'] = {
    usable_for_training: 0,
    usable_for_holdout: 0,
    usable_for_cost_only: 0,
    usable_for_failure_analysis_only: 0,
    excluded: 0,
  };
  for (const r of rows) {
    const d = classifyRow(r);
    decisions.push(d);
    counts[d.usage] += 1;
  }
  return Object.freeze({
    decisions: Object.freeze(decisions),
    counts: Object.freeze(counts),
  });
}
