// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Keyset (seek) pagination over a `(createdAt, id)` composite key.
 *
 * The list endpoints used to filter cursors with `id: { gt: after }` — a
 * LEXICOGRAPHIC comparison over ids shaped `msg_${nanoid(24)}`. Those ids are a
 * uniformly random draw, so their lexicographic order is a random permutation of
 * insertion order, and `id > cursor` selects a random ~50% subset of the list
 * that has no relationship to "the rows after the cursor". Concretely: about half
 * the rows already returned come back again, and about half the rows not yet
 * returned become PERMANENTLY unreachable — no sequence of `after` calls can
 * retrieve them.
 *
 * Ordering is by `createdAt` (TIMESTAMP(3), millisecond resolution) with `id` as
 * a tiebreaker, so the cursor must compare against BOTH columns as a row value.
 *
 * No migration: this works against the existing `(thread_id, created_at)` index.
 */

export interface CursorRow {
  id: string;
  createdAt: Date;
}

export type ListOrder = 'asc' | 'desc';

/**
 * Rows strictly after `c` in ascending `(createdAt, id)` order.
 *
 * The leading `gte` is logically implied by the OR below. It is there because it
 * is what keeps the predicate index-seekable: without it the planner falls back
 * to the `thread_id` index condition alone and walks every already-seen row.
 */
const afterRow = (c: CursorRow) => ({
  AND: [
    { createdAt: { gte: c.createdAt } },
    {
      OR: [{ createdAt: { gt: c.createdAt } }, { createdAt: c.createdAt, id: { gt: c.id } }],
    },
  ],
});

/** Rows strictly before `c` in ascending `(createdAt, id)` order. */
const beforeRow = (c: CursorRow) => ({
  AND: [
    { createdAt: { lte: c.createdAt } },
    {
      OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }],
    },
  ],
});

/**
 * `after` and `before` are positions in the REQUESTED order, not in time.
 *
 * The old code mapped `after` to `gt` unconditionally, so with the default
 * `order: 'desc'` it paged backwards into rows the caller already held — a second
 * bug independent of the id-comparison one, and one that a sortable-id scheme
 * would not have fixed.
 */
export function keysetFilters(
  order: ListOrder,
  after?: CursorRow,
  before?: CursorRow
): Record<string, unknown>[] {
  const filters: Record<string, unknown>[] = [];
  if (after) filters.push(order === 'asc' ? afterRow(after) : beforeRow(after));
  if (before) filters.push(order === 'asc' ? beforeRow(before) : afterRow(before));
  return filters;
}

/**
 * A bare `before` walks BACKWARDS from the cursor. Scanning in display order with
 * a LIMIT would return the far end of the list rather than the adjacent page, so
 * scan reversed and restore display order in memory.
 */
export function scanPlan(
  order: ListOrder,
  hasAfter: boolean,
  hasBefore: boolean
): { scanOrder: ListOrder; reverse: boolean } {
  const scanOrder: ListOrder = hasBefore && !hasAfter ? (order === 'asc' ? 'desc' : 'asc') : order;
  return { scanOrder, reverse: scanOrder !== order };
}

/** `createdAt` alone is not a total order at millisecond resolution. */
export const orderByCreatedAtThenId = (order: ListOrder) => [{ createdAt: order }, { id: order }];
