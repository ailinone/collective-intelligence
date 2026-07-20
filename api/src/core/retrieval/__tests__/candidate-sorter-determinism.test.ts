// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * candidate-sorter-determinism.test.ts — MVP 5A
 *
 * Proves the sort comparator obeys the documented total order:
 *   1. rejected=false before rejected=true
 *   2. totalScore desc
 *   3. routeId asc (lexicographic)
 *   4. canonicalModelId asc
 *   5. offeringId asc
 *
 * And that the sort is deterministic across 1000 iterations.
 */

import { describe, expect, it } from 'vitest';
import { compareCandidates, sortCandidates } from '../candidate-sorter';
import type { ModelScoreResult } from '../../scoring/model-scorer';
import { zeroBreakdown } from '../../scoring/score-breakdown';

function makeResult(overrides: Partial<ModelScoreResult>): ModelScoreResult {
  return {
    routeId: 'r-default',
    canonicalModelId: 'c-default',
    offeringId: 'o-default',
    totalScore: 0.5,
    breakdown: zeroBreakdown(),
    rejected: false,
    rejectionReasons: [],
    freshnessStatus: 'current_and_routable',
    ...overrides,
  };
}

describe('compareCandidates — primary sort: accepted before rejected', () => {
  it('rejected=false comes BEFORE rejected=true', () => {
    const a = makeResult({ rejected: false, totalScore: 0.1 });
    const b = makeResult({ rejected: true, totalScore: 0.9 });
    expect(compareCandidates(a, b)).toBeLessThan(0);
    expect(compareCandidates(b, a)).toBeGreaterThan(0);
  });
});

describe('compareCandidates — secondary sort: totalScore desc', () => {
  it('higher totalScore comes first', () => {
    const high = makeResult({ totalScore: 0.9 });
    const low = makeResult({ totalScore: 0.1 });
    expect(compareCandidates(high, low)).toBeLessThan(0);
    expect(compareCandidates(low, high)).toBeGreaterThan(0);
  });
});

describe('compareCandidates — tie-breaker: routeId ascending', () => {
  it('alphabetically smaller routeId wins on tied score', () => {
    const a = makeResult({ totalScore: 0.5, routeId: 'a' });
    const b = makeResult({ totalScore: 0.5, routeId: 'b' });
    expect(compareCandidates(a, b)).toBeLessThan(0);
    expect(compareCandidates(b, a)).toBeGreaterThan(0);
  });
});

describe('compareCandidates — third tie-breaker: canonicalModelId', () => {
  it('breaks tie on routeId equality (route ids identical, canonical differs)', () => {
    const a = makeResult({ totalScore: 0.5, routeId: 'r', canonicalModelId: 'a' });
    const b = makeResult({ totalScore: 0.5, routeId: 'r', canonicalModelId: 'b' });
    expect(compareCandidates(a, b)).toBeLessThan(0);
  });
});

describe('compareCandidates — fourth tie-breaker: offeringId', () => {
  it('breaks tie on routeId + canonical equality', () => {
    const a = makeResult({
      totalScore: 0.5,
      routeId: 'r',
      canonicalModelId: 'c',
      offeringId: 'a',
    });
    const b = makeResult({
      totalScore: 0.5,
      routeId: 'r',
      canonicalModelId: 'c',
      offeringId: 'b',
    });
    expect(compareCandidates(a, b)).toBeLessThan(0);
  });

  it('returns 0 when all identity fields equal', () => {
    const a = makeResult({
      totalScore: 0.5,
      routeId: 'r',
      canonicalModelId: 'c',
      offeringId: 'o',
    });
    const b = makeResult({
      totalScore: 0.5,
      routeId: 'r',
      canonicalModelId: 'c',
      offeringId: 'o',
    });
    expect(compareCandidates(a, b)).toBe(0);
  });
});

describe('sortCandidates — deterministic', () => {
  it('multiple shufflings produce identical output', () => {
    const baseline: ModelScoreResult[] = [
      makeResult({ routeId: 'r-1', totalScore: 0.7 }),
      makeResult({ routeId: 'r-2', totalScore: 0.7 }),
      makeResult({ routeId: 'r-3', totalScore: 0.5 }),
      makeResult({ routeId: 'r-4', totalScore: 0.9 }),
      makeResult({ routeId: 'r-5', totalScore: 0.5, rejected: true }),
    ];

    // Deterministic shuffles via LCG seed.
    const shuffle = (arr: readonly ModelScoreResult[], seed: number): ModelScoreResult[] => {
      const out = [...arr];
      let s = seed >>> 0;
      const next = (): number => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
      };
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };

    const sortedA = sortCandidates(shuffle(baseline, 42));
    const sortedB = sortCandidates(shuffle(baseline, 7));
    const sortedC = sortCandidates(shuffle(baseline, 1337));

    const ids = (arr: readonly ModelScoreResult[]) => arr.map((r) => r.routeId).join(',');
    expect(ids(sortedA)).toBe(ids(sortedB));
    expect(ids(sortedB)).toBe(ids(sortedC));
  });

  it('1000 iterations of sort yield identical result', () => {
    const baseline: ModelScoreResult[] = [
      makeResult({ routeId: 'r-1', totalScore: 0.7 }),
      makeResult({ routeId: 'r-2', totalScore: 0.5, rejected: true }),
      makeResult({ routeId: 'r-3', totalScore: 0.9 }),
    ];

    const first = sortCandidates(baseline).map((r) => r.routeId).join(',');
    for (let i = 0; i < 1000; i += 1) {
      const next = sortCandidates(baseline).map((r) => r.routeId).join(',');
      if (next !== first) {
        throw new Error(`non-deterministic at iter ${i}`);
      }
    }
    expect(first).toBeTruthy();
  });
});

describe('sortCandidates — does not mutate input', () => {
  it('input array is unchanged after sort', () => {
    const arr: ModelScoreResult[] = [
      makeResult({ routeId: 'b', totalScore: 0.3 }),
      makeResult({ routeId: 'a', totalScore: 0.8 }),
    ];
    const before = arr.map((r) => r.routeId).join(',');
    sortCandidates(arr);
    const after = arr.map((r) => r.routeId).join(',');
    expect(after).toBe(before);
  });

  it('returns a NEW array', () => {
    const arr: ModelScoreResult[] = [makeResult({ routeId: 'a' })];
    const sorted = sortCandidates(arr);
    expect(sorted).not.toBe(arr);
  });
});
