// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Phase 4 — TEI client + embedding cache + semantic index + resolver.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cosineSimilarity,
  createSemanticIndex,
  getSemanticIndex,
  resetSemanticIndexForTesting,
  vectorNorm,
  type SemanticIndex,
} from '../semantic-index';
import { getTEIClient, resetTEIClientForTesting } from '../tei-client';
import { getEmbeddingCache, resetEmbeddingCacheForTesting } from '../embedding-cache';
import { resolveSemanticCandidates } from '../semantic-resolver';
import {
  getOperationalCandidatePool,
  resetOperationalCandidatePoolForTesting,
} from '../operational-candidate-pool';
import {
  resetProviderHealthRegistryForTesting,
  getProviderHealthRegistry,
} from '../provider-health-registry';
import { resetHealthSyncBusForTesting } from '../health-sync-bus';
import { classifyProviderError } from '../error-classification';
import type { ProviderDiscoverySnapshot } from '../types';

// ─── Math helpers ─────────────────────────────────────────────────────────

describe('vectorNorm + cosineSimilarity', () => {
  it('vectorNorm computes L2', () => {
    expect(vectorNorm(Float32Array.from([3, 4]))).toBeCloseTo(5);
    expect(vectorNorm(Float32Array.from([1, 0, 0]))).toBeCloseTo(1);
    expect(vectorNorm(Float32Array.from([0, 0, 0]))).toBe(0);
  });

  it('cosineSimilarity returns 1 for identical direction', () => {
    const a = Float32Array.from([1, 2, 3]);
    const aNorm = vectorNorm(a);
    expect(cosineSimilarity(a, aNorm, a)).toBeCloseTo(1, 6);
  });

  it('cosineSimilarity returns 0 for orthogonal', () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([0, 1]);
    expect(cosineSimilarity(a, vectorNorm(a), b)).toBeCloseTo(0);
  });

  it('cosineSimilarity returns -1 for opposite', () => {
    const a = Float32Array.from([1, 2]);
    const b = Float32Array.from([-1, -2]);
    expect(cosineSimilarity(a, vectorNorm(a), b)).toBeCloseTo(-1, 5);
  });

  it('returns 0 on dimension mismatch', () => {
    const a = Float32Array.from([1, 2]);
    const b = Float32Array.from([1, 2, 3]);
    expect(cosineSimilarity(a, vectorNorm(a), b)).toBe(0);
  });
});

// ─── LinearScanIndex ──────────────────────────────────────────────────────

describe('LinearScanIndex', () => {
  let idx: SemanticIndex;

  beforeEach(() => {
    idx = createSemanticIndex();
  });

  it('adds and retrieves by kNN', () => {
    idx.add({ id: 'a', embedding: Float32Array.from([1, 0, 0]) });
    idx.add({ id: 'b', embedding: Float32Array.from([0, 1, 0]) });
    idx.add({ id: 'c', embedding: Float32Array.from([0.9, 0.1, 0]) });

    const query = Float32Array.from([1, 0, 0]);
    const hits = idx.knn(query, 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].id).toBe('a');
    expect(hits[1].id).toBe('c');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('returns empty when k=0', () => {
    idx.add({ id: 'a', embedding: Float32Array.from([1, 0]) });
    expect(idx.knn(Float32Array.from([1, 0]), 0)).toHaveLength(0);
  });

  it('returns empty when index is empty', () => {
    expect(idx.knn(Float32Array.from([1, 0]), 5)).toHaveLength(0);
  });

  it('add replaces by id', () => {
    idx.add({ id: 'x', embedding: Float32Array.from([1, 0]) });
    idx.add({ id: 'x', embedding: Float32Array.from([0, 1]) });
    expect(idx.size()).toBe(1);
  });

  it('remove deletes', () => {
    idx.add({ id: 'x', embedding: Float32Array.from([1, 0]) });
    idx.remove('x');
    expect(idx.size()).toBe(0);
  });

  it('rebuild replaces all entries atomically', () => {
    idx.add({ id: 'x', embedding: Float32Array.from([1, 0]) });
    idx.rebuild([{ id: 'y', embedding: Float32Array.from([0, 1]) }]);
    expect(idx.size()).toBe(1);
    const hits = idx.knn(Float32Array.from([0, 1]), 1);
    expect(hits[0].id).toBe('y');
  });

  it('preserves meta on hits', () => {
    idx.add({ id: 'a', embedding: Float32Array.from([1, 0]), meta: { tier: 'native' } });
    const hits = idx.knn(Float32Array.from([1, 0]), 1);
    expect(hits[0].meta).toEqual({ tier: 'native' });
  });
});

// ─── TEI client (mocked fetch) ────────────────────────────────────────────

describe('TEIClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetTEIClientForTesting();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('embed parses single-input response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [0.1, 0.2, 0.3],
    } as unknown as Response);

    const client = getTEIClient({ baseUrl: 'http://test' });
    const emb = await client.embed('hello');
    expect(Array.from(emb)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ]);
  });

  it('embedBatch parses multi-input response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    } as unknown as Response);

    const client = getTEIClient({ baseUrl: 'http://test' });
    const arr = await client.embedBatch(['a', 'b']);
    expect(arr).toHaveLength(2);
    expect(arr[0][0]).toBeCloseTo(0.1, 5);
    expect(arr[1][0]).toBeCloseTo(0.3, 5);
  });

  it('throws on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    } as unknown as Response);

    const client = getTEIClient({ baseUrl: 'http://test' });
    await expect(client.embed('x')).rejects.toThrow(/HTTP 500/);
  });

  it('isHealthy returns true on /health 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true } as unknown as Response);
    const client = getTEIClient({ baseUrl: 'http://test' });
    expect(await client.isHealthy()).toBe(true);
  });

  it('isHealthy returns false on error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connect refused'));
    const client = getTEIClient({ baseUrl: 'http://test' });
    expect(await client.isHealthy()).toBe(false);
  });
});

