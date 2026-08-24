// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, beforeEach } from 'vitest';
import { TtftTracker, resetTtftTrackerForTesting } from '../ttft-tracker';

describe('TtftTracker', () => {
  beforeEach(() => {
    resetTtftTrackerForTesting();
  });

  it('EWMA follows samples with the configured alpha (deterministic)', () => {
    const t = new TtftTracker(32, 0.5);
    t.recordFirstChunk('prov', 'm1', 1000);
    t.recordFirstChunk('prov', 'm1', 2000);
    // ewma = 0.5*2000 + 0.5*(1000) = 1500
    expect(t.predictedTtftMs('prov', 'm1')).toBe(1500);
    t.recordFirstChunk('prov', 'm1', 500);
    // ewma = 0.5*500 + 0.5*1500 = 1000
    expect(t.predictedTtftMs('prov', 'm1')).toBe(1000);
  });

  it('returns null prediction with no success samples', () => {
    const t = new TtftTracker();
    expect(t.predictedTtftMs('prov', 'm-none')).toBeNull();
    t.recordFailure('prov', 'm-fail');
    expect(t.predictedTtftMs('prov', 'm-fail')).toBeNull();
  });

  it('p95 uses nearest-rank over the recent ring', () => {
    const t = new TtftTracker(32);
    for (let i = 1; i <= 20; i++) t.recordFirstChunk('prov', 'm1', i * 100);
    // ceil(0.95 * 20) = 19th smallest → 1900
    expect(t.p95TtftMs('prov', 'm1')).toBe(1900);
  });

  it('ring keeps only the last ringSize samples', () => {
    const t = new TtftTracker(4);
    for (let i = 1; i <= 10; i++) t.recordFirstChunk('prov', 'm1', i * 100);
    // Ring = [700, 800, 900, 1000]; p95 nearest-rank = ceil(0.95*4)=4th → 1000
    expect(t.p95TtftMs('prov', 'm1')).toBe(1000);
  });

  it('keys routes by provider+model (case-insensitive provider)', () => {
    const t = new TtftTracker();
    t.recordFirstChunk('Prov', 'm1', 500);
    expect(t.predictedTtftMs('prov', 'm1')).toBe(500);
    expect(t.predictedTtftMs('other', 'm1')).toBeNull();
  });

  it('errorRate counts failures against successes', () => {
    const t = new TtftTracker();
    t.recordFirstChunk('prov', 'm1', 100);
    t.recordFirstChunk('prov', 'm1', 100);
    t.recordFailure('prov', 'm1');
    expect(t.errorRate('prov', 'm1')).toBeCloseTo(1 / 3);
  });

  it('failures contribute no latency samples', () => {
    const t = new TtftTracker();
    t.recordFailure('prov', 'm1');
    t.recordFailure('prov', 'm1');
    expect(t.sampleCount('prov', 'm1')).toBe(0);
    expect(t.p95TtftMs('prov', 'm1')).toBeNull();
  });

  describe('computeFirstChunkBudgetMs', () => {
    it('falls back to the static window below minSamples', () => {
      const t = new TtftTracker();
      for (let i = 0; i < 4; i++) t.recordFirstChunk('prov', 'm1', 800);
      expect(
        t.computeFirstChunkBudgetMs('prov', 'm1', { staticFallbackMs: 3000, minSamples: 5 })
      ).toBe(3000);
    });

    it('uses clamp(p95 * factor, floor, ceiling) with enough history', () => {
      const t = new TtftTracker();
      for (let i = 1; i <= 20; i++) t.recordFirstChunk('prov', 'm1', i * 100); // p95 = 1900
      expect(
        t.computeFirstChunkBudgetMs('prov', 'm1', {
          staticFallbackMs: 3000,
          factor: 1.5,
          floorMs: 1500,
          ceilingMs: 8000,
          minSamples: 5,
        })
      ).toBe(2850);
    });

    it('clamps to the floor', () => {
      const t = new TtftTracker();
      for (let i = 1; i <= 20; i++) t.recordFirstChunk('prov', 'm1', i * 10); // p95 = 190
      expect(
        t.computeFirstChunkBudgetMs('prov', 'm1', {
          staticFallbackMs: 3000,
          factor: 1.5,
          floorMs: 1500,
          ceilingMs: 8000,
          minSamples: 5,
        })
      ).toBe(1500);
    });

    it('clamps to the ceiling', () => {
      const t = new TtftTracker();
      for (let i = 1; i <= 20; i++) t.recordFirstChunk('prov', 'm1', i * 1000); // p95 = 19000
      expect(
        t.computeFirstChunkBudgetMs('prov', 'm1', {
          staticFallbackMs: 3000,
          factor: 1.5,
          floorMs: 1500,
          ceilingMs: 8000,
          minSamples: 5,
        })
      ).toBe(8000);
    });

    it('normalizes an inverted ceiling down to the floor', () => {
      const t = new TtftTracker();
      for (let i = 1; i <= 20; i++) t.recordFirstChunk('prov', 'm1', i * 1000);
      expect(
        t.computeFirstChunkBudgetMs('prov', 'm1', {
          staticFallbackMs: 3000,
          factor: 1.5,
          floorMs: 1500,
          ceilingMs: 500, // inverted
          minSamples: 5,
        })
      ).toBe(1500);
    });
  });
});
