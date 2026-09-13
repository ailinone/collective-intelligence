// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Full-cache in-memory candidate retrieval (SELECTION_USE_FULL_CACHE_INDEX,
 * flag-gated, default OFF) regression suite.
 *
 * Context: dynamic-model-selector.ts's default candidate retrieval
 * (getBucketFairCandidateUids) draws from a BOUNDED SQL slice
 * (curatedTake/aggregatedTake, ~400 rows each) of a catalog that is 111k+
 * rows today and growing without a static cap — any fixed-size slice
 * structurally caps how much of the catalog selection can ever see, no
 * matter how fair the slice itself is once drawn. getFullCacheFairCandidateModels
 * is an ADDITIVE alternative, gated behind SELECTION_USE_FULL_CACHE_INDEX
 * (default OFF — see the flag's own doc in dynamic-model-selector.ts), that
 * filters/ranks directly against the FULL in-process catalog cache
 * (model-catalog-service.ts's getAllCatalogModels()/getCatalogIndices()) —
 * zero request-time Postgres round trips, by construction.
 *
 * Same test posture as bucket-fair-candidate-retrieval.test.ts (its sibling
 * for the SQL path): drives the REAL DynamicModelSelector.findModelsByRequirements
 * end to end, with only the Prisma/Redis boundary mocked — no selection logic
 * reimplemented here. Unlike that suite, this one also asserts the flagged
 * path's headline property: ZERO $queryRaw/$executeRawUnsafe calls (the SQL
 * path's own two live queries) fire when the flag is on.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { mockQueryRaw, mockExecuteRawUnsafe, mockFindMany } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockExecuteRawUnsafe: vi.fn().mockResolvedValue(0),
  mockFindMany: vi.fn(),
}));

vi.mock('@/database/client', () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
    $executeRawUnsafe: mockExecuteRawUnsafe,
    $transaction: (cb: (tx: unknown) => unknown) =>
      Promise.resolve(cb({ $queryRaw: mockQueryRaw, $executeRawUnsafe: mockExecuteRawUnsafe })),
    model: { findMany: mockFindMany },
  },
}));

const fakeRedisStore = new Map<string, string>();
vi.mock('@/cache/redis-client', () => ({
  getRedisClient: () => ({
    get: vi.fn(async (key: string) => fakeRedisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      fakeRedisStore.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (fakeRedisStore.delete(key) ? 1 : 0)),
  }),
}));

process.env.SELECTION_POPULARITY_SEED = 'false';

// Static import after mock/env setup — same rationale as
// bucket-fair-candidate-retrieval.test.ts: a normal one-time module
// evaluation against the mocks already in place, avoiding the ~5-6s
// re-initialization cost of vi.resetModules() + dynamic re-import for this
// module's large transitive graph.
import {
  DynamicModelSelector,
  __resetBucketFairCachesForTests,
} from '@/core/selection/dynamic-model-selector';
import { invalidateCatalogCache } from '@/services/model-catalog-service';

function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

/** A curated/native catalog-cache row: no serverless_callable/hubInventoryClass
 *  marker — the real shape openai/anthropic/google/xai rows carry. Matches
 *  CATALOG_HOT_PATH_SELECT's projection (model-catalog-service.ts), NOT the
 *  ModelWithProvider shape the OLD SQL path's own fixtures use. */
function curatedCatalogRecord(
  id: string,
  providerName: string,
  capabilities: string[] = ['chat', 'reasoning']
) {
  return {
    id,
    providerId: `${providerName}-provider-id`,
    name: id,
    displayName: id,
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
    capabilities,
    performance: { latencyMs: 500, throughput: 100, quality: 0.9, reliability: 0.99 },
    status: 'active',
    metadata: {},
    lastSyncedAt: null,
    provider: { name: providerName },
  };
}

/** An aggregated/HF-index catalog-cache row. */
function aggregatedCatalogRecord(id: string, capabilities: string[] = ['chat']) {
  return {
    id,
    providerId: 'huggingface-provider-id',
    name: id,
    displayName: id,
    contextWindow: 32_000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities,
    performance: { latencyMs: 800, throughput: 50, quality: 0.6, reliability: 0.9 },
    status: 'active',
    metadata: { serverless_callable: true, hubInventoryClass: 'aggregated_index' },
    lastSyncedAt: null,
    provider: { name: 'huggingface' },
  };
}

