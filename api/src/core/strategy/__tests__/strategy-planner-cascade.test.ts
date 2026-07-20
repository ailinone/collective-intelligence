// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-planner-cascade.test.ts — MVP 5B
 *
 * Tests cost_cascade, quality_cascade and the latency-sensitive
 * single_best fastest-pick.
 */

import { describe, expect, it } from 'vitest';
import { planStrategy } from '../strategy-planner';
import {
  CHEAP_CONTEXT,
  FAST_CONTEXT,
  QUALITY_CASCADE_CONTEXT,
  STANDARD_CONTEXT,
  makeResult,
} from './fixtures/strategy-fixtures';

describe('planStrategy — cost_cascade', () => {
  it('high cost sensitivity + >=2 candidates → cost_cascade', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-mid-cost',
          breakdownOverrides: { costEfficiency: 0.5 },
        }),
        makeResult({
          routeId: 'r-cheap',
          breakdownOverrides: { costEfficiency: 0.95 },
        }),
      ],
      context: CHEAP_CONTEXT,
    });
    expect(result.plan.strategy).toBe('cost_cascade');
    // Cheapest should be selected (sorted by costEfficiency desc).
    expect(result.plan.selectedRouteIds[0]).toBe('r-cheap');
    expect(result.plan.fallbackRouteIds).toContain('r-mid-cost');
  });

  it('high cost sensitivity but only 1 candidate → fallback to single_best', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-only',
          breakdownOverrides: { costEfficiency: 0.5 },
        }),
      ],
      context: CHEAP_CONTEXT,
    });
    expect(result.plan.strategy).toBe('single_best');
    expect(result.rejectedStrategies.some((r) => r.strategy === 'cost_cascade')).toBe(true);
  });

  it('cost_cascade selects ONE primary + rest fallback ordered by cost', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-c',
          breakdownOverrides: { costEfficiency: 0.5 },
        }),
        makeResult({
          routeId: 'r-a',
          breakdownOverrides: { costEfficiency: 0.9 },
        }),
        makeResult({
          routeId: 'r-b',
          breakdownOverrides: { costEfficiency: 0.7 },
        }),
      ],
      context: CHEAP_CONTEXT,
    });
    expect(result.plan.selectedRouteIds).toEqual(['r-a']);
    expect(result.plan.fallbackRouteIds).toEqual(['r-b', 'r-c']);
  });
});

describe('planStrategy — quality_cascade', () => {
  it('high complexity + confidenceNeeded > 0.8 + >=2 candidates → quality_cascade', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1', totalScore: 0.9 }),
        makeResult({ routeId: 'r-2', totalScore: 0.7 }),
      ],
      context: QUALITY_CASCADE_CONTEXT,
    });
    expect(result.plan.strategy).toBe('quality_cascade');
    expect(result.plan.selectedRouteIds).toEqual(['r-1']);
    expect(result.plan.fallbackRouteIds).toEqual(['r-2']);
  });

  it('high complexity but low confidence → falls back to default (no quality_cascade)', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1', totalScore: 0.9 }),
        makeResult({ routeId: 'r-2', totalScore: 0.7 }),
      ],
      context: {
        ...QUALITY_CASCADE_CONTEXT,
        confidenceNeeded: 0.5, // below 0.8 gate
      },
    });
    expect(result.plan.strategy).not.toBe('quality_cascade');
  });
});

describe('planStrategy — latency-sensitive single_best', () => {
  it('high latency sensitivity → single_best fastest', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-slow',
          breakdownOverrides: { latencyScore: 0.2 },
        }),
        makeResult({
          routeId: 'r-fast',
          breakdownOverrides: { latencyScore: 0.95 },
        }),
        makeResult({
          routeId: 'r-mid',
          breakdownOverrides: { latencyScore: 0.5 },
        }),
      ],
      context: FAST_CONTEXT,
    });
    expect(result.plan.strategy).toBe('single_best');
    expect(result.plan.selectedRouteIds).toEqual(['r-fast']);
    expect(result.plan.fallbackRouteIds).toContain('r-slow');
    expect(result.plan.fallbackRouteIds).toContain('r-mid');
  });

  it('latency tie-breaks by routeId asc', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-b',
          breakdownOverrides: { latencyScore: 0.9 },
        }),
        makeResult({
          routeId: 'r-a',
          breakdownOverrides: { latencyScore: 0.9 },
        }),
      ],
      context: FAST_CONTEXT,
    });
    expect(result.plan.selectedRouteIds).toEqual(['r-a']);
  });
});

describe('planStrategy — reasons are explicit on cascade choice', () => {
  it('cost_cascade reasons include high_cost_sensitivity_cost_cascade', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1' }),
        makeResult({ routeId: 'r-2' }),
      ],
      context: CHEAP_CONTEXT,
    });
    expect(result.plan.reasons).toContain('high_cost_sensitivity_cost_cascade');
  });

  it('quality_cascade reasons include high_complexity_high_confidence_quality_cascade', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1' }),
        makeResult({ routeId: 'r-2' }),
      ],
      context: QUALITY_CASCADE_CONTEXT,
    });
    expect(result.plan.reasons).toContain(
      'high_complexity_high_confidence_quality_cascade',
    );
  });

  it('fast single_best reasons include high_latency_sensitivity_fastest_single', () => {
    const result = planStrategy({
      candidates: [makeResult({ routeId: 'r-1' })],
      context: FAST_CONTEXT,
    });
    expect(result.plan.reasons).toContain('high_latency_sensitivity_fastest_single');
  });
});
