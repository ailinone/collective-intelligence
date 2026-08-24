// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { CostCascadeStrategy } from '../cost-cascade-strategy';
import type { Model } from '@/core/pool/pool-types';

function makeModel(id: string, inputCostPer1k: number, outputCostPer1k = 0): Model {
  return {
    id,
    provider: 'test-provider',
    providerId: 'test-provider',
    name: id,
    inputCostPer1k,
    outputCostPer1k,
  } as unknown as Model;
}

/**
 * Regression coverage for the 2026-08-17 anonymous-chat outage:
 * estimate must track the cheapest candidate across the FULL eligible pool
 * (engine passes context.models for isCascading strategies), never the sum
 * of an arbitrary slice.
 */
describe('CostCascadeStrategy.calculateEstimatedCost (budget-gate semantics)', () => {
  const strategy = new CostCascadeStrategy();

  it('estimates from the cheapest candidate of the full pool, not a slice sum', () => {
    // Pool drift shape: premium models first, cheap groq/cerebras-tier last.
    // Old sum-over-slice behavior estimated 0.015+ and rejected the request.
    const pool = [
      makeModel('premium-a', 0.006, 0.009),
      makeModel('premium-b', 0.005, 0.01),
      makeModel('premium-c', 0.007, 0.008),
      makeModel('premium-d', 0.004, 0.011),
      makeModel('premium-e', 0.0055, 0.0095),
      makeModel('cheap-f', 0.00006, 0.00006),
      makeModel('cheap-g', 0.0001, 0.0001),
    ];
    const estimate = strategy.calculateEstimatedCost(pool, 1000, 1000);
    // cheapest = cheap-f: 1000/1000 * (0.00006 + 0.00006) = 0.00012 — under
    // ailin-economy's 0.003 budget where the old slice-sum said 0.015035.
    expect(estimate).toBeCloseTo(0.00012, 10);
  });

  it('still blocks genuinely impossible budgets (every candidate exceeds budget)', () => {
    const pool = [makeModel('a', 0.01), makeModel('b', 0.012)];
    expect(strategy.calculateEstimatedCost(pool, 1000, 1000)).toBeCloseTo(0.01, 10);
  });

  it('treats free (self-hosted) rungs as zero cost', () => {
    const ladder = [
      makeModel('paid', 0.004),
      { ...makeModel('self-hosted', 0), provider: 'self-hosted' },
    ];
    expect(strategy.calculateEstimatedCost(ladder, 1000, 1000)).toBe(0);
  });

  it('handles empty input', () => {
    expect(strategy.calculateEstimatedCost([], 1000, 1000)).toBe(0);
  });
});
