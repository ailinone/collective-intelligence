// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-expected-judge-estimator.test.ts — MVP 8B.7
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_ENSEMBLE_ESTIMATORS,
  additiveCurrentEstimator,
  cappedAdditiveEstimator,
  conservativeParallelEstimator,
  evaluateEnsembleEstimator,
  learnEmpiricalCalibration,
  lowerBoundEnsembleEstimator,
  makeEmpiricalEnsembleEstimator,
  multiplicativeBoundedEstimator,
  pairAwareDirectEstimator,
  pickBestEnsembleEstimator,
  weightedAnchorSupportEstimator,
} from '../ensemble-expected-judge-estimator';
import type {
  EnsembleCalibrationExample,
  EnsembleEstimateInput,
} from '../ensemble-calibration-types';

function input(
  overrides: Partial<EnsembleEstimateInput> & {
    members: { judgeMean: number; judgeMedian?: number; judgeP80?: number; judgeStdDev?: number }[];
  },
): EnsembleEstimateInput {
  return {
    members: [],
    memberProfiles: overrides.members.map((m, i) => ({
      modelId: `m${i}`,
      judgeMean: m.judgeMean,
      judgeMedian: m.judgeMedian ?? m.judgeMean,
      judgeP80: m.judgeP80 ?? m.judgeMean,
      judgeStdDev: m.judgeStdDev,
    })),
    peerLift: overrides.peerLift ?? 0.04,
    uncertaintyPenaltyWeight: overrides.uncertaintyPenaltyWeight ?? 0.5,
    singleBaselineJudge: overrides.singleBaselineJudge ?? 0.5,
    pairProfile: overrides.pairProfile,
  };
}

describe('additive_current', () => {
  it('= anchor + Σ peer_lift (no cap, no uncertainty)', () => {
    const e = additiveCurrentEstimator.estimate(
      input({ members: [{ judgeMean: 0.7 }, { judgeMean: 0.5 }], peerLift: 0.1 }),
    );
    expect(e.expectedJudge).toBeCloseTo(0.7 + 0.1, 6);
  });
});

describe('multiplicative_bounded', () => {
  it('= anchor * (1 + min(maxLift, Σ peer_lift)), bounded', () => {
    const e = multiplicativeBoundedEstimator.estimate(
      input({ members: [{ judgeMean: 0.7 }, { judgeMean: 0.5 }], peerLift: 0.1 }),
    );
    // anchor=0.7, 1 extra * 0.1 = 0.1 lift, total 0.1
    expect(e.expectedJudge).toBeCloseTo(0.7 * 1.1, 6);
  });

  it('caps lift at 0.20', () => {
    const e = multiplicativeBoundedEstimator.estimate(
      input({
        members: [
          { judgeMean: 0.7 },
          { judgeMean: 0.5 },
          { judgeMean: 0.5 },
          { judgeMean: 0.5 },
        ],
        peerLift: 0.5,
      }),
    );
    // 3 extras × 0.5 = 1.5, capped to 0.20.
    expect(e.expectedJudge).toBeCloseTo(0.7 * 1.2, 6);
  });

  it('applies uncertainty penalty when stdDev present', () => {
    const e = multiplicativeBoundedEstimator.estimate(
      input({
        members: [{ judgeMean: 0.7, judgeStdDev: 0.2 }, { judgeMean: 0.5, judgeStdDev: 0.2 }],
        peerLift: 0,
        uncertaintyPenaltyWeight: 0.5,
      }),
    );
    expect(e.uncertainty).toBeGreaterThan(0);
    expect(e.lowerBound).toBeLessThan(e.expectedJudge);
  });
});

describe('capped_additive', () => {
  it('caps per-model and total gains', () => {
    const e = cappedAdditiveEstimator.estimate(
      input({
        members: [
          { judgeMean: 0.6 },
          { judgeMean: 0.5 },
          { judgeMean: 0.5 },
          { judgeMean: 0.5 },
        ],
        peerLift: 0.3,
      }),
    );
    // per-model cap 0.06 × 3 extras = 0.18, total cap 0.18 → +0.18
    expect(e.expectedJudge).toBeCloseTo(0.6 + 0.18, 6);
  });
});

describe('weighted_anchor_support', () => {
  it('= 0.7*anchor + 0.25*support + 0.05*pairBonus - uncertainty', () => {
    const e = weightedAnchorSupportEstimator.estimate(
      input({
        members: [{ judgeMean: 0.8 }, { judgeMean: 0.6 }],
        pairProfile: {
          modelA: 'a',
          modelB: 'b',
          complementarityScore: 0.5,
        },
        uncertaintyPenaltyWeight: 0,
      }),
    );
    // 0.7*0.8 + 0.25*0.6 + 0.05*0.5 = 0.56 + 0.15 + 0.025 = 0.735
    expect(e.expectedJudge).toBeCloseTo(0.735, 4);
  });
});

describe('pair_aware_direct', () => {
  it('blends anchor with pair.judgeMean by paretoWinRate', () => {
    const e = pairAwareDirectEstimator.estimate(
      input({
        members: [{ judgeMean: 0.8 }, { judgeMean: 0.5 }],
        pairProfile: {
          modelA: 'a',
          modelB: 'b',
          judgeMean: 0.9,
          paretoWinRate: 0.5,
        },
      }),
    );
    expect(e.expectedJudge).toBeCloseTo(0.5 * 0.8 + 0.5 * 0.9, 4);
  });

  it('falls back to anchor + peer_lift when pair profile absent', () => {
    const e = pairAwareDirectEstimator.estimate(
      input({ members: [{ judgeMean: 0.7 }, { judgeMean: 0.5 }], peerLift: 0.1 }),
    );
    expect(e.expectedJudge).toBeCloseTo(0.8, 4);
  });
});

