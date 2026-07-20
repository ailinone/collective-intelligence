// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-lift-policy.ts — MVP 8B.7
 *
 * Policy controlling the calibrated optimizer's behaviour. Default is
 * STRICT: ensemble must beat single baseline AND stay within cost
 * ceiling AND form at least 50% of decisions (not fall back trivially).
 */

export interface EnsembleLiftPolicy {
  readonly estimatorName: string;

  readonly maxTotalLift: number;
  readonly maxPerAdditionalModelLift: number;
  readonly minNonFallbackRate: number;

  readonly minExpectedJudgeRatioVsSingle: number;
  readonly maxCostRatioVsSingle: number;

  readonly uncertaintyPenaltyWeight: number;
  readonly variancePenaltyWeight: number;

  readonly minTrainSamplesForTaskTypeApproval: number;
  readonly minHoldoutSamplesForTaskTypeApproval: number;

  readonly allowTaskTypeApprovalWithFallbackOnly: boolean;
}

export const DEFAULT_ENSEMBLE_LIFT_POLICY: EnsembleLiftPolicy = Object.freeze({
  estimatorName: 'multiplicative_bounded',

  maxTotalLift: 0.2,
  maxPerAdditionalModelLift: 0.06,
  minNonFallbackRate: 0.5,

  minExpectedJudgeRatioVsSingle: 1.0,
  maxCostRatioVsSingle: 1.0,

  uncertaintyPenaltyWeight: 0.5,
  variancePenaltyWeight: 0.3,

  minTrainSamplesForTaskTypeApproval: 30,
  minHoldoutSamplesForTaskTypeApproval: 20,

  allowTaskTypeApprovalWithFallbackOnly: false,
});

export function resolveEnsembleLiftPolicy(
  override?: Partial<EnsembleLiftPolicy>,
): EnsembleLiftPolicy {
  if (!override) return DEFAULT_ENSEMBLE_LIFT_POLICY;
  return Object.freeze({ ...DEFAULT_ENSEMBLE_LIFT_POLICY, ...override });
}
