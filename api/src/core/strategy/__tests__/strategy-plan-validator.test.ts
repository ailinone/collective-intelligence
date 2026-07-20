// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-plan-validator.test.ts — MVP 5B
 *
 * Exercises every rule of the validator.
 */

import { describe, expect, it } from 'vitest';
import { validateStrategyPlan } from '../strategy-plan-validator';
import { DEFAULT_STRATEGY_POLICY } from '../strategy-policy';
import type { StrategyPlan } from '../strategy-types';

function makePlan(overrides: Partial<StrategyPlan>): StrategyPlan {
  return {
    strategy: 'single_best',
    selectedRouteIds: ['r-1'],
    fallbackRouteIds: [],
    maxParallelism: 1,
    estimatedCostClass: 'low',
    estimatedLatencyClass: 'mid',
    confidence: 0.8,
    reasons: ['test'],
    constraintsApplied: [],
    ...overrides,
  };
}

describe('validateStrategyPlan — happy paths', () => {
  it('valid single_best passes', () => {
    const v = validateStrategyPlan(makePlan({ strategy: 'single_best', selectedRouteIds: ['r-1'] }));
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('valid consensus passes', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'consensus',
        selectedRouteIds: ['r-1', 'r-2', 'r-3'],
        maxParallelism: 3,
      }),
    );
    expect(v.valid).toBe(true);
  });

  it('valid no_viable_strategy passes', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'no_viable_strategy',
        selectedRouteIds: [],
        maxParallelism: 0,
        confidence: 0,
      }),
    );
    expect(v.valid).toBe(true);
  });
});

describe('validateStrategyPlan — confidence range', () => {
  it('rejects confidence < 0', () => {
    const v = validateStrategyPlan(makePlan({ confidence: -0.1 }));
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.startsWith('confidence_out_of_range'))).toBe(true);
  });

  it('rejects confidence > 1', () => {
    const v = validateStrategyPlan(makePlan({ confidence: 1.5 }));
    expect(v.valid).toBe(false);
  });

  it('rejects NaN confidence', () => {
    const v = validateStrategyPlan(makePlan({ confidence: NaN }));
    expect(v.valid).toBe(false);
  });
});

describe('validateStrategyPlan — duplicates', () => {
  it('rejects duplicate in selectedRouteIds', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'consensus',
        selectedRouteIds: ['r-1', 'r-1', 'r-2'],
        maxParallelism: 3,
      }),
    );
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('duplicate_in_selectedRouteIds');
  });

  it('rejects duplicate in fallbackRouteIds', () => {
    const v = validateStrategyPlan(
      makePlan({
        selectedRouteIds: ['r-1'],
        fallbackRouteIds: ['r-2', 'r-2'],
      }),
    );
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('duplicate_in_fallbackRouteIds');
  });

  it('rejects fallback overlapping with selected', () => {
    const v = validateStrategyPlan(
      makePlan({
        selectedRouteIds: ['r-1'],
        fallbackRouteIds: ['r-1', 'r-2'],
      }),
    );
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.startsWith('fallback_overlaps_selected'))).toBe(true);
  });
});

describe('validateStrategyPlan — strategy-specific rules', () => {
  it('no_viable_strategy with non-empty selectedRouteIds is invalid', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'no_viable_strategy',
        selectedRouteIds: ['r-1'],
      }),
    );
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('no_viable_strategy_has_selected_routes');
  });

  it('single_best with > 1 selected is invalid', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'single_best',
        selectedRouteIds: ['r-1', 'r-2'],
      }),
    );
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.startsWith('single_best_too_many_selected'))).toBe(true);
  });

  it('local_first with > 1 selected is invalid', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'local_first',
        selectedRouteIds: ['r-1', 'r-2'],
      }),
    );
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.startsWith('local_first_too_many_selected'))).toBe(true);
  });

  it('collective strategies must respect maxParallelism', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'consensus',
        selectedRouteIds: ['r-1', 'r-2', 'r-3'],
        maxParallelism: 2, // too small
      }),
    );
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.startsWith('collective_exceeds_maxParallelism'))).toBe(true);
  });

  it('collective strategies with maxParallelism=0 are invalid', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'consensus',
        selectedRouteIds: ['r-1'],
        maxParallelism: 0,
      }),
    );
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('collective_zero_parallelism');
  });
});

describe('validateStrategyPlan — local_required rule', () => {
  it('REJECTS plan whose selectedRouteIds include external route', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'single_best',
        selectedRouteIds: ['r-cloud'],
      }),
      {
        privacyMode: 'local_required',
        routeKindById: new Map([['r-cloud', 'native']]),
      },
    );
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.includes('local_required_includes_external_route'))).toBe(
      true,
    );
  });

  it('REJECTS plan whose fallbackRouteIds include external route', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'single_best',
        selectedRouteIds: ['r-local'],
        fallbackRouteIds: ['r-cloud-fallback'],
      }),
      {
        privacyMode: 'local_required',
        routeKindById: new Map([
          ['r-local', 'local'],
          ['r-cloud-fallback', 'native'],
        ]),
      },
    );
    expect(v.valid).toBe(false);
    expect(
      v.errors.some((e) => e.includes('local_required_fallback_includes_external_route')),
    ).toBe(true);
  });

  it('accepts plan with only local routes', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'single_best',
        selectedRouteIds: ['r-local-1'],
      }),
      {
        privacyMode: 'local_required',
        routeKindById: new Map([['r-local-1', 'local']]),
      },
    );
    expect(v.valid).toBe(true);
  });
});

describe('validateStrategyPlan — explicit pin + fallback policy', () => {
  it('REJECTS plan with fallback when pin set and policy forbids', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'single_best',
        selectedRouteIds: ['r-pinned'],
        fallbackRouteIds: ['r-alt'],
      }),
      {
        explicitModelPin: {
          source: 'request_modelPin',
          routeId: 'r-pinned',
          allowSubstitution: false,
        },
        policy: { ...DEFAULT_STRATEGY_POLICY, allowFallbackForExplicitPin: false },
      },
    );
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('explicit_pin_has_fallback_but_policy_forbids');
  });

  it('accepts plan with fallback when pin set and policy allows', () => {
    const v = validateStrategyPlan(
      makePlan({
        strategy: 'single_best',
        selectedRouteIds: ['r-pinned'],
        fallbackRouteIds: ['r-alt'],
      }),
      {
        explicitModelPin: {
          source: 'request_modelPin',
          routeId: 'r-pinned',
          allowSubstitution: true,
        },
        policy: { ...DEFAULT_STRATEGY_POLICY, allowFallbackForExplicitPin: true },
      },
    );
    expect(v.valid).toBe(true);
  });
});
