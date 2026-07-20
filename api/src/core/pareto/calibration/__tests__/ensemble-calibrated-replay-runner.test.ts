// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-calibrated-replay-runner.test.ts — MVP 8B.7
 *
 * Smoke test for the full ensemble-calibrated pipeline: peer-lift +
 * estimator pick + calibrated optimizer.
 */

import { describe, expect, it } from 'vitest';
import { calibratePeerLift } from '../peer-lift-calibrator';
import { pickBestEnsembleEstimator } from '../ensemble-expected-judge-estimator';
import { optimizeEnsembleCalibrated } from '../ensemble-calibrated-optimizer';
import { resolveEnsembleLiftPolicy } from '../ensemble-lift-policy';
import type { EnsembleCalibrationExample } from '../ensemble-calibration-types';
import type { ContributionAwareScore } from '../../../contribution/contribution-aware-candidate-scorer';

function ex(observed: number, taskType = 'code'): EnsembleCalibrationExample {
  return Object.freeze({
    executionId: `e-${observed}-${Math.random()}`,
    experimentId: 'exp',
    taskId: 't',
    taskType,
    strategyId: 'parallel',
    effectiveStrategyId: 'parallel',
    selectedModelIds: ['a', 'b'],
    observedJudge: observed,
    observedCostUsd: 0.008,
    singleBaselineJudge: 0.5,
    singleBaselineCostUsd: 0.02,
    modelProfileJudges: [
      { modelId: 'a', judgeMean: 0.55, judgeMedian: 0.55, judgeP80: 0.55 },
      { modelId: 'b', judgeMean: 0.45, judgeMedian: 0.45, judgeP80: 0.45 },
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

describe('ensemble-calibrated replay runner — smoke', () => {
  it('end-to-end: train calibrate → apply on candidate set', () => {
    const trainExamples: EnsembleCalibrationExample[] = [];
    for (let i = 0; i < 20; i += 1) trainExamples.push(ex(0.6 + i * 0.005));

    const peerLift = calibratePeerLift({ trainExamples });
    expect(peerLift).toBeDefined();

    const selection = pickBestEnsembleEstimator({
      examples: trainExamples,
      peerLiftLookup: () => peerLift.globalPeerLift,
      uncertaintyPenaltyWeight: 0.5,
    });
    expect(selection.chosen).toBeDefined();

    const result = optimizeEnsembleCalibrated({
      candidates: [
        score('m1', 0.7, 0.005),
        score('m2', 0.65, 0.005),
      ],
      baseline: { singleModelJudge: 0.55, singleModelCostUsd: 0.02 },
      taskType: 'code',
      peerLiftCalibration: peerLift,
      liftPolicy: resolveEnsembleLiftPolicy({ estimatorName: selection.chosen.name }),
      estimator: selection.chosen,
    });
    expect(result.ensemblePlan).toBeDefined();
    expect(['parallel', 'single_fallback']).toContain(result.ensemblePlan.strategyId);
  });

  it('does not crash on empty train', () => {
    const peerLift = calibratePeerLift({ trainExamples: [] });
    const selection = pickBestEnsembleEstimator({
      examples: [],
      peerLiftLookup: () => 0,
      uncertaintyPenaltyWeight: 0.5,
    });
    expect(selection.chosen).toBeDefined();
    const result = optimizeEnsembleCalibrated({
      candidates: [score('m1', 0.7, 0.005)],
      baseline: { singleModelJudge: 0.5, singleModelCostUsd: 0.02 },
      taskType: 'code',
      peerLiftCalibration: peerLift,
      liftPolicy: resolveEnsembleLiftPolicy(),
      estimator: selection.chosen,
    });
    // With a single candidate, falls back to single.
    expect(result.ensemblePlan.strategyId).toBe('single_fallback');
  });
});
