// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * discovery-fleet-health.ts: the fleet-wide verdict behind the auto-disable
 * circuit breaker (2026-09-24 review fix).
 *
 * Pins:
 *   - decideAutoDisableDiscoverySignal() trusts only verdicts from a complete
 *     round no older than the limit, prefers the newest, and exempts the
 *     union of every fresh verdict's flagged providers;
 *   - no verdict at all, or only stale ones, is "untrusted" with a reason
 *     (the sweep then disables nothing);
 *   - the snapshot parser rejects anything malformed instead of trusting it;
 *   - the Redis store sends exactly GET / SET PX on the documented key;
 *   - publish and read never throw (Redis trouble is a warning / "absent").
 *
 * Hermetic: the real Redis client is mocked to throw if anything reaches it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/cache/redis-client', () => ({
  getQueueRedisClient: () => {
    throw new Error('unit test must not reach the real Redis client');
  },
}));

import {
  createRedisDiscoveryHealthSnapshotStore,
  decideAutoDisableDiscoverySignal,
  DEFAULT_DISCOVERY_SIGNAL_MAX_AGE_MS,
  DISCOVERY_HEALTH_SNAPSHOT_KEY,
  DISCOVERY_HEALTH_SNAPSHOT_TTL_MS,
  parseDiscoveryHealthSnapshot,
  publishDiscoveryHealthSnapshot,
  readDiscoveryHealthSnapshot,
  resolveDiscoverySignalMaxAgeMs,
  type DiscoveryHealthSnapshot,
  type DiscoveryHealthSnapshotStore,
  type SnapshotRedisClient,
} from '@/services/discovery-fleet-health';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 24, 5, 0, 0);

function snapshot(overrides: Partial<DiscoveryHealthSnapshot> = {}): DiscoveryHealthSnapshot {
  return {
    version: 1,
    completedAt: NOW - 30 * 60 * 1000,
    unhealthyProviders: ['aws-bedrock'],
    sourcesAttempted: 250,
    owner: 'ci-api-1:1',
    leaseEpoch: 7,
    ...overrides,
  };
}

class MemoryStore implements DiscoveryHealthSnapshotStore {
  value: string | null = null;
  lastTtlMs: number | null = null;
  async read(): Promise<string | null> {
    return this.value;
  }
  async write(value: string, ttlMs: number): Promise<void> {
    this.value = value;
    this.lastTtlMs = ttlMs;
  }
}

describe('decideAutoDisableDiscoverySignal', () => {
  it('is untrusted when no complete round was ever recorded (the blind-process case)', () => {
    const signal = decideAutoDisableDiscoverySignal([null, null], 3 * HOUR, NOW);

    expect(signal.trusted).toBe(false);
    if (signal.trusted) throw new Error('unreachable');
    expect(signal.newestCompletedAt).toBeNull();
    expect(signal.reason).toMatch(/no complete discovery round/);
  });

  it('is untrusted when every verdict is older than the limit, and reports the newest one', () => {
    const signal = decideAutoDisableDiscoverySignal(
      [
        { basis: 'local', completedAt: NOW - 5 * HOUR, unhealthyProviders: [] },
        { basis: 'fleet', completedAt: NOW - 4 * HOUR, unhealthyProviders: [] },
      ],
      3 * HOUR,
      NOW
    );

    expect(signal.trusted).toBe(false);
    if (signal.trusted) throw new Error('unreachable');
    expect(signal.newestCompletedAt?.getTime()).toBe(NOW - 4 * HOUR);
    expect(signal.reason).toMatch(/240 min ago.*180 min limit/);
  });

  it('trusts a fresh fleet verdict even when this process never ran a round', () => {
    const signal = decideAutoDisableDiscoverySignal(
      [null, { basis: 'fleet', completedAt: NOW - HOUR, unhealthyProviders: ['orqai'] }],
      3 * HOUR,
      NOW
    );

    expect(signal).toMatchObject({ trusted: true, basis: 'fleet', ageMs: HOUR });
    if (!signal.trusted) throw new Error('unreachable');
    expect(signal.unhealthyProviders).toEqual(new Set(['orqai']));
  });

  it('takes the newest fresh verdict as basis and exempts the union of all fresh verdicts', () => {
    const signal = decideAutoDisableDiscoverySignal(
      [
        { basis: 'local', completedAt: NOW - 2 * HOUR, unhealthyProviders: ['aws-bedrock'] },
        { basis: 'fleet', completedAt: NOW - 10 * 60 * 1000, unhealthyProviders: ['orqai'] },
      ],
      3 * HOUR,
      NOW
    );

    expect(signal).toMatchObject({ trusted: true, basis: 'fleet' });
    if (!signal.trusted) throw new Error('unreachable');
    expect(signal.unhealthyProviders).toEqual(new Set(['aws-bedrock', 'orqai']));
  });

  it('ignores the flagged providers of a stale verdict next to a fresh one', () => {
    const signal = decideAutoDisableDiscoverySignal(
      [
        { basis: 'local', completedAt: NOW - 30 * 60 * 1000, unhealthyProviders: [] },
        { basis: 'fleet', completedAt: NOW - 9 * HOUR, unhealthyProviders: ['orqai'] },
      ],
      3 * HOUR,
      NOW
    );

    expect(signal).toMatchObject({ trusted: true, basis: 'local' });
    if (!signal.trusted) throw new Error('unreachable');
    expect(signal.unhealthyProviders.size).toBe(0);
  });
});

