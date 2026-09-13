// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capacity-scaling plan (docs/CAPACITY-SCALING-PLAN-10K-USERS.md, Track 1
 * §2.3) regression suite: the catalog hot-path cache (`getAllCatalogModels`)
 * used to run its full-catalog Postgres query (all non-disabled models —
 * 111k+ rows and growing, no static cap) independently, undeduplicated, on
 * a 4-minute timer in EVERY `ci_api` replica AND `ci_worker`.
 *
 * These tests prove the fix end to end with a fake, shared, in-memory
 * "Redis" (a plain Map, standing in for the real `redis-cache` instance) and
 * a mocked `prisma.model.findMany`:
 *
 *  - only the BullMQ-elected process's refreshCatalogCacheAhead() ever
 *    queries Postgres; a second, independent replica hydrates the SAME
 *    result from the shared Redis snapshot without querying Postgres at
 *    all (simulated via `vi.resetModules()` between "replicas" — each import
 *    gets its own module-level in-process cache state, exactly like two
 *    separate Node processes, while sharing the same fake Redis backing
 *    store declared at file scope);
 *  - concurrent cold-cache misses within ONE process still single-flight
 *    onto one query (pre-existing thundering-herd guard, unchanged);
 *  - a fresh-environment boot (nothing published to Redis yet) still
 *    produces a correct, non-empty catalog via direct Postgres fallback;
 *  - a Redis outage (every call throws) still produces a correct, non-empty
 *    catalog via direct Postgres fallback — fail-open-to-degraded, never
 *    fail-to-empty;
 *  - invalidateCatalogCache() clears the Redis snapshot too, so a caller
 *    that explicitly forced a fresh reload doesn't immediately re-hydrate
 *    stale pre-invalidation data;
 *  - the full-enumeration invariant (no `take:` cap) holds on the actual
 *    Postgres call args, not just via source inspection;
 *  - refreshCatalogCacheAhead() (the fleet-wide writer) always re-queries
 *    Postgres even when its own local cache is warm — it must never
 *    silently degrade into "just re-read my own cache".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CATALOG_REDIS_KEY,
  CATALOG_REDIS_META_KEY,
  parseCatalogSnapshotMeta,
} from '@/services/catalog-hot-path';

const findManyMock = vi.fn();

vi.mock('@/database/client', () => ({
  prisma: { model: { findMany: (...args: unknown[]) => findManyMock(...args) } },
  Prisma: {},
}));

const fakeRedisStore = new Map<string, string>();
let redisShouldThrow = false;

const redisGet = vi.fn(async (key: string) => {
  if (redisShouldThrow) throw new Error('redis unavailable (test)');
  return fakeRedisStore.get(key) ?? null;
});
const redisSet = vi.fn(async (key: string, value: string) => {
  if (redisShouldThrow) throw new Error('redis unavailable (test)');
  fakeRedisStore.set(key, value);
  return 'OK';
});
const redisDel = vi.fn(async (key: string) => {
  if (redisShouldThrow) throw new Error('redis unavailable (test)');
  return fakeRedisStore.delete(key) ? 1 : 0;
});

vi.mock('@/cache/redis-client', () => ({
  getRedisClient: () => ({ get: redisGet, set: redisSet, del: redisDel }),
}));

function makeRecord(id: string, providerName: string) {
  return {
    id,
    providerId: providerName,
    name: id,
    displayName: id,
    contextWindow: 8000,
    maxOutputTokens: 1000,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat'],
    performance: {},
    status: 'active',
    metadata: null,
    lastSyncedAt: null,
    provider: { name: providerName },
  };
}

