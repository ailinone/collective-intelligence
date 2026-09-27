// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Catalog cache freshness policy (catalog load audit 2026-09-24, R1-R3):
 * stale-while-revalidate with a max-stale bound, single-flight load
 * with a caller timeout, stale-if-error, typed 503 error instead of a raw
 * Prisma error, exponential backoff after a failed load, and the Redis
 * compare-and-swap that stops an older read from overwriting a newer
 * snapshot.
 *
 * Same harness as model-catalog-service-fleet-cache.test.ts: a Map standing
 * in for the cache Redis (with the publish script modelled by
 * fake-catalog-redis.ts) and a mocked prisma.model.findMany. The policy
 * knobs are shrunk through env so fake timers can walk through them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CATALOG_REDIS_KEY, CATALOG_REDIS_META_KEY, parseCatalogSnapshotMeta } from '@/services/catalog-hot-path';
import { isCatalogUnavailableError, type CatalogUnavailableError } from '@/services/catalog-errors';
import { runCatalogPublishScript } from './fake-catalog-redis';

const findManyMock = vi.fn();

vi.mock('@/database/client', () => ({
  prisma: { model: { findMany: (...args: unknown[]) => findManyMock(...args) } },
  Prisma: {},
}));

const fakeRedisStore = new Map<string, string>();

vi.mock('@/cache/redis-client', () => ({
  getRedisClient: () => ({
    get: async (key: string) => fakeRedisStore.get(key) ?? null,
    set: async (key: string, value: string) => {
      fakeRedisStore.set(key, value);
      return 'OK';
    },
    del: async (key: string) => (fakeRedisStore.delete(key) ? 1 : 0),
    eval: async (script: unknown, numKeys: unknown, ...args: unknown[]) =>
      runCatalogPublishScript(fakeRedisStore, script, numKeys, ...args),
  }),
}));

const TTL_MS = 1_000;
const MAX_STALE_MS = 2_000;
const STALE_IF_ERROR_MS = 5_000;
const LOAD_TIMEOUT_MS = 500;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 4_000;
const T0 = new Date('2026-09-24T00:00:00.000Z').getTime();

function makeRecord(id: string, providerName = 'provA') {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let promise chains run without moving the (fake) clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    await Promise.resolve();
  }
}

function ids(models: Array<{ id: string }>): string[] {
  return models.map((m) => m.id);
}

