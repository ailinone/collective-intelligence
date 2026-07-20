// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * peer-lift-calibrator.test.ts — MVP 8B.7
 */

import { describe, expect, it } from 'vitest';
import {
  calibratePeerLift,
  lookupPeerLift,
} from '../peer-lift-calibrator';
import type { EnsembleCalibrationExample } from '../ensemble-calibration-types';

function example(
  overrides: Partial<EnsembleCalibrationExample> & {
    members: readonly { modelId: string; judgeMean: number }[];
    observedJudge: number;
    taskType?: string;
    strategy?: string;
  },
): EnsembleCalibrationExample {
  return Object.freeze({
    executionId: `e-${Math.random().toString(36).slice(2)}`,
    experimentId: 'exp1',
    taskId: 't1',
    taskType: overrides.taskType ?? 'code',
    strategyId: overrides.strategy ?? 'parallel',
    effectiveStrategyId: overrides.strategy ?? 'parallel',
    selectedModelIds: overrides.members.map((m) => m.modelId),
    observedJudge: overrides.observedJudge,
    observedCostUsd: 0.01,
    singleBaselineJudge: 0.5,
    singleBaselineCostUsd: 0.02,
    modelProfileJudges: overrides.members.map((m) => ({
      modelId: m.modelId,
      judgeMean: m.judgeMean,
      judgeMedian: m.judgeMean,
      judgeP80: m.judgeMean,
    })),
  });
}

describe('calibratePeerLift', () => {
  it('returns 0 lift when ensemble judge matches best member judge', () => {
    const data = [
      example({
        members: [{ modelId: 'a', judgeMean: 0.7 }, { modelId: 'b', judgeMean: 0.5 }],
        observedJudge: 0.7,
      }),
      example({
        members: [{ modelId: 'a', judgeMean: 0.7 }, { modelId: 'b', judgeMean: 0.5 }],
        observedJudge: 0.7,
      }),
    ];
    const r = calibratePeerLift({ trainExamples: data, minSamples: 1 });
    // Per-task shrinkage with k=8 and n=2 ⇒ shrunk toward global.
    // localMean = 0, globalMean = 0 → still 0.
    expect(r.peerLiftByTaskType.code).toBe(0);
  });

  it('returns positive lift when ensemble judge exceeds best individual', () => {
    const data = [
      example({
        members: [{ modelId: 'a', judgeMean: 0.7 }, { modelId: 'b', judgeMean: 0.5 }],
        observedJudge: 0.9,
      }),
      example({
        members: [{ modelId: 'a', judgeMean: 0.7 }, { modelId: 'b', judgeMean: 0.5 }],
        observedJudge: 0.85,
      }),
    ];
    const r = calibratePeerLift({ trainExamples: data, minSamples: 1, shrinkageK: 1 });
    expect(r.globalPeerLift).toBeGreaterThan(0);
    expect(r.peerLiftByTaskType.code).toBeGreaterThan(0);
  });

  it('applies shrinkage toward global when sample size is small', () => {
    const data: EnsembleCalibrationExample[] = [];
    // 50 examples of 'code' with lift = 0.1
    for (let i = 0; i < 50; i += 1) {
      data.push(
        example({
          taskType: 'code',
          members: [{ modelId: 'a', judgeMean: 0.5 }, { modelId: 'b', judgeMean: 0.5 }],
          observedJudge: 0.6,
        }),
      );
    }
    // 1 example of 'analysis' with extreme lift = 0.4 (outlier)
    data.push(
      example({
        taskType: 'analysis',
        members: [{ modelId: 'a', judgeMean: 0.5 }, { modelId: 'b', judgeMean: 0.5 }],
        observedJudge: 0.9,
      }),
    );
    const r = calibratePeerLift({ trainExamples: data, shrinkageK: 8 });
    // analysis should be shrunk toward global mean (0.1ish), not 0.4.
    expect(r.peerLiftByTaskType.analysis).toBeLessThan(0.35);
    expect(r.peerLiftByTaskType.analysis).toBeGreaterThan(0);
  });

  it('only counts ensembles with judge', () => {
    const data: EnsembleCalibrationExample[] = [];
    // 5 ensemble rows.
    for (let i = 0; i < 5; i += 1) {
      data.push(
        example({
          members: [{ modelId: 'a', judgeMean: 0.5 }, { modelId: 'b', judgeMean: 0.5 }],
          observedJudge: 0.7,
        }),
      );
    }
    const r = calibratePeerLift({ trainExamples: data });
    expect(r.sampleCountByTaskType.code).toBe(5);
  });

  it('lookupPeerLift returns task-type value when present', () => {
    const cal = calibratePeerLift({
      trainExamples: [
        example({
          members: [{ modelId: 'a', judgeMean: 0.5 }, { modelId: 'b', judgeMean: 0.5 }],
          observedJudge: 0.7,
        }),
      ],
    });
    const v = lookupPeerLift(cal, 'code', 'parallel');
    expect(typeof v).toBe('number');
  });

  it('lookupPeerLift falls back to strategy then global', () => {
    const cal = calibratePeerLift({
      trainExamples: [
        example({
          taskType: 'code',
          members: [{ modelId: 'a', judgeMean: 0.5 }, { modelId: 'b', judgeMean: 0.5 }],
          observedJudge: 0.7,
        }),
      ],
    });
    const v = lookupPeerLift(cal, 'never-seen', 'parallel');
    // Falls back to strategy.
    expect(typeof v).toBe('number');
  });

  it('output is frozen', () => {
    const r = calibratePeerLift({ trainExamples: [] });
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('peer_lift can be zero or negative', () => {
    const data = [
      example({
        members: [{ modelId: 'a', judgeMean: 0.7 }, { modelId: 'b', judgeMean: 0.5 }],
        observedJudge: 0.5, // lower than best member!
      }),
    ];
    const r = calibratePeerLift({ trainExamples: data, shrinkageK: 0 });
    expect(r.peerLiftByTaskType.code).toBeLessThan(0);
  });
});
