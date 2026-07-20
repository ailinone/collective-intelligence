// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import {
  pairByTaskDeltas,
  pairedTTest,
  pairedCohensD,
  meanDelta,
  sharedTaskIndices,
  type TaskScore,
} from '../statistical-analysis';

describe('pairByTaskDeltas', () => {
  it('pairs on the COMMON task set (inner join) and averages repetitions per cell', () => {
    const a: TaskScore[] = [
      { taskIndex: 1, value: 0.9 }, { taskIndex: 1, value: 0.7 }, // avg 0.8
      { taskIndex: 2, value: 0.6 },
      { taskIndex: 3, value: 1.0 }, // no match in b → dropped
    ];
    const b: TaskScore[] = [
      { taskIndex: 1, value: 0.5 },
      { taskIndex: 2, value: 0.6 },
      { taskIndex: 9, value: 0.1 }, // no match in a → dropped
    ];
    const deltas = pairByTaskDeltas(a, b).sort((x, y) => x - y);
    // task1: 0.8-0.5=0.3 ; task2: 0.6-0.6=0.0
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toBeCloseTo(0.0, 6);
    expect(deltas[1]).toBeCloseTo(0.3, 6);
  });

  it('removes the task-mix confounding: an arm running an easier subset does NOT win on mix', () => {
    // Collective ran only the easy task (high score); single ran both.
    // Pooled means would falsely favor the collective; paired shows parity.
    const collective: TaskScore[] = [{ taskIndex: 1, value: 0.95 }]; // easy task only
    const single: TaskScore[] = [
      { taskIndex: 1, value: 0.95 }, // same on the easy task
      { taskIndex: 2, value: 0.30 }, // single also ran a hard task
    ];
    const pooledCollective = 0.95;
    const pooledSingle = (0.95 + 0.30) / 2; // 0.625
    expect(pooledCollective - pooledSingle).toBeGreaterThan(0.3); // pooled: spurious win
    const deltas = pairByTaskDeltas(collective, single);
    expect(deltas).toHaveLength(1); // only task 1 is shared
    expect(meanDelta(deltas)).toBeCloseTo(0, 6); // paired: parity (the truth)
  });
});

describe('pairedTTest', () => {
  it('is not significant when per-task deltas hover around zero', () => {
    const r = pairedTTest([0.01, -0.02, 0.0, 0.015, -0.005]);
    expect(r.significant).toBe(false);
  });

  it('is significant when the collective consistently beats the single per task', () => {
    const r = pairedTTest([0.08, 0.09, 0.07, 0.085, 0.075, 0.09]);
    expect(r.significant).toBe(true);
    expect(r.tStatistic).toBeGreaterThan(0);
  });

  it('needs at least 2 shared tasks', () => {
    expect(pairedTTest([0.5]).significant).toBe(false);
    expect(pairedTTest([]).significant).toBe(false);
  });

  it('handles a constant non-zero delta as significant', () => {
    const r = pairedTTest([0.1, 0.1, 0.1]);
    expect(r.significant).toBe(true);
  });
});

describe('pairedCohensD', () => {
  it('categorizes effect size on the delta distribution', () => {
    expect(pairedCohensD([0.001, -0.001, 0.0]).category).toBe('negligible');
    const large = pairedCohensD([0.5, 0.5, 0.5, 0.5]);
    expect(large.category).toBe('large');
  });
});

describe('sharedTaskIndices', () => {
  it('returns the sorted intersection of taskIndex values (the exact audit trail for pairByTaskDeltas)', () => {
    const a: TaskScore[] = [{ taskIndex: 3, value: 0.5 }, { taskIndex: 1, value: 0.6 }, { taskIndex: 9, value: 0.7 }];
    const b: TaskScore[] = [{ taskIndex: 1, value: 0.4 }, { taskIndex: 3, value: 0.3 }, { taskIndex: 5, value: 0.2 }];
    expect(sharedTaskIndices(a, b)).toEqual([1, 3]); // 9 and 5 are not shared; sorted ascending
  });

  it('length always matches pairByTaskDeltas — same inner join, same count', () => {
    const a: TaskScore[] = [{ taskIndex: 1, value: 0.9 }, { taskIndex: 2, value: 0.6 }, { taskIndex: 4, value: 0.1 }];
    const b: TaskScore[] = [{ taskIndex: 1, value: 0.5 }, { taskIndex: 2, value: 0.6 }];
    expect(sharedTaskIndices(a, b).length).toBe(pairByTaskDeltas(a, b).length);
  });

  it('is empty when there is no overlap', () => {
    expect(sharedTaskIndices([{ taskIndex: 1, value: 0.1 }], [{ taskIndex: 2, value: 0.2 }])).toEqual([]);
  });
});
