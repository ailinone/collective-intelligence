// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for cost-integrity-guard.
 *
 * Anchors the fix for the negative-cost incident 2026-02-20 where
 * `eval-baseline-metrics.json` reported `avgCostPerRequest: -2786 USD`
 * for the debate strategy. The exact upstream root cause was not located
 * in a single adapter (every reviewed adapter is defensive with
 * Math.max(0, ...)) — the guard provides defense-in-depth at the
 * createModelExecution + response-emitter + eval-aggregator boundaries.
 *
 * Test inputs include the specific signatures observed in the production
 * incident: large-magnitude negative integers (-95, -325, -1797) that
 * correlate with token counts, suggesting a subtraction path somewhere
 * upstream. These tests will FAIL THE GUARD CONTRACT if a regression
 * reintroduces a code path that silently lets such values through.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = process.env.CI_COST_INTEGRITY_POLICY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  delete process.env.CI_COST_INTEGRITY_POLICY;
  // Default to non-production so the env-dependent default resolves to
  // strict-throw — most tests assert on the strict path. Tests that want
  // the production behavior set NODE_ENV explicitly.
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  if (ORIGINAL_ENV !== undefined) {
    process.env.CI_COST_INTEGRITY_POLICY = ORIGINAL_ENV;
  } else {
    delete process.env.CI_COST_INTEGRITY_POLICY;
  }
  if (ORIGINAL_NODE_ENV !== undefined) {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  } else {
    delete process.env.NODE_ENV;
  }
});

// ─── Pure classification (policy-independent) ─────────────────────────────

describe('guardCost classification', () => {
  it('passes a small positive cost through unchanged (warn-and-null policy)', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';
    const { guardCost } = await import('../cost-integrity-guard');
    const result = guardCost(0.000259, { callSite: 'test' });
    expect(result.ok).toBe(true);
    expect(result.cost).toBe(0.000259);
    expect(result.reason).toBeUndefined();
  });

  it('passes zero through unchanged (zero is a valid cost)', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';
    const { guardCost } = await import('../cost-integrity-guard');
    const result = guardCost(0, { callSite: 'test' });
    expect(result.ok).toBe(true);
    expect(result.cost).toBe(0);
  });

  it('rejects a negative cost under warn-and-null', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';
    const { guardCost } = await import('../cost-integrity-guard');
    const result = guardCost(-2786.097718, { callSite: 'test', strategy: 'debate' });
    expect(result.ok).toBe(false);
    expect(result.cost).toBe(null);
    expect(result.reason).toBe('negative');
  });

  it('rejects NaN', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';
    const { guardCost } = await import('../cost-integrity-guard');
    const result = guardCost(NaN, { callSite: 'test' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('infinite');
  });

  it('rejects Infinity and -Infinity', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';
    const { guardCost } = await import('../cost-integrity-guard');
    expect(guardCost(Infinity, { callSite: 'test' }).reason).toBe('infinite');
    expect(guardCost(-Infinity, { callSite: 'test' }).reason).toBe('infinite');
  });

  it('rejects null and undefined', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';
    const { guardCost } = await import('../cost-integrity-guard');
    expect(guardCost(null, { callSite: 'test' }).reason).toBe('undefined-or-null');
    expect(guardCost(undefined, { callSite: 'test' }).reason).toBe('undefined-or-null');
  });

  it('rejects non-numeric types (strings, objects)', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';
    const { guardCost } = await import('../cost-integrity-guard');
    expect(guardCost('0.001', { callSite: 'test' }).reason).toBe('not-a-number');
    expect(guardCost({}, { callSite: 'test' }).reason).toBe('not-a-number');
  });
});

// ─── Policy: strict-throw ─────────────────────────────────────────────────

describe('guardCost — strict-throw policy', () => {
  it('throws CostIntegrityError on the exact -2786 signature from the incident', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'strict-throw';
    const { guardCost, CostIntegrityError } = await import('../cost-integrity-guard');
    expect(() =>
      guardCost(-2786.097718, { callSite: 'eval-aggregator', strategy: 'debate' }),
    ).toThrow(CostIntegrityError);
  });

  it('throws on each of the observed negative-cost signatures (-94.99, -324.99, -1796.96)', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'strict-throw';
    const { guardCost } = await import('../cost-integrity-guard');
    const signatures = [-94.999963, -324.9997409, -325.9997237, -1796.9668662];
    for (const sig of signatures) {
      expect(() => guardCost(sig, { callSite: 'test' })).toThrow();
    }
  });

  it('throws on NaN under strict policy', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'strict-throw';
    const { guardCost } = await import('../cost-integrity-guard');
    expect(() => guardCost(NaN, { callSite: 'test' })).toThrow();
  });
});

