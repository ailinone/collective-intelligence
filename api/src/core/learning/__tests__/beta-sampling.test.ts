// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Beta sampling statistical correctness (audit P0-4 / LN-04).
 *
 * The bandit's Thompson Sampling depends on REAL Beta(α, β) draws. The
 * previous implementation (posterior mean ± uniform noise) pinned fresh
 * arms — Beta(1,1) — near 0.5, so a never-selected strategy could not
 * outdraw an incumbent with mean ≳ 0.8 (cold-start trap). These tests pin
 * the distributional properties that make Thompson exploration work.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/database/client', () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

import { betaSample } from '@/core/learning/strategy-bandit';

const N = 4000;

function draws(alpha: number, beta: number, n = N): number[] {
  return Array.from({ length: n }, () => betaSample(alpha, beta));
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

describe('betaSample — true Beta(α, β) draws', () => {
  it('matches the Beta mean for a strong incumbent (8, 2)', () => {
    expect(mean(draws(8, 2))).toBeCloseTo(8 / 10, 1);
  });

  it('matches the Beta mean for a weak arm (2, 8)', () => {
    expect(mean(draws(2, 8))).toBeCloseTo(2 / 10, 1);
  });

  it('Beta(1,1) is uniform — fresh arms must explore the full [0,1] range', () => {
    const xs = draws(1, 1);
    // Uniform(0,1): mean 0.5, stddev ≈ 0.2887
    expect(mean(xs)).toBeGreaterThan(0.45);
    expect(mean(xs)).toBeLessThan(0.55);
    expect(stddev(xs)).toBeGreaterThan(0.25);
    expect(stddev(xs)).toBeLessThan(0.33);
  });

  it('a fresh arm Beta(1,1) outdraws a 0.8-mean incumbent ~20% of the time (cold-start exploration)', () => {
    const winRate = draws(1, 1).filter(x => x > 0.8).length / N;
    expect(winRate).toBeGreaterThan(0.13);
    expect(winRate).toBeLessThan(0.27);
  });

  it('posterior concentrates with evidence: Beta(80,20) is tight around 0.8', () => {
    const sd = stddev(draws(80, 20));
    // Analytic stddev = sqrt(0.8*0.2/101) ≈ 0.0398
    expect(sd).toBeGreaterThan(0.02);
    expect(sd).toBeLessThan(0.06);
  });

  it('handles shape < 1 (boost path) and respects output clamps', () => {
    for (const x of draws(0.5, 0.5, 1000)) {
      expect(x).toBeGreaterThanOrEqual(0.01);
      expect(x).toBeLessThanOrEqual(0.99);
      expect(Number.isFinite(x)).toBe(true);
    }
  });
});