beforeEach(() => {
  fakeRedisStore.clear();
  redisShouldThrow = false;
  findManyMock.mockReset();
  redisGet.mockClear();
  redisSet.mockClear();
  redisDel.mockClear();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

function redisGetKeys(): string[] {
  return redisGet.mock.calls.map(([key]) => key);
}

function storedMeta() {
  return parseCatalogSnapshotMeta(fakeRedisStore.get(CATALOG_REDIS_META_KEY) ?? null);
}

describe('model-catalog-service fleet-wide Redis snapshot (capacity-scaling plan Track 1 §2.3)', () => {
  it('election-winner simulation: the elected refresh queries Postgres once; a second replica hydrates from Redis without querying Postgres at all', async () => {
    findManyMock.mockResolvedValue([makeRecord('model-a', 'provA')]);

    // Replica A: simulates the BullMQ-elected process running its tick.
    const replicaA = await import('@/services/model-catalog-service');
    await replicaA.refreshCatalogCacheAhead();
    expect(findManyMock).toHaveBeenCalledTimes(1);

    // Replica B: a fresh module instance (independent in-process cache
    // state, exactly like a second ci_api replica) that did NOT win the
    // tick — it only ever calls the cold-path resolver.
    vi.resetModules();
    const replicaB = await import('@/services/model-catalog-service');
    const models = await replicaB.getAllCatalogModels();

    // Still exactly 1 — replica B hydrated from the shared Redis snapshot,
    // it never ran its own findMany.
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('model-a');
    expect(models[0].provider).toBe('provA');
  });

  it('concurrent cold-cache misses within one process single-flight onto ONE Postgres query (pre-existing thundering-herd guard)', async () => {
    findManyMock.mockResolvedValue([makeRecord('model-a', 'provA')]);
    const svc = await import('@/services/model-catalog-service');

    const [a, b, c] = await Promise.all([
      svc.getAllCatalogModels(),
      svc.getAllCatalogModels(),
      svc.getAllCatalogModels(),
    ]);

    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('fresh-environment boot: nothing published to Redis yet, so getAllCatalogModels() still returns a correct, non-empty catalog via direct Postgres fallback', async () => {
    findManyMock.mockResolvedValue([
      makeRecord('model-a', 'provA'),
      makeRecord('model-b', 'provB'),
    ]);
    const svc = await import('@/services/model-catalog-service');

    expect(fakeRedisStore.size).toBe(0); // nothing published yet
    const models = await svc.getAllCatalogModels();

    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(models.length).toBe(2);
    // ...and it publishes (snapshot + its content-fingerprint meta) for the
    // next replica to hydrate from.
    expect(fakeRedisStore.size).toBe(2);
    expect(fakeRedisStore.has(CATALOG_REDIS_KEY)).toBe(true);
    expect(fakeRedisStore.has(CATALOG_REDIS_META_KEY)).toBe(true);
  });

  it('Redis-unavailable fallback: getAllCatalogModels() still produces a correct, non-empty catalog when every Redis call throws', async () => {
    redisShouldThrow = true;
    findManyMock.mockResolvedValue([makeRecord('model-a', 'provA')]);
    const svc = await import('@/services/model-catalog-service');

    const models = await svc.getAllCatalogModels();

    expect(models.length).toBe(1);
    expect(models[0].id).toBe('model-a');
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateCatalogCache() clears the fleet-wide Redis snapshot too, so a forced reload does not immediately re-hydrate stale data', async () => {
    findManyMock
      .mockResolvedValueOnce([makeRecord('model-old', 'provA')])
      .mockResolvedValueOnce([makeRecord('model-new', 'provA')]);
    const svc = await import('@/services/model-catalog-service');

    const first = await svc.getAllCatalogModels();
    expect(first[0]?.id).toBe('model-old');
    expect(findManyMock).toHaveBeenCalledTimes(1);

    svc.invalidateCatalogCache();
    // Let the fire-and-forget Redis delete settle.
    await vi.waitFor(() => expect(fakeRedisStore.size).toBe(0));

    const second = await svc.getAllCatalogModels();
    expect(findManyMock).toHaveBeenCalledTimes(2);
    expect(second[0]?.id).toBe('model-new');
  });

  it('full-enumeration invariant: the direct Postgres rebuild never adds a `take` cap (pinned per model-catalog-service.ts\'s own "do NOT add take:" comment)', async () => {
    findManyMock.mockResolvedValue([makeRecord('model-a', 'provA')]);
    const svc = await import('@/services/model-catalog-service');

    await svc.getAllCatalogModels();

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const callArgs = findManyMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('take');
    expect(callArgs.where).toEqual({ status: { not: 'disabled' } });
  });

  it('refreshCatalogCacheAhead() always re-queries Postgres even when its own local cache is already warm — it is the fleet-wide writer, not a cache reader', async () => {
    findManyMock
      .mockResolvedValueOnce([makeRecord('model-a', 'provA')])
      .mockResolvedValueOnce([makeRecord('model-a', 'provA'), makeRecord('model-b', 'provB')]);
    const svc = await import('@/services/model-catalog-service');

    await svc.getAllCatalogModels(); // warms local cache + Redis via Postgres
    expect(findManyMock).toHaveBeenCalledTimes(1);

    await svc.refreshCatalogCacheAhead(); // fleet-wide tick — must hit Postgres again
    expect(findManyMock).toHaveBeenCalledTimes(2);

    const models = await svc.getAllCatalogModels(); // served from the just-refreshed local cache
    expect(models.length).toBe(2);
    expect(findManyMock).toHaveBeenCalledTimes(2);
  });

  it('hydrateCatalogCacheAhead() (the per-process keep-warm step) hydrates from Redis but NEVER touches Postgres, even on a cold local cache', async () => {
    findManyMock.mockResolvedValue([makeRecord('model-a', 'provA')]);
    const publisher = await import('@/services/model-catalog-service');
    await publisher.refreshCatalogCacheAhead(); // publish a snapshot for the next replica
    expect(findManyMock).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const replica = await import('@/services/model-catalog-service');
    await replica.hydrateCatalogCacheAhead();

    expect(findManyMock).toHaveBeenCalledTimes(1); // unchanged — no Postgres call from this replica
    const models = await replica.getAllCatalogModels(); // now served warm, from the hydrate above
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(models[0]?.id).toBe('model-a');
  });

  it('hydrateCatalogCacheAhead() is a silent no-op when Redis has nothing published (does not throw, does not touch Postgres)', async () => {
    const svc = await import('@/services/model-catalog-service');
    await expect(svc.hydrateCatalogCacheAhead()).resolves.toBeUndefined();
    expect(findManyMock).not.toHaveBeenCalled();
  });
});

/**
 * Snapshot content fingerprint (2026-09): the elected producer republishes
 * the >100 MB snapshot every 4 minutes whether or not anything changed, and
 * every process used to GET + JSON.parse it on every tick. The producer now
 * also publishes CATALOG_REDIS_META_KEY (content sha256 + rowCount); readers
 * fetch that first and skip the big GET + parse when it matches what they
 * already hold, extending their local TTL instead. These cases pin the skip,
 * the hydrate-on-change, and the compatibility fallbacks.
 */
describe('model-catalog-service snapshot fingerprint (skip unchanged snapshot)', () => {
  async function publishThenHydrateReplica(records: unknown[]) {
    findManyMock.mockResolvedValue(records);
    const publisher = await import('@/services/model-catalog-service');
    await publisher.refreshCatalogCacheAhead();
    expect(findManyMock).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const replica = await import('@/services/model-catalog-service');
    await replica.hydrateCatalogCacheAhead();
    expect(redisGetKeys()).toEqual([CATALOG_REDIS_META_KEY, CATALOG_REDIS_KEY]);
    redisGet.mockClear();
    return replica;
  }

  it('publishes the snapshot BEFORE its meta, so a reader can never pair a new fingerprint with an old snapshot', async () => {
    findManyMock.mockResolvedValue([makeRecord('model-a', 'provA')]);
    const svc = await import('@/services/model-catalog-service');
    await svc.refreshCatalogCacheAhead();

    const setKeys = redisSet.mock.calls.map(([key]) => key);
    expect(setKeys).toEqual([CATALOG_REDIS_KEY, CATALOG_REDIS_META_KEY]);
    const meta = storedMeta();
    expect(meta).not.toBeNull();
    expect(meta?.rowCount).toBe(1);
    expect(meta?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(svc.getCatalogFingerprint()).toBe(meta?.fingerprint);
    // The wire format is unchanged: a plain JSON array in scan order.
    expect(JSON.parse(fakeRedisStore.get(CATALOG_REDIS_KEY) ?? '')).toEqual(
      JSON.parse(JSON.stringify(await svc.getAllCatalogModels()))
    );
  });

  it('skips the snapshot GET + parse when the published fingerprint matches what the replica already holds (meta-only read, same models, same indices)', async () => {
    const replica = await publishThenHydrateReplica([makeRecord('model-a', 'provA')]);
    const before = await replica.getAllCatalogModels();
    const indicesBefore = replica.getCatalogIndices();

    await replica.hydrateCatalogCacheAhead();

    expect(redisGetKeys()).toEqual([CATALOG_REDIS_META_KEY]);
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(await replica.getAllCatalogModels()).toBe(before);
    expect(replica.getCatalogIndices()).toBe(indicesBefore);
    expect(replica.getCatalogFingerprint()).toBe(storedMeta()?.fingerprint);
  });

  it('the skip path extends the local TTL: after CATALOG_CACHE_TTL_MS the cold path still resolves via the unchanged snapshot, never Postgres', async () => {
    vi.useFakeTimers();
    const replica = await publishThenHydrateReplica([makeRecord('model-a', 'provA')]);

    await vi.advanceTimersByTimeAsync(7 * 60_000); // past the 6min local TTL
    const models = await replica.getAllCatalogModels();

    expect(redisGetKeys()).toEqual([CATALOG_REDIS_META_KEY]);
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(models[0]?.id).toBe('model-a');
  });

  it('hydrates fully when the published fingerprint changed (producer republished different rows)', async () => {
    const replica = await publishThenHydrateReplica([makeRecord('model-a', 'provA')]);

    findManyMock.mockResolvedValue([makeRecord('model-a', 'provA'), makeRecord('model-b', 'provB')]);
    vi.resetModules();
    const publisher = await import('@/services/model-catalog-service');
    await publisher.refreshCatalogCacheAhead();
    expect(findManyMock).toHaveBeenCalledTimes(2);
    redisGet.mockClear();

    await replica.hydrateCatalogCacheAhead();

    expect(redisGetKeys()).toEqual([CATALOG_REDIS_META_KEY, CATALOG_REDIS_KEY]);
    expect((await replica.getAllCatalogModels()).map((m) => m.id)).toEqual(['model-a', 'model-b']);
    expect(findManyMock).toHaveBeenCalledTimes(2); // only the publisher touched Postgres
  });

  it('hydrates fully when a replica has no local catalog yet, even though meta is present', async () => {
    findManyMock.mockResolvedValue([makeRecord('model-a', 'provA')]);
    const publisher = await import('@/services/model-catalog-service');
    await publisher.refreshCatalogCacheAhead();
    redisGet.mockClear();

    vi.resetModules();
    const replica = await import('@/services/model-catalog-service');
    expect(replica.getCatalogFingerprint()).toBeNull();
    await replica.hydrateCatalogCacheAhead();

    expect(redisGetKeys()).toEqual([CATALOG_REDIS_META_KEY, CATALOG_REDIS_KEY]);
    expect((await replica.getAllCatalogModels())[0]?.id).toBe('model-a');
    expect(replica.getCatalogFingerprint()).toBe(storedMeta()?.fingerprint);
  });

  it('treats a missing meta (producer on the previous version) as "changed": GET + parse on every hydrate, still no Postgres', async () => {
    const replica = await publishThenHydrateReplica([makeRecord('model-a', 'provA')]);
    fakeRedisStore.delete(CATALOG_REDIS_META_KEY);

    await replica.hydrateCatalogCacheAhead();
    await replica.hydrateCatalogCacheAhead();

    expect(redisGetKeys()).toEqual([
      CATALOG_REDIS_META_KEY,
      CATALOG_REDIS_KEY,
      CATALOG_REDIS_META_KEY,
      CATALOG_REDIS_KEY,
    ]);
    expect(replica.getCatalogFingerprint()).toBeNull();
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect((await replica.getAllCatalogModels())[0]?.id).toBe('model-a');
  });

  it('treats a malformed meta as "changed" and never installs a fingerprint from it', async () => {
    const replica = await publishThenHydrateReplica([makeRecord('model-a', 'provA')]);
    fakeRedisStore.set(CATALOG_REDIS_META_KEY, '{not json');

    await replica.hydrateCatalogCacheAhead();

    expect(redisGetKeys()).toEqual([CATALOG_REDIS_META_KEY, CATALOG_REDIS_KEY]);
    expect(replica.getCatalogFingerprint()).toBeNull();
  });

  it('a rowCount mismatch between meta and snapshot (read across a republish) records an unknown fingerprint so the next tick re-parses', async () => {
    findManyMock.mockResolvedValue([makeRecord('model-a', 'provA')]);
    const publisher = await import('@/services/model-catalog-service');
    await publisher.refreshCatalogCacheAhead();
    const meta = storedMeta();
    fakeRedisStore.set(CATALOG_REDIS_META_KEY, JSON.stringify({ ...meta, rowCount: 99 }));
    redisGet.mockClear();

    vi.resetModules();
    const replica = await import('@/services/model-catalog-service');
    await replica.hydrateCatalogCacheAhead();
    expect(redisGetKeys()).toEqual([CATALOG_REDIS_META_KEY, CATALOG_REDIS_KEY]);
    expect((await replica.getAllCatalogModels())[0]?.id).toBe('model-a');
    expect(replica.getCatalogFingerprint()).toBeNull();
    redisGet.mockClear();

    // Not trusted, so no skip: the next tick reads the snapshot again.
    await replica.hydrateCatalogCacheAhead();
    expect(redisGetKeys()).toEqual([CATALOG_REDIS_META_KEY, CATALOG_REDIS_KEY]);
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });

  it('fingerprint is insensitive to Postgres scan order (the producer query has no ORDER BY)', async () => {
    const a = makeRecord('model-a', 'provA');
    const b = makeRecord('model-b', 'provB');
    findManyMock.mockResolvedValueOnce([a, b]).mockResolvedValueOnce([b, a]);
    const svc = await import('@/services/model-catalog-service');

    await svc.refreshCatalogCacheAhead();
    const first = storedMeta();
    await svc.refreshCatalogCacheAhead();
    const second = storedMeta();

    expect(first?.fingerprint).toBe(second?.fingerprint);
    // ...while the published order still follows the scan order.
    expect((JSON.parse(fakeRedisStore.get(CATALOG_REDIS_KEY) ?? '') as { id: string }[]).map((m) => m.id)).toEqual([
      'model-b',
      'model-a',
    ]);
  });

  it('fingerprint changes when any row content changes', async () => {
    findManyMock
      .mockResolvedValueOnce([makeRecord('model-a', 'provA')])
      .mockResolvedValueOnce([{ ...makeRecord('model-a', 'provA'), contextWindow: 16000 }]);
    const svc = await import('@/services/model-catalog-service');

    await svc.refreshCatalogCacheAhead();
    const first = storedMeta();
    await svc.refreshCatalogCacheAhead();
    const second = storedMeta();

    expect(first?.fingerprint).not.toBe(second?.fingerprint);
  });

  it('the elected producer does not re-parse the snapshot it just published itself', async () => {
    findManyMock.mockResolvedValue([makeRecord('model-a', 'provA')]);
    const svc = await import('@/services/model-catalog-service');
    await svc.refreshCatalogCacheAhead();
    redisGet.mockClear();

    await svc.hydrateCatalogCacheAhead();

    expect(redisGetKeys()).toEqual([CATALOG_REDIS_META_KEY]);
  });

  it('invalidateCatalogCache() clears the meta key and the local fingerprint too', async () => {
    findManyMock.mockResolvedValue([makeRecord('model-a', 'provA')]);
    const svc = await import('@/services/model-catalog-service');
    await svc.refreshCatalogCacheAhead();
    expect(fakeRedisStore.size).toBe(2);

    svc.invalidateCatalogCache();

    expect(svc.getCatalogFingerprint()).toBeNull();
    await vi.waitFor(() => expect(fakeRedisStore.size).toBe(0));
  });

  it('never-empty: an empty snapshot with a matching meta is not served via the skip path', async () => {
    const replica = await publishThenHydrateReplica([makeRecord('model-a', 'provA')]);
    const meta = storedMeta();
    fakeRedisStore.set(CATALOG_REDIS_KEY, '[]');
    fakeRedisStore.set(CATALOG_REDIS_META_KEY, JSON.stringify({ ...meta, rowCount: 0 }));

    // Fingerprint still matches the non-empty catalog the replica holds, so
    // the skip keeps serving that; the empty payload is never installed.
    await replica.hydrateCatalogCacheAhead();
    expect((await replica.getAllCatalogModels()).length).toBe(1);

    // And a fresh replica that has nothing yet falls through to Postgres.
    vi.resetModules();
    const fresh = await import('@/services/model-catalog-service');
    findManyMock.mockResolvedValue([makeRecord('model-z', 'provZ')]);
    const models = await fresh.getAllCatalogModels();
    expect(models[0]?.id).toBe('model-z');
    expect(findManyMock).toHaveBeenCalledTimes(2);
  });
});
