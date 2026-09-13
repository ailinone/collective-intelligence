// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * In-memory catalog indices (SELECTION_USE_FULL_CACHE_INDEX follow-up)
 * regression suite.
 *
 * dynamic-model-selector.ts's candidate retrieval today draws from a BOUNDED
 * SQL slice (curatedTake/aggregatedTake, ~400 rows each) of a catalog that is
 * 111k+ rows and growing without a static cap. getFullCacheFairCandidateModels
 * (dynamic-model-selector.ts) is a flag-gated alternative that instead
 * filters/ranks directly against the full in-process catalog cache
 * (getAllCatalogModels()) via the indices this file tests:
 * `getCatalogIndices()` returning `{ byCapability, byProvider, byId }`.
 *
 * These indices MUST be rebuilt at exactly the same two moments catalogCache
 * itself is ever assigned (see model-catalog-service.ts's `setCatalogCache`
 * helper: the direct Postgres rebuild in rebuildCatalogCacheFromPostgres, and
 * the fleet-wide Redis-snapshot pull in hydrateCatalogCacheFromRedis) — never
 * separately, never stale. This suite proves that end to end, following the
 * SAME fake-Redis-Map + mocked-Prisma-findMany pattern already established in
 * model-catalog-service-fleet-cache.test.ts for exactly this module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManyMock = vi.fn();

vi.mock('@/database/client', () => ({
  prisma: { model: { findMany: (...args: unknown[]) => findManyMock(...args) } },
  Prisma: {},
}));

const fakeRedisStore = new Map<string, string>();

const redisGet = vi.fn(async (key: string) => fakeRedisStore.get(key) ?? null);
const redisSet = vi.fn(async (key: string, value: string) => {
  fakeRedisStore.set(key, value);
  return 'OK';
});
const redisDel = vi.fn(async (key: string) => (fakeRedisStore.delete(key) ? 1 : 0));

vi.mock('@/cache/redis-client', () => ({
  getRedisClient: () => ({ get: redisGet, set: redisSet, del: redisDel }),
}));

function makeRecord(
  id: string,
  providerName: string,
  capabilities: string[] = ['chat']
) {
  return {
    id,
    providerId: providerName,
    name: id,
    displayName: id,
    contextWindow: 8000,
    maxOutputTokens: 1000,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities,
    performance: {},
    status: 'active',
    metadata: null,
    lastSyncedAt: null,
    provider: { name: providerName },
  };
}

beforeEach(() => {
  fakeRedisStore.clear();
  findManyMock.mockReset();
  vi.resetModules();
});