// ─── Policy: silent-zero ──────────────────────────────────────────────────

describe('guardCost — silent-zero policy', () => {
  it('replaces negative with 0 silently (legacy backward-compat mode)', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'silent-zero';
    const { guardCost } = await import('../cost-integrity-guard');
    const result = guardCost(-2786, { callSite: 'test' });
    expect(result.cost).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('negative');
  });
});

// ─── Policy: env-dependent ────────────────────────────────────────────────

describe('guardCost — env-dependent policy', () => {
  it('resolves to strict-throw in non-production', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'env-dependent';
    process.env.NODE_ENV = 'test';
    const { guardCost } = await import('../cost-integrity-guard');
    expect(() => guardCost(-100, { callSite: 'test' })).toThrow();
  });

  it('resolves to warn-and-null in production (does not throw)', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'env-dependent';
    process.env.NODE_ENV = 'production';
    const { guardCost } = await import('../cost-integrity-guard');
    const result = guardCost(-100, { callSite: 'test' });
    expect(result.cost).toBe(null);
    expect(result.ok).toBe(false);
  });
});

// ─── Aggregator: filterValidCosts ─────────────────────────────────────────

describe('filterValidCosts (aggregator helper)', () => {
  it('keeps positives, drops negatives + NaN + null + non-numbers', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';
    const { filterValidCosts } = await import('../cost-integrity-guard');
    const result = filterValidCosts(
      [0.001, -94.999, 0, NaN, null, undefined, 'oops', 0.002, -2786],
      { callSite: 'test-aggregator' },
    );
    expect(result.valid).toEqual([0.001, 0, 0.002]);
    expect(result.rejected).toBe(6);
    expect(result.rejectionReasons.get('negative')).toBe(2);
    expect(result.rejectionReasons.get('undefined-or-null')).toBe(2);
    expect(result.rejectionReasons.get('not-a-number')).toBe(1);
    expect(result.rejectionReasons.get('infinite')).toBe(1); // NaN
  });

  it('returns empty arrays when no valid samples exist (does not crash)', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';
    const { filterValidCosts } = await import('../cost-integrity-guard');
    const result = filterValidCosts([-1, -2, -3], { callSite: 'test' });
    expect(result.valid).toEqual([]);
    expect(result.rejected).toBe(3);
  });
});

// ─── Reproduction of the incident pattern ─────────────────────────────────

describe('regression: 2026-02-20 negative-cost incident reproduction', () => {
  it('a benchmark run with 48 debate executions producing -58 USD each would NOT aggregate to -2786', async () => {
    // Simulates the exact eval-baseline-metrics.json observation:
    //   48 debate requests × avgCost -58 USD = -2786 USD aggregated.
    // With the integrity guard active, those samples are rejected and the
    // aggregate becomes null (no valid data) — NOT -2786.
    process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';
    const { filterValidCosts } = await import('../cost-integrity-guard');

    const incidentCosts = Array.from({ length: 48 }, () => -58.04);
    const filtered = filterValidCosts(incidentCosts, {
      callSite: 'regression-test',
      strategy: 'debate',
    });
    expect(filtered.valid.length).toBe(0);
    expect(filtered.rejected).toBe(48);

    const aggregate = filtered.valid.length === 0
      ? null
      : filtered.valid.reduce((s, v) => s + v, 0) / filtered.valid.length;

    expect(aggregate).toBe(null); // ← critical: NOT -2786, NOT -58.04
  });

  it('mixed valid + negative samples report partial coverage', async () => {
    process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';
    const { filterValidCosts } = await import('../cost-integrity-guard');
    const mixed = [0.001, 0.002, -94.999, 0.003, -325.0, 0];
    const result = filterValidCosts(mixed, { callSite: 'test' });
    expect(result.valid).toEqual([0.001, 0.002, 0.003, 0]);
    expect(result.rejected).toBe(2);
  });
});
