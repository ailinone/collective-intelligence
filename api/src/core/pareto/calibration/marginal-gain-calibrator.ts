// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * marginal-gain-calibrator.ts — MVP 8B.7
 *
 * Replaces the fixed `peer_lift = 0.04` + unbounded stacking from the
 * MVP 8A `ParetoEnsembleOptimizer` with a bounded, calibrated marginal
 * gain. The optimizer uses these caps when growing the ensemble; the
 * estimator catalog uses them when projecting the final expectedJudge.
 *
 * Pure types + a small search over (maxTotalGain, maxPerModelGain,
 * uncertaintyPenaltyWeight) on train-only data. The search picks the
 * combination that minimises MAE on the train ensemble examples.
 */

import type {
  EnsembleCalibrationExample,
  EnsembleEstimator,
} from './ensemble-calibration-types';
import type { PeerLiftCalibrationResult } from './peer-lift-calibrator';
import { lookupPeerLift } from './peer-lift-calibrator';

// ─── Policy ─────────────────────────────────────────────────────────────

export interface MarginalGainPolicy {
  readonly maxTotalGain: number;
  readonly maxPerModelGain: number;
  readonly minMarginalGain: number;
  readonly uncertaintyPenaltyWeight: number;
  readonly variancePenaltyWeight: number;
  readonly peerLiftMultiplier: number;
}

export const DEFAULT_MARGINAL_GAIN_POLICY: MarginalGainPolicy = Object.freeze({
  maxTotalGain: 0.2,
  maxPerModelGain: 0.08,
  minMarginalGain: 0.02,
  uncertaintyPenaltyWeight: 0.5,
  variancePenaltyWeight: 0.3,
  peerLiftMultiplier: 1.0,
});

export function resolveMarginalGainPolicy(
  override?: Partial<MarginalGainPolicy>,
): MarginalGainPolicy {
  if (!override) return DEFAULT_MARGINAL_GAIN_POLICY;
  return Object.freeze({ ...DEFAULT_MARGINAL_GAIN_POLICY, ...override });
}

// ─── Search grid (train-only validation) ────────────────────────────────

export interface MarginalGainCalibrationInput {
  readonly trainExamples: readonly EnsembleCalibrationExample[];
  readonly peerLift: PeerLiftCalibrationResult;
  readonly estimator: EnsembleEstimator;
  /** Optional restricted grid. Defaults to the canonical one. */
  readonly maxTotalGainGrid?: readonly number[];
  readonly maxPerModelGainGrid?: readonly number[];
  readonly uncertaintyPenaltyGrid?: readonly number[];
}

export interface MarginalGainGridResult {
  readonly policy: MarginalGainPolicy;
  readonly meanAbsoluteError: number;
  readonly medianAbsoluteError: number;
  readonly nonFallbackRate: number;
  readonly sampleCount: number;
}

export interface MarginalGainCalibrationResult {
  readonly chosenPolicy: MarginalGainPolicy;
  readonly evaluations: readonly MarginalGainGridResult[];
  readonly chosenEvaluation: MarginalGainGridResult;
}

/**
 * Searches the policy grid on train-only data and picks the lowest-MAE
 * policy. Deterministic tie-break: smaller maxTotalGain first.
 */
export function calibrateMarginalGain(
  input: MarginalGainCalibrationInput,
): MarginalGainCalibrationResult {
  const totalGrid = input.maxTotalGainGrid ?? [0.1, 0.15, 0.2, 0.25];
  const perModelGrid = input.maxPerModelGainGrid ?? [0.03, 0.05, 0.08];
  const penaltyGrid = input.uncertaintyPenaltyGrid ?? [0.25, 0.5, 0.75];

  const evaluations: MarginalGainGridResult[] = [];
  for (const total of totalGrid) {
    for (const perModel of perModelGrid) {
      for (const penalty of penaltyGrid) {
        const policy = resolveMarginalGainPolicy({
          maxTotalGain: total,
          maxPerModelGain: perModel,
          uncertaintyPenaltyWeight: penalty,
        });
        const ev = evaluatePolicy(policy, input);
        evaluations.push(ev);
      }
    }
  }
  evaluations.sort((a, b) => {
    if (a.meanAbsoluteError !== b.meanAbsoluteError) {
      return a.meanAbsoluteError - b.meanAbsoluteError;
    }
    if (a.policy.maxTotalGain !== b.policy.maxTotalGain) {
      return a.policy.maxTotalGain - b.policy.maxTotalGain;
    }
    return a.policy.maxPerModelGain - b.policy.maxPerModelGain;
  });
  const top = evaluations[0];
  return Object.freeze({
    chosenPolicy: top.policy,
    evaluations: Object.freeze(evaluations),
    chosenEvaluation: top,
  });
}

function evaluatePolicy(
  policy: MarginalGainPolicy,
  input: MarginalGainCalibrationInput,
): MarginalGainGridResult {
  const errors: number[] = [];
  let nonFallback = 0;
  for (const ex of input.trainExamples) {
    if (ex.selectedModelIds.length < 2) continue;
    if (ex.modelProfileJudges.length === 0) continue;
    const peerLift = lookupPeerLift(input.peerLift, ex.taskType, ex.effectiveStrategyId);
    // Build an estimator input from this example's profiles.
    // We don't have ContributionAwareScore here — but the estimator's
    // member-judge access is via memberProfiles. We construct an
    // adapter that passes empty member array; the estimator falls back
    // to profile data only.
    const estimate = input.estimator.estimate({
      members: [],
      memberProfiles: ex.modelProfileJudges,
      pairProfile: ex.pairProfile,
      peerLift,
      uncertaintyPenaltyWeight: policy.uncertaintyPenaltyWeight,
      singleBaselineJudge: ex.singleBaselineJudge,
    });
    const err = Math.abs(estimate.expectedJudge - ex.observedJudge);
    errors.push(err);
    if (estimate.expectedJudge >= ex.singleBaselineJudge) nonFallback += 1;
  }
  errors.sort((a, b) => a - b);
  return Object.freeze({
    policy,
    meanAbsoluteError: avg(errors),
    medianAbsoluteError: percentile(errors, 0.5),
    nonFallbackRate: errors.length > 0 ? nonFallback / errors.length : 0,
    sampleCount: errors.length,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

function avg(arr: readonly number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * Math.max(0, Math.min(1, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