/** Wires mockFindMany to serve the catalog hot-path query (identified by the
 *  presence of `select`, model-catalog-service.ts's CATALOG_HOT_PATH_SELECT)
 *  with the given fixture rows. Any OTHER shape (the old SQL path's
 *  uid-membership hydration, or the terminal never-collapse fallback) returns
 *  empty — those must never fire on a healthy flagged-path request; a test
 *  that expects the never-collapse fallback overrides this explicitly. */
function mockCatalogHydration(
  catalogRecords: ReturnType<typeof curatedCatalogRecord>[],
  fallbackPool: ReturnType<typeof curatedCatalogRecord>[] = []
): void {
  mockFindMany.mockImplementation(
    async (args: { select?: unknown; where?: { uid?: { in?: string[] } } }) => {
      if (args?.select) return catalogRecords; // model-catalog-service.ts hot path
      if (args?.where?.uid?.in) return []; // old-path uid hydration — unused here
      return fallbackPool; // terminal never-collapse fallback
    }
  );
}

const baseCriteria = {
  taskType: 'general' as const,
  complexity: 'medium' as const,
  contextSize: 1000,
};

beforeEach(() => {
  mockQueryRaw.mockReset();
  mockExecuteRawUnsafe.mockReset().mockResolvedValue(0);
  mockFindMany.mockReset();
  fakeRedisStore.clear();
  __resetBucketFairCachesForTests();
  invalidateCatalogCache();
  process.env.SELECTION_USE_FULL_CACHE_INDEX = 'true';
  process.env.SELECTION_POPULARITY_SEED = 'false';
});

afterEach(() => {
  delete process.env.SELECTION_USE_FULL_CACHE_INDEX;
});

