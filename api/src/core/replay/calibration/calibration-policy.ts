// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * calibration-policy.ts — MVP 8B.6
 *
 * Calibration thresholds + per-task-type policy. Pure config.
 */

export interface CalibrationPolicy {
  /** Max acceptable expected_vs_observed_judge_error globally. */
  readonly maxOverallJudgeError: number;
  /** Stricter threshold for the primary task type (code-generation). */
  readonly maxCodeGenerationJudgeError: number;
  /** Minimum quality_and_cost_success_rate for approval. */
  readonly minQualityAndCostSuccessRate: number;
  /** Minimum quality_ge_single_rate for approval. */
  readonly minQualityGeSingleRate: number;
  /** Minimum cost_le_single_rate for approval. */
  readonly minCostLeSingleRate: number;
  /** Max acceptable cost_prediction_error in USD. */
  readonly maxCostPredictionError: number;
  /** Min coverage rate (fraction of holdout actually scored). */
  readonly minCoverageRate: number;
  /** Per-task-type min holdout sample to even consider approval. */
  readonly minHoldoutSamplesPerTaskType: number;
  /** Per-task-type min train sample to compute reliable profiles. */
  readonly minTrainSamplesPerTaskType: number;
}

export const DEFAULT_CALIBRATION_POLICY: CalibrationPolicy = Object.freeze({
  maxOverallJudgeError: 0.3,
  maxCodeGenerationJudgeError: 0.25,
  minQualityAndCostSuccessRate: 0.8,
  minQualityGeSingleRate: 0.85,
  minCostLeSingleRate: 0.85,
  maxCostPredictionError: 0.1,
  minCoverageRate: 0.8,
  minHoldoutSamplesPerTaskType: 20,
  minTrainSamplesPerTaskType: 30,
});

export function resolveCalibrationPolicy(
  override?: Partial<CalibrationPolicy>,
): CalibrationPolicy {
  if (!override) return DEFAULT_CALIBRATION_POLICY;
  return Object.freeze({ ...DEFAULT_CALIBRATION_POLICY, ...override });
}
