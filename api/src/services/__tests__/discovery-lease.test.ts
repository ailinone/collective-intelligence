// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * discovery-lease.ts: the fleet-wide lease around a model-discovery round.
 *
 * The lease logic (acquire, heartbeat, local fencing check, release, fail
 * open) runs against an in-memory store with TTL semantics, driven by fake
 * timers. The Redis store is checked separately for the exact keys/args it
 * sends and how it parses replies. Hermetic: the real Redis client is mocked
 * to throw if anything reaches for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/cache/redis-client', () => ({
  getQueueRedisClient: () => {
    throw new Error('unit test must not reach the real Redis client');
  },
}));

import {
  acquireDiscoveryLease,
  createRedisDiscoveryLeaseStore,
  DEFAULT_DISCOVERY_LEASE_TTL_MS,
  DISCOVERY_LEASE_EPOCH_KEY,
  DISCOVERY_LEASE_KEY,
  isDiscoveryLeaseEnabled,
  parseLeaseEpoch,
  resolveDiscoveryLeaseTtlMs,
  type DiscoveryLeaseAcquireResult,
  type DiscoveryLeaseStore,
  type LeaseRedisClient,
} from '@/services/discovery-lease';

/** Map-backed store with the same atomic semantics as the Lua scripts. */
class FakeLeaseStore implements DiscoveryLeaseStore {
  value: string | null = null;
  expiresAt = 0;
  epoch = 0;
  renewCalls = 0;
  releaseCalls = 0;

  private live(): string | null {
    if (this.value !== null && Date.now() >= this.expiresAt) this.value = null;
    return this.value;
  }

  async tryAcquire(ownerId: string, ttlMs: number): Promise<DiscoveryLeaseAcquireResult> {
    const holder = this.live();
    if (holder !== null) return { acquired: false, holder };
    this.epoch += 1;
    const token = `${this.epoch}|${ownerId}`;
    this.value = token;
    this.expiresAt = Date.now() + ttlMs;
    return { acquired: true, token, epoch: this.epoch };
  }

