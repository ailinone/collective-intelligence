// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * marginal-gain-calibrator.test.ts — MVP 8B.7
 */

import { describe, expect, it } from 'vitest';
import {
  calibrateMarginalGain,
  DEFAULT_MARGINAL_GAIN_POLICY,
  resolveMarginalGainPolicy,
} from '../marginal-gain-calibrator';
import { calibratePeerLift } from '../peer-lift-calibrator';
import {
  multiplicativeBoundedEstimator,
} from '../ensemble-expected-judge-estimator';
import type { EnsembleCalibrationExample } from '../ensemble-calibration-types';

function example(members: { judgeMean: number }[], observed: number): EnsembleCalibrationExample {
  return Object.freeze({
    executionId: `e-${Math.random().toString(36).slice(2)}`,
    experimentId: 'exp',
    taskId: 't',
    taskType: 'code',
    strategyId: 'parallel',
    effectiveStrategyId: 'parallel',
    selectedModelIds: members.map((_, i) => `m${i}`),
    observedJudge: observed,
    observedCostUsd: 0.01,
    singleBaselineJudge: 0.5,
    singleBaselineCostUsd: 0.02,
    modelProfileJudges: members.map((m, i) => ({
      modelId: `m${i}`,
      judgeMean: m.judgeMean,
      judgeMedian: m.judgeMean,
      judgeP80: m.judgeMean,
    })),
  });
}

describe('resolveMarginalGainPolicy', () => {
  it('returns defaults when no override', () => {
    const p = resolveMarginalGainPolicy();
    expect(p).toBe(DEFAULT_MARGINAL_GAIN_POLICY);
  });

  it('merges override on top of defaults', () => {
    const p = resolveMarginalGainPolicy({ maxTotalGain: 0.5 });
    expect(p.maxTotalGain).toBe(0.5);
    expect(p.maxPerModelGain).toBe(DEFAULT_MARGINAL_GAIN_POLICY.maxPerModelGain);
  });
});

describe('calibrateMarginalGain', () => {
  it('runs grid search over the policy space', () => {
    const examples: EnsembleCalibrationExample[] = [];
    for (let i = 0; i < 5; i += 1) {
      examples.push(example([{ judgeMean: 0.5 }, { judgeMean: 0.4 }], 0.55));
    }
    const peerLift = calibratePeerLift({ trainExamples: examples });
    const r = calibrateMarginalGain({
      trainExamples: examples,
      peerLift,
      estimator: multiplicativeBoundedEstimator,
    });
    expect(r.evaluations.length).toBe(4 * 3 * 3); // 4*3*3 grid
    expect(r.chosenPolicy.maxTotalGain).toBeGreaterThan(0);
  });

  it('picks the lowest MAE policy', () => {
    const examples: EnsembleCalibrationExample[] = [];
    for (let i = 0; i < 8; i += 1) {
      examples.push(example([{ judgeMean: 0.5 }, { judgeMean: 0.5 }], 0.5));
    }
    const peerLift = calibratePeerLift({ trainExamples: examples });
    const r = calibrateMarginalGain({
      trainExamples: examples,
      peerLift,
      estimator: multiplicativeBoundedEstimator,
    });
    // The lowest MAE policy must be at the top of evaluations.
    for (const ev of r.evaluations) {
      expect(ev.meanAbsoluteError).toBeGreaterThanOrEqual(
        r.chosenEvaluation.meanAbsoluteError,
      );
    }
  });

  it('output is frozen', () => {
    const examples = [example([{ judgeMean: 0.5 }, { judgeMean: 0.5 }], 0.5)];
    const peerLift = calibratePeerLift({ trainExamples: examples });
    const r = calibrateMarginalGain({
      trainExamples: examples,
      peerLift,
      estimator: multiplicativeBoundedEstimator,
    });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.chosenPolicy)).toBe(true);
  });
});
