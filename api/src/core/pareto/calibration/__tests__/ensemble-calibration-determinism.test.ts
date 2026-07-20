// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-calibration-determinism.test.ts — MVP 8B.7
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { calibratePeerLift } from '../peer-lift-calibrator';
import {
  evaluateEnsembleEstimator,
  multiplicativeBoundedEstimator,
  pickBestEnsembleEstimator,
} from '../ensemble-expected-judge-estimator';
import { optimizeEnsembleCalibrated } from '../ensemble-calibrated-optimizer';
import { DEFAULT_ENSEMBLE_LIFT_POLICY } from '../ensemble-lift-policy';
import type { EnsembleCalibrationExample } from '../ensemble-calibration-types';
import type { ContributionAwareScore } from '../../../contribution/contribution-aware-candidate-scorer';

afterEach(() => vi.restoreAllMocks());

function ex(observed: number): EnsembleCalibrationExample {
  return Object.freeze({
    executionId: `e-${observed}`,
    experimentId: 'exp',
    taskId: 't',
    taskType: 'code',
    strategyId: 'parallel',
    effectiveStrategyId: 'parallel',
    selectedModelIds: ['a', 'b'],
    observedJudge: observed,
    observedCostUsd: 0.01,
    singleBaselineJudge: 0.5,
    singleBaselineCostUsd: 0.02,
    modelProfileJudges: [
      { modelId: 'a', judgeMean: 0.6, judgeMedian: 0.6, judgeP80: 0.6 },
      { modelId: 'b', judgeMean: 0.4, judgeMedian: 0.4, judgeP80: 0.4 },
    ],
  });
}

function score(modelId: string, expectedJudge: number, cost: number): ContributionAwareScore {
  return Object.freeze({
    routeId: `r::${modelId}`,
    modelId,
    totalScore: expectedJudge,
    breakdown: Object.freeze({
      structuralScore: expectedJudge,
      contributionScore: expectedJudge,
      qualityPerDollarScore: 0.5,
      taskTypeFit: 1,
      modalityFit: 1,
      harmPenalty: 0,
      costPenalty: -0.1,
      confidencePenalty: -0.05,
    }),
    recommendedRole: 'anchor' as const,
    rejected: false,
    rejectionReasons: Object.freeze([]),
    explanation: 'ok',
    estimatedCostUsd: cost,
    expectedJudge,
  });
}

describe('ensemble calibration — determinism', () => {
  it('calibratePeerLift is deterministic over 100 runs', () => {
    const examples = [ex(0.6), ex(0.65), ex(0.7)];
    const a = JSON.stringify(calibratePeerLift({ trainExamples: examples }));
    for (let i = 0; i < 100; i += 1) {
      expect(JSON.stringify(calibratePeerLift({ trainExamples: examples }))).toBe(a);
    }
  });

  it('pickBestEnsembleEstimator is deterministic', () => {
    const examples = [ex(0.6), ex(0.7), ex(0.8)];
    const a = JSON.stringify(
      pickBestEnsembleEstimator({
        examples,
        peerLiftLookup: () => 0.05,
        uncertaintyPenaltyWeight: 0.5,
      }),
    );
    for (let i = 0; i < 50; i += 1) {
      expect(
        JSON.stringify(
          pickBestEnsembleEstimator({
            examples,
            peerLiftLookup: () => 0.05,
            uncertaintyPenaltyWeight: 0.5,
          }),
        ),
      ).toBe(a);
    }
  });

  it('optimizeEnsembleCalibrated is deterministic', () => {
    const peerLift = calibratePeerLift({ trainExamples: [ex(0.7)] });
    const args = {
      candidates: [score('m1', 0.8, 0.005), score('m2', 0.75, 0.005)],
      baseline: { singleModelJudge: 0.6, singleModelCostUsd: 0.02 },
      taskType: 'code',
      peerLiftCalibration: peerLift,
      liftPolicy: DEFAULT_ENSEMBLE_LIFT_POLICY,
      estimator: multiplicativeBoundedEstimator,
    };
    const a = JSON.stringify(optimizeEnsembleCalibrated(args));
    for (let i = 0; i < 100; i += 1) {
      expect(JSON.stringify(optimizeEnsembleCalibrated(args))).toBe(a);
    }
  });

  it('does not call Date.now or Math.random', () => {
    const dateSpy = vi.spyOn(Date, 'now');
    const randSpy = vi.spyOn(Math, 'random');
    const examples = [ex(0.6), ex(0.7)];
    calibratePeerLift({ trainExamples: examples });
    evaluateEnsembleEstimator({
      estimator: multiplicativeBoundedEstimator,
      examples,
      peerLiftLookup: () => 0.05,
      uncertaintyPenaltyWeight: 0.5,
    });
    expect(dateSpy).not.toHaveBeenCalled();
    expect(randSpy).not.toHaveBeenCalled();
  });
});
