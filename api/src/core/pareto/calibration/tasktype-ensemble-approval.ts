// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * tasktype-ensemble-approval.ts — MVP 8B.7
 *
 * Decides per-task-type approval with the new `min_non_fallback_rate`
 * gate. A task type CANNOT be approved if `fallback_rate >= 1.0` or
 * `non_fallback_rate < policy.minNonFallbackRate`.
 *
 * Pure. No I/O.
 */

import type { EnsembleLiftPolicy } from './ensemble-lift-policy';

export type TaskTypeApprovalStatus =
  | 'approved'
  | 'blocked_insufficient_data'
  | 'blocked_high_error'
  | 'blocked_fallback_only'
  | 'blocked_cost'
  | 'blocked_quality'
  | 'exploratory_only';

export interface TaskTypeEnsembleApproval {
  readonly taskType: string;
  readonly approved: boolean;
  readonly status: TaskTypeApprovalStatus;

  readonly trainSamples: number;
  readonly holdoutSamples: number;

  readonly expectedVsObservedJudgeError: number;
  readonly qualityAndCostSuccessRate: number;
  readonly costLeSingleRate: number;
  readonly qualityGeSingleRate: number;
  readonly nonFallbackRate: number;
  readonly fallbackRate: number;

  readonly reasons: readonly string[];
}

export interface TaskTypeApprovalInput {
  readonly taskType: string;
  readonly trainSamples: number;
  readonly holdoutSamples: number;
  readonly expectedVsObservedJudgeError: number;
  readonly qualityAndCostSuccessRate: number;
  readonly costLeSingleRate: number;
  readonly qualityGeSingleRate: number;
  readonly nonFallbackRate: number;
  readonly fallbackRate: number;
  readonly policy: EnsembleLiftPolicy;
  /** Stricter error ceiling for code-generation (default 0.25). */
  readonly codeGenerationErrorCeiling?: number;
}

export function decideTaskTypeApproval(
  input: TaskTypeApprovalInput,
): TaskTypeEnsembleApproval {
  const reasons: string[] = [];
  const p = input.policy;
  const errorCeiling =
    input.taskType === 'code-generation'
      ? input.codeGenerationErrorCeiling ?? 0.25
      : 0.3;

  // Sample size first — short-circuits everything.
  if (
    input.trainSamples < p.minTrainSamplesForTaskTypeApproval ||
    input.holdoutSamples < p.minHoldoutSamplesForTaskTypeApproval
  ) {
    reasons.push(
      `samples:train=${input.trainSamples}<${p.minTrainSamplesForTaskTypeApproval}_or_holdout=${input.holdoutSamples}<${p.minHoldoutSamplesForTaskTypeApproval}`,
    );
    return build(input, 'blocked_insufficient_data', false, reasons);
  }

  // Fallback gate — the BIG new check.
  if (
    !p.allowTaskTypeApprovalWithFallbackOnly &&
    (input.fallbackRate >= 1.0 || input.nonFallbackRate < p.minNonFallbackRate)
  ) {
    reasons.push(
      `nonFallbackRate=${input.nonFallbackRate.toFixed(3)}<${p.minNonFallbackRate}_OR_fallbackRate>=1.0`,
    );
    return build(input, 'blocked_fallback_only', false, reasons);
  }

  // Judge error.
  if (input.expectedVsObservedJudgeError > errorCeiling) {
    reasons.push(
      `judge_error=${input.expectedVsObservedJudgeError.toFixed(3)}>${errorCeiling}`,
    );
    return build(input, 'blocked_high_error', false, reasons);
  }

  // Quality.
  if (input.qualityGeSingleRate < 0.85) {
    reasons.push(`quality_ge_single_rate=${input.qualityGeSingleRate.toFixed(3)}<0.85`);
    return build(input, 'blocked_quality', false, reasons);
  }

  // Cost.
  if (input.costLeSingleRate < 0.85) {
    reasons.push(`cost_le_single_rate=${input.costLeSingleRate.toFixed(3)}<0.85`);
    return build(input, 'blocked_cost', false, reasons);
  }

  // Quality+cost combined.
  if (input.qualityAndCostSuccessRate < 0.8) {
    reasons.push(
      `quality_and_cost_success_rate=${input.qualityAndCostSuccessRate.toFixed(3)}<0.80`,
    );
    return build(input, 'blocked_quality', false, reasons);
  }

  reasons.push('all_gates_passed');
  return build(input, 'approved', true, reasons);
}

function build(
  input: TaskTypeApprovalInput,
  status: TaskTypeApprovalStatus,
  approved: boolean,
  reasons: string[],
): TaskTypeEnsembleApproval {
  return Object.freeze({
    taskType: input.taskType,
    approved,
    status,
    trainSamples: input.trainSamples,
    holdoutSamples: input.holdoutSamples,
    expectedVsObservedJudgeError: input.expectedVsObservedJudgeError,
    qualityAndCostSuccessRate: input.qualityAndCostSuccessRate,
    costLeSingleRate: input.costLeSingleRate,
    qualityGeSingleRate: input.qualityGeSingleRate,
    nonFallbackRate: input.nonFallbackRate,
    fallbackRate: input.fallbackRate,
    reasons: Object.freeze(reasons),
  });
}
