// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-expected-judge-estimator.ts — MVP 8B.7
 *
 * 8 ensemble-level estimators of `expectedJudge`. Each takes per-member
 * historical profiles + optional pair profile + a calibrated peer-lift,
 * and returns an `EnsembleExpectedJudgeEstimate`.
 *
 * All pure functions; no clock, no randomness, no I/O.
 */

import type {
  EnsembleCalibrationExample,
  EnsembleEstimateInput,
  EnsembleEstimator,
  EnsembleExpectedJudgeEstimate,
} from './ensemble-calibration-types';

// ─── Common helpers ─────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function buildEstimate(
  name: string,
  expectedJudge: number,
  uncertainty: number,
  reasons: readonly string[],
): EnsembleExpectedJudgeEstimate {
  const ej = clamp01(expectedJudge);
  const u = Math.max(0, Math.min(1, uncertainty));
  const lb = clamp01(ej - u);
  return Object.freeze({
    estimatorName: name,
    expectedJudge: ej,
    uncertainty: u,
    lowerBound: lb,
    reasons: Object.freeze(reasons.slice()),
  });
}

function anchorJudge(input: EnsembleEstimateInput): number {
  if (input.memberProfiles.length === 0) return 0;
  let best = 0;
  for (const m of input.memberProfiles) if (m.judgeMean > best) best = m.judgeMean;
  return best;
}

function supportJudge(input: EnsembleEstimateInput): number {
  if (input.memberProfiles.length <= 1) return 0;
  // Second-best.
  let best = -Infinity;
  let second = -Infinity;
  for (const m of input.memberProfiles) {
    if (m.judgeMean > best) {
      second = best;
      best = m.judgeMean;
    } else if (m.judgeMean > second) {
      second = m.judgeMean;
    }
  }
  return second === -Infinity ? 0 : second;
}

function meanStdDev(input: EnsembleEstimateInput): number {
  if (input.memberProfiles.length === 0) return 0;
  let s = 0;
  let n = 0;
  for (const m of input.memberProfiles) {
    if (typeof m.judgeStdDev === 'number') {
      s += m.judgeStdDev;
      n += 1;
    }
  }
  return n > 0 ? s / n : 0;
}

// ─── 1. additive_current ────────────────────────────────────────────────

export const additiveCurrentEstimator: EnsembleEstimator = Object.freeze({
  name: 'additive_current',
  estimate(input: EnsembleEstimateInput): EnsembleExpectedJudgeEstimate {
    const anchor = anchorJudge(input);
    const additional = input.memberProfiles.length - 1;
    const sumLifts = additional * Math.max(0, input.peerLift);
    return buildEstimate(
      'additive_current',
      anchor + sumLifts,
      0,
      [`anchor=${anchor.toFixed(4)}`, `peer_lift=${input.peerLift.toFixed(4)}`, `n_extras=${additional}`],
    );
  },
});

// ─── 2. multiplicative_bounded ──────────────────────────────────────────

export const multiplicativeBoundedEstimator: EnsembleEstimator = Object.freeze({
  name: 'multiplicative_bounded',
  estimate(input: EnsembleEstimateInput): EnsembleExpectedJudgeEstimate {
    const anchor = anchorJudge(input);
    const additional = input.memberProfiles.length - 1;
    const maxLift = 0.2; // hard ceiling
    const totalLift = Math.min(maxLift, additional * Math.max(0, input.peerLift));
    const expected = anchor * (1 + totalLift);
    const uncertainty = input.uncertaintyPenaltyWeight * meanStdDev(input);
    return buildEstimate(
      'multiplicative_bounded',
      expected,
      uncertainty,
      [
        `anchor=${anchor.toFixed(4)}`,
        `totalLift=${totalLift.toFixed(4)}`,
        `uncertainty=${uncertainty.toFixed(4)}`,
      ],
    );
  },
});

// ─── 3. capped_additive ─────────────────────────────────────────────────

export const cappedAdditiveEstimator: EnsembleEstimator = Object.freeze({
  name: 'capped_additive',
  estimate(input: EnsembleEstimateInput): EnsembleExpectedJudgeEstimate {
    const anchor = anchorJudge(input);
    const additional = input.memberProfiles.length - 1;
    const perCap = 0.06;
    const totalCap = 0.18;
    const raw = additional * Math.max(0, Math.min(input.peerLift, perCap));
    const cappedGain = Math.min(totalCap, raw);
    return buildEstimate(
      'capped_additive',
      Math.min(1, anchor + cappedGain),
      0,
      [`anchor=${anchor.toFixed(4)}`, `gain=${cappedGain.toFixed(4)}`],
    );
  },
});

// ─── 4. weighted_anchor_support ─────────────────────────────────────────

