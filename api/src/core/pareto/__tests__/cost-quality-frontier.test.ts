// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * cost-quality-frontier.test.ts — MVP 8A
 *
 * Direct tests for the Pareto math primitives.
 */

import { describe, expect, it } from 'vitest';
import {
  computeParetoFrontier,
  isParetoDominated,
} from '../cost-quality-frontier';

interface Point {
  readonly id: string;
  readonly q: number;
  readonly c: number;
}

const X = {
  quality: (p: Point) => p.q,
  cost: (p: Point) => p.c,
  tieKey: (p: Point) => p.id,
};

describe('computeParetoFrontier', () => {
  it('empty input → empty frontier', () => {
    expect(computeParetoFrontier<Point>([], X)).toEqual([]);
  });

  it('singleton input → itself', () => {
    const a: Point = { id: 'a', q: 0.7, c: 0.02 };
    expect(computeParetoFrontier([a], X)).toEqual([a]);
  });

  it('removes a candidate that is dominated on BOTH dimensions', () => {
    const a: Point = { id: 'a', q: 0.8, c: 0.01 };
    const b: Point = { id: 'b', q: 0.5, c: 0.02 };
    const frontier = computeParetoFrontier([a, b], X);
    expect(frontier.length).toBe(1);
    expect(frontier[0].id).toBe('a');
  });

  it('keeps both when one is cheaper and the other is better', () => {
    const a: Point = { id: 'a', q: 0.9, c: 0.05 };
    const b: Point = { id: 'b', q: 0.7, c: 0.01 };
    const frontier = computeParetoFrontier([a, b], X);
    expect(frontier.length).toBe(2);
    // Order: by ascending cost.
    expect(frontier[0].id).toBe('b');
    expect(frontier[1].id).toBe('a');
  });

  it('strictly-dominated candidate is removed', () => {
    const a: Point = { id: 'a', q: 0.9, c: 0.02 };
    const b: Point = { id: 'b', q: 0.5, c: 0.01 }; // cheaper, lower q — on frontier
    const c: Point = { id: 'c', q: 0.9, c: 0.03 }; // dominated by a (more expensive, same q)
    const frontier = computeParetoFrontier([a, b, c], X);
    expect(frontier.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('equal-quality equal-cost duplicates are both kept (no strict domination)', () => {
    const a: Point = { id: 'a', q: 0.5, c: 0.02 };
    const b: Point = { id: 'b', q: 0.5, c: 0.02 };
    const frontier = computeParetoFrontier([a, b], X);
    expect(frontier.length).toBe(2);
  });

  it('frontier order is deterministic across runs', () => {
    const points: Point[] = [
      { id: 'z', q: 0.6, c: 0.03 },
      { id: 'a', q: 0.7, c: 0.04 },
      { id: 'm', q: 0.8, c: 0.05 },
      { id: 'b', q: 0.5, c: 0.02 },
    ];
    const f1 = computeParetoFrontier(points, X).map((p) => p.id);
    const f2 = computeParetoFrontier(points, X).map((p) => p.id);
    expect(f1).toEqual(f2);
  });

  it('returned array is frozen', () => {
    const a: Point = { id: 'a', q: 0.8, c: 0.01 };
    const frontier = computeParetoFrontier([a], X);
    expect(Object.isFrozen(frontier)).toBe(true);
  });
});

describe('isParetoDominated', () => {
  it('returns true when an other dominates the candidate', () => {
    const cand: Point = { id: 'x', q: 0.5, c: 0.05 };
    const others: Point[] = [{ id: 'y', q: 0.9, c: 0.01 }];
    expect(isParetoDominated(cand, others, X)).toBe(true);
  });

  it('returns false when no other dominates', () => {
    const cand: Point = { id: 'x', q: 0.9, c: 0.05 };
    const others: Point[] = [{ id: 'y', q: 0.7, c: 0.01 }];
    expect(isParetoDominated(cand, others, X)).toBe(false);
  });

  it('does NOT count equal-equal as domination (strict on at least one axis)', () => {
    const cand: Point = { id: 'x', q: 0.7, c: 0.02 };
    const others: Point[] = [{ id: 'y', q: 0.7, c: 0.02 }];
    expect(isParetoDominated(cand, others, X)).toBe(false);
  });
});
