// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-planner-collective.test.ts — MVP 5B
 *
 * Tests consensus, expert_panel, critique_repair, parallel_diverse.
 */

import { describe, expect, it } from 'vitest';
import { planStrategy } from '../strategy-planner';
import {
  EXTREME_COMPLEXITY_CONTEXT,
  HIGH_RISK_CONTEXT,
  makeResult,
  STANDARD_CONTEXT,
} from './fixtures/strategy-fixtures';

describe('planStrategy — consensus', () => {
  it('high risk + >=3 candidates → consensus', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1', totalScore: 0.9 }),
        makeResult({ routeId: 'r-2', totalScore: 0.85 }),
        makeResult({ routeId: 'r-3', totalScore: 0.8 }),
      ],
      context: HIGH_RISK_CONTEXT,
    });
    expect(result.plan.strategy).toBe('consensus');
    expect(result.plan.selectedRouteIds).toEqual(['r-1', 'r-2', 'r-3']);
    expect(result.plan.maxParallelism).toBe(3);
  });

  it('high risk but only 2 candidates → consensus rejected, falls through', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1' }),
        makeResult({ routeId: 'r-2' }),
      ],
      context: HIGH_RISK_CONTEXT,
    });
    expect(result.plan.strategy).not.toBe('consensus');
    expect(result.rejectedStrategies.some((r) => r.strategy === 'consensus')).toBe(true);
  });

  it('high risk + 4 candidates → consensus picks top 3 + fallback', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1' }),
        makeResult({ routeId: 'r-2' }),
        makeResult({ routeId: 'r-3' }),
        makeResult({ routeId: 'r-4' }),
      ],
      context: HIGH_RISK_CONTEXT,
    });
    expect(result.plan.selectedRouteIds).toEqual(['r-1', 'r-2', 'r-3']);
    expect(result.plan.fallbackRouteIds).toEqual(['r-4']);
  });
});

describe('planStrategy — expert_panel', () => {
  it('extreme complexity + >=4 candidates → expert_panel', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1' }),
        makeResult({ routeId: 'r-2' }),
        makeResult({ routeId: 'r-3' }),
        makeResult({ routeId: 'r-4' }),
      ],
      context: EXTREME_COMPLEXITY_CONTEXT,
    });
    expect(result.plan.strategy).toBe('expert_panel');
    expect(result.plan.selectedRouteIds.length).toBe(4);
  });

  it('extreme complexity + 3 candidates → critique_repair (fallback)', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1' }),
        makeResult({ routeId: 'r-2' }),
        makeResult({ routeId: 'r-3' }),
      ],
      context: EXTREME_COMPLEXITY_CONTEXT,
    });
    expect(result.plan.strategy).toBe('critique_repair');
    expect(result.plan.selectedRouteIds.length).toBe(2);
    expect(result.rejectedStrategies.some((r) => r.strategy === 'expert_panel')).toBe(true);
  });

  it('extreme complexity + 1 candidate → fallback to default single_best', () => {
    const result = planStrategy({
      candidates: [makeResult({ routeId: 'r-only' })],
      context: EXTREME_COMPLEXITY_CONTEXT,
    });
    // 1 candidate → critique_repair needs 2, falls through. Default = single_best.
    expect(result.plan.strategy).toBe('single_best');
    expect(result.plan.selectedRouteIds).toEqual(['r-only']);
  });
});

describe('planStrategy — parallel_diverse', () => {
  it('medium risk + 3 distinct canonicals → parallel_diverse', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-a', canonicalModelId: 'cm-a' }),
        makeResult({ routeId: 'r-b', canonicalModelId: 'cm-b' }),
        makeResult({ routeId: 'r-c', canonicalModelId: 'cm-c' }),
      ],
      context: {
        ...STANDARD_CONTEXT,
        riskLevel: 'medium',
      },
    });
    expect(result.plan.strategy).toBe('parallel_diverse');
    // Top 3 distinct canonicals picked.
    expect(result.plan.selectedRouteIds.length).toBe(3);
  });

  it('medium risk + repeated canonical → diversity check picks distinct first', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-a', canonicalModelId: 'cm-a', totalScore: 0.9 }),
        makeResult({ routeId: 'r-a2', canonicalModelId: 'cm-a', totalScore: 0.85 }), // duplicate canonical
        makeResult({ routeId: 'r-b', canonicalModelId: 'cm-b', totalScore: 0.8 }),
        makeResult({ routeId: 'r-c', canonicalModelId: 'cm-c', totalScore: 0.7 }),
      ],
      context: {
        ...STANDARD_CONTEXT,
        riskLevel: 'medium',
      },
    });
    expect(result.plan.strategy).toBe('parallel_diverse');
    // Selected routes have distinct canonical ids.
    const selectedCanonicals = result.plan.selectedRouteIds.map((rid) => {
      if (rid === 'r-a') return 'cm-a';
      if (rid === 'r-a2') return 'cm-a';
      if (rid === 'r-b') return 'cm-b';
      if (rid === 'r-c') return 'cm-c';
      return 'unknown';
    });
    const uniq = new Set(selectedCanonicals);
    expect(uniq.size).toBe(selectedCanonicals.length);
  });

  it('low risk + 3 distinct canonicals → NOT parallel_diverse (gate by risk)', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-a', canonicalModelId: 'cm-a' }),
        makeResult({ routeId: 'r-b', canonicalModelId: 'cm-b' }),
        makeResult({ routeId: 'r-c', canonicalModelId: 'cm-c' }),
      ],
      context: STANDARD_CONTEXT, // riskLevel: 'low'
    });
    expect(result.plan.strategy).not.toBe('parallel_diverse');
  });
});

describe('planStrategy — collective gating', () => {
  it('allowCollectiveForHighRisk=false disables consensus even with enough candidates', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1' }),
        makeResult({ routeId: 'r-2' }),
        makeResult({ routeId: 'r-3' }),
      ],
      context: HIGH_RISK_CONTEXT,
      policy: { allowCollectiveForHighRisk: false },
    });
    expect(result.plan.strategy).not.toBe('consensus');
  });
});