export const weightedAnchorSupportEstimator: EnsembleEstimator = Object.freeze({
  name: 'weighted_anchor_support',
  estimate(input: EnsembleEstimateInput): EnsembleExpectedJudgeEstimate {
    const anchor = anchorJudge(input);
    const support = supportJudge(input);
    const pairBonus = input.pairProfile?.complementarityScore ?? 0;
    const stdDev = meanStdDev(input);
    const uncertaintyPenalty = input.uncertaintyPenaltyWeight * stdDev;
    const expected = 0.7 * anchor + 0.25 * support + 0.05 * pairBonus - uncertaintyPenalty;
    return buildEstimate(
      'weighted_anchor_support',
      expected,
      uncertaintyPenalty,
      [`anchor=${anchor.toFixed(4)}`, `support=${support.toFixed(4)}`, `pairBonus=${pairBonus.toFixed(4)}`],
    );
  },
});

// ─── 5. pair_aware_direct ───────────────────────────────────────────────

export const pairAwareDirectEstimator: EnsembleEstimator = Object.freeze({
  name: 'pair_aware_direct',
  estimate(input: EnsembleEstimateInput): EnsembleExpectedJudgeEstimate {
    const anchor = anchorJudge(input);
    const pair = input.pairProfile;
    if (pair && typeof pair.judgeMean === 'number') {
      const winRate = pair.paretoWinRate ?? 0.5;
      const expected = (1 - winRate) * anchor + winRate * pair.judgeMean;
      return buildEstimate(
        'pair_aware_direct',
        expected,
        0,
        [`anchor=${anchor.toFixed(4)}`, `pairJudge=${pair.judgeMean.toFixed(4)}`, `winRate=${winRate.toFixed(4)}`],
      );
    }
    return buildEstimate('pair_aware_direct', anchor + input.peerLift, 0, [
      `anchor=${anchor.toFixed(4)}`,
      'no_pair_profile_fallback_to_peer_lift',
    ]);
  },
});

// ─── 6. lower_bound_ensemble ────────────────────────────────────────────

export const lowerBoundEnsembleEstimator: EnsembleEstimator = Object.freeze({
  name: 'lower_bound_ensemble',
  estimate(input: EnsembleEstimateInput): EnsembleExpectedJudgeEstimate {
    const anchor = anchorJudge(input);
    const additional = input.memberProfiles.length - 1;
    const raw = anchor + additional * Math.max(0, input.peerLift) * 0.5;
    const stdDev = meanStdDev(input);
    const uncertainty = input.uncertaintyPenaltyWeight * stdDev + 0.05;
    return buildEstimate(
      'lower_bound_ensemble',
      raw - uncertainty,
      uncertainty,
      [`anchor=${anchor.toFixed(4)}`, `uncertainty=${uncertainty.toFixed(4)}`],
    );
  },
});

// ─── 7. conservative_parallel ───────────────────────────────────────────

export const conservativeParallelEstimator: EnsembleEstimator = Object.freeze({
  name: 'conservative_parallel',
  estimate(input: EnsembleEstimateInput): EnsembleExpectedJudgeEstimate {
    const anchor = anchorJudge(input);
    const support = supportJudge(input);
    const base = Math.max(anchor, 0.7 * anchor + 0.3 * support);
    const lift = Math.max(0, input.peerLift) * 0.75;
    return buildEstimate(
      'conservative_parallel',
      base + lift,
      0,
      [`base=${base.toFixed(4)}`, `lift=${lift.toFixed(4)}`],
    );
  },
});

// ─── 8. empirical_ensemble_calibrated ───────────────────────────────────

/**
 * Uses a precomputed (offset, scale) learned from train ensemble
 * examples. When no calibration is supplied (offset=0, scale=1), this
 * degrades to the additive baseline.
 */
export interface EmpiricalEnsembleCalibration {
  readonly offset: number;
  readonly scale: number;
}

export function makeEmpiricalEnsembleEstimator(
  cal: EmpiricalEnsembleCalibration,
): EnsembleEstimator {
  return Object.freeze({
    name: 'empirical_ensemble_calibrated',
    estimate(input: EnsembleEstimateInput): EnsembleExpectedJudgeEstimate {
      const anchor = anchorJudge(input);
      const additional = input.memberProfiles.length - 1;
      const raw = anchor + additional * Math.max(0, input.peerLift);
      const calibrated = raw * cal.scale + cal.offset;
      return buildEstimate(
        'empirical_ensemble_calibrated',
        calibrated,
        0,
        [`anchor=${anchor.toFixed(4)}`, `scale=${cal.scale.toFixed(4)}`, `offset=${cal.offset.toFixed(4)}`],
      );
    },
  });
}

/**
 * Learns `(offset, scale)` from train ensemble examples via least-squares
 * fit on `observed_judge ~ (anchor + peer_lift*extras) * scale + offset`.
 * Pure / deterministic — uses simple closed-form linear regression.
 */
export function learnEmpiricalCalibration(
  examples: readonly EnsembleCalibrationExample[],
  peerLiftLookup: (ex: EnsembleCalibrationExample) => number,
): EmpiricalEnsembleCalibration {
  const points: Array<{ x: number; y: number }> = [];
  for (const ex of examples) {
    if (ex.selectedModelIds.length < 2) continue;
    if (ex.modelProfileJudges.length === 0) continue;
    let best = 0;
    for (const m of ex.modelProfileJudges) if (m.judgeMean > best) best = m.judgeMean;
    const additional = ex.selectedModelIds.length - 1;
    const x = best + additional * Math.max(0, peerLiftLookup(ex));
    points.push({ x, y: ex.observedJudge });
  }
  if (points.length < 2) return Object.freeze({ offset: 0, scale: 1 });
  // Closed-form linear regression y = a + b*x.
  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  const n = points.length;
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    num += dx * (p.y - meanY);
    den += dx * dx;
  }
  const scale = den > 1e-9 ? num / den : 1;
  const offset = meanY - scale * meanX;
  return Object.freeze({ offset, scale });
}

