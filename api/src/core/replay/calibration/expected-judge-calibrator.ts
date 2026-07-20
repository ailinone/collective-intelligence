// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * expected-judge-calibrator.ts — MVP 8B.6
 *
 * Implements the catalogue of estimators for `expectedJudge` and a
 * helper that picks the best one on a train-only cross-validation.
 *
 * Estimators (all pure, all closed-form, all deterministic):
 *
 *   judgeMean              — current MVP 8B.5 estimator (baseline)
 *   judgeMedian            — robust to outliers
 *   judgeP80               — optimistic (top quintile)
 *   weightedMedianP80      — 0.6·median + 0.4·P80 (per spec)
 *   lowerConfidenceBound   — mean − 1.96·stdDev/√n  (Wilson-style)
 *   variancePenalizedMean  — mean − 0.5·stdDev
 *   empiricalBayesShrinkage — mean shrunken toward global prior by
 *                            sampleWeight
 *   taskTypeCalibrated     — apply per-task-type global offset
 *   pairAwareCalibrated    — like taskType but uses pair-level data
 *                            when available
 *
 * For ensemble scoring, the per-candidate estimate replaces
 * `profile.judgeMean`. The Pareto optimizer's growth math is unchanged.
 *
 * Pure. No I/O. No clock. No randomness.
 */

import type { ModelTaskPerformanceProfile } from '../../contribution/model-task-performance-profile';

// ─── Estimator surface ──────────────────────────────────────────────────

export interface ExpectedJudgeEstimateInput {
  readonly profile: ModelTaskPerformanceProfile;
  /** Optional task-type-level offset learned from train. */
  readonly taskTypeOffset?: number;
  /** Optional global prior for empirical-Bayes shrinkage. */
  readonly globalMean?: number;
  /** Optional pair-aware lift used by pairAwareCalibrated. */
  readonly pairLiftMean?: number;
}

export interface ExpectedJudgeEstimator {
  readonly name: string;
  estimate(input: ExpectedJudgeEstimateInput): number;
}

// ─── Catalogue ──────────────────────────────────────────────────────────

export const judgeMeanEstimator: ExpectedJudgeEstimator = Object.freeze({
  name: 'judgeMean',
  estimate: (i: ExpectedJudgeEstimateInput) => clamp01(i.profile.judgeMean),
});

export const judgeMedianEstimator: ExpectedJudgeEstimator = Object.freeze({
  name: 'judgeMedian',
  estimate: (i: ExpectedJudgeEstimateInput) => clamp01(i.profile.judgeMedian),
});

export const judgeP80Estimator: ExpectedJudgeEstimator = Object.freeze({
  name: 'judgeP80',
  estimate: (i: ExpectedJudgeEstimateInput) => clamp01(i.profile.judgeP80),
});

export const weightedMedianP80Estimator: ExpectedJudgeEstimator = Object.freeze({
  name: 'weightedMedianP80',
  estimate: (i: ExpectedJudgeEstimateInput) =>
    clamp01(0.6 * i.profile.judgeMedian + 0.4 * i.profile.judgeP80),
});

export const lowerConfidenceBoundEstimator: ExpectedJudgeEstimator = Object.freeze({
  name: 'lowerConfidenceBound',
  estimate: (i: ExpectedJudgeEstimateInput) => {
    const p = i.profile;
    if (p.sampleCount <= 0) return 0;
    const se = p.judgeStdDev / Math.sqrt(Math.max(1, p.sampleCount));
    return clamp01(p.judgeMean - 1.96 * se);
  },
});

export const variancePenalizedMeanEstimator: ExpectedJudgeEstimator = Object.freeze({
  name: 'variancePenalizedMean',
  estimate: (i: ExpectedJudgeEstimateInput) => clamp01(i.profile.judgeMean - 0.5 * i.profile.judgeStdDev),
});

export const empiricalBayesShrinkageEstimator: ExpectedJudgeEstimator = Object.freeze({
  name: 'empiricalBayesShrinkage',
  estimate: (i: ExpectedJudgeEstimateInput) => {
    const p = i.profile;
    const prior = typeof i.globalMean === 'number' ? i.globalMean : 0.5;
    return clamp01(p.sampleWeight * p.judgeMean + (1 - p.sampleWeight) * prior);
  },
});

