// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic tests for the Redis client factory's split-by-concern + HA
 * plumbing (scale-to-100k Phase 5, issue #150):
 *
 *   - by default (no REDIS_QUEUE_HOST, REDIS_SENTINEL_ENABLED, or
 *     REDIS_CLUSTER_ENABLED set) every client still points at the single general `REDIS_HOST`/
 *     `REDIS_PORT`, preserving today's single-instance behavior;
 *   - REDIS_SENTINEL_ENABLED swaps host/port for a `sentinels`/`name` option
 *     set (ioredis Sentinel mode — HA via failover, no sharding, so every
 *     existing multi-key/multi-db consumer keeps working unmodified);
 *   - REDIS_CLUSTER_ENABLED now fails fast instead of silently creating a
 *     single-node client while claiming cluster mode is active (the prior,
 *     misleading no-op — see redis-client.ts for why real Cluster mode isn't
 *     safe yet: BullMQ's non-hash-tagged keys + the `redis-global` layer's
 *     `db: 1` usage);
 *   - `getQueueRedisClient()`/`createRedisClient()` (BullMQ + the idempotency
 *     store) resolve against `REDIS_QUEUE_*`, independently of the general
 *     `getRedisClient()`/`getGlobalRedisClient()` connection, so an operator
 *     can point the money path at a physically separate, non-evicting Redis
 *     without any code change.
 *
 * ioredis is mocked with a bare recorder — this only proves the CONSTRUCTOR
 * OPTIONS are correct, not real Sentinel/Cluster wire behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakeRedisOptions {
  host?: string;
  port?: number;
  sentinels?: Array<{ host: string; port: number }>;
  name?: string;
  db?: number;
}

const constructedOptions: FakeRedisOptions[] = [];

vi.mock('ioredis', () => {
  class FakeRedis {
    options: FakeRedisOptions;
    constructor(options: FakeRedisOptions) {
      this.options = options;
      constructedOptions.push(options);
    }
    on() {
      return this;
    }
    once() {
      return this;
    }
    removeAllListeners() {
      return this;
    }
    duplicate() {
      return new FakeRedis(this.options);
    }
    quit() {
      return Promise.resolve('OK');
    }
    disconnect() {
      /* no-op */
    }
  }
  return { default: FakeRedis };
});

const ORIGINAL_ENV = process.env;

describe('redis-client', () => {
  beforeEach(() => {
    vi.resetModules();
    constructedOptions.length = 0;
    process.env = { ...ORIGINAL_ENV };
    delete process.env.REDIS_URL;
    delete process.env.REDIS_QUEUE_URL;
    delete process.env.REDIS_CLUSTER_ENABLED;
    delete process.env.REDIS_CLUSTER_NODES;
    delete process.env.REDIS_SENTINEL_ENABLED;
    delete process.env.REDIS_SENTINELS;
    delete process.env.REDIS_SENTINEL_NAME;
    delete process.env.REDIS_QUEUE_HOST;
    delete process.env.REDIS_QUEUE_PORT;
    delete process.env.REDIS_QUEUE_SENTINEL_ENABLED;
    delete process.env.REDIS_QUEUE_SENTINELS;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults every client to the single general host/port (today\'s behavior, unchanged)', async () => {
    process.env.REDIS_HOST = 'shared-host';
    process.env.REDIS_PORT = '7000';

    const { getRedisClient, getQueueRedisClient } = await import('../redis-client');
    getRedisClient();
    getQueueRedisClient();

    expect(constructedOptions).toHaveLength(2);
    for (const options of constructedOptions) {
      expect(options).toMatchObject({ host: 'shared-host', port: 7000 });
      expect(options.sentinels).toBeUndefined();
    }
  });

  it('creates a Sentinel-configured client when REDIS_SENTINEL_ENABLED=true', async () => {
    process.env.REDIS_SENTINEL_ENABLED = 'true';
    process.env.REDIS_SENTINELS = 'sentinel-1:26379,sentinel-2:26379';
    process.env.REDIS_SENTINEL_NAME = 'my-master-group';

    const { getRedisClient } = await import('../redis-client');
    getRedisClient();

    const options = constructedOptions[0]!;
    expect(options.sentinels).toEqual([
      { host: 'sentinel-1', port: 26379 },
      { host: 'sentinel-2', port: 26379 },
    ]);
    expect(options.name).toBe('my-master-group');
    expect(options.host).toBeUndefined();
  });

  it('throws instead of silently ignoring REDIS_CLUSTER_ENABLED', async () => {
    process.env.REDIS_CLUSTER_ENABLED = 'true';
    process.env.REDIS_CLUSTER_NODES = 'node-1:6379,node-2:6379';

    const { getRedisClient } = await import('../redis-client');
    expect(() => getRedisClient()).toThrow(/REDIS_CLUSTER_ENABLED is not supported/);
    expect(constructedOptions).toHaveLength(0);
  });

  it('routes the queue client through REDIS_QUEUE_* overrides, independent of the general client', async () => {
    process.env.REDIS_HOST = 'cache-host';
    process.env.REDIS_PORT = '7000';
    process.env.REDIS_QUEUE_HOST = 'queue-host';
    process.env.REDIS_QUEUE_PORT = '7001';

    const { getRedisClient, getQueueRedisClient } = await import('../redis-client');
    getRedisClient();
    getQueueRedisClient();

    expect(constructedOptions).toHaveLength(2);
    expect(constructedOptions[0]).toMatchObject({ host: 'cache-host', port: 7000 });
    expect(constructedOptions[1]).toMatchObject({ host: 'queue-host', port: 7001 });
  });

  it('falls back the queue client to the general host/port when REDIS_QUEUE_* is unset', async () => {
    process.env.REDIS_HOST = 'shared-host';
    process.env.REDIS_PORT = '7000';

    const { getQueueRedisClient } = await import('../redis-client');
    getQueueRedisClient();

    expect(constructedOptions[0]).toMatchObject({ host: 'shared-host', port: 7000 });
  });

  it('createRedisClient (BullMQ/queue isolated connections) resolves against the queue config, not the general one', async () => {
    process.env.REDIS_HOST = 'cache-host';
    process.env.REDIS_PORT = '7000';
    process.env.REDIS_QUEUE_HOST = 'queue-host';
    process.env.REDIS_QUEUE_PORT = '7001';

    const { createRedisClient } = await import('../redis-client');
    createRedisClient('bullmq-test');

    expect(constructedOptions).toHaveLength(1);
    expect(constructedOptions[0]).toMatchObject({ host: 'queue-host', port: 7001 });
  });

  it('REDIS_QUEUE_SENTINEL_ENABLED can be set independently of the general REDIS_SENTINEL_ENABLED', async () => {
    process.env.REDIS_QUEUE_SENTINEL_ENABLED = 'true';
    process.env.REDIS_QUEUE_SENTINELS = 'q-sentinel-1:26379';

    const { getRedisClient, getQueueRedisClient } = await import('../redis-client');
    getRedisClient();
    getQueueRedisClient();

    expect(constructedOptions[0]!.sentinels).toBeUndefined(); // general client: plain host/port
    expect(constructedOptions[1]!.sentinels).toEqual([{ host: 'q-sentinel-1', port: 26379 }]);
  });
});