// ─── EmbeddingCache ───────────────────────────────────────────────────────

describe('EmbeddingCache', () => {
  beforeEach(() => {
    resetEmbeddingCacheForTesting();
    resetTEIClientForTesting();
  });

  it('hits cache on second call for same text', async () => {
    let callCount = 0;
    const fakeTei = {
      embed: vi.fn(async () => {
        callCount++;
        return Float32Array.from([1, 2, 3]);
      }),
      embedBatch: vi.fn(),
      isHealthy: vi.fn(),
    };
    const cache = getEmbeddingCache(100, fakeTei as never);

    await cache.getOrCompute('hello');
    await cache.getOrCompute('hello');
    await cache.getOrCompute('hello');

    expect(callCount).toBe(1); // only first call hit TEI
    const counts = cache.hitMissCounts();
    expect(counts.hits).toBe(2);
    expect(counts.misses).toBe(1);
    expect(cache.hitRate()).toBeCloseTo(2 / 3);
  });

  it('different texts get different embeddings (separate misses)', async () => {
    let i = 0;
    const fakeTei = {
      embed: vi.fn(async () => Float32Array.from([i++, 0])),
      embedBatch: vi.fn(),
      isHealthy: vi.fn(),
    };
    const cache = getEmbeddingCache(100, fakeTei as never);

    const a = await cache.getOrCompute('one');
    const b = await cache.getOrCompute('two');
    expect(a[0]).not.toBe(b[0]);
    expect(cache.hitMissCounts().misses).toBe(2);
  });

  it('LRU evicts oldest at capacity', async () => {
    let i = 0;
    const fakeTei = {
      embed: vi.fn(async () => Float32Array.from([i++, 0])),
      embedBatch: vi.fn(),
      isHealthy: vi.fn(),
    };
    const cache = getEmbeddingCache(2, fakeTei as never);

    await cache.getOrCompute('a');
    await cache.getOrCompute('b');
    await cache.getOrCompute('c'); // evicts 'a'
    expect(cache.size()).toBe(2);

    // Re-fetching 'a' should be a miss (was evicted)
    const before = cache.hitMissCounts().misses;
    await cache.getOrCompute('a');
    expect(cache.hitMissCounts().misses).toBe(before + 1);
  });
});

// ─── resolveSemanticCandidates (integration) ──────────────────────────────

