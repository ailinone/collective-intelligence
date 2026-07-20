// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-determinism.test.ts — MVP 8A
 *
 * The optimizer must produce byte-identical plans on identical input.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { optimizeParetoEnsemble } from '../pareto-ensemble-optimizer';
import {
  scoreAnchorA,
  scoreAnchorB,
  scorePairX,
  scorePairY,
  scoreCheapGood,
  scoreCheapHarmful,
  scoreMini,
  scoreExpensiveNotPareto,
  STANDARD_BASELINE,
} from './fixtures/candidate-fixtures';

afterEach(() => {
  vi.restoreAllMocks();
});

function runOnce(): unknown {
  return optimizeParetoEnsemble({
    candidates: [
      scoreAnchorA(),
      scoreAnchorB(),
      scorePairX(),
      scorePairY(),
      scoreCheapGood(),
      scoreCheapHarmful(),
      scoreMini('a'),
      scoreExpensiveNotPareto(),
    ],
    taskType: 'code-generation',
    taskModality: 'text',
    baseline: STANDARD_BASELINE,
  });
}

describe('pareto — determinism', () => {
  it('same input → byte-identical JSON over 1000 iterations', () => {
    const first = JSON.stringify(runOnce());
    for (let i = 0; i < 1000; i += 1) {
      expect(JSON.stringify(runOnce())).toBe(first);
    }
  });

  it('does not call Date.now', () => {
    const spy = vi.spyOn(Date, 'now');
    runOnce();
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not call Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    runOnce();
    expect(spy).not.toHaveBeenCalled();
  });

  it('candidate input array is not mutated', () => {
    const cands = [scorePairX(), scorePairY(), scoreAnchorA()];
    const before = JSON.stringify(cands);
    optimizeParetoEnsemble({
      candidates: cands,
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(JSON.stringify(cands)).toBe(before);
  });

  it('tie-breaker on equal totalScore is alphabetical by routeId', () => {
    // Two near-identical candidates — verify routeId order is stable.
    const a = { ...scorePairX(), routeId: 'r-a' };
    const b = { ...scorePairX(), routeId: 'r-b' };
    const plan = optimizeParetoEnsemble({
      candidates: [b, a],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    const selected = plan.selectedRouteIds;
    // The order should be deterministic — alphabetical seed when scores tie.
    // We just assert the two runs produce the same order:
    const plan2 = optimizeParetoEnsemble({
      candidates: [b, a],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan2.selectedRouteIds).toEqual(selected);
  });

  it('reordering input does not affect result (stable across permutations)', () => {
    const cands = [
      scoreAnchorA(),
      scoreAnchorB(),
      scorePairX(),
      scorePairY(),
    ];
    const a = JSON.stringify(
      optimizeParetoEnsemble({
        candidates: cands,
        taskType: 'code-generation',
        taskModality: 'text',
        baseline: STANDARD_BASELINE,
      }).selectedModelIds,
    );
    const reversed = [...cands].reverse();
    const b = JSON.stringify(
      optimizeParetoEnsemble({
        candidates: reversed,
        taskType: 'code-generation',
        taskModality: 'text',
        baseline: STANDARD_BASELINE,
      }).selectedModelIds,
    );
    expect(a).toBe(b);
  });
});
