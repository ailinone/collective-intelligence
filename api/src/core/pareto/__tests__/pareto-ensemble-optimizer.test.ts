// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-ensemble-optimizer.test.ts — MVP 8A
 *
 * Smoke tests for the optimizer's happy paths. Strategy + Pareto-status
 * specific cases live in dedicated test files (15.1–15.8).
 */

import { describe, expect, it } from 'vitest';
import { optimizeParetoEnsemble } from '../pareto-ensemble-optimizer';
import {
  scoreAnchorA,
  scoreAnchorB,
  scorePairX,
  scorePairY,
  STANDARD_BASELINE,
} from './fixtures/candidate-fixtures';

describe('optimizeParetoEnsemble — happy paths', () => {
  it('non-empty candidates produce a plan', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [scoreAnchorA(), scoreAnchorB(), scorePairX(), scorePairY()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan).toBeDefined();
    expect(plan.selectedRouteIds.length).toBeGreaterThan(0);
    expect(plan.selectedModelIds.length).toBe(plan.selectedRouteIds.length);
    expect(plan.explanation).toBeTruthy();
  });

  it('empty candidates → single_fallback with no model', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan.strategyId).toBe('single_fallback');
    expect(plan.selectedRouteIds.length).toBe(0);
  });

  it('all-rejected candidates → single_fallback with no model', () => {
    const cand = scorePairX();
    // Force a reject by mutating the original — we copy first so we don't poison.
    const rejected = {
      ...cand,
      rejected: true,
      rejectionReasons: ['modality_mismatch'],
    };
    const plan = optimizeParetoEnsemble({
      candidates: [rejected],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan.strategyId).toBe('single_fallback');
  });

  it('plan output is frozen', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [scorePairX(), scorePairY()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.selectedRouteIds)).toBe(true);
    expect(Object.isFrozen(plan.marginalContributions)).toBe(true);
  });

  it('marginalContributions has an entry per accepted member at least', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [scorePairX(), scorePairY()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    const accepted = plan.marginalContributions.filter((m) => m.accepted);
    expect(accepted.length).toBeGreaterThanOrEqual(plan.selectedModelIds.length);
  });
});
