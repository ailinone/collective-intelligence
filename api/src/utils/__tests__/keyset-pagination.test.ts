// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The predicates are asserted by SEMANTICS, not by shape.
 *
 * A test that only checked the object literal would pass just as happily for a
 * predicate that selects the wrong rows, which is exactly the failure being
 * fixed: `id: { gt: after }` is a perfectly well-formed Prisma filter and it
 * selected a random ~50% subset of the list. So these tests evaluate the emitted
 * filter against an in-memory table and assert on which rows come back.
 *
 * The fixture deliberately contains rows that TIE on `createdAt`. Ties are the
 * normal case, not an edge case: `created_at` is TIMESTAMP(3) and messages
 * written in the same millisecond tie exactly.
 */

import { describe, it, expect } from 'vitest';
import {
  keysetFilters,
  scanPlan,
  orderByCreatedAtThenId,
  type CursorRow,
  type ListOrder,
} from '@/utils/keyset-pagination';

interface Row {
  id: string;
  createdAt: Date;
}

const t = (ms: number) => new Date(1_700_000_000_000 + ms);

// Ids are deliberately NOT in lexicographic order relative to time — that is the
// whole defect. 'zz' is oldest, 'aa' is newest.
const ROWS: Row[] = [
  { id: 'zz', createdAt: t(0) },
  { id: 'mm', createdAt: t(1) },
  { id: 'bb', createdAt: t(1) }, // ties with mm
  { id: 'aa', createdAt: t(2) },
];

/** Sorts by (createdAt, id) in the given direction — mirrors orderByCreatedAtThenId. */
function sorted(rows: Row[], order: ListOrder): Row[] {
  const dir = order === 'asc' ? 1 : -1;
  return [...rows].sort(
    (a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  );
}

/** Minimal evaluator for the AND/OR/comparison shape the helper emits. */
function matches(row: Row, node: Record<string, unknown>): boolean {
  if (Array.isArray(node.AND)) {
    return (node.AND as Record<string, unknown>[]).every((n) => matches(row, n));
  }
  if (Array.isArray(node.OR)) {
    return (node.OR as Record<string, unknown>[]).some((n) => matches(row, n));
  }
  return Object.entries(node).every(([field, cond]) => {
    const value = row[field as keyof Row];
    if (cond instanceof Date) return (value as Date).getTime() === cond.getTime();
    if (typeof cond === 'string') return value === cond;
    const [op, operand] = Object.entries(cond as Record<string, unknown>)[0];
    const a = value instanceof Date ? value.getTime() : String(value);
    const b = operand instanceof Date ? operand.getTime() : String(operand);
    switch (op) {
      case 'gt':
        return a > b;
      case 'gte':
        return a >= b;
      case 'lt':
        return a < b;
      case 'lte':
        return a <= b;
      default:
        throw new Error(`unhandled operator ${op}`);
    }
  });
}

const select = (order: ListOrder, after?: CursorRow, before?: CursorRow): string[] => {
  const filters = keysetFilters(order, after, before);
  const kept = ROWS.filter((r) => filters.every((f) => matches(r, f)));
  return sorted(kept, order).map((r) => r.id);
};

describe('keysetFilters', () => {
  it('selects the rows after the cursor in ascending order, including across a tie', () => {
    // Cursor is 'mm', which ties with 'bb'. Ascending (createdAt, id) puts bb
    // BEFORE mm, so bb must NOT come back.
    expect(select('asc', { id: 'mm', createdAt: t(1) })).toEqual(['aa']);
  });

  it('includes the tied sibling that sorts after the cursor', () => {
    expect(select('asc', { id: 'bb', createdAt: t(1) })).toEqual(['mm', 'aa']);
  });

  it('walks the other way in descending order', () => {
    // Descending, "after mm" means older rows.
    expect(select('desc', { id: 'mm', createdAt: t(1) })).toEqual(['bb', 'zz']);
  });

  it('never returns the cursor row itself', () => {
    for (const order of ['asc', 'desc'] as ListOrder[]) {
      for (const row of ROWS) {
        expect(select(order, { id: row.id, createdAt: row.createdAt })).not.toContain(row.id);
      }
    }
  });

  it('bounds a range when after and before are combined', () => {
    expect(select('asc', { id: 'zz', createdAt: t(0) }, { id: 'aa', createdAt: t(2) })).toEqual([
      'bb',
      'mm',
    ]);
  });

  it('traverses the whole list exactly once, in either order', () => {
    // The property the old code broke: paging with `after` must visit every row
    // once. With `id: { gt: after }` over random ids, some rows repeated and
    // others were unreachable forever.
    for (const order of ['asc', 'desc'] as ListOrder[]) {
      const seen: string[] = [];
      let cursor: CursorRow | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = select(order, cursor).slice(0, 1);
        if (page.length === 0) break;
        seen.push(page[0]);
        const row = ROWS.find((r) => r.id === page[0]);
        cursor = row ? { id: row.id, createdAt: row.createdAt } : undefined;
      }
      expect(seen).toEqual(sorted(ROWS, order).map((r) => r.id));
    }
  });

  it('emits no filter when there is no cursor', () => {
    expect(keysetFilters('asc')).toEqual([]);
  });
});

describe('scanPlan', () => {
  it('scans in display order for a plain page and for `after`', () => {
    expect(scanPlan('desc', false, false)).toEqual({ scanOrder: 'desc', reverse: false });
    expect(scanPlan('desc', true, false)).toEqual({ scanOrder: 'desc', reverse: false });
  });

  it('reverses the scan for a bare `before`, then restores display order', () => {
    // Otherwise LIMIT returns the far end of the list rather than the page
    // adjacent to the cursor.
    expect(scanPlan('desc', false, true)).toEqual({ scanOrder: 'asc', reverse: true });
    expect(scanPlan('asc', false, true)).toEqual({ scanOrder: 'desc', reverse: true });
  });

  it('does not reverse when both bounds are given', () => {
    expect(scanPlan('asc', true, true)).toEqual({ scanOrder: 'asc', reverse: false });
  });
});

describe('orderByCreatedAtThenId', () => {
  it('always includes the id tiebreaker, because createdAt is not a total order', () => {
    expect(orderByCreatedAtThenId('asc')).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(orderByCreatedAtThenId('desc')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});
