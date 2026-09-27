// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CATALOG_SNAPSHOT_PUBLISH_SCRIPT against a real Redis 7 (the same
 * `redis:7-alpine` image production's `redis-cache` runs), so the Lua itself,
 * not a JS model of it, is what these cases prove: cjson decoding of the
 * meta, RENAME over the live key, TTLs, and the compare-and-swap decision.
 *
 * Runs in the "Integration tests" CI step (vitest.integration.config.ts
 * picks up *.integration.test.ts), which already requires Docker for
 * Testcontainers. It starts its own throwaway Redis container.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { CATALOG_REDIS_KEY, CATALOG_REDIS_META_KEY } from '@/services/catalog-hot-path';
import {
  CATALOG_SNAPSHOT_STAGING_PREFIX,
  CATALOG_SNAPSHOT_STAGING_TTL_MS,
  publishCatalogSnapshotCas,
} from '@/services/catalog-snapshot-publisher';

let container: StartedRedisContainer;
let redis: Redis;

function snapshot(ids: string[], generatedAt: number) {
  return {
    json: JSON.stringify(ids.map((id) => ({ id }))),
    meta: { fingerprint: `fp-${ids.join('-')}`, rowCount: ids.length, generatedAt },
  };
}

async function liveIds(): Promise<string[]> {
  const raw = await redis.get(CATALOG_REDIS_KEY);
  return raw ? (JSON.parse(raw) as Array<{ id: string }>).map((m) => m.id) : [];
}

async function liveVersion(): Promise<number | null> {
  const raw = await redis.get(CATALOG_REDIS_META_KEY);
  return raw ? (JSON.parse(raw) as { generatedAt: number }).generatedAt : null;
}

async function stagingKeys(): Promise<string[]> {
  return redis.keys(`${CATALOG_SNAPSHOT_STAGING_PREFIX}*`);
}

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis({
    host: container.getHost(),
    port: container.getMappedPort(6379),
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
}, 120_000);

afterAll(async () => {
  await redis?.quit().catch(() => undefined);
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await redis.flushall();
});

describe('catalog snapshot publish script on a real Redis 7', () => {
  it('publishes snapshot and meta with the live TTL and removes the staging key', async () => {
    const snap = snapshot(['a', 'b'], 1_000);
    // Live TTL well above the staging TTL: RENAME carries the staging key's
    // TTL over, so this proves the script re-applied the live one.
    const liveTtlMs = CATALOG_SNAPSHOT_STAGING_TTL_MS * 5;

    await expect(publishCatalogSnapshotCas(redis, snap, liveTtlMs)).resolves.toBe('published');

    expect(await liveIds()).toEqual(['a', 'b']);
    expect(JSON.parse((await redis.get(CATALOG_REDIS_META_KEY)) ?? 'null')).toEqual(snap.meta);
    for (const key of [CATALOG_REDIS_KEY, CATALOG_REDIS_META_KEY]) {
      const ttl = await redis.pttl(key);
      expect(ttl).toBeGreaterThan(CATALOG_SNAPSHOT_STAGING_TTL_MS);
      expect(ttl).toBeLessThanOrEqual(liveTtlMs);
    }
    expect(await stagingKeys()).toEqual([]);
  });

  it('rejects an older version while the newer snapshot is live', async () => {
    await publishCatalogSnapshotCas(redis, snapshot(['new'], 2_000), 90_000);

    await expect(publishCatalogSnapshotCas(redis, snapshot(['old'], 1_000), 90_000)).resolves.toBe(
      'superseded'
    );

    expect(await liveIds()).toEqual(['new']);
    expect(await liveVersion()).toBe(2_000);
    expect(await stagingKeys()).toEqual([]);
  });

  it('accepts an equal or newer version', async () => {
    await publishCatalogSnapshotCas(redis, snapshot(['v1'], 1_000), 90_000);
    await expect(publishCatalogSnapshotCas(redis, snapshot(['v1b'], 1_000), 90_000)).resolves.toBe(
      'published'
    );
    expect(await liveIds()).toEqual(['v1b']);

    await expect(publishCatalogSnapshotCas(redis, snapshot(['v2'], 1_758_672_000_000), 90_000)).resolves.toBe(
      'published'
    );
    expect(await liveIds()).toEqual(['v2']);
    expect(await liveVersion()).toBe(1_758_672_000_000);
  });

  it('publishes an older version when the newer meta lost its snapshot', async () => {
    await publishCatalogSnapshotCas(redis, snapshot(['new'], 2_000), 90_000);
    await redis.del(CATALOG_REDIS_KEY);

    await expect(publishCatalogSnapshotCas(redis, snapshot(['old'], 1_000), 90_000)).resolves.toBe(
      'published'
    );
    expect(await liveIds()).toEqual(['old']);
    expect(await liveVersion()).toBe(1_000);
  });

  it('treats a malformed meta and a meta without generatedAt as absent', async () => {
    await redis.set(CATALOG_REDIS_KEY, '[]');
    await redis.set(CATALOG_REDIS_META_KEY, '{not json');
    await expect(publishCatalogSnapshotCas(redis, snapshot(['a'], 1_000), 90_000)).resolves.toBe(
      'published'
    );

    await redis.set(CATALOG_REDIS_META_KEY, JSON.stringify({ fingerprint: 'x', rowCount: 1 }));
    await expect(publishCatalogSnapshotCas(redis, snapshot(['b'], 500), 90_000)).resolves.toBe(
      'published'
    );
    expect(await liveIds()).toEqual(['b']);
  });

  it('returns staging-lost and changes nothing when the staging key is gone', async () => {
    await publishCatalogSnapshotCas(redis, snapshot(['live'], 1_000), 90_000);
    const evicting = {
      set: async () => 'OK' as const, // staging write never lands (as if evicted)
      eval: redis.eval.bind(redis),
      del: redis.del.bind(redis),
    } as unknown as Redis;

    await expect(publishCatalogSnapshotCas(evicting, snapshot(['next'], 2_000), 90_000)).resolves.toBe(
      'staging-lost'
    );
    expect(await liveIds()).toEqual(['live']);
    expect(await liveVersion()).toBe(1_000);
  });
});
