// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-calibrated-optimizer.test.ts — MVP 8B.7
 */

import { describe, expect, it } from 'vitest';
import { optimizeEnsembleCalibrated } from '../ensemble-calibrated-optimizer';
import {
  multiplicativeBoundedEstimator,
} from '../ensemble-expected-judge-estimator';
import { DEFAULT_ENSEMBLE_LIFT_POLICY } from '../ensemble-lift-policy';
import { calibratePeerLift } from '../peer-lift-calibrator';
import type { ContributionAwareScore } from '../../../contribution/contribution-aware-candidate-scorer';

function score(
  routeId: string,
  modelId: string,
  expectedJudge: number,
  cost: number,
  role: 'anchor' | 'support' | 'budget_support' = 'anchor',
): ContributionAwareScore {
  return Object.freeze({
    routeId,
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
    recommendedRole: role,
    rejected: false,
    rejectionReasons: Object.freeze([]),
    explanation: 'ok',
    estimatedCostUsd: cost,
    expectedJudge,
  });
}

const baseline = Object.freeze({
  singleModelJudge: 0.6,
  singleModelCostUsd: 0.02,
});

const peerLift = calibratePeerLift({ trainExamples: [] });

describe('optimizeEnsembleCalibrated — happy path', () => {
  it('forms an ensemble when judge >= baseline and cost <= ceiling', () => {
    const r = optimizeEnsembleCalibrated({
      candidates: [
        score('r1', 'm1', 0.8, 0.005),
        score('r2', 'm2', 0.75, 0.005),
      ],
      baseline,
      taskType: 'code',
      peerLiftCalibration: peerLift,
      liftPolicy: DEFAULT_ENSEMBLE_LIFT_POLICY,
      estimator: multiplicativeBoundedEstimator,
    });
    expect(r.ensemblePlan.strategyId).toBe('parallel');
    expect(r.ensemblePlan.selectedModelIds.length).toBeGreaterThanOrEqual(2);
    expect(r.ensemblePlan.expectedCostUsd).toBeLessThanOrEqual(baseline.singleModelCostUsd);
  });

  it('falls back to single when judge would be below baseline', () => {
    const r = optimizeEnsembleCalibrated({
      candidates: [
        score('r1', 'm1', 0.3, 0.005),
        score('r2', 'm2', 0.25, 0.005),
      ],
      baseline,
      taskType: 'code',
      peerLiftCalibration: peerLift,
      liftPolicy: DEFAULT_ENSEMBLE_LIFT_POLICY,
      estimator: multiplicativeBoundedEstimator,
    });
    expect(r.ensemblePlan.strategyId).toBe('single_fallback');
    expect(r.fallbackReason).toBeTruthy();
  });

  it('does NOT stack unbounded gains', () => {
    const candidates: ContributionAwareScore[] = [];
    for (let i = 0; i < 10; i += 1) candidates.push(score(`r${i}`, `m${i}`, 0.7, 0.001));
    const r = optimizeEnsembleCalibrated({
      candidates,
      baseline,
      taskType: 'code',
      peerLiftCalibration: peerLift,
      liftPolicy: DEFAULT_ENSEMBLE_LIFT_POLICY,
      estimator: multiplicativeBoundedEstimator,
    });
    // Even with 10 candidates available, only members up to maxModels=3
    // can be added.
    expect(r.ensemblePlan.selectedModelIds.length).toBeLessThanOrEqual(3);
  });

  it('falls back when cost ceiling would be exceeded', () => {
    const r = optimizeEnsembleCalibrated({
      candidates: [
        score('r1', 'm1', 0.8, 0.02),
        score('r2', 'm2', 0.7, 0.02),
        score('r3', 'm3', 0.7, 0.02),
      ],
      baseline,
      taskType: 'code',
      peerLiftCalibration: peerLift,
      liftPolicy: DEFAULT_ENSEMBLE_LIFT_POLICY,
      estimator: multiplicativeBoundedEstimator,
    });
    // First candidate alone hits cost=0.02 = baseline; adding any second pushes over.
    expect(r.ensemblePlan.strategyId).toBe('single_fallback');
  });

  it('respects all-rejected input', () => {
    const cand: ContributionAwareScore = {
      ...score('r1', 'm1', 0.8, 0.005),
      rejected: true,
      rejectionReasons: Object.freeze(['modality_mismatch']),
    };
    const r = optimizeEnsembleCalibrated({
      candidates: [cand],
      baseline,
      taskType: 'code',
      peerLiftCalibration: peerLift,
      liftPolicy: DEFAULT_ENSEMBLE_LIFT_POLICY,
      estimator: multiplicativeBoundedEstimator,
    });
    expect(r.ensemblePlan.strategyId).toBe('single_fallback');
    expect(r.fallbackReason).toBeTruthy();
  });

  it('output is frozen', () => {
    const r = optimizeEnsembleCalibrated({
      candidates: [score('r1', 'm1', 0.8, 0.005), score('r2', 'm2', 0.75, 0.005)],
      baseline,
      taskType: 'code',
      peerLiftCalibration: peerLift,
      liftPolicy: DEFAULT_ENSEMBLE_LIFT_POLICY,
      estimator: multiplicativeBoundedEstimator,
    });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.ensemblePlan)).toBe(true);
  });
});

describe('optimizeEnsembleCalibrated — paretoStatus', () => {
  it('beats_baseline when judge >= and cost <= baseline', () => {
    const r = optimizeEnsembleCalibrated({
      candidates: [
        score('r1', 'm1', 0.8, 0.005),
        score('r2', 'm2', 0.75, 0.005),
      ],
      baseline,
      taskType: 'code',
      peerLiftCalibration: peerLift,
      liftPolicy: DEFAULT_ENSEMBLE_LIFT_POLICY,
      estimator: multiplicativeBoundedEstimator,
    });
    expect(r.ensemblePlan.paretoStatus).toBe('beats_baseline');
  });
});
