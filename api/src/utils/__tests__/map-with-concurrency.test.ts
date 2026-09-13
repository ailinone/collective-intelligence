// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from '../map-with-concurrency';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('mapWithConcurrency', () => {
  it('never has more than `limit` calls in flight and preserves result order', async () => {
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    let inFlight = 0;
    let maxInFlight = 0;

    const run = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gates[i].promise;
      inFlight--;
      return i * 10;
    });

    await flush();
    expect(inFlight).toBe(2);

    // Release out of order to prove ordering is by input index, not completion.
    gates[1].resolve();
    await flush();
    expect(inFlight).toBe(2);
    gates[0].resolve();
    gates[3].resolve();
    gates[2].resolve();
    await flush();
    gates[5].resolve();
    gates[4].resolve();

    expect(await run).toEqual([0, 10, 20, 30, 40, 50]);
    expect(maxInFlight).toBe(2);
  });

  it('limit 0 / undefined / NaN runs everything concurrently (Promise.all semantics)', async () => {
    for (const limit of [0, undefined, Number.NaN, -1]) {
      const gates = Array.from({ length: 4 }, () => deferred<number>());
      let started = 0;
      const run = mapWithConcurrency([0, 1, 2, 3], limit, async (i) => {
        started++;
        return gates[i].promise;
      });
      await flush();
      expect(started).toBe(4);
      gates.forEach((g, i) => g.resolve(i));
      expect(await run).toEqual([0, 1, 2, 3]);
    }
  });

  it('a rejection propagates like Promise.all', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error('boom');
        return i;
      })
    ).rejects.toThrow('boom');
  });

  it('empty input resolves to []', async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });

  it('passes the index to the mapper', async () => {
    expect(await mapWithConcurrency(['a', 'b', 'c'], 1, async (item, index) => `${item}${index}`)).toEqual([
      'a0',
      'b1',
      'c2',
    ]);
  });
});
