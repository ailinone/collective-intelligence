// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic unit tests for DistributedBulkhead (scale-to-100k Phase 2).
 *
 * No real Redis: getRedisClient() is mocked to a small in-memory sorted-set
 * fake that implements the SAME contract as the Lua script in
 * distributed-bulkhead.ts (atomic sweep-expired-then-acquire-if-under-cap).
 * This verifies the class's calling conventions (keys, args, response
 * shape) and the concurrency/expiry/fallback behavior end to end. It does
 * NOT execute the actual Lua script text against a real Redis server — that
 * is covered by the testcontainers integration suite (vitest.integration.config.ts),
 * consistent with how the rest of this codebase separates hermetic vs
 * integration coverage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const fakeRedis = {
  sets: new Map<string, Map<string, number>>(),

  reset() {
    this.sets.clear();
  },

  getSet(key: string): Map<string, number> {
    let set = this.sets.get(key);
    if (!set) {
      set = new Map();
      this.sets.set(key, set);
    }
    return set;
  },

  // Mirrors the Lua script in distributed-bulkhead.ts's tryAcquire(): sweep
  // expired members, then acquire iff under the cap.
  async eval(_script: string, _numKeys: number, ...args: unknown[]): Promise<[number, number]> {
    const [key, nowStr, maxConcurrentStr, leaseId, expiresAtStr] = args as string[];
    const now = Number(nowStr);
    const maxConcurrent = Number(maxConcurrentStr);
    const expiresAt = Number(expiresAtStr);

    const set = this.getSet(key);
    for (const [member, score] of set) {
      if (score <= now) set.delete(member);
    }

    const active = set.size;
    if (active < maxConcurrent) {
      set.set(leaseId, expiresAt);
      return [1, active + 1];
    }
    return [0, active];
  },

  async zrem(key: string, member: string): Promise<number> {
    const set = this.getSet(key);
    const had = set.delete(member);
    return had ? 1 : 0;
  },

  async zcard(key: string): Promise<number> {
    return this.getSet(key).size;
  },

  async zremrangebyscore(key: string, _min: string, max: string): Promise<number> {
    const now = max === '-inf' ? -Infinity : Number(max);
    const set = this.getSet(key);
    let removed = 0;
    for (const [member, score] of set) {
      if (score <= now) {
        set.delete(member);
        removed++;
      }
    }
    return removed;
  },
};

let shouldThrowOnGetClient = false;

vi.mock('@/cache/redis-client', () => ({
  getRedisClient: () => {
    if (shouldThrowOnGetClient) {
      throw new Error('simulated Redis connection failure');
    }
    return fakeRedis;
  },
}));

// Import after the mock is registered.
const { DistributedBulkhead } = await import('../distributed-bulkhead');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('DistributedBulkhead', () => {
  beforeEach(() => {
    fakeRedis.reset();
    shouldThrowOnGetClient = false;
  });

  it('defaults to local fallback in test environment (no Redis required)', async () => {
    const bulkhead = new DistributedBulkhead({ name: 'test-local-default', maxConcurrent: 2 });
    const result = await bulkhead.execute(async () => 'ok');
    expect(result).toBe('ok');
    const stats = await bulkhead.getStats();
    expect(stats.mode).toBe('local_fallback');
  });

  it('enforces the fleet-wide cap across two independent instances sharing the same Redis (replicas do not multiply capacity)', async () => {
    const name = 'shared-provider';
    const maxConcurrent = 3;
    const replicaA = new DistributedBulkhead({ name, maxConcurrent, forceDistributed: true, queueTimeout: 2000 });
    const replicaB = new DistributedBulkhead({ name, maxConcurrent, forceDistributed: true, queueTimeout: 2000 });

    let concurrentInFlight = 0;
    let maxObservedConcurrent = 0;

    const holdOperation = async () => {
      concurrentInFlight++;
      maxObservedConcurrent = Math.max(maxObservedConcurrent, concurrentInFlight);
      await sleep(40); // self-releasing — no manual coordination needed
      concurrentInFlight--;
    };

    // 6 total attempts (2x the cap) split across both "replicas" at once —
    // if capacity multiplied per-instance (the bug being fixed), all 6 would
    // run concurrently instead of being capped at 3 fleet-wide.
    const attempts = [
      replicaA.execute(holdOperation),
      replicaA.execute(holdOperation),
      replicaB.execute(holdOperation),
      replicaB.execute(holdOperation),
      replicaA.execute(holdOperation),
      replicaB.execute(holdOperation),
    ];

    await Promise.all(attempts);

    expect(maxObservedConcurrent).toBeLessThanOrEqual(maxConcurrent);
  });

  it('releases the lease after the operation completes (capacity returns to 0 active)', async () => {
    const bulkhead = new DistributedBulkhead({ name: 'release-test', maxConcurrent: 5, forceDistributed: true });
    await bulkhead.execute(async () => 'done');
    const stats = await bulkhead.getStats();
    expect(stats.activeLeases).toBe(0);
    expect(stats.mode).toBe('distributed');
  });

  it('releases the lease even when the operation throws', async () => {
    const bulkhead = new DistributedBulkhead({ name: 'release-on-error', maxConcurrent: 1, forceDistributed: true });
    await expect(bulkhead.execute(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const stats = await bulkhead.getStats();
    expect(stats.activeLeases).toBe(0);
  });

  it('rejects with a clear error when at capacity past queueTimeout', async () => {
    const bulkhead = new DistributedBulkhead({
      name: 'capacity-test',
      maxConcurrent: 1,
      forceDistributed: true,
      queueTimeout: 150,
    });

    let releaseFirst: () => void = () => {};
    const first = bulkhead.execute(
      () => new Promise<void>((resolve) => { releaseFirst = resolve; })
    );
    await sleep(10); // let the first operation acquire its lease

    await expect(bulkhead.execute(async () => 'never')).rejects.toThrow(/at capacity/);

    releaseFirst();
    await first;
  });

  it('sweeps an expired (crashed-holder) lease so capacity self-heals without a manual release', async () => {
    const name = 'crash-recovery';
    const bulkhead = new DistributedBulkhead({ name, maxConcurrent: 1, forceDistributed: true });

    // Simulate a replica that crashed while holding a lease: insert an
    // already-expired member directly, bypassing the class's own release().
    fakeRedis.getSet(`bulkhead:${name}:leases`).set('crashed-lease-id', Date.now() - 1000);
    expect(await fakeRedis.zcard(`bulkhead:${name}:leases`)).toBe(1);

    // A fresh acquire should sweep the expired lease and succeed anyway,
    // rather than staying wedged at "capacity" forever.
    const result = await bulkhead.execute(async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('falls back to local enforcement when Redis throws, without crashing the caller', async () => {
    const bulkhead = new DistributedBulkhead({ name: 'redis-down', maxConcurrent: 2, forceDistributed: true });
    shouldThrowOnGetClient = true;

    const result = await bulkhead.execute(async () => 'still works');
    expect(result).toBe('still works');

    const stats = await bulkhead.getStats();
    expect(stats.mode).toBe('local_fallback');
  });
});
