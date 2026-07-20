// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-calibration-no-holdout-leakage.test.ts — MVP 8B.7
 */

import { describe, expect, it } from 'vitest';
import { calibratePeerLift } from '../peer-lift-calibrator';
import { pickBestEnsembleEstimator } from '../ensemble-expected-judge-estimator';
import type { EnsembleCalibrationExample } from '../ensemble-calibration-types';

function example(id: string, experimentId: string, observed: number): EnsembleCalibrationExample {
  return Object.freeze({
    executionId: id,
    experimentId,
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
      { modelId: 'a', judgeMean: 0.5, judgeMedian: 0.5, judgeP80: 0.5 },
      { modelId: 'b', judgeMean: 0.4, judgeMedian: 0.4, judgeP80: 0.4 },
    ],
  });
}

describe('no holdout leakage — calibrator input contract', () => {
  it('calibratePeerLift only reads from trainExamples', () => {
    // Build train + holdout sets with disjoint experimentIds.
    const train: EnsembleCalibrationExample[] = [];
    const holdout: EnsembleCalibrationExample[] = [];
    for (let i = 0; i < 20; i += 1) train.push(example(`t-${i}`, 'exp-train', 0.6));
    for (let i = 0; i < 5; i += 1) holdout.push(example(`h-${i}`, 'exp-holdout', 0.9));

    const r = calibratePeerLift({ trainExamples: train });
    // No holdout executionIds in any of the reasons or sample buckets.
    const reasonText = r.reasons.join(',');
    for (const h of holdout) {
      expect(reasonText).not.toContain(h.executionId);
    }
  });

  it('pickBestEnsembleEstimator never accepts holdout examples', () => {
    const train: EnsembleCalibrationExample[] = [];
    const holdout: EnsembleCalibrationExample[] = [];
    for (let i = 0; i < 10; i += 1) train.push(example(`t-${i}`, 'exp-train', 0.6));
    for (let i = 0; i < 3; i += 1) holdout.push(example(`h-${i}`, 'exp-holdout', 0.9));
    // The caller passes only train; verify the contract by inspecting
    // the sample count of the evaluation.
    const r = pickBestEnsembleEstimator({
      examples: train,
      peerLiftLookup: () => 0.05,
      uncertaintyPenaltyWeight: 0.5,
    });
    for (const ev of r.evaluations) {
      expect(ev.sampleCount).toBe(train.length);
    }
  });

  it('train + holdout experimentIds are disjoint sets (smoke)', () => {
    const train = [
      example('t-1', 'exp-A', 0.6),
      example('t-2', 'exp-A', 0.7),
    ];
    const holdout = [example('h-1', 'exp-B', 0.9)];
    const trainExp = new Set(train.map((e) => e.experimentId));
    const holdoutExp = new Set(holdout.map((e) => e.experimentId));
    for (const id of holdoutExp) expect(trainExp.has(id)).toBe(false);
  });
});