describe('lower_bound_ensemble', () => {
  it('subtracts uncertainty + fixed penalty', () => {
    const e = lowerBoundEnsembleEstimator.estimate(
      input({
        members: [{ judgeMean: 0.7, judgeStdDev: 0.2 }, { judgeMean: 0.5 }],
        peerLift: 0.1,
        uncertaintyPenaltyWeight: 0.5,
      }),
    );
    expect(e.expectedJudge).toBeLessThan(0.7);
    expect(e.uncertainty).toBeGreaterThan(0);
  });
});

describe('conservative_parallel', () => {
  it('= max(anchor, weightedSupport) + lift * 0.75', () => {
    const e = conservativeParallelEstimator.estimate(
      input({ members: [{ judgeMean: 0.8 }, { judgeMean: 0.6 }], peerLift: 0.1 }),
    );
    const base = Math.max(0.8, 0.7 * 0.8 + 0.3 * 0.6);
    expect(e.expectedJudge).toBeCloseTo(base + 0.075, 4);
  });
});

describe('empirical_ensemble_calibrated', () => {
  it('applies offset + scale', () => {
    const cal = { offset: 0.1, scale: 0.8 };
    const est = makeEmpiricalEnsembleEstimator(cal);
    const e = est.estimate(
      input({ members: [{ judgeMean: 0.7 }, { judgeMean: 0.5 }], peerLift: 0.1 }),
    );
    // raw = 0.7 + 1*0.1 = 0.8; scaled = 0.8*0.8 + 0.1 = 0.74
    expect(e.expectedJudge).toBeCloseTo(0.74, 4);
  });

  it('learns from training examples', () => {
    const examples: EnsembleCalibrationExample[] = Array.from(
      { length: 10 },
      (_, i) => ({
        executionId: `e${i}`,
        experimentId: 'exp',
        taskId: 't',
        taskType: 'code',
        strategyId: 'parallel',
        effectiveStrategyId: 'parallel',
        selectedModelIds: ['a', 'b'],
        observedJudge: 0.5 + 0.05 * i,
        observedCostUsd: 0.01,
        singleBaselineJudge: 0.5,
        singleBaselineCostUsd: 0.02,
        modelProfileJudges: [
          { modelId: 'a', judgeMean: 0.5 + 0.05 * i, judgeMedian: 0.5, judgeP80: 0.5 },
          { modelId: 'b', judgeMean: 0.4, judgeMedian: 0.4, judgeP80: 0.4 },
        ],
      }),
    );
    const cal = learnEmpiricalCalibration(examples, () => 0);
    expect(Number.isFinite(cal.offset)).toBe(true);
    expect(Number.isFinite(cal.scale)).toBe(true);
  });
});

describe('evaluateEnsembleEstimator', () => {
  it('returns MAE / median / p80 / nonFallback', () => {
    const data: EnsembleCalibrationExample[] = [
      {
        executionId: 'e1',
        experimentId: 'exp',
        taskId: 't',
        taskType: 'code',
        strategyId: 'parallel',
        effectiveStrategyId: 'parallel',
        selectedModelIds: ['a', 'b'],
        observedJudge: 0.8,
        observedCostUsd: 0.01,
        singleBaselineJudge: 0.5,
        singleBaselineCostUsd: 0.02,
        modelProfileJudges: [
          { modelId: 'a', judgeMean: 0.7, judgeMedian: 0.7, judgeP80: 0.7 },
          { modelId: 'b', judgeMean: 0.5, judgeMedian: 0.5, judgeP80: 0.5 },
        ],
      },
    ];
    const ev = evaluateEnsembleEstimator({
      estimator: additiveCurrentEstimator,
      examples: data,
      peerLiftLookup: () => 0.1,
      uncertaintyPenaltyWeight: 0,
    });
    expect(ev.sampleCount).toBe(1);
    expect(ev.meanAbsoluteError).toBeCloseTo(0.0, 4);
  });
});

describe('pickBestEnsembleEstimator', () => {
  it('picks lowest composite (MAE + 0.3*(1-nonFallbackRate))', () => {
    const data: EnsembleCalibrationExample[] = [];
    for (let i = 0; i < 10; i += 1) {
      data.push({
        executionId: `e${i}`,
        experimentId: 'exp',
        taskId: 't',
        taskType: 'code',
        strategyId: 'parallel',
        effectiveStrategyId: 'parallel',
        selectedModelIds: ['a', 'b'],
        observedJudge: 0.85,
        observedCostUsd: 0.01,
        singleBaselineJudge: 0.5,
        singleBaselineCostUsd: 0.02,
        modelProfileJudges: [
          { modelId: 'a', judgeMean: 0.7, judgeMedian: 0.7, judgeP80: 0.7 },
          { modelId: 'b', judgeMean: 0.5, judgeMedian: 0.5, judgeP80: 0.5 },
        ],
      });
    }
    const r = pickBestEnsembleEstimator({
      examples: data,
      peerLiftLookup: () => 0.1,
      uncertaintyPenaltyWeight: 0,
    });
    expect(r.chosen.name).toBeTruthy();
    expect(r.evaluations.length).toBe(ALL_ENSEMBLE_ESTIMATORS.length);
  });
});