export const taskTypeCalibratedEstimator: ExpectedJudgeEstimator = Object.freeze({
  name: 'taskTypeCalibrated',
  estimate: (i: ExpectedJudgeEstimateInput) => {
    const offset = typeof i.taskTypeOffset === 'number' ? i.taskTypeOffset : 0;
    return clamp01(i.profile.judgeMean + offset);
  },
});

export const pairAwareCalibratedEstimator: ExpectedJudgeEstimator = Object.freeze({
  name: 'pairAwareCalibrated',
  estimate: (i: ExpectedJudgeEstimateInput) => {
    if (typeof i.pairLiftMean === 'number') {
      return clamp01(0.5 * i.profile.judgeMean + 0.5 * i.pairLiftMean);
    }
    const offset = typeof i.taskTypeOffset === 'number' ? i.taskTypeOffset : 0;
    return clamp01(i.profile.judgeMean + offset);
  },
});

export const ALL_ESTIMATORS: readonly ExpectedJudgeEstimator[] = Object.freeze([
  judgeMeanEstimator,
  judgeMedianEstimator,
  judgeP80Estimator,
  weightedMedianP80Estimator,
  lowerConfidenceBoundEstimator,
  variancePenalizedMeanEstimator,
  empiricalBayesShrinkageEstimator,
  taskTypeCalibratedEstimator,
  pairAwareCalibratedEstimator,
]);

// ─── Train-only cross-validation evaluator ──────────────────────────────

export interface TrainEvalDatum {
  readonly profile: ModelTaskPerformanceProfile;
  readonly observedJudge: number;
  readonly taskTypeOffset?: number;
  readonly globalMean?: number;
  readonly pairLiftMean?: number;
}

export interface EstimatorEvaluation {
  readonly estimatorName: string;
  readonly meanAbsoluteError: number;
  readonly medianAbsoluteError: number;
  readonly p80AbsoluteError: number;
  readonly sampleCount: number;
}

export function evaluateEstimator(
  estimator: ExpectedJudgeEstimator,
  data: readonly TrainEvalDatum[],
): EstimatorEvaluation {
  if (data.length === 0) {
    return Object.freeze({
      estimatorName: estimator.name,
      meanAbsoluteError: 0,
      medianAbsoluteError: 0,
      p80AbsoluteError: 0,
      sampleCount: 0,
    });
  }
  const errors: number[] = [];
  for (const d of data) {
    const predicted = estimator.estimate({
      profile: d.profile,
      taskTypeOffset: d.taskTypeOffset,
      globalMean: d.globalMean,
      pairLiftMean: d.pairLiftMean,
    });
    errors.push(Math.abs(predicted - d.observedJudge));
  }
  errors.sort((a, b) => a - b);
  return Object.freeze({
    estimatorName: estimator.name,
    meanAbsoluteError: mean(errors),
    medianAbsoluteError: percentile(errors, 0.5),
    p80AbsoluteError: percentile(errors, 0.8),
    sampleCount: errors.length,
  });
}

export interface EstimatorSelectionResult {
  readonly evaluations: readonly EstimatorEvaluation[];
  readonly chosen: ExpectedJudgeEstimator;
  readonly chosenEvaluation: EstimatorEvaluation;
}

/**
 * Picks the estimator with the LOWEST mean absolute error on the given
 * train evaluation data. Deterministic tie-break: alphabetical name.
 */
export function pickBestEstimator(
  data: readonly TrainEvalDatum[],
  estimators: readonly ExpectedJudgeEstimator[] = ALL_ESTIMATORS,
): EstimatorSelectionResult {
  const evaluations = estimators.map((e) => evaluateEstimator(e, data));
  const indexed = evaluations.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => {
    if (a.e.meanAbsoluteError !== b.e.meanAbsoluteError) {
      return a.e.meanAbsoluteError - b.e.meanAbsoluteError;
    }
    return a.e.estimatorName < b.e.estimatorName ? -1 : 1;
  });
  const top = indexed[0];
  return Object.freeze({
    evaluations: Object.freeze(evaluations),
    chosen: estimators[top.i],
    chosenEvaluation: top.e,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function mean(arr: readonly number[]): number {
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
