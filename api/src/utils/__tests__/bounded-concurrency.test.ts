// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Bounded-concurrency primitives used to pace the Tiered Capability
 * Fingerprint sweep (`jobs/capability-fingerprint-job.ts`) across many real
 * provider lanes. Pins:
 *   - `runWithBoundedConcurrency` never exceeds the given global cap and
 *     never drops/duplicates an item, including on worker rejection.
 *   - `PerKeyLimiter` never lets more than `maxPerKey` tasks run for the
 *     SAME key concurrently, while DIFFERENT keys run fully independently.
 */
import { describe, it, expect, vi } from 'vitest';
import { runWithBoundedConcurrency, PerKeyLimiter } from '../bounded-concurrency';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('runWithBoundedConcurrency', () => {
  it('never exceeds the concurrency cap while processing every item', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let current = 0;
    let maxObserved = 0;

    const results = await runWithBoundedConcurrency(items, 4, async (item) => {
      current++;
      maxObserved = Math.max(maxObserved, current);
      await sleep(5);
      current--;
      return item * 2;
    });

    expect(maxObserved).toBeLessThanOrEqual(4);
    expect(results).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(results[i]).toEqual({ item: i, index: i, status: 'fulfilled', value: i * 2 });
    }
  });

  it('captures a worker rejection as a result entry instead of throwing', async () => {
    const items = [1, 2, 3];
    const results = await runWithBoundedConcurrency(items, 2, async (item) => {
      if (item === 2) throw new Error('boom');
      return item;
    });

    expect(results[0]).toMatchObject({ status: 'fulfilled', value: 1 });
    expect(results[1].status).toBe('rejected');
    if (results[1].status === 'rejected') {
      expect((results[1].reason as Error).message).toBe('boom');
    }
    expect(results[2]).toMatchObject({ status: 'fulfilled', value: 3 });
  });

  it('returns an empty array for an empty input without calling the worker', async () => {
    const worker = vi.fn();
    const results = await runWithBoundedConcurrency([], 5, worker);
    expect(results).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('clamps a non-positive or fractional concurrency to at least 1', async () => {
    const items = [1, 2, 3];
    const results = await runWithBoundedConcurrency(items, 0, async (item) => item);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : undefined))).toEqual([1, 2, 3]);
  });
});

describe('PerKeyLimiter', () => {
  it('never lets more than maxPerKey tasks run concurrently for the SAME key', async () => {
    const limiter = new PerKeyLimiter({ maxPerKey: 2 });
    let current = 0;
    let maxObserved = 0;

    const tasks = Array.from({ length: 10 }, () =>
      limiter.run('provider-a', async () => {
        current++;
        maxObserved = Math.max(maxObserved, current);
        await sleep(5);
        current--;
      })
    );
    await Promise.all(tasks);

    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  it('runs DIFFERENT keys fully independently (no cross-key throttling)', async () => {
    const limiter = new PerKeyLimiter({ maxPerKey: 1 });
    const order: string[] = [];

    // Both keys start a slow task at the same time; with independent keys,
    // key B's task should NOT wait for key A's to finish.
    const a = limiter.run('a', async () => {
      await sleep(30);
      order.push('a-done');
    });
    const b = limiter.run('b', async () => {
      await sleep(5);
      order.push('b-done');
    });

    await Promise.all([a, b]);
    expect(order).toEqual(['b-done', 'a-done']);
  });

  it('queues excess tasks for a key and runs them after the in-flight one releases', async () => {
    const limiter = new PerKeyLimiter({ maxPerKey: 1 });
    const order: number[] = [];

    const tasks = [1, 2, 3].map((n) =>
      limiter.run('lane', async () => {
        order.push(n);
        await sleep(5);
      })
    );
    await Promise.all(tasks);

    // Single-slot lane must serialize strictly in submission order.
    expect(order).toEqual([1, 2, 3]);
  });

  it('applies inter-task delay+jitter between successive tasks on the SAME key', async () => {
    const limiter = new PerKeyLimiter({ maxPerKey: 1, interTaskDelayMs: 20, interTaskJitterMs: 0 });
    const timestamps: number[] = [];

    const tasks = [1, 2].map(() =>
      limiter.run('lane', async () => {
        timestamps.push(Date.now());
      })
    );
    await Promise.all(tasks);

    expect(timestamps).toHaveLength(2);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(18); // small slack for timer jitter
  });

  it('propagates a task error without corrupting the key state for the next queued task', async () => {
    const limiter = new PerKeyLimiter({ maxPerKey: 1 });
    let secondRan = false;

    const first = limiter.run('lane', async () => {
      throw new Error('boom');
    });
    const second = limiter.run('lane', async () => {
      secondRan = true;
    });

    await expect(first).rejects.toThrow('boom');
    await second;
    expect(secondRan).toBe(true);
  });
});
