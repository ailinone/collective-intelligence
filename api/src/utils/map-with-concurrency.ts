// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `Promise.all(items.map(fn))` with at most `limit` calls in flight.
 *
 * `limit` <= 0, non-finite or undefined means unbounded (plain
 * `Promise.all`), so callers can wire an env knob whose unset/0 value keeps
 * today's full fan-out. Results keep input order; the first rejection
 * rejects the whole call, exactly like `Promise.all`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number | undefined,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const bounded =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && limit < items.length;

  if (!bounded) {
    return Promise.all(items.map((item, index) => fn(item, index)));
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