describe('resolveDiscoverySignalMaxAgeMs', () => {
  it('defaults to 3 hours and honours a positive override', () => {
    expect(DEFAULT_DISCOVERY_SIGNAL_MAX_AGE_MS).toBe(3 * HOUR);
    expect(resolveDiscoverySignalMaxAgeMs({})).toBe(3 * HOUR);
    expect(resolveDiscoverySignalMaxAgeMs({ MODEL_AUTO_DISABLE_DISCOVERY_MAX_AGE_MS: '7200000' })).toBe(
      2 * HOUR
    );
  });

  it('falls back to the default for invalid or non-positive values', () => {
    for (const raw of ['0', '-5', 'abc', '']) {
      expect(resolveDiscoverySignalMaxAgeMs({ MODEL_AUTO_DISABLE_DISCOVERY_MAX_AGE_MS: raw })).toBe(
        3 * HOUR
      );
    }
  });
});

describe('parseDiscoveryHealthSnapshot', () => {
  it('round-trips a valid snapshot', () => {
    const value = snapshot();
    expect(parseDiscoveryHealthSnapshot(JSON.stringify(value))).toEqual(value);
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['not JSON', '{nope'],
    ['an array', '[]'],
    ['a wrong version', JSON.stringify({ ...snapshot(), version: 2 })],
    ['a non-numeric completedAt', JSON.stringify({ ...snapshot(), completedAt: '2026-09-24' })],
    ['non-string providers', JSON.stringify({ ...snapshot(), unhealthyProviders: [1, 2] })],
    ['missing sourcesAttempted', JSON.stringify({ ...snapshot(), sourcesAttempted: undefined })],
  ])('rejects %s', (_label, raw) => {
    expect(parseDiscoveryHealthSnapshot(raw)).toBeNull();
  });
});

describe('Redis snapshot store', () => {
  it('reads with GET and writes with SET ... PX on the documented key', async () => {
    const calls: unknown[][] = [];
    const client: SnapshotRedisClient = {
      get: async (key) => {
        calls.push(['get', key]);
        return 'stored';
      },
      set: async (key, value, mode, ttlMs) => {
        calls.push(['set', key, value, mode, ttlMs]);
        return 'OK';
      },
    };
    const store = createRedisDiscoveryHealthSnapshotStore(() => client);

    await store.write('{"v":1}', 1234);
    await expect(store.read()).resolves.toBe('stored');

    expect(DISCOVERY_HEALTH_SNAPSHOT_KEY).toBe('ci:model-discovery:health-snapshot');
    expect(calls).toEqual([
      ['set', DISCOVERY_HEALTH_SNAPSHOT_KEY, '{"v":1}', 'PX', 1234],
      ['get', DISCOVERY_HEALTH_SNAPSHOT_KEY],
    ]);
  });
});

describe('publishDiscoveryHealthSnapshot / readDiscoveryHealthSnapshot', () => {
  it('publishes the JSON with the GC TTL and reads it back', async () => {
    const store = new MemoryStore();
    const value = snapshot();

    await expect(publishDiscoveryHealthSnapshot(value, { store })).resolves.toBe(true);
    expect(store.lastTtlMs).toBe(DISCOVERY_HEALTH_SNAPSHOT_TTL_MS);
    await expect(readDiscoveryHealthSnapshot({ store })).resolves.toEqual(value);
  });

  it('never throws: a failing or hanging store is a false publish and an absent read', async () => {
    const failing: DiscoveryHealthSnapshotStore = {
      read: async () => {
        throw new Error('ECONNREFUSED');
      },
      write: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const hanging: DiscoveryHealthSnapshotStore = {
      read: () => new Promise<string | null>(() => undefined),
      write: () => new Promise<void>(() => undefined),
    };

    await expect(publishDiscoveryHealthSnapshot(snapshot(), { store: failing })).resolves.toBe(false);
    await expect(readDiscoveryHealthSnapshot({ store: failing })).resolves.toBeNull();
    await expect(
      publishDiscoveryHealthSnapshot(snapshot(), { store: hanging, opTimeoutMs: 20 })
    ).resolves.toBe(false);
    await expect(readDiscoveryHealthSnapshot({ store: hanging, opTimeoutMs: 20 })).resolves.toBeNull();
  });

  it('treats a malformed stored value as absent', async () => {
    const store = new MemoryStore();
    store.value = '{"version":1}';
    await expect(readDiscoveryHealthSnapshot({ store })).resolves.toBeNull();
  });

  it('the default store goes through getQueueRedisClient, and its failure is contained', async () => {
    // The mocked client getter throws; publish/read must still not throw.
    await expect(publishDiscoveryHealthSnapshot(snapshot())).resolves.toBe(false);
    await expect(readDiscoveryHealthSnapshot()).resolves.toBeNull();
  });
});