describe('model-catalog-service in-memory catalog indices', () => {
  it('getCatalogIndices() is null before the catalog has ever been hydrated in this process', async () => {
    const svc = await import('@/services/model-catalog-service');
    expect(svc.getCatalogIndices()).toBeNull();
  });

  it('a direct Postgres rebuild (getAllCatalogModels cold path) builds indices covering EVERY row — no truncation', async () => {
    const records = Array.from({ length: 250 }, (_, i) =>
      makeRecord(`model-${i}`, i % 2 === 0 ? 'openai' : 'anthropic', ['chat', 'reasoning'])
    );
    findManyMock.mockResolvedValue(records);
    const svc = await import('@/services/model-catalog-service');

    const models = await svc.getAllCatalogModels();
    expect(models).toHaveLength(250);

    const indices = svc.getCatalogIndices();
    expect(indices).not.toBeNull();
    expect(indices!.byId.size).toBe(250); // full enumeration, no cap
    expect(indices!.byProvider.get('openai')).toHaveLength(125);
    expect(indices!.byProvider.get('anthropic')).toHaveLength(125);
    expect(indices!.byCapability.get('chat')!.size).toBe(250);
    expect(indices!.byCapability.get('reasoning')!.size).toBe(250);
  });

  it('a fleet-wide Redis-snapshot hydrate (a different replica, never touching Postgres) ALSO builds indices, not just the flat cache', async () => {
    const records = [makeRecord('model-a', 'provA', ['chat']), makeRecord('model-b', 'provB', ['vision'])];
    findManyMock.mockResolvedValue(records);

    // Replica A: elected process, publishes to the shared fake Redis.
    const replicaA = await import('@/services/model-catalog-service');
    await replicaA.refreshCatalogCacheAhead();
    expect(findManyMock).toHaveBeenCalledTimes(1);

    // Replica B: fresh module instance, hydrates from Redis only.
    vi.resetModules();
    const replicaB = await import('@/services/model-catalog-service');
    await replicaB.getAllCatalogModels();
    expect(findManyMock).toHaveBeenCalledTimes(1); // replica B never queried Postgres

    const indices = replicaB.getCatalogIndices();
    expect(indices).not.toBeNull();
    expect(indices!.byId.size).toBe(2);
    expect(indices!.byId.get('model-a')?.provider).toBe('provA');
    expect(indices!.byCapability.get('vision')?.has('model-b')).toBe(true);
  });

  it('refreshCatalogCacheAhead() (fleet-wide writer) rebuilds indices to match the NEW snapshot, not the stale one', async () => {
    findManyMock
      .mockResolvedValueOnce([makeRecord('model-old', 'provA', ['chat'])])
      .mockResolvedValueOnce([
        makeRecord('model-old', 'provA', ['chat']),
        makeRecord('model-new', 'provB', ['reasoning']),
      ]);
    const svc = await import('@/services/model-catalog-service');

    await svc.getAllCatalogModels();
    expect(svc.getCatalogIndices()!.byId.size).toBe(1);

    await svc.refreshCatalogCacheAhead();
    const indices = svc.getCatalogIndices();
    expect(indices!.byId.size).toBe(2);
    expect(indices!.byId.has('model-new')).toBe(true);
    expect(indices!.byCapability.get('reasoning')?.has('model-new')).toBe(true);
  });

  it('invalidateCatalogCache() clears the indices too, not just the flat catalog cache', async () => {
    findManyMock.mockResolvedValue([makeRecord('model-a', 'provA')]);
    const svc = await import('@/services/model-catalog-service');

    await svc.getAllCatalogModels();
    expect(svc.getCatalogIndices()).not.toBeNull();

    svc.invalidateCatalogCache();
    expect(svc.getCatalogIndices()).toBeNull();
  });

  it('a model with multiple capabilities appears in every one of its capability sets, and byId returns the exact same object getAllCatalogModels() returns (no copying)', async () => {
    findManyMock.mockResolvedValue([makeRecord('multi-cap', 'openai', ['chat', 'vision', 'reasoning'])]);
    const svc = await import('@/services/model-catalog-service');

    const models = await svc.getAllCatalogModels();
    const indices = svc.getCatalogIndices()!;

    for (const cap of ['chat', 'vision', 'reasoning']) {
      expect(indices.byCapability.get(cap)?.has('multi-cap')).toBe(true);
    }
    expect(indices.byId.get('multi-cap')).toBe(models[0]); // same reference, not a copy
  });
});

describe('buildCatalogIndices structural contract: no static cap on the full-catalog scan', () => {
  it('source does not slice/limit/take the models array before indexing every row', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const source = readFileSync(
      path.resolve(__dirname, '..', 'model-catalog-service.ts'),
      'utf8'
    );

    const marker = 'function buildCatalogIndices(models: Model[]): CatalogIndices {';
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let i = start + marker.length - 1;
    let end = -1;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(-1);
    const body = source.slice(start, end);

    // The function must iterate the FULL `models` array with a plain for-of —
    // no `.slice(`, `.filter(...).slice(`, or a numeric `take`/`limit`
    // constant that would silently truncate the indexed set below the full
    // catalog. (curatedTake/aggregatedTake are legitimate, INTENTIONAL
    // per-request output bounds applied later, in dynamic-model-selector.ts,
    // over the full indices this function builds — never inside this
    // function itself.)
    expect(body).toMatch(/for\s*\(\s*const model of models\s*\)/);
    expect(body).not.toMatch(/\.slice\(/);
    expect(body).not.toMatch(/\btake\s*:/);
    expect(body).not.toMatch(/\bLIMIT\b/i);
  });
});