// ─── Catalog ────────────────────────────────────────────────────────────

export const ALL_ENSEMBLE_ESTIMATORS: readonly EnsembleEstimator[] = Object.freeze([
  additiveCurrentEstimator,
  multiplicativeBoundedEstimator,
  cappedAdditiveEstimator,
  weightedAnchorSupportEstimator,
  pairAwareDirectEstimator,
  lowerBoundEnsembleEstimator,
  conservativeParallelEstimator,
]);

// ─── Evaluation ─────────────────────────────────────────────────────────

export interface EnsembleEstimatorEvaluation {
  readonly estimatorName: string;
  readonly meanAbsoluteError: number;
  readonly medianAbsoluteError: number;
  readonly p80AbsoluteError: number;
  readonly nonFallbackRate: number;
  readonly sampleCount: number;
}

export interface EvaluateEnsembleEstimatorInput {
  readonly estimator: EnsembleEstimator;
  readonly examples: readonly EnsembleCalibrationExample[];
  readonly peerLiftLookup: (ex: EnsembleCalibrationExample) => number;
  readonly uncertaintyPenaltyWeight: number;
}

export function evaluateEnsembleEstimator(
  input: EvaluateEnsembleEstimatorInput,
): EnsembleEstimatorEvaluation {
  const errors: number[] = [];
  let nonFallback = 0;
  for (const ex of input.examples) {
    if (ex.selectedModelIds.length < 2) continue;
    if (ex.modelProfileJudges.length === 0) continue;
    const estimate = input.estimator.estimate({
      members: [],
      memberProfiles: ex.modelProfileJudges,
      pairProfile: ex.pairProfile,
      peerLift: input.peerLiftLookup(ex),
      uncertaintyPenaltyWeight: input.uncertaintyPenaltyWeight,
      singleBaselineJudge: ex.singleBaselineJudge,
    });
    errors.push(Math.abs(estimate.expectedJudge - ex.observedJudge));
    if (estimate.expectedJudge >= ex.singleBaselineJudge) nonFallback += 1;
  }
  errors.sort((a, b) => a - b);
  return Object.freeze({
    estimatorName: input.estimator.name,
    meanAbsoluteError: avg(errors),
    medianAbsoluteError: percentile(errors, 0.5),
    p80AbsoluteError: percentile(errors, 0.8),
    nonFallbackRate: errors.length > 0 ? nonFallback / errors.length : 0,
    sampleCount: errors.length,
  });
}

/**
 * Picks the best ensemble estimator on train-only data. Selects on
 * a composite score: MAE + 0.3 * fallback_rate_penalty (so a low-MAE
 * estimator that triggers 100% fallback gets penalised).
 */
export interface PickBestEnsembleEstimatorInput {
  readonly examples: readonly EnsembleCalibrationExample[];
  readonly peerLiftLookup: (ex: EnsembleCalibrationExample) => number;
  readonly uncertaintyPenaltyWeight: number;
  readonly estimators?: readonly EnsembleEstimator[];
}

export interface PickBestEnsembleEstimatorResult {
  readonly evaluations: readonly EnsembleEstimatorEvaluation[];
  readonly chosen: EnsembleEstimator;
  readonly chosenEvaluation: EnsembleEstimatorEvaluation;
  readonly composite: number;
}

export function pickBestEnsembleEstimator(
  input: PickBestEnsembleEstimatorInput,
): PickBestEnsembleEstimatorResult {
  const estimators = input.estimators ?? ALL_ENSEMBLE_ESTIMATORS;
  const evaluations = estimators.map((est) =>
    evaluateEnsembleEstimator({
      estimator: est,
      examples: input.examples,
      peerLiftLookup: input.peerLiftLookup,
      uncertaintyPenaltyWeight: input.uncertaintyPenaltyWeight,
    }),
  );
  // Composite = MAE + 0.3 * (1 - nonFallbackRate). Lower is better.
  const composites = evaluations.map((e) => e.meanAbsoluteError + 0.3 * (1 - e.nonFallbackRate));
  let bestIdx = 0;
  for (let i = 1; i < composites.length; i += 1) {
    if (composites[i] < composites[bestIdx]) bestIdx = i;
    else if (composites[i] === composites[bestIdx]) {
      if (evaluations[i].estimatorName < evaluations[bestIdx].estimatorName) bestIdx = i;
    }
  }
  return Object.freeze({
    evaluations: Object.freeze(evaluations),
    chosen: estimators[bestIdx],
    chosenEvaluation: evaluations[bestIdx],
    composite: composites[bestIdx],
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
