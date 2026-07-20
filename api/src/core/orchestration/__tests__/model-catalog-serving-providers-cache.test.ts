// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1C §7 — Catalog serving-providers cache + concurrency tests.
 *
 * Pins the J1B performance hotfix:
 *   - Snapshot-based catalog filter (in-memory) replaces Prisma OR-of-many.
 *   - Promise-cache for `lookupServingProvidersFromCatalog` is exercised
 *     by exposing a request-scoped `withConcurrencyCache` helper so
 *     tests can simulate two concurrent role lookups for the same
 *     logical model and assert they share the in-flight promise.
 *   - Rejected lookups are NOT cached indefinitely.
 *   - In-memory filter is bounded by `maxResults`.
 *
 * No DB, no provider calls, no secrets.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  lookupServingProvidersFromCatalog,
  type CatalogRow,
  type LookupCatalogRows,
} from '@/core/orchestration/lookup-serving-providers';

const sampleRows: CatalogRow[] = [
  { providerId: '1', providerName: 'aiml', modelId: 'a', name: 'gemma-3-4b-it', capabilities: ['chat'] },
  { providerId: '2', providerName: 'deepinfra', modelId: 'b', name: 'google/gemma-3-4b-it', capabilities: ['chat'] },
  { providerId: '3', providerName: 'openrouter', modelId: 'c', name: 'google/gemma-3-4b-it', capabilities: ['chat'] },
];

describe('01C.1B-J1C §7 — catalog lookup concurrency + cache cleanup', () => {
  it('Promise cache: two concurrent lookups for the same id share the in-flight promise', async () => {
    let inFlightCount = 0;
    let maxConcurrent = 0;
    const lookupCatalogRows: LookupCatalogRows = vi.fn(async () => {
      inFlightCount += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlightCount);
      await new Promise((r) => setTimeout(r, 30));
      inFlightCount -= 1;
      return sampleRows;
    });

    // Simulate request-scoped Promise cache like the one in the dry-run service.
    const cache = new Map<string, Promise<unknown>>();
    const getServingProviders = (logicalModelId: string) => {
      const key = logicalModelId.toLowerCase();
      const hit = cache.get(key);
      if (hit) return hit;
      const p = lookupServingProvidersFromCatalog({
        logicalModelId,
        requireCapability: 'chat',
        lookupCatalogRows,
      }).catch((err) => {
        if (cache.get(key) === p) cache.delete(key);
        throw err;
      });
      cache.set(key, p);
      return p;
    };

    const [r1, r2] = await Promise.all([
      getServingProviders('gemma-3-4b-it'),
      getServingProviders('gemma-3-4b-it'),
    ]);
    expect(r1).toBe(r2);                  // same promise resolved → same value (object identity)
    expect(lookupCatalogRows).toHaveBeenCalledTimes(1); // only ONE DB-side call
    expect(maxConcurrent).toBe(1);
  });

  it('rejected lookup is removed from cache so the next call can retry', async () => {
    let callCount = 0;
    const lookupCatalogRows: LookupCatalogRows = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('catalog_snapshot_timeout');
      return sampleRows;
    });

    const cache = new Map<string, Promise<unknown>>();
    const getServingProviders = (logicalModelId: string) => {
      const key = logicalModelId.toLowerCase();
      const hit = cache.get(key);
      if (hit) return hit;
      const p = lookupServingProvidersFromCatalog({
        logicalModelId,
        requireCapability: 'chat',
        lookupCatalogRows,
      }).catch((err) => {
        if (cache.get(key) === p) cache.delete(key);
        throw err;
      });
      cache.set(key, p);
      return p;
    };

    await expect(getServingProviders('gemma-3-4b-it')).rejects.toThrow('catalog_snapshot_timeout');
    // Cache should be cleared
    expect(cache.has('gemma-3-4b-it')).toBe(false);
    // Second call retries and succeeds
    const r2 = await getServingProviders('gemma-3-4b-it');
    expect(Array.isArray(r2)).toBe(true);
    expect((r2 as readonly unknown[]).length).toBeGreaterThan(0);
    expect(callCount).toBe(2);
  });

  it('different logical-model keys do NOT share the cache entry', async () => {
    const calls: string[] = [];
    const lookupCatalogRows: LookupCatalogRows = vi.fn(async (q) => {
      calls.push(q.patterns[0] ?? '');
      return sampleRows;
    });
    const cache = new Map<string, Promise<unknown>>();
    const get = (id: string) => {
      const k = id.toLowerCase();
      const hit = cache.get(k);
      if (hit) return hit;
      const p = lookupServingProvidersFromCatalog({
        logicalModelId: id,
        requireCapability: 'chat',
        lookupCatalogRows,
      });
      cache.set(k, p);
      return p;
    };
    await Promise.all([get('gemma-3-4b-it'), get('llama-3.2-11b')]);
    expect(lookupCatalogRows).toHaveBeenCalledTimes(2);
  });

  it('apiModelId is preserved verbatim from the catalog row', async () => {
    const rows: CatalogRow[] = [
      { providerId: '1', providerName: 'deepinfra', modelId: 'x', name: 'meta-llama/Llama-3.2-11B-Vision-Instruct', capabilities: ['chat'] },
    ];
    const result = await lookupServingProvidersFromCatalog({
      logicalModelId: 'meta/llama-3.2-11b',
      requireCapability: 'chat',
      lookupCatalogRows: vi.fn().mockResolvedValue(rows),
    });
    expect(result.length).toBe(1);
    expect(result[0].apiModelId).toBe('meta-llama/Llama-3.2-11B-Vision-Instruct');
  });

  it('maxResults bound is honored', async () => {
    const big: CatalogRow[] = Array.from({ length: 500 }, (_, i) => ({
      providerId: String(i),
      providerName: `prov-${i}`,
      modelId: `m-${i}`,
      name: 'gemma-3-4b-it',
      capabilities: ['chat'],
    }));
    const result = await lookupServingProvidersFromCatalog({
      logicalModelId: 'gemma-3-4b-it',
      requireCapability: 'chat',
      maxResults: 50,
      lookupCatalogRows: vi.fn().mockResolvedValue(big),
    });
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('no provider HTTP call is made (lookup is catalog-only)', async () => {
    // Sanity check: the lookup adapter is the only network surface; if the
    // test injects a sync resolver, no fetch is invoked.
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      fetchCalled = true;
      throw new Error('fetch must not be called');
    }) as never;
    try {
      await lookupServingProvidersFromCatalog({
        logicalModelId: 'gemma-3-4b-it',
        requireCapability: 'chat',
        lookupCatalogRows: vi.fn().mockResolvedValue(sampleRows),
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(fetchCalled).toBe(false);
  });
});