describe('full-cache-index candidate retrieval (SELECTION_USE_FULL_CACHE_INDEX=true)', () => {
  it('returns a MIX of curated/native and aggregated-index candidates, with ZERO SQL round trips', async () => {
    const openaiId = randomId('openai');
    const anthropicId = randomId('anthropic');
    const agg1 = randomId('hf');
    const agg2 = randomId('hf');
    const agg3 = randomId('hf');

    mockCatalogHydration([
      curatedCatalogRecord(openaiId, 'openai'),
      curatedCatalogRecord(anthropicId, 'anthropic'),
      aggregatedCatalogRecord(agg1),
      aggregatedCatalogRecord(agg2),
      aggregatedCatalogRecord(agg3),
    ]);

    const selector = new DynamicModelSelector();
    const result = await selector.findModelsByRequirements(baseCriteria);

    // Headline property of this path: it never touches the SQL bucket-fair
    // queries at all.
    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
    // Exactly one findMany call — the catalog hot-path hydration — no matter
    // how many candidates are drawn from it afterward.
    expect(mockFindMany).toHaveBeenCalledTimes(1);

    const resultIds = result.map((m) => m.id);
    expect(resultIds).toContain(openaiId);
    expect(resultIds).toContain(anthropicId);
    expect(resultIds).toContain(agg1);
    expect(resultIds).toContain(agg2);
  });

  it('provider-fairness cap holds over the FULL catalog: a dominant provider cannot consume the whole curated take even at real catalog scale', async () => {
    const dominant = Array.from({ length: 2000 }, (_, i) =>
      curatedCatalogRecord(randomId(`dominant-${i}`), 'dominant-aggregator')
    );
    const openaiId = randomId('openai');
    const anthropicId = randomId('anthropic');
    const googleId = randomId('google');

    mockCatalogHydration([
      ...dominant,
      curatedCatalogRecord(openaiId, 'openai'),
      curatedCatalogRecord(anthropicId, 'anthropic'),
      curatedCatalogRecord(googleId, 'google'),
    ]);

    const selector = new DynamicModelSelector();
    const result = await selector.findModelsByRequirements(baseCriteria);
    const resultIds = new Set(result.map((m) => m.id));

    expect(resultIds.has(openaiId)).toBe(true);
    expect(resultIds.has(anthropicId)).toBe(true);
    expect(resultIds.has(googleId)).toBe(true);

    const dominantInResult = result.filter((m) => m.provider === 'dominant-aggregator');
    const curatedTake = 400; // default config
    expect(dominantInResult.length).toBeLessThanOrEqual(Math.ceil(curatedTake * 0.15));
  });

  it('a rare provider whose ONLY row sits at the very end of a large catalog is still reachable — no pre-truncation before fairness ranking', async () => {
    // This is the exact structural defect this whole feature targets: a
    // BOUNDED SQL slice (or any retrieval that truncates before ranking)
    // could never see a row that happens to sort/scan last. Building 1500
    // filler rows before the rare provider's single row proves the full
    // catalog cache is genuinely scanned in full, not an early-terminated
    // prefix of it.
    const filler = Array.from({ length: 1500 }, (_, i) =>
      curatedCatalogRecord(randomId(`filler-${i}`), 'filler-provider')
    );
    const rareId = randomId('rare-vendor');

    mockCatalogHydration([...filler, curatedCatalogRecord(rareId, 'rare-vendor')]);

    const selector = new DynamicModelSelector();
    const result = await selector.findModelsByRequirements(baseCriteria);

    expect(result.map((m) => m.id)).toContain(rareId);
  });

  it('respects a hard required-capability filter using the legacy capability index for pre-narrowing, without bypassing the authoritative post-hydration filter', async () => {
    const visionId = randomId('vision-model');
    const chatOnlyId = randomId('chat-only');
    // Extra vision-capable candidates so the post-narrowing pool clears the
    // terminal never-collapse floor (<5 total) on its own — this test is
    // about the capability pre-narrowing behavior itself, not the unrelated
    // never-collapse fallback (covered separately below).
    const visionFillers = Array.from({ length: 4 }, (_, i) => randomId(`vision-filler-${i}`));
    // Chat-only fillers (must NOT survive the narrowing/filter).
    const chatOnlyFillers = Array.from({ length: 4 }, (_, i) => randomId(`chat-filler-${i}`));

    mockCatalogHydration([
      curatedCatalogRecord(visionId, 'openai', ['chat', 'vision']),
      curatedCatalogRecord(chatOnlyId, 'anthropic', ['chat']),
      ...visionFillers.map((id, i) => curatedCatalogRecord(id, `vision-provider-${i}`, ['chat', 'vision'])),
      ...chatOnlyFillers.map((id) => aggregatedCatalogRecord(id, ['chat'])),
    ]);

    const selector = new DynamicModelSelector();
    const result = await selector.findModelsByRequirements({
      ...baseCriteria,
      requiredCapabilities: ['vision'],
    });

    const resultIds = result.map((m) => m.id);
    expect(resultIds).toContain(visionId);
    for (const id of visionFillers) expect(resultIds).toContain(id);
    expect(resultIds).not.toContain(chatOnlyId);
    for (const id of chatOnlyFillers) expect(resultIds).not.toContain(id);
  });

  it('never-collapse: an empty/cold catalog cache falls back to the full unrestricted pool (same terminal fallback the SQL path uses)', async () => {
    const fallbackId = randomId('fallback');
    // getAllCatalogModels() itself resolves to an empty catalog (findMany
    // with `select` returns []) — getFullCacheFairCandidateModels then has
    // no indices to draw from, so models.length stays 0 and the shared
    // never-collapse branch (models.length < 5) takes over.
    mockCatalogHydration([], [curatedCatalogRecord(fallbackId, 'openai')]);

    const selector = new DynamicModelSelector();
    const result = await selector.findModelsByRequirements(baseCriteria);

    expect(result.map((m) => m.id)).toContain(fallbackId);
  });

  it('the SQL path (flag OFF) is completely unaffected: identical behavior to the pre-existing suite', async () => {
    process.env.SELECTION_USE_FULL_CACHE_INDEX = 'false';
    const openaiId = randomId('openai');
    // Padding so the pool clears the terminal never-collapse floor (<5
    // total) — unrelated to what this test actually verifies (that the flag
    // being off routes through the SQL path untouched).
    const aggIds = [randomId('hf'), randomId('hf'), randomId('hf'), randomId('hf')];

    mockQueryRaw.mockImplementation((query: unknown) => {
      const text =
        query && typeof query === 'object' && 'sql' in query
          ? String((query as { sql: unknown }).sql)
          : String(query);
      if (text.includes('hubInventoryClass')) {
        return Promise.resolve([
          { uid: openaiId, providerId: 'openai-provider-id', providerName: 'openai', contextWindow: 128_000, usageCount: 0 },
        ]);
      }
      if (text.includes('serverless_callable')) {
        return Promise.resolve(aggIds.map((uid) => ({ uid })));
      }
      return Promise.resolve([]);
    });
    const oldPathCatalog = [
      { ...curatedCatalogRecord(openaiId, 'openai'), uid: openaiId },
      ...aggIds.map((uid) => ({ ...aggregatedCatalogRecord(uid), uid })),
    ];
    mockFindMany.mockImplementation(async (args: { where?: { uid?: { in?: string[] } } }) => {
      const inUids = args?.where?.uid?.in;
      if (!inUids) return [];
      return oldPathCatalog.filter((r) => inUids.includes(r.uid));
    });

    const selector = new DynamicModelSelector();
    const result = await selector.findModelsByRequirements(baseCriteria);

    // With the flag off, the catalog hot-path findMany (identified by
    // `select`) must never be consulted for candidate retrieval.
    expect(mockQueryRaw).toHaveBeenCalled();
    expect(result.map((m) => m.id)).toContain(openaiId);
  });
});