describe('resolveSemanticCandidates', () => {
  beforeEach(() => {
    resetSemanticIndexForTesting();
    resetEmbeddingCacheForTesting();
    resetTEIClientForTesting();
    resetOperationalCandidatePoolForTesting();
    resetProviderHealthRegistryForTesting();
    resetHealthSyncBusForTesting();
  });

  function buildSnap(
    rows: Array<{ providerId: string; modelId: string; available?: boolean }>,
  ): ProviderDiscoverySnapshot {
    const map = new Map<string, ReturnType<typeof makeRow>>();
    for (const r of rows) {
      const existing = map.get(r.providerId);
      if (existing) {
        // append model
        existing.models = [...existing.models, { modelId: r.modelId }];
      } else {
        map.set(r.providerId, makeRow(r.providerId, r.modelId, r.available !== false));
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      durationMs: 50,
      totalConfigured: map.size,
      totalAvailable: map.size,
      totalUnavailable: 0,
      results: map,
    };
  }
  function makeRow(providerId: string, modelId: string, available: boolean) {
    return {
      providerId,
      status: available ? ('available' as const) : ('unavailable' as const),
      healthState: 'healthy' as const,
      discoveryConfidence: 'verified' as const,
      models: [{ modelId }],
      includeInOperationalPool: available,
      discoveredAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      probeLatencyMs: 10,
    };
  }

  it('falls back to pool query when index is empty', async () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnap([
        { providerId: 'openai', modelId: 'gpt-4o' },
        { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
      ]),
    });

    const ranked = await resolveSemanticCandidates({ query: 'hello', k: 5 });
    expect(ranked).toHaveLength(2);
    expect(ranked[0].semanticScore).toBeUndefined();
  });

  it('ranks by cosine similarity when index is populated', async () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnap([
        { providerId: 'openai', modelId: 'gpt-4o' },
        { providerId: 'anthropic', modelId: 'claude' },
      ]),
    });

    // Mock TEI to return [1, 0] for query
    const fakeTei = {
      embed: vi.fn(async () => Float32Array.from([1, 0])),
      embedBatch: vi.fn(),
      isHealthy: vi.fn(),
    };
    getEmbeddingCache(100, fakeTei as never);

    // Populate index with two embeddings
    const idx = getSemanticIndex();
    idx.add({ id: 'openai::gpt-4o', embedding: Float32Array.from([0.9, 0.1]) });
    idx.add({ id: 'anthropic::claude', embedding: Float32Array.from([0, 1]) });

    const ranked = await resolveSemanticCandidates({ query: 'hello', k: 2 });
    expect(ranked).toHaveLength(2);
    expect(ranked[0].candidate.providerId).toBe('openai');
    expect(ranked[0].semanticScore).toBeGreaterThan(ranked[1].semanticScore!);
  });

  it('filters out unhealthy candidates after kNN', async () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnap([
        { providerId: 'openai', modelId: 'gpt-4o' },
        { providerId: 'aihubmix', modelId: 'm1' },
      ]),
    });

    // Mark aihubmix as auth_failed
    getProviderHealthRegistry().recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });

    const fakeTei = {
      embed: vi.fn(async () => Float32Array.from([1, 0])),
      embedBatch: vi.fn(),
      isHealthy: vi.fn(),
    };
    getEmbeddingCache(100, fakeTei as never);

    const idx = getSemanticIndex();
    idx.add({ id: 'openai::gpt-4o', embedding: Float32Array.from([0.5, 0.5]) });
    idx.add({ id: 'aihubmix::m1', embedding: Float32Array.from([1, 0]) }); // closer to query

    const ranked = await resolveSemanticCandidates({ query: 'q', k: 5 });
    // aihubmix would semantically beat openai but is filtered as unhealthy
    expect(ranked).toHaveLength(1);
    expect(ranked[0].candidate.providerId).toBe('openai');
  });

  it('respects k limit', async () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnap([
        { providerId: 'a', modelId: 'm' },
        { providerId: 'b', modelId: 'm' },
        { providerId: 'c', modelId: 'm' },
      ]),
    });

    const fakeTei = {
      embed: vi.fn(async () => Float32Array.from([1, 0])),
      embedBatch: vi.fn(),
      isHealthy: vi.fn(),
    };
    getEmbeddingCache(100, fakeTei as never);

    const idx = getSemanticIndex();
    idx.add({ id: 'a::m', embedding: Float32Array.from([0.9, 0.1]) });
    idx.add({ id: 'b::m', embedding: Float32Array.from([0.5, 0.5]) });
    idx.add({ id: 'c::m', embedding: Float32Array.from([0.1, 0.9]) });

    const ranked = await resolveSemanticCandidates({ query: 'q', k: 2 });
    expect(ranked).toHaveLength(2);
  });
});
