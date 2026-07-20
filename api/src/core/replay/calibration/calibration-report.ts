// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * calibration-report.ts — MVP 8B.6
 *
 * Assembles the final calibration report:
 *   - estimator comparison (all estimators tested on TRAIN CV)
 *   - chosen estimator
 *   - calibrated holdout metrics
 *   - per-task-type breakdown
 *   - approval verdict per calibration policy
 *
 * Pure. No I/O.
 */

import type {
  EstimatorEvaluation,
} from './expected-judge-calibrator';
import type { CalibrationMetrics } from './calibration-metrics';
import type {
  CalibrationPolicy,
} from './calibration-policy';
import type { TaskTypeCalibrationRecord } from './tasktype-calibration';

export interface CalibrationApprovalDecision {
  readonly approved: boolean;
  readonly reasons: readonly string[];
  readonly approvedTaskTypes: readonly string[];
  readonly blockedTaskTypes: readonly string[];
}

export interface CalibrationReport {
  readonly chosenEstimator: string;
  readonly evaluations: readonly EstimatorEvaluation[];
  readonly calibratedMetrics: CalibrationMetrics;
  readonly metricsByTaskType: readonly TaskTypeCalibrationRecord[];
  readonly policy: CalibrationPolicy;
  readonly approval: CalibrationApprovalDecision;
  readonly mvp8b5Baseline: {
    readonly expected_vs_observed_judge_error: number;
    readonly quality_and_cost_success_rate: number;
    readonly cost_prediction_error: number;
  };
  readonly generatedAt: string;
}

export interface BuildCalibrationReportInput {
  readonly chosenEstimator: string;
  readonly evaluations: readonly EstimatorEvaluation[];
  readonly calibratedMetrics: CalibrationMetrics;
  readonly metricsByTaskType: readonly TaskTypeCalibrationRecord[];
  readonly policy: CalibrationPolicy;
  readonly nowIso: string;
}

/** Locked baseline numbers from the MVP 8B.5 report — not re-computed. */
const MVP_8B5_BASELINE = Object.freeze({
  expected_vs_observed_judge_error: 0.403,
  quality_and_cost_success_rate: 0.877,
  cost_prediction_error: 0.048,
});

export function buildCalibrationReport(
  input: BuildCalibrationReportInput,
): CalibrationReport {
  const approval = decideApproval(input);
  return Object.freeze({
    chosenEstimator: input.chosenEstimator,
    evaluations: input.evaluations,
    calibratedMetrics: input.calibratedMetrics,
    metricsByTaskType: input.metricsByTaskType,
    policy: input.policy,
    approval,
    mvp8b5Baseline: MVP_8B5_BASELINE,
    generatedAt: input.nowIso,
  });
}

function decideApproval(
  input: BuildCalibrationReportInput,
): CalibrationApprovalDecision {
  const reasons: string[] = [];
  let approved = true;
  const policy = input.policy;
  const m = input.calibratedMetrics;

  // 1. Global judge-error ceiling.
  if (m.expected_vs_observed_judge_error >= policy.maxOverallJudgeError) {
    approved = false;
    reasons.push(
      `overall_judge_error_high:${m.expected_vs_observed_judge_error.toFixed(3)}>=${policy.maxOverallJudgeError}`,
    );
  } else {
    reasons.push(
      `overall_judge_error_ok:${m.expected_vs_observed_judge_error.toFixed(3)}`,
    );
  }

  // 2. quality_and_cost_success_rate.
  if (m.quality_and_cost_success_rate < policy.minQualityAndCostSuccessRate) {
    approved = false;
    reasons.push(
      `quality_and_cost_success_rate_low:${m.quality_and_cost_success_rate.toFixed(3)}<${policy.minQualityAndCostSuccessRate}`,
    );
  }
  // 3. quality_ge_single_rate.
  if (m.quality_ge_single_rate < policy.minQualityGeSingleRate) {
    approved = false;
    reasons.push(
      `quality_ge_single_rate_low:${m.quality_ge_single_rate.toFixed(3)}<${policy.minQualityGeSingleRate}`,
    );
  }
  // 4. cost_le_single_rate.
  if (m.cost_le_single_rate < policy.minCostLeSingleRate) {
    approved = false;
    reasons.push(
      `cost_le_single_rate_low:${m.cost_le_single_rate.toFixed(3)}<${policy.minCostLeSingleRate}`,
    );
  }
  // 5. cost prediction.
  if (m.cost_prediction_error > policy.maxCostPredictionError) {
    approved = false;
    reasons.push(
      `cost_prediction_error_high:${m.cost_prediction_error.toFixed(4)}>${policy.maxCostPredictionError}`,
    );
  }
  // 6. coverage.
  if (m.coverage_rate < policy.minCoverageRate) {
    approved = false;
    reasons.push(`coverage_rate_low:${m.coverage_rate.toFixed(3)}<${policy.minCoverageRate}`);
  }

  // Per-task-type approval split.
  const approvedTaskTypes: string[] = [];
  const blockedTaskTypes: string[] = [];
  for (const t of input.metricsByTaskType) {
    if (t.approvedForCollective) approvedTaskTypes.push(t.taskType);
    else blockedTaskTypes.push(t.taskType);
  }
  if (approvedTaskTypes.length === 0) {
    approved = false;
    reasons.push('no_task_type_approved');
  } else {
    reasons.push(`approved_task_types:${approvedTaskTypes.join(',')}`);
  }
  if (blockedTaskTypes.length > 0) {
    reasons.push(`blocked_task_types:${blockedTaskTypes.join(',')}`);
  }

  return Object.freeze({
    approved,
    reasons: Object.freeze(reasons),
    approvedTaskTypes: Object.freeze(approvedTaskTypes),
    blockedTaskTypes: Object.freeze(blockedTaskTypes),
  });
}