describe('getFullCacheFairCandidateModels structural contract: no static truncation before fairness ranking', () => {
  it('the full-catalog scan iterates every indexed model with no early-exit break, no pre-ranking slice', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const source = readFileSync(
      path.resolve(__dirname, '..', 'dynamic-model-selector.ts'),
      'utf8'
    );

    const marker = 'export function getFullCacheFairCandidateModels(';
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const braceStart = source.indexOf('{', source.indexOf(')', start));
    let depth = 0;
    let i = braceStart;
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
    const body = source.slice(braceStart, end);

    // Full enumeration: iterates indices.byId.values() directly (a Map built
    // from the WHOLE cached catalog — see catalog-indices.test.ts), not a
    // `.slice(...)`'d or counter-limited view of it.
    expect(body).toMatch(/for\s*\(\s*const model of indices\.byId\.values\(\)\s*\)/);

    // Isolate the scan loop body specifically (from the `for` marker to its
    // matching close brace) and assert it contains neither an early-exit
    // `break`/`return` tied to a running count, nor a `.slice(` — the two
    // ways a "full scan" could be silently turned back into a truncated one.
    const loopStart = body.indexOf('for (const model of indices.byId.values())');
    expect(loopStart).toBeGreaterThan(-1);
    let loopDepth = 0;
    let j = body.indexOf('{', loopStart);
    let loopEnd = -1;
    for (; j < body.length; j += 1) {
      if (body[j] === '{') loopDepth += 1;
      else if (body[j] === '}') {
        loopDepth -= 1;
        if (loopDepth === 0) {
          loopEnd = j;
          break;
        }
      }
    }
    expect(loopEnd).toBeGreaterThan(-1);
    const loopBody = body.slice(loopStart, loopEnd);
    expect(loopBody).not.toMatch(/\bbreak\b/);
    expect(loopBody).not.toMatch(/\.slice\(/);

    // The two `.slice(`/take-shaped bounds that DO exist in this function
    // (aggregatedCandidates.slice(0, aggregatedTake), and curatedTake being
    // handed to selectCuratedFairUids) are legitimate, INTENTIONAL per-request
    // output bounds applied AFTER the full scan completes — the same
    // per-request bound the SQL path's own `LIMIT ${aggregatedTake}` and
    // curatedTake already apply. This test only guards against a cap
    // sneaking in BEFORE the scan/fairness-ranking stage, not against those.
    expect(body).toMatch(/aggregatedCandidates\.slice\(0, aggregatedTake\)/);
  });
});