async function importService() {
  return import('@/services/model-catalog-service');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.stubEnv('CATALOG_CACHE_TTL_MS', String(TTL_MS));
  vi.stubEnv('CATALOG_CACHE_MAX_STALE_MS', String(MAX_STALE_MS));
  vi.stubEnv('CATALOG_CACHE_STALE_IF_ERROR_MS', String(STALE_IF_ERROR_MS));
  vi.stubEnv('CATALOG_LOAD_TIMEOUT_MS', String(LOAD_TIMEOUT_MS));
  vi.stubEnv('CATALOG_LOAD_BACKOFF_BASE_MS', String(BACKOFF_BASE_MS));
  vi.stubEnv('CATALOG_LOAD_BACKOFF_MAX_MS', String(BACKOFF_MAX_MS));
  vi.stubEnv('CATALOG_REDIS_TIMEOUT_MS', '60000');
  fakeRedisStore.clear();
  findManyMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('catalog cache: stale-while-revalidate with a max-stale bound', () => {
  it('past expiry but within max-stale, callers get the cached copy immediately and exactly one background load runs', async () => {
    findManyMock.mockResolvedValueOnce([makeRecord('model-v1')]);
    const svc = await importService();
    expect(ids(await svc.getAllCatalogModels())).toEqual(['model-v1']);

    // Force the revalidation to reach Postgres, and make it slow.
    fakeRedisStore.clear();
    await vi.advanceTimersByTimeAsync(TTL_MS + 500);
    const refresh = deferred<unknown[]>();
    findManyMock.mockReturnValueOnce(refresh.promise);

    const [a, b, c] = await Promise.all([
      svc.getAllCatalogModels(),
      svc.getAllCatalogModels(),
      svc.getAllCatalogModels(),
    ]);
    expect(ids(a)).toEqual(['model-v1']);
    expect(b).toBe(a);
    expect(c).toBe(a);
    await settle();
    expect(findManyMock).toHaveBeenCalledTimes(2); // 1 cold + 1 shared revalidation

    refresh.resolve([makeRecord('model-v2')]);
    await settle();
    expect(ids(await svc.getAllCatalogModels())).toEqual(['model-v2']);
    expect(findManyMock).toHaveBeenCalledTimes(2);
  });

  it('beyond max-stale, the caller waits for the load instead of being served the old copy', async () => {
    findManyMock.mockResolvedValueOnce([makeRecord('model-v1')]);
    const svc = await importService();
    await svc.getAllCatalogModels();

    fakeRedisStore.clear();
    await vi.advanceTimersByTimeAsync(TTL_MS + MAX_STALE_MS + 1);
    const refresh = deferred<unknown[]>();
    findManyMock.mockReturnValueOnce(refresh.promise);

    let settled = false;
    const pending = svc.getAllCatalogModels().then((models) => {
      settled = true;
      return models;
    });
    await settle();
    expect(settled).toBe(false);

    refresh.resolve([makeRecord('model-v2')]);
    expect(ids(await pending)).toEqual(['model-v2']);
  });

  it('a failed background revalidation backs off: stale calls inside the backoff window start no new load', async () => {
    findManyMock.mockResolvedValueOnce([makeRecord('model-v1')]);
    const svc = await importService();
    await svc.getAllCatalogModels();

    fakeRedisStore.clear();
    await vi.advanceTimersByTimeAsync(TTL_MS + 100);
    findManyMock.mockRejectedValueOnce(new Error('db down'));
    expect(ids(await svc.getAllCatalogModels())).toEqual(['model-v1']);
    await settle();
    expect(findManyMock).toHaveBeenCalledTimes(2);

    expect(ids(await svc.getAllCatalogModels())).toEqual(['model-v1']);
    await settle();
    expect(findManyMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS);
    findManyMock.mockResolvedValueOnce([makeRecord('model-v2')]);
    expect(ids(await svc.getAllCatalogModels())).toEqual(['model-v1']); // still served stale
    await settle();
    expect(findManyMock).toHaveBeenCalledTimes(3);
    expect(ids(await svc.getAllCatalogModels())).toEqual(['model-v2']);
  });
});

describe('catalog cache: single-flight load with a caller timeout', () => {
  it('concurrent cold callers share one query; a caller that times out gets a typed 503 error, and the load keeps serving later callers', async () => {
    const hang = deferred<unknown[]>();
    findManyMock.mockReturnValueOnce(hang.promise);
    const svc = await importService();

    const first = svc.getAllCatalogModels().catch((error: unknown) => error);
    const second = svc.getAllCatalogModels().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    const [err1, err2] = await Promise.all([first, second]);

    expect(isCatalogUnavailableError(err1)).toBe(true);
    expect(isCatalogUnavailableError(err2)).toBe(true);
    expect((err1 as CatalogUnavailableError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(findManyMock).toHaveBeenCalledTimes(1);

    // The timed-out load is still the single flight: a new caller joins it.
    const third = svc.getAllCatalogModels();
    hang.resolve([makeRecord('model-late')]);
    expect(ids(await third)).toEqual(['model-late']);
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });
});

describe('catalog cache: failures surface as CatalogUnavailableError, never the raw Prisma error', () => {
  const prismaError = new Error(
    'Invalid `prisma.model.findMany()` invocation: canceling statement due to statement timeout'
  );

  it('with no last-good copy the caller gets a sanitized error that keeps the original as cause', async () => {
    findManyMock.mockRejectedValueOnce(prismaError);
    const svc = await importService();

    const error = await svc.getAllCatalogModels().catch((e: unknown) => e);

    expect(isCatalogUnavailableError(error)).toBe(true);
    const typed = error as CatalogUnavailableError;
    expect(typed.message).not.toMatch(/prisma|statement|findMany/i);
    expect(typed.cause).toBe(prismaError);
    expect(typed.retryAfterSeconds).toBe(Math.ceil(BACKOFF_BASE_MS / 1000));
  });

  it('backs off after a failure (no new query inside the window) and grows the window exponentially', async () => {
    findManyMock.mockRejectedValueOnce(prismaError).mockRejectedValueOnce(prismaError);
    const svc = await importService();

    await svc.getAllCatalogModels().catch(() => undefined);
    expect(findManyMock).toHaveBeenCalledTimes(1);

    const during = await svc.getAllCatalogModels().catch((e: unknown) => e);
    expect(isCatalogUnavailableError(during)).toBe(true);
    expect(findManyMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS);
    const second = await svc.getAllCatalogModels().catch((e: unknown) => e);
    expect(findManyMock).toHaveBeenCalledTimes(2);
    expect((second as CatalogUnavailableError).retryAfterSeconds).toBe(
      Math.ceil((2 * BACKOFF_BASE_MS) / 1000)
    );

    await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS);
    await svc.getAllCatalogModels().catch(() => undefined);
    expect(findManyMock).toHaveBeenCalledTimes(2); // still inside the doubled window

    await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS);
    findManyMock.mockResolvedValueOnce([makeRecord('model-a')]);
    expect(ids(await svc.getAllCatalogModels())).toEqual(['model-a']);
    expect(findManyMock).toHaveBeenCalledTimes(3);
  });

  it('stale-if-error: a failed load beyond max-stale serves the last-good copy while it is within the bound, then fails explicitly', async () => {
    findManyMock.mockResolvedValueOnce([makeRecord('model-v1')]);
    const svc = await importService();
    await svc.getAllCatalogModels();
    fakeRedisStore.clear();

    await vi.advanceTimersByTimeAsync(TTL_MS + MAX_STALE_MS + 1);
    findManyMock.mockRejectedValueOnce(prismaError);
    expect(ids(await svc.getAllCatalogModels())).toEqual(['model-v1']);

    await vi.advanceTimersByTimeAsync(STALE_IF_ERROR_MS);
    findManyMock.mockRejectedValueOnce(prismaError);
    const error = await svc.getAllCatalogModels().catch((e: unknown) => e);
    expect(isCatalogUnavailableError(error)).toBe(true);
  });
});

describe('catalog snapshot publish: compare-and-swap on the read start time', () => {
  it('a rebuild whose read started earlier cannot overwrite a newer snapshot that was published first', async () => {
    const slowRead = deferred<unknown[]>();
    findManyMock.mockReturnValueOnce(slowRead.promise);
    const replicaA = await importService();
    const replicaADone = replicaA.refreshCatalogCacheAhead(); // read starts at T0
    await settle();

    await vi.advanceTimersByTimeAsync(1_000);
    vi.resetModules();
    findManyMock.mockResolvedValueOnce([makeRecord('model-new')]);
    const replicaB = await importService();
    await replicaB.refreshCatalogCacheAhead(); // read starts at T0 + 1s, publishes first

    slowRead.resolve([makeRecord('model-old')]);
    await replicaADone;

    const published = JSON.parse(fakeRedisStore.get(CATALOG_REDIS_KEY) ?? '[]') as Array<{ id: string }>;
    expect(ids(published)).toEqual(['model-new']);
    expect(parseCatalogSnapshotMeta(fakeRedisStore.get(CATALOG_REDIS_META_KEY) ?? null)?.generatedAt).toBe(
      T0 + 1_000
    );
    // The rejected staging copy is gone; only the live pair remains.
    expect([...fakeRedisStore.keys()].sort()).toEqual([CATALOG_REDIS_KEY, CATALOG_REDIS_META_KEY].sort());
  });

  it('a newer read replaces an older published snapshot', async () => {
    findManyMock.mockResolvedValueOnce([makeRecord('model-old')]);
    const svc = await importService();
    await svc.refreshCatalogCacheAhead();

    await vi.advanceTimersByTimeAsync(1_000);
    findManyMock.mockResolvedValueOnce([makeRecord('model-new')]);
    await svc.refreshCatalogCacheAhead();

    const published = JSON.parse(fakeRedisStore.get(CATALOG_REDIS_KEY) ?? '[]') as Array<{ id: string }>;
    expect(ids(published)).toEqual(['model-new']);
  });
});
