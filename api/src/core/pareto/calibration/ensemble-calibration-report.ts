// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-calibration-report.ts — MVP 8B.7
 *
 * Assembles the final report comparing MVP 8B.5 / 8B.6 / 8B.7 with the
 * approval verdict. Pure. No I/O.
 */

import type {
  EnsembleCalibrationMetrics,
  EnsembleEstimator,
} from './ensemble-calibration-types';
import type { EnsembleEstimatorEvaluation } from './ensemble-expected-judge-estimator';
import type { EnsembleLiftPolicy } from './ensemble-lift-policy';
import type { MarginalGainCalibrationResult } from './marginal-gain-calibrator';
import type { PeerLiftCalibrationResult } from './peer-lift-calibrator';
import type { TaskTypeEnsembleApproval } from './tasktype-ensemble-approval';

const MVP_8B5_BASELINE = Object.freeze({
  expected_vs_observed_judge_error: 0.403,
  fallback_rate: 0.123,
  quality_and_cost_success_rate: 0.877,
});

const MVP_8B6_BASELINE = Object.freeze({
  expected_vs_observed_judge_error: 0.432,
  fallback_rate: 1.0,
  quality_and_cost_success_rate: 0.877,
});

export interface EnsembleCalibrationReport {
  readonly chosenEstimator: string;
  readonly estimatorEvaluations: readonly EnsembleEstimatorEvaluation[];
  readonly peerLift: PeerLiftCalibrationResult;
  readonly marginalGainCalibration: MarginalGainCalibrationResult;
  readonly liftPolicy: EnsembleLiftPolicy;
  readonly calibratedMetrics: EnsembleCalibrationMetrics;
  readonly approvalsByTaskType: readonly TaskTypeEnsembleApproval[];
  readonly approval: {
    readonly approved: boolean;
    readonly approvedTaskTypes: readonly string[];
    readonly blockedTaskTypes: readonly string[];
    readonly reasons: readonly string[];
  };
  readonly mvp8b5Baseline: typeof MVP_8B5_BASELINE;
  readonly mvp8b6Baseline: typeof MVP_8B6_BASELINE;
  readonly generatedAt: string;
}

export interface BuildEnsembleCalibrationReportInput {
  readonly chosenEstimator: EnsembleEstimator;
  readonly estimatorEvaluations: readonly EnsembleEstimatorEvaluation[];
  readonly peerLift: PeerLiftCalibrationResult;
  readonly marginalGainCalibration: MarginalGainCalibrationResult;
  readonly liftPolicy: EnsembleLiftPolicy;
  readonly calibratedMetrics: EnsembleCalibrationMetrics;
  readonly approvalsByTaskType: readonly TaskTypeEnsembleApproval[];
  readonly nowIso: string;
}

export function buildEnsembleCalibrationReport(
  input: BuildEnsembleCalibrationReportInput,
): EnsembleCalibrationReport {
  const approvedTaskTypes: string[] = [];
  const blockedTaskTypes: string[] = [];
  for (const t of input.approvalsByTaskType) {
    if (t.approved) approvedTaskTypes.push(t.taskType);
    else blockedTaskTypes.push(t.taskType);
  }
  const reasons: string[] = [];
  let approved = approvedTaskTypes.length > 0;
  if (approvedTaskTypes.length > 0) {
    reasons.push(`approved_task_types:${approvedTaskTypes.join(',')}`);
  } else {
    reasons.push('no_task_type_approved');
  }
  if (blockedTaskTypes.length > 0) {
    reasons.push(`blocked_task_types:${blockedTaskTypes.join(',')}`);
  }
  reasons.push(
    `chosen_estimator:${input.chosenEstimator.name}`,
  );
  reasons.push(
    `calibrated_judge_error:${input.calibratedMetrics.expectedVsObservedJudgeError.toFixed(3)}`,
  );
  reasons.push(
    `non_fallback_rate:${input.calibratedMetrics.nonFallbackRate.toFixed(3)}`,
  );
  if (input.calibratedMetrics.nonFallbackRate < input.liftPolicy.minNonFallbackRate) {
    approved = false;
    reasons.push(
      `non_fallback_rate_below_policy:${input.calibratedMetrics.nonFallbackRate.toFixed(3)}<${input.liftPolicy.minNonFallbackRate}`,
    );
  }

  return Object.freeze({
    chosenEstimator: input.chosenEstimator.name,
    estimatorEvaluations: input.estimatorEvaluations,
    peerLift: input.peerLift,
    marginalGainCalibration: input.marginalGainCalibration,
    liftPolicy: input.liftPolicy,
    calibratedMetrics: input.calibratedMetrics,
    approvalsByTaskType: input.approvalsByTaskType,
    approval: Object.freeze({
      approved,
      approvedTaskTypes: Object.freeze(approvedTaskTypes),
      blockedTaskTypes: Object.freeze(blockedTaskTypes),
      reasons: Object.freeze(reasons),
    }),
    mvp8b5Baseline: MVP_8B5_BASELINE,
    mvp8b6Baseline: MVP_8B6_BASELINE,
    generatedAt: input.nowIso,
  });
}
