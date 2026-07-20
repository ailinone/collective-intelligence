// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-sampling.test.ts — MVP 8C.0
 */

import { describe, expect, it } from 'vitest';
import { shouldSample } from '../shadow-routing-sampling';

describe('shouldSample — boundary rates', () => {
  it('sampleRate=0 always false', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(shouldSample(`req-${i}`, 0)).toBe(false);
    }
  });

  it('sampleRate=1 always true (when requestId non-empty)', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(shouldSample(`req-${i}`, 1)).toBe(true);
    }
  });

  it('empty requestId always false', () => {
    expect(shouldSample('', 0.5)).toBe(false);
    expect(shouldSample('', 1)).toBe(false);
  });

  it('rate < 0 → false', () => {
    expect(shouldSample('req-1', -0.1)).toBe(false);
  });

  it('rate > 1 treated as 1', () => {
    expect(shouldSample('req-1', 2)).toBe(true);
  });

  it('NaN rate → false', () => {
    expect(shouldSample('req-1', NaN)).toBe(false);
  });
});

describe('shouldSample — determinism', () => {
  it('same (requestId, rate) → same result', () => {
    const a = shouldSample('req-determinism-1', 0.3);
    for (let i = 0; i < 1000; i += 1) {
      expect(shouldSample('req-determinism-1', 0.3)).toBe(a);
    }
  });

  it('different requestIds give different decisions at the same rate', () => {
    const trues: string[] = [];
    const falses: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const rid = `req-determinism-${i}`;
      (shouldSample(rid, 0.5) ? trues : falses).push(rid);
    }
    // With 200 ids at rate 0.5, we expect a roughly even split.
    expect(trues.length).toBeGreaterThan(50);
    expect(falses.length).toBeGreaterThan(50);
  });
});

describe('shouldSample — approximate rate', () => {
  it('rate=0.1 produces ~10% sampled across 10,000 ids', () => {
    let sampled = 0;
    for (let i = 0; i < 10_000; i += 1) {
      if (shouldSample(`req-rate-${i}`, 0.1)) sampled += 1;
    }
    const ratio = sampled / 10_000;
    // Allow ±2% tolerance for hash distribution.
    expect(ratio).toBeGreaterThan(0.08);
    expect(ratio).toBeLessThan(0.12);
  });

  it('rate=0.5 produces ~50% sampled', () => {
    let sampled = 0;
    for (let i = 0; i < 10_000; i += 1) {
      if (shouldSample(`req-rate-${i}`, 0.5)) sampled += 1;
    }
    const ratio = sampled / 10_000;
    expect(ratio).toBeGreaterThan(0.47);
    expect(ratio).toBeLessThan(0.53);
  });
});
