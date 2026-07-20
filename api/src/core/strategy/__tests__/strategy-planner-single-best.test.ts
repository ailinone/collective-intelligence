// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-planner-single-best.test.ts — MVP 5B
 *
 * Covers the default `single_best` path + its fallback chain.
 */

import { describe, expect, it } from 'vitest';
import { planStrategy } from '../strategy-planner';
import { STANDARD_CONTEXT, makeResult } from './fixtures/strategy-fixtures';

describe('planStrategy — default → single_best', () => {
  it('single candidate yields single_best with that route selected', () => {
    const result = planStrategy({
      candidates: [makeResult({ routeId: 'r-1' })],
      context: STANDARD_CONTEXT,
    });
    expect(result.plan.strategy).toBe('single_best');
    expect(result.plan.selectedRouteIds).toEqual(['r-1']);
    expect(result.plan.maxParallelism).toBe(1);
  });

  it('multiple candidates → top candidate selected, rest in fallback', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-top', totalScore: 0.9 }),
        makeResult({ routeId: 'r-2nd', totalScore: 0.7 }),
        makeResult({ routeId: 'r-3rd', totalScore: 0.5 }),
      ],
      context: STANDARD_CONTEXT,
    });
    expect(result.plan.strategy).toBe('single_best');
    expect(result.plan.selectedRouteIds).toEqual(['r-top']);
    expect(result.plan.fallbackRouteIds).toEqual(['r-2nd', 'r-3rd']);
    // Note: input order is preserved as fallback order.
  });

  it('reasons include `default_single_best`', () => {
    const result = planStrategy({
      candidates: [makeResult({ routeId: 'r-1' })],
      context: STANDARD_CONTEXT,
    });
    expect(result.plan.reasons).toContain('default_single_best');
  });

  it('confidence reflects the selected candidate totalScore', () => {
    const result = planStrategy({
      candidates: [makeResult({ routeId: 'r-1', totalScore: 0.82 })],
      context: STANDARD_CONTEXT,
    });
    expect(result.plan.confidence).toBeCloseTo(0.82, 3);
  });

  it('empty candidate set → no_viable_strategy', () => {
    const result = planStrategy({
      candidates: [],
      context: STANDARD_CONTEXT,
    });
    expect(result.plan.strategy).toBe('no_viable_strategy');
    expect(result.plan.selectedRouteIds).toEqual([]);
    expect(result.plan.fallbackRouteIds).toEqual([]);
    expect(result.plan.maxParallelism).toBe(0);
    expect(result.plan.reasons).toContain('empty_candidates');
  });

  it('estimatedCostClass reflects selected route', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-cheap',
          breakdownOverrides: { costEfficiency: 0.96 },
        }),
      ],
      context: STANDARD_CONTEXT,
    });
    expect(result.plan.estimatedCostClass).toBe('free');
  });

  it('estimatedLatencyClass reflects selected route', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-fast',
          breakdownOverrides: { latencyScore: 0.85 },
        }),
      ],
      context: STANDARD_CONTEXT,
    });
    expect(result.plan.estimatedLatencyClass).toBe('low');
  });
});
