// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * expected-judge-calibrator.test.ts — MVP 8B.6
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_ESTIMATORS,
  empiricalBayesShrinkageEstimator,
  evaluateEstimator,
  judgeMeanEstimator,
  judgeMedianEstimator,
  judgeP80Estimator,
  lowerConfidenceBoundEstimator,
  pickBestEstimator,
  taskTypeCalibratedEstimator,
  variancePenalizedMeanEstimator,
  weightedMedianP80Estimator,
  type TrainEvalDatum,
} from '../calibration/expected-judge-calibrator';
import type { ModelTaskPerformanceProfile } from '../../contribution/model-task-performance-profile';

function profile(
  overrides: Partial<ModelTaskPerformanceProfile> = {},
): ModelTaskPerformanceProfile {
  return Object.freeze({
    modelId: 'm',
    taskType: 'code',
    sampleCount: 10,
    judgeMean: 0.7,
    judgeMedian: 0.65,
    judgeP80: 0.85,
    judgeStdDev: 0.15,
    judgeVariance: 0.0225,
    winRate: 0.5,
    lossRate: 0.1,
    zeroRate: 0,
    harmRate: 0.05,
    costMean: 0.02,
    costP95: 0.03,
    qualityPerDollar: 35,
    contributionScore: 0.6,
    harmScore: 0.05,
    confidence: 0.8,
    calibrationConfidence: 0.7,
    sampleWeight: 10 / 15,
    recommendedRole: 'anchor',
    ...overrides,
  });
}

describe('estimators — formulae', () => {
  it('judgeMean returns judgeMean', () => {
    expect(judgeMeanEstimator.estimate({ profile: profile() })).toBe(0.7);
  });

  it('judgeMedian returns judgeMedian', () => {
    expect(judgeMedianEstimator.estimate({ profile: profile() })).toBe(0.65);
  });

  it('judgeP80 returns judgeP80', () => {
    expect(judgeP80Estimator.estimate({ profile: profile() })).toBe(0.85);
  });

  it('weightedMedianP80 = 0.6*median + 0.4*p80', () => {
    const v = weightedMedianP80Estimator.estimate({ profile: profile() });
    expect(v).toBeCloseTo(0.6 * 0.65 + 0.4 * 0.85, 6);
  });

  it('lowerConfidenceBound = mean - 1.96*sd/sqrt(n)', () => {
    const v = lowerConfidenceBoundEstimator.estimate({ profile: profile() });
    const expected = 0.7 - 1.96 * (0.15 / Math.sqrt(10));
    expect(v).toBeCloseTo(expected, 6);
  });

  it('variancePenalizedMean = mean - 0.5*sd', () => {
    const v = variancePenalizedMeanEstimator.estimate({ profile: profile() });
    expect(v).toBeCloseTo(0.7 - 0.5 * 0.15, 6);
  });

  it('empiricalBayesShrinkage = w*mean + (1-w)*prior', () => {
    const p = profile({ sampleWeight: 0.5 });
    const v = empiricalBayesShrinkageEstimator.estimate({
      profile: p,
      globalMean: 0.4,
    });
    expect(v).toBeCloseTo(0.5 * 0.7 + 0.5 * 0.4, 6);
  });

  it('taskTypeCalibrated adds offset to mean', () => {
    const v = taskTypeCalibratedEstimator.estimate({
      profile: profile(),
      taskTypeOffset: -0.1,
    });
    expect(v).toBeCloseTo(0.7 - 0.1, 6);
  });

  it('all estimators clamp into [0,1]', () => {
    // Force a negative result via huge variance penalty.
    const p = profile({ judgeMean: 0.05, judgeStdDev: 0.6 });
    for (const e of ALL_ESTIMATORS) {
      const v = e.estimate({ profile: p });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('evaluateEstimator + pickBestEstimator', () => {
  it('returns zero MAE when predictions match exactly', () => {
    const p = profile({ judgeMean: 0.5 });
    const data: TrainEvalDatum[] = [
      { profile: p, observedJudge: 0.5 },
      { profile: p, observedJudge: 0.5 },
    ];
    const r = evaluateEstimator(judgeMeanEstimator, data);
    expect(r.meanAbsoluteError).toBe(0);
  });

  it('penalises an over-optimistic estimator on conservative data', () => {
    const p = profile({ judgeMean: 0.9, judgeP80: 1.0, judgeStdDev: 0.05 });
    const data: TrainEvalDatum[] = [
      { profile: p, observedJudge: 0.4 },
      { profile: p, observedJudge: 0.5 },
      { profile: p, observedJudge: 0.6 },
    ];
    const meanEval = evaluateEstimator(judgeMeanEstimator, data);
    const lcbEval = evaluateEstimator(lowerConfidenceBoundEstimator, data);
    // LCB should be closer to observed (0.4..0.6) than mean (0.9).
    expect(lcbEval.meanAbsoluteError).toBeLessThan(meanEval.meanAbsoluteError);
  });

  it('pickBestEstimator chooses the lowest MAE', () => {
    const p = profile({ judgeMean: 0.9, judgeP80: 1.0, judgeStdDev: 0.1 });
    const data: TrainEvalDatum[] = [
      { profile: p, observedJudge: 0.4 },
      { profile: p, observedJudge: 0.5 },
    ];
    const r = pickBestEstimator(data);
    expect(r.chosen.name).not.toBe('judgeMean');
  });

  it('empty data → MAE=0', () => {
    const r = evaluateEstimator(judgeMeanEstimator, []);
    expect(r.meanAbsoluteError).toBe(0);
    expect(r.sampleCount).toBe(0);
  });
});