  async renew(token: string, ttlMs: number): Promise<boolean> {
    this.renewCalls += 1;
    if (this.live() !== token) return false;
    this.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async release(token: string): Promise<boolean> {
    this.releaseCalls += 1;
    if (this.live() !== token) return false;
    this.value = null;
    return true;
  }

  /** Simulates another process taking the key after ours expired. */
  takeOver(token: string, ttlMs: number): void {
    this.value = token;
    this.expiresAt = Date.now() + ttlMs;
  }
}

const TTL = 30_000;

/** Lets the heartbeat's promise chain (store call, timeout wrapper, handler) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('acquireDiscoveryLease: mutual exclusion and fencing epoch', () => {
  it('grants the lease to one owner, refuses a second while held, and hands out a strictly larger epoch next time', async () => {
    const store = new FakeLeaseStore();

    const first = await acquireDiscoveryLease({ store, ttlMs: TTL, ownerId: 'api-1' });
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error('unreachable');
    expect(first.failedOpen).toBe(false);
    expect(first.lease.epoch).toBe(1);
    expect(first.lease.token).toBe('1|api-1');

    const second = await acquireDiscoveryLease({ store, ttlMs: TTL, ownerId: 'worker-1' });
    expect(second).toEqual({ acquired: false, holder: '1|api-1' });

    await first.lease.release();
    expect(store.value).toBeNull();

    const third = await acquireDiscoveryLease({ store, ttlMs: TTL, ownerId: 'worker-1' });
    expect(third.acquired).toBe(true);
    if (!third.acquired) throw new Error('unreachable');
    expect(third.lease.epoch).toBe(2);
    expect(third.lease.epoch!).toBeGreaterThan(first.lease.epoch!);
    await third.lease.release();
  });

  it('a holder that stops renewing (SIGKILLed mid-round) blocks others only until its TTL runs out', async () => {
    const store = new FakeLeaseStore();
    const killed = await acquireDiscoveryLease({ store, ttlMs: TTL, ownerId: 'old-worker' });
    if (!killed.acquired) throw new Error('expected the lease');
    // The killed process never reaches Redis again.
    vi.spyOn(store, 'renew').mockRejectedValue(new Error('process gone'));

    expect(
      (await acquireDiscoveryLease({ store, ttlMs: TTL, ownerId: 'new-worker' })).acquired
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(TTL);
    await flush();
    const next = await acquireDiscoveryLease({ store, ttlMs: TTL, ownerId: 'new-worker' });
    expect(next.acquired).toBe(true);
    if (!next.acquired) throw new Error('unreachable');
    expect(next.lease.epoch).toBe(2);

    // A late release from the old holder is a no-op for the new one (CAS).
    await killed.lease.release();
    expect(store.value).toBe('2|new-worker');
    await next.lease.release();
  });
});

describe('acquireDiscoveryLease: heartbeat and local fencing check', () => {
  it('renews every ttl/3 and stays valid through a round several TTLs long', async () => {
    const store = new FakeLeaseStore();
    const got = await acquireDiscoveryLease({ store, ttlMs: TTL, ownerId: 'worker-1' });
    if (!got.acquired) throw new Error('expected the lease');

    for (let elapsed = 0; elapsed < 5 * TTL; elapsed += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(got.lease.isValid()).toBe(true);
    }
    expect(store.value).toBe(got.lease.token);
    expect(store.renewCalls).toBeGreaterThanOrEqual(14); // 150 s / 10 s

    await got.lease.release();
    expect(store.value).toBeNull();
  });

  it('turns invalid as soon as a renewal is refused, and release() then leaves the new holder alone', async () => {
    const store = new FakeLeaseStore();
    const got = await acquireDiscoveryLease({ store, ttlMs: TTL, ownerId: 'worker-old' });
    if (!got.acquired) throw new Error('expected the lease');

    // Another process owns the key now (ours expired while we were paused).
    store.takeOver('2|worker-new', TTL);
    await vi.advanceTimersByTimeAsync(TTL / 3);
    await flush();
    expect(got.lease.isValid()).toBe(false);

    const releasesBefore = store.releaseCalls;
    await got.lease.release();
    expect(store.value).toBe('2|worker-new');
    // Lost leases do not even try to delete.
    expect(store.releaseCalls).toBe(releasesBefore);
  });

  it('turns invalid after a full TTL without a confirmed renewal (Redis errors), without waiting for Redis to answer', async () => {
    const store = new FakeLeaseStore();
    const got = await acquireDiscoveryLease({ store, ttlMs: TTL, ownerId: 'worker-1' });
    if (!got.acquired) throw new Error('expected the lease');
    vi.spyOn(store, 'renew').mockRejectedValue(new Error('ECONNRESET'));

    await vi.advanceTimersByTimeAsync(TTL - 1_000);
    expect(got.lease.isValid()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(got.lease.isValid()).toBe(false);

    await got.lease.release();
  });

  it('keeps a renewal that hangs from overlapping with the next tick and still expires validity locally', async () => {
    const store = new FakeLeaseStore();
    const got = await acquireDiscoveryLease({
      store,
      ttlMs: TTL,
      ownerId: 'worker-1',
      opTimeoutMs: 60_000,
    });
    if (!got.acquired) throw new Error('expected the lease');
    const renew = vi
      .spyOn(store, 'renew')
      .mockImplementation(() => new Promise<boolean>(() => undefined));

    await vi.advanceTimersByTimeAsync(TTL);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(got.lease.isValid()).toBe(false);
    await got.lease.release();
  });

  it('release() is idempotent and stops the heartbeat', async () => {
    const store = new FakeLeaseStore();
    const got = await acquireDiscoveryLease({ store, ttlMs: TTL, ownerId: 'worker-1' });
    if (!got.acquired) throw new Error('expected the lease');

    await got.lease.release();
    await got.lease.release();
    expect(store.releaseCalls).toBe(1);
    expect(got.lease.isValid()).toBe(false);

    const renewsAtRelease = store.renewCalls;
    await vi.advanceTimersByTimeAsync(5 * TTL);
    expect(store.renewCalls).toBe(renewsAtRelease);
  });
});

describe('acquireDiscoveryLease: fails open when Redis cannot answer', () => {
  it('times out a hanging acquire and returns an unguarded lease', async () => {
    const store = new FakeLeaseStore();
    vi.spyOn(store, 'tryAcquire').mockImplementation(
      () => new Promise<DiscoveryLeaseAcquireResult>(() => undefined)
    );

    const pending = acquireDiscoveryLease({
      store,
      ttlMs: TTL,
      ownerId: 'worker-1',
      opTimeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const got = await pending;

    expect(got.acquired).toBe(true);
    if (!got.acquired) throw new Error('unreachable');
    expect(got.failedOpen).toBe(true);
    expect(got.lease.token).toBeNull();
    expect(got.lease.epoch).toBeNull();
    expect(got.lease.isValid()).toBe(true);
    await expect(got.lease.release()).resolves.toBeUndefined();
  });

  it('treats an acquire error the same way', async () => {
    const store = new FakeLeaseStore();
    vi.spyOn(store, 'tryAcquire').mockRejectedValue(new Error('Connection is closed.'));

    const got = await acquireDiscoveryLease({ store, ttlMs: TTL, ownerId: 'worker-1' });
    expect(got).toMatchObject({ acquired: true, failedOpen: true });
  });
});

describe('createRedisDiscoveryLeaseStore', () => {
  function fakeClient(reply: unknown): LeaseRedisClient & { eval: ReturnType<typeof vi.fn> } {
    return { eval: vi.fn().mockResolvedValue(reply) };
  }

  it('acquires with one script over the lease key and the epoch counter, passing owner and TTL', async () => {
    const client = fakeClient([1, '7|host:12:abcd']);
    const store = createRedisDiscoveryLeaseStore(() => client);

    const result = await store.tryAcquire('host:12:abcd', 120_000);

    expect(result).toEqual({ acquired: true, token: '7|host:12:abcd', epoch: 7 });
    const [script, numKeys, ...args] = client.eval.mock.calls[0]!;
    expect(numKeys).toBe(2);
    expect(args).toEqual([
      DISCOVERY_LEASE_KEY,
      DISCOVERY_LEASE_EPOCH_KEY,
      'host:12:abcd',
      '120000',
    ]);
    expect(script).toContain("'NX'");
    expect(script).toContain("'PX'");
    expect(script).toContain('INCR');
  });

  it('reports the current holder when the key is taken', async () => {
    const store = createRedisDiscoveryLeaseStore(() => fakeClient([0, '3|other']));
    await expect(store.tryAcquire('me', 1_000)).resolves.toEqual({
      acquired: false,
      holder: '3|other',
    });
  });

  it('renews and releases only through compare-and-set scripts on the exact token', async () => {
    const renewClient = fakeClient(1);
    const renewStore = createRedisDiscoveryLeaseStore(() => renewClient);
    await expect(renewStore.renew('7|me', 120_000)).resolves.toBe(true);
    const [renewScript, renewKeys, ...renewArgs] = renewClient.eval.mock.calls[0]!;
    expect(renewKeys).toBe(1);
    expect(renewArgs).toEqual([DISCOVERY_LEASE_KEY, '7|me', '120000']);
    expect(renewScript).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(renewScript).toContain('PEXPIRE');

    await expect(
      createRedisDiscoveryLeaseStore(() => fakeClient(0)).renew('7|me', 1)
    ).resolves.toBe(false);

    const releaseClient = fakeClient(1);
    await expect(createRedisDiscoveryLeaseStore(() => releaseClient).release('7|me')).resolves.toBe(
      true
    );
    const [releaseScript, releaseKeys, ...releaseArgs] = releaseClient.eval.mock.calls[0]!;
    expect(releaseKeys).toBe(1);
    expect(releaseArgs).toEqual([DISCOVERY_LEASE_KEY, '7|me']);
    expect(releaseScript).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(releaseScript).toContain('DEL');

    await expect(createRedisDiscoveryLeaseStore(() => fakeClient(0)).release('7|me')).resolves.toBe(
      false
    );
  });
});

describe('configuration helpers', () => {
  it('isDiscoveryLeaseEnabled: explicit flag wins, otherwise on only in production', () => {
    expect(
      isDiscoveryLeaseEnabled({ MODEL_DISCOVERY_LEASE_ENABLED: 'true', NODE_ENV: 'test' })
    ).toBe(true);
    expect(
      isDiscoveryLeaseEnabled({ MODEL_DISCOVERY_LEASE_ENABLED: 'false', NODE_ENV: 'production' })
    ).toBe(false);
    expect(isDiscoveryLeaseEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(isDiscoveryLeaseEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(isDiscoveryLeaseEnabled({ NODE_ENV: 'development' })).toBe(false);
  });

  it('resolveDiscoveryLeaseTtlMs: default, invalid values and a floor of 10 s', () => {
    expect(resolveDiscoveryLeaseTtlMs({})).toBe(DEFAULT_DISCOVERY_LEASE_TTL_MS);
    expect(resolveDiscoveryLeaseTtlMs({ MODEL_DISCOVERY_LEASE_TTL_MS: 'abc' })).toBe(
      DEFAULT_DISCOVERY_LEASE_TTL_MS
    );
    expect(resolveDiscoveryLeaseTtlMs({ MODEL_DISCOVERY_LEASE_TTL_MS: '0' })).toBe(
      DEFAULT_DISCOVERY_LEASE_TTL_MS
    );
    expect(resolveDiscoveryLeaseTtlMs({ MODEL_DISCOVERY_LEASE_TTL_MS: '500' })).toBe(10_000);
    expect(resolveDiscoveryLeaseTtlMs({ MODEL_DISCOVERY_LEASE_TTL_MS: '300000' })).toBe(300_000);
  });

  it('parseLeaseEpoch reads the fencing epoch out of a token', () => {
    expect(parseLeaseEpoch('42|host:1:abcd')).toBe(42);
    expect(Number.isNaN(parseLeaseEpoch('garbage'))).toBe(true);
  });
});
