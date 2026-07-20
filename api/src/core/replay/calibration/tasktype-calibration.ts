// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * tasktype-calibration.ts — MVP 8B.6
 *
 * Per-task-type analysis. For each task type observed in train+holdout
 * we compute its sample counts, best estimator's error, success rate,
 * fallback rate, and decide approval per the calibration policy.
 *
 * Pure. No I/O.
 */

import type { ReplayRowResult } from '../historical-replay-types';
import type { CalibrationPolicy } from './calibration-policy';

export interface TaskTypeCalibrationRecord {
  readonly taskType: string;
  readonly sampleCountTrain: number;
  readonly sampleCountHoldout: number;
  readonly bestEstimator: string;
  readonly expectedVsObservedError: number;
  readonly qualityAndCostSuccessRate: number;
  readonly fallbackRate: number;
  readonly approvedForCollective: boolean;
  readonly status:
    | 'approved'
    | 'insufficient_data'
    | 'judge_error_too_high'
    | 'quality_thesis_failed'
    | 'cost_thesis_failed';
  readonly reason: string;
}

export interface BuildTaskTypeCalibrationInput {
  readonly rows: readonly ReplayRowResult[];
  /** Sample counts per task type, computed on TRAIN ONLY. */
  readonly trainCountsByTaskType: ReadonlyMap<string, number>;
  /** Error per task type, from the chosen estimator (TRAIN CV). */
  readonly errorByTaskType: ReadonlyMap<string, number>;
  readonly bestEstimatorName: string;
  readonly policy: CalibrationPolicy;
}

export function buildTaskTypeCalibration(
  input: BuildTaskTypeCalibrationInput,
): readonly TaskTypeCalibrationRecord[] {
  const buckets = new Map<string, ReplayRowResult[]>();
  for (const r of input.rows) {
    let b = buckets.get(r.taskType);
    if (!b) {
      b = [];
      buckets.set(r.taskType, b);
    }
    b.push(r);
  }

  const out: TaskTypeCalibrationRecord[] = [];
  for (const [taskType, rows] of [...buckets.entries()].sort()) {
    const sampleCountTrain = input.trainCountsByTaskType.get(taskType) ?? 0;
    const sampleCountHoldout = rows.length;
    const expectedError = input.errorByTaskType.get(taskType) ?? 1;
    const successCount = rows.filter((r) => r.pareto_meets_both).length;
    const fallbackCount = rows.filter((r) => r.pareto_single_fallback).length;
    const successRate = successCount / sampleCountHoldout;
    const fallbackRate = fallbackCount / sampleCountHoldout;

    const decision = decideTaskType(
      taskType,
      sampleCountTrain,
      sampleCountHoldout,
      expectedError,
      successRate,
      input.policy,
    );
    out.push(
      Object.freeze({
        taskType,
        sampleCountTrain,
        sampleCountHoldout,
        bestEstimator: input.bestEstimatorName,
        expectedVsObservedError: expectedError,
        qualityAndCostSuccessRate: successRate,
        fallbackRate,
        approvedForCollective: decision.status === 'approved',
        status: decision.status,
        reason: decision.reason,
      }),
    );
  }
  return Object.freeze(out);
}

function decideTaskType(
  taskType: string,
  sampleCountTrain: number,
  sampleCountHoldout: number,
  expectedError: number,
  successRate: number,
  policy: CalibrationPolicy,
): { status: TaskTypeCalibrationRecord['status']; reason: string } {
  // Insufficient data short-circuits everything.
  if (
    sampleCountTrain < policy.minTrainSamplesPerTaskType ||
    sampleCountHoldout < policy.minHoldoutSamplesPerTaskType
  ) {
    return {
      status: 'insufficient_data',
      reason: `train=${sampleCountTrain},holdout=${sampleCountHoldout},minTrain=${policy.minTrainSamplesPerTaskType},minHoldout=${policy.minHoldoutSamplesPerTaskType}`,
    };
  }
  // Judge error must be below the per-task-type ceiling.
  const errorCeiling =
    taskType === 'code-generation'
      ? policy.maxCodeGenerationJudgeError
      : policy.maxOverallJudgeError;
  if (expectedError > errorCeiling) {
    return {
      status: 'judge_error_too_high',
      reason: `error=${expectedError.toFixed(3)}>${errorCeiling.toFixed(3)}`,
    };
  }
  // Quality+cost thesis success rate.
  if (successRate < policy.minQualityAndCostSuccessRate) {
    return {
      status: 'quality_thesis_failed',
      reason: `success_rate=${successRate.toFixed(3)}<${policy.minQualityAndCostSuccessRate}`,
    };
  }
  return {
    status: 'approved',
    reason: `error=${expectedError.toFixed(3)}<=${errorCeiling.toFixed(3)};success_rate=${successRate.toFixed(3)}`,
  };
}
