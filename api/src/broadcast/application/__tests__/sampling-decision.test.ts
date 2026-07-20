// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for deterministic sampling (ADR-018).
 *
 * Verifies the 6 properties documented in sampling-decision.ts:
 *   1. DETERMINISTIC — same inputs → same decision
 *   2. COMPLETE SESSIONS — same sessionId → same decision
 *   3. RATE ACCURACY — over N sessions, ~rate pass through
 *   4. SHORT-CIRCUITS — 0 and 1 are exact
 *   5. DESTINATION INDEPENDENCE — different destinations get different bias
 *   6. FALLBACK — missing sessionId uses requestId
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  decideSampling,
  shouldSample,
  __resetSamplingKeyCacheForTests,
} from '../sampling-decision';

beforeEach(() => __resetSamplingKeyCacheForTests());

describe('sampling-decision — determinism', () => {
  it('same (destinationId, sessionId, rate) yields identical decisions', () => {
    const destinationId = randomUUID();
    const sessionId = 'session-abc-123';
    for (let i = 0; i < 20; i++) {
      const d = decideSampling({
        destinationId,
        sessionId,
        requestId: 'ignored',
        samplingRate: 0.3,
      });
      const d2 = decideSampling({
        destinationId,
        sessionId,
        requestId: 'ignored',
        samplingRate: 0.3,
      });
      expect(d).toEqual(d2);
    }
  });
});

describe('sampling-decision — complete sessions', () => {
  it('all requests within a session share the decision', () => {
    const destinationId = randomUUID();
    const sessionId = 'multi-turn-conversation';
    // 50 hypothetical requests in one session
    const decisions = Array.from({ length: 50 }, (_, i) =>
      shouldSample(destinationId, sessionId, 0.5),
    );
    expect(new Set(decisions).size).toBe(1);
  });
});

describe('sampling-decision — rate accuracy', () => {
  it('approximately samplingRate fraction of unique sessions pass at rate=0.5', () => {
    const destinationId = randomUUID();
    const N = 5000;
    let hits = 0;
    for (let i = 0; i < N; i++) {
      if (shouldSample(destinationId, `session-${i}`, 0.5)) hits++;
    }
    // Binomial stdev for N=5000, p=0.5 is ~35; allow 5σ margin
    expect(Math.abs(hits / N - 0.5)).toBeLessThan(0.035);
  });

  it('approximately 10% at rate=0.1', () => {
    const destinationId = randomUUID();
    const N = 5000;
    let hits = 0;
    for (let i = 0; i < N; i++) {
      if (shouldSample(destinationId, `session-${i}`, 0.1)) hits++;
    }
    expect(Math.abs(hits / N - 0.1)).toBeLessThan(0.03);
  });
});

describe('sampling-decision — short-circuits', () => {
  it('rate=0 always excludes', () => {
    const destinationId = randomUUID();
    for (let i = 0; i < 100; i++) {
      expect(shouldSample(destinationId, `s-${i}`, 0)).toBe(false);
    }
  });

  it('rate=1 always includes', () => {
    const destinationId = randomUUID();
    for (let i = 0; i < 100; i++) {
      expect(shouldSample(destinationId, `s-${i}`, 1)).toBe(true);
    }
  });

  it('clamps rates outside [0,1]', () => {
    const destinationId = randomUUID();
    expect(shouldSample(destinationId, 's-1', -1)).toBe(false);
    expect(shouldSample(destinationId, 's-1', 2)).toBe(true);
    expect(shouldSample(destinationId, 's-1', Number.NaN)).toBe(false);
    expect(shouldSample(destinationId, 's-1', Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe('sampling-decision — destination independence', () => {
  it('two destinations at 50% rate do NOT see the same halves', () => {
    const destA = randomUUID();
    const destB = randomUUID();
    const N = 2000;
    let aIncluded = 0;
    let bIncluded = 0;
    let bothIncluded = 0;
    for (let i = 0; i < N; i++) {
      const sid = `session-${i}`;
      const a = shouldSample(destA, sid, 0.5);
      const b = shouldSample(destB, sid, 0.5);
      if (a) aIncluded++;
      if (b) bIncluded++;
      if (a && b) bothIncluded++;
    }
    // Each destination is near 50%
    expect(Math.abs(aIncluded / N - 0.5)).toBeLessThan(0.04);
    expect(Math.abs(bIncluded / N - 0.5)).toBeLessThan(0.04);
    // If independent, P(A ∧ B) = 0.25. Allow ±3σ.
    expect(Math.abs(bothIncluded / N - 0.25)).toBeLessThan(0.04);
  });
});

describe('sampling-decision — fallback', () => {
  it('falls back to requestId when sessionId is missing', () => {
    const destinationId = randomUUID();
    const result = decideSampling({
      destinationId,
      sessionId: null,
      requestId: 'req-123',
      samplingRate: 0.5,
    });
    expect(result.fallbackToRequestId).toBe(true);
  });

  it('falls back to requestId when sessionId is undefined', () => {
    const destinationId = randomUUID();
    const result = decideSampling({
      destinationId,
      requestId: 'req-abc',
      samplingRate: 0.5,
    });
    expect(result.fallbackToRequestId).toBe(true);
  });

  it('does NOT fall back when sessionId is empty string — treated as no session', () => {
    const destinationId = randomUUID();
    const result = decideSampling({
      destinationId,
      sessionId: '',
      requestId: 'req-abc',
      samplingRate: 0.5,
    });
    // Empty string is falsy — falls back
    expect(result.fallbackToRequestId).toBe(true);
  });

  it('with fallback, different requestIds get independent decisions', () => {
    const destinationId = randomUUID();
    const N = 2000;
    let hits = 0;
    for (let i = 0; i < N; i++) {
      const result = decideSampling({
        destinationId,
        sessionId: null,
        requestId: `req-${i}`,
        samplingRate: 0.5,
      });
      if (result.include) hits++;
    }
    expect(Math.abs(hits / N - 0.5)).toBeLessThan(0.04);
  });
});

describe('sampling-decision — bucket bounds', () => {
  it('bucket is always in [0, 1) for non-short-circuit rates', () => {
    const destinationId = randomUUID();
    for (let i = 0; i < 500; i++) {
      const d = decideSampling({
        destinationId,
        sessionId: `s-${i}`,
        requestId: 'x',
        samplingRate: 0.5,
      });
      expect(d.bucket).toBeGreaterThanOrEqual(0);
      expect(d.bucket).toBeLessThan(1);
    }
  });
});
