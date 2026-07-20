// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * calibrated-estimator.test.ts — MVP 8B.6
 */

import { describe, expect, it } from 'vitest';
import {
  computeGlobalMean,
  estimateCalibratedJudge,
  learnTaskTypeOffsets,
} from '../calibration/calibrated-expected-judge-estimator';
import {
  judgeMeanEstimator,
  variancePenalizedMeanEstimator,
  type TrainEvalDatum,
} from '../calibration/expected-judge-calibrator';
import type { ModelTaskPerformanceProfile } from '../../contribution/model-task-performance-profile';

function p(
  overrides: Partial<ModelTaskPerformanceProfile> & { modelId: string; taskType: string },
): ModelTaskPerformanceProfile {
  return Object.freeze({
    modelId: overrides.modelId,
    taskType: overrides.taskType,
    sampleCount: 10,
    judgeMean: 0.7,
    judgeMedian: 0.7,
    judgeP80: 0.8,
    judgeStdDev: 0.1,
    judgeVariance: 0.01,
    winRate: 0.5,
    lossRate: 0.1,
    zeroRate: 0,
    harmRate: 0.05,
    costMean: 0.02,
    costP95: 0.03,
    qualityPerDollar: 35,
    contributionScore: 0.6,
    harmScore: 0.05,
    confidence: 0.9,
    calibrationConfidence: 0.8,
    sampleWeight: 10 / 15,
    recommendedRole: 'anchor',
    ...overrides,
  });
}

describe('learnTaskTypeOffsets', () => {
  it('returns mean(observed − predicted) per task type', () => {
    const data: TrainEvalDatum[] = [
      { profile: p({ modelId: 'a', taskType: 'code', judgeMean: 0.9 }), observedJudge: 0.5 },
      { profile: p({ modelId: 'b', taskType: 'code', judgeMean: 0.8 }), observedJudge: 0.6 },
      { profile: p({ modelId: 'c', taskType: 'reasoning', judgeMean: 0.7 }), observedJudge: 0.7 },
    ];
    const offsets = learnTaskTypeOffsets(data);
    // code: avg(0.5-0.9, 0.6-0.8) = avg(-0.4, -0.2) = -0.3
    expect(offsets.get('code')).toBeCloseTo(-0.3, 6);
    // reasoning: avg(0.7-0.7) = 0
    expect(offsets.get('reasoning')).toBe(0);
  });

  it('handles empty data', () => {
    const offsets = learnTaskTypeOffsets([]);
    expect(offsets.size).toBe(0);
  });
});

describe('computeGlobalMean', () => {
  it('returns mean of observedJudge', () => {
    const data: TrainEvalDatum[] = [
      { profile: p({ modelId: 'a', taskType: 'code' }), observedJudge: 0.5 },
      { profile: p({ modelId: 'b', taskType: 'code' }), observedJudge: 0.9 },
    ];
    expect(computeGlobalMean(data)).toBe(0.7);
  });

  it('returns 0.5 prior on empty data', () => {
    expect(computeGlobalMean([])).toBe(0.5);
  });
});

describe('estimateCalibratedJudge', () => {
  it('applies the chosen estimator with the right context', () => {
    const offsetMap = new Map<string, number>([['code', -0.2]]);
    const profile = p({ modelId: 'a', taskType: 'code', judgeMean: 0.8 });
    const ctx = {
      estimator: judgeMeanEstimator,
      taskTypeOffsetMap: offsetMap,
      globalMean: 0.5,
    };
    // judgeMeanEstimator ignores offset; returns 0.8.
    expect(estimateCalibratedJudge(ctx, profile)).toBe(0.8);
  });

  it('variancePenalized + offset combine as expected', () => {
    const offsetMap = new Map<string, number>([['code', 0.0]]);
    const profile = p({ modelId: 'a', taskType: 'code', judgeMean: 0.8, judgeStdDev: 0.2 });
    const ctx = {
      estimator: variancePenalizedMeanEstimator,
      taskTypeOffsetMap: offsetMap,
      globalMean: 0.5,
    };
    // variancePenalizedMean = 0.8 - 0.5*0.2 = 0.7
    expect(estimateCalibratedJudge(ctx, profile)).toBeCloseTo(0.7, 6);
  });
});
