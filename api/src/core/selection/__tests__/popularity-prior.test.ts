// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the cold-start popularity prior — the dynamic signal that stops the
 * selector from picking 0-download junk over real models when there is no
 * runtime history. The ranking contract that matters:
 *   popular (2M dl)  >  modest (10k dl)  >  captured-zero (0 dl)
 *   absent-signal    →  undefined (caller keeps neutral flat fallback)
 */
import { describe, it, expect } from 'vitest';
import { computePopularityPrior, popularityPriorFromMetadata } from '../popularity-prior';

describe('computePopularityPrior', () => {
  it('returns undefined when NO popularity signal is present', () => {
    expect(computePopularityPrior(undefined, undefined, undefined)).toBeUndefined();
  });

  it('treats a captured downloads:0 as a REAL (near-zero) signal, not absent', () => {
    const p = computePopularityPrior(0, 0, 0);
    expect(p).toBeDefined();
    expect(p).toBeCloseTo(0, 5);
  });

  it('ranks popular >> modest >> zero (the anti-junk ordering)', () => {
    const popular = computePopularityPrior(2_000_000, 5_000, 50)!;
    const modest = computePopularityPrior(10_000, 100, 5)!;
    const zero = computePopularityPrior(0, 0, 0)!;
    expect(popular).toBeGreaterThan(modest);
    expect(modest).toBeGreaterThan(zero);
  });

  it('keeps the prior within [0,1] even for huge counts', () => {
    const p = computePopularityPrior(999_999_999, 9_999_999, 9999)!;
    expect(p).toBeLessThanOrEqual(1);
    expect(p).toBeGreaterThanOrEqual(0);
  });

  it('downloads dominate likes (legitimacy proxy)', () => {
    // High downloads / no likes should beat low downloads / high likes.
    const manyDl = computePopularityPrior(1_000_000, 0, 0)!;
    const manyLk = computePopularityPrior(10, 100_000, 0)!;
    expect(manyDl).toBeGreaterThan(manyLk);
  });

  it('ignores non-finite / wrong-typed values gracefully', () => {
    expect(computePopularityPrior(NaN, undefined, undefined)).toBeUndefined();
    const p = computePopularityPrior(1000, NaN, undefined);
    expect(p).toBeDefined();
  });
});

describe('popularityPriorFromMetadata', () => {
  it('extracts numeric signals from a metadata blob', () => {
    const p = popularityPriorFromMetadata({ downloads: 2_000_000, likes: 5000, trendingScore: 50 });
    expect(p).toBeGreaterThan(0.5);
  });

  it('returns undefined for null/empty/non-numeric metadata', () => {
    expect(popularityPriorFromMetadata(null)).toBeUndefined();
    expect(popularityPriorFromMetadata(undefined)).toBeUndefined();
    expect(popularityPriorFromMetadata({})).toBeUndefined();
    expect(popularityPriorFromMetadata({ downloads: '12345' })).toBeUndefined();
  });
});
