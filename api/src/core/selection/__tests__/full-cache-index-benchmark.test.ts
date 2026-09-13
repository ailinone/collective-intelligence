// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Real-scale benchmark for SELECTION_USE_FULL_CACHE_INDEX (2026-09-08).
 *
 * Purpose: measure the actual cost of the new in-memory candidate-retrieval
 * path (getFullCacheFairCandidateModels + the index build it depends on,
 * model-catalog-service.ts's buildCatalogIndices) at the SAME scale/shape as
 * the real production catalog, so the PR for this change can cite real
 * numbers instead of estimates — this repo's own standing convention (see
 * e.g. curated-fair-selection.test.ts's "performs well at real-catalog
 * scale" case, and every "measured live, 2026-09-07" comment in
 * dynamic-model-selector.ts).
 *
 * The dataset shape below mirrors real production numbers pulled read-only
 * from a production database snapshot (2026-09-08):
 *   - total non-disabled models: 111,666
 *   - curated/native bucket (hubInventoryClass != 'aggregated_index'): 37,629
 *     rows across 95 distinct providers (EXPLAIN ANALYZE Memoize node:
 *     "Hits: 37,534  Misses: 95")
 *   - aggregated/HF-index bucket (serverless_callable=true): 73,782 rows
 *   - the curated-bucket snapshot query itself (getCuratedBucketSnapshot's
 *     exact SQL) measured via live EXPLAIN ANALYZE: 176.454ms execution time
 *   - the aggregated-bucket query (getAggregatedBucketUids' exact SQL,
 *     ORDER BY usage_count DESC LIMIT 300): 2.005ms execution time
 * See this file's sibling full-cache-fair-candidate-retrieval.test.ts and the
 * PR description for the full comparison against these baselines.
 *
 * This is a real Node process executing the REAL shipped functions
 * (getFullCacheFairCandidateModels, and model-catalog-service.ts's real
 * catalog-hydration path via refreshCatalogCacheAhead — which runs the real
 * buildCatalogIndices()) against this realistically-sized/shaped dataset —
 * not a theoretical estimate. Only the Postgres/Redis boundary is mocked
 * (same convention as every other test in this area).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findManyMock = vi.fn();
vi.mock('@/database/client', () => ({
  prisma: { model: { findMany: (...args: unknown[]) => findManyMock(...args) } },
  Prisma: {},
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

import {
  DynamicModelSelector,
  getFullCacheFairCandidateModels,
} from '@/core/selection/dynamic-model-selector';
import { getAllCatalogModels, invalidateCatalogCache } from '@/services/model-catalog-service';

/** Per-provider curated-bucket breakdown reflecting a real production shape
 *  (cited in curated-fair-selection.test.ts and dynamic-model-selector.ts's
 *  own module doc), reused here rather than re-deriving so both suites are
 *  anchored to the same numbers. Padded with synthetic long-tail providers
 *  to reach the same distinct-provider count and curated-row total measured
 *  in that snapshot. */
const NAMED_CURATED_PROVIDERS: Array<[string, number]> = [
  ['dominant-aggregator', 22_144],
  ['minor-aggregator-1', 1_464],
  ['minor-aggregator-2', 1_292],
  ['minor-aggregator-3', 1_013],
  ['minor-aggregator-4', 879],
  ['openai', 136],
  ['cohere', 35],
  ['xai', 21],
  ['anthropic', 15],
  ['google', 12],
  ['deepseek', 3],
];

function buildRealisticCatalogRecords(): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  let namedTotal = 0;
  for (const [provider, count] of NAMED_CURATED_PROVIDERS) {
    namedTotal += count;
    for (let i = 0; i < count; i++) {
      records.push(curatedRecord(`${provider}-${i}`, provider));
    }
  }
  // Long tail: remaining distinct providers (95 - 11 named = 84) sharing the
  // remaining row budget (37,629 - namedTotal) — mirrors "95 distinct
  // providers total" from the live EXPLAIN ANALYZE Memoize node.
  const remainingProviders = 95 - NAMED_CURATED_PROVIDERS.length;
  const remainingRows = 37_629 - namedTotal;
  const perTailProvider = Math.floor(remainingRows / remainingProviders);
  for (let p = 0; p < remainingProviders; p++) {
    const providerName = `long-tail-provider-${p}`;
    const rows = p === remainingProviders - 1 ? remainingRows - perTailProvider * (remainingProviders - 1) : perTailProvider;
    for (let i = 0; i < rows; i++) {
      records.push(curatedRecord(`${providerName}-${i}`, providerName));
    }
  }
  // Aggregated/HF-index bucket: 73,782 rows, one dominant provider
  // (huggingface), matching the live count.
  for (let i = 0; i < 73_782; i++) {
    records.push(aggregatedRecord(`hf-${i}`));
  }
  // Real finding, unrelated to this PR (pre-existing in the OLD SQL path
  // too, since both bucket predicates are copied verbatim from
  // getCuratedBucketSnapshot/getAggregatedBucketUids): 111,666 (total) -
  // 37,629 (curated) - 73,782 (aggregated/serverless_callable) = 255 rows
  // are tagged `hubInventoryClass: 'aggregated_index'` but NOT
  // `serverless_callable: true` — structurally invisible to BOTH buckets
  // (excluded from curated by the aggregated_index tag, excluded from
  // aggregated by lacking serverless_callable). Included here so this
  // benchmark's row count matches the live total exactly, and so this path's
  // pool composition (700 candidates below) is measured against the SAME
  // "some rows are unreachable by design" reality the SQL path already has —
  // not swept under the rug by a rounder synthetic total.
  for (let i = 0; i < 255; i++) {
    records.push({ ...curatedRecord(`orphan-${i}`, 'orphan-provider'), metadata: { hubInventoryClass: 'aggregated_index' } });
  }
  return records;
}

function curatedRecord(id: string, providerName: string) {
  // Real top legacy-capability distribution, live prod 2026-09-08: chat
  // 53,492/111,666 (~48%), reasoning 4,110 (~3.7%), vision 3,326 (~3%),
  // function_calling 2,366 (~2.1%) — approximated per-row via a stable hash
  // of the id so the synthetic capability index has a realistic, non-uniform
  // shape instead of every row declaring every capability.
  const h = hashStr(id);
  const capabilities = ['chat'];
  if (h % 100 < 4) capabilities.push('reasoning');
  if (h % 100 < 3) capabilities.push('vision');
  if (h % 100 < 2) capabilities.push('function_calling');
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

function aggregatedRecord(id: string) {
  const h = hashStr(id);
  const capabilities = ['chat'];
  if (h % 100 < 4) capabilities.push('reasoning');
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

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

beforeEach(() => {
  findManyMock.mockReset();
  fakeRedisStore.clear();
  invalidateCatalogCache();
});

describe('SELECTION_USE_FULL_CACHE_INDEX real-scale benchmark', () => {
  it(
    'builds indices + runs candidate retrieval over the real production catalog shape (111,666 rows, 95 curated providers, 73,782 aggregated) fast enough for the request hot path',
    async () => {
      const records = buildRealisticCatalogRecords();
      expect(records.length).toBe(111_666); // matches the live count exactly

      findManyMock.mockResolvedValue(records);

      // Best-effort GC before the "before" snapshot so the memory delta below
      // isn't dominated by unrelated garbage from building `records` itself.
      // Only available when the process runs with --expose-gc (not guaranteed
      // in every CI invocation) — when absent this measurement is a looser
      // upper bound, not invalid, and is reported as such.
      global.gc?.();
      const heapBefore = process.memoryUsage().heapUsed;

      // Phase 1: catalog hydration + index build (the cost that already runs
      // today, off the request path, on the 4min refresh-ahead cadence — see
      // cache-refresh-ahead.ts). Timed separately from phase 2 because this
      // cost is NOT attributable to any single request either way.
      const hydrateStart = performance.now();
      const models = await getAllCatalogModels();
      const hydrateMs = performance.now() - hydrateStart;
      expect(models.length).toBe(111_666);
      expect(findManyMock).toHaveBeenCalledTimes(1);

      global.gc?.();
      const heapAfterCatalog = process.memoryUsage().heapUsed;
      const catalogPlusIndicesMb = (heapAfterCatalog - heapBefore) / (1024 * 1024);

      // Phase 1b: isolate JUST the indices' incremental cost from the
      // catalog's own (pre-existing, unrelated-to-this-PR) memory cost. The
      // real `models` array (and its Model objects) is already resident at
      // this point — building a second, independent set of Maps/Sets over
      // the SAME model references (no object copying, same as the real
      // buildCatalogIndices in model-catalog-service.ts) isolates exactly
      // what those Maps/Sets themselves cost on top of the already-resident
      // catalog.
      global.gc?.();
      const heapBeforeIndicesOnly = process.memoryUsage().heapUsed;
      const byId2 = new Map<string, (typeof models)[number]>();
      const byProvider2 = new Map<string, string[]>();
      const byCapability2 = new Map<string, Set<string>>();
      for (const model of models) {
        byId2.set(model.id, model);
        const list = byProvider2.get(model.provider);
        if (list) list.push(model.id);
        else byProvider2.set(model.provider, [model.id]);
        for (const cap of model.capabilities ?? []) {
          let set = byCapability2.get(cap);
          if (!set) {
            set = new Set();
            byCapability2.set(cap, set);
          }
          set.add(model.id);
        }
      }
      global.gc?.();
      const heapAfterIndicesOnly = process.memoryUsage().heapUsed;
      const indicesOnlyMb = (heapAfterIndicesOnly - heapBeforeIndicesOnly) / (1024 * 1024);
      expect(byId2.size).toBe(111_666);

      // Phase 2: the actual per-request candidate-retrieval cost this PR
      // introduces — getFullCacheFairCandidateModels, reading the
      // already-warm indices synchronously, zero I/O.
      const iterations = 20;
      const perCallMs: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const result = getFullCacheFairCandidateModels(
          { contextSize: 1000 },
          400, // curatedTake (default)
          300, // aggregatedUsageTake (400 total - 100 popularity reserve, default)
          0.15 // curatedMaxProviderShare (default)
        );
        perCallMs.push(performance.now() - start);
        expect(result.models.length).toBeGreaterThan(0);
      }
      const avgMs = perCallMs.reduce((a, b) => a + b, 0) / iterations;
      const maxMs = Math.max(...perCallMs);

      // eslint-disable-next-line no-console
      console.info(
        `[SELECTION_USE_FULL_CACHE_INDEX benchmark] catalog hydrate+index-build (111,666 rows): ${hydrateMs.toFixed(2)}ms | ` +
          `getFullCacheFairCandidateModels: avg ${avgMs.toFixed(3)}ms, max ${maxMs.toFixed(3)}ms over ${iterations} calls | ` +
          `heap delta (catalog+indices combined, ${global.gc ? 'GC-forced' : 'NOT GC-forced — upper bound'}): ${catalogPlusIndicesMb.toFixed(1)}MB | ` +
          `heap delta (indices ONLY, isolated from the already-resident catalog): ${indicesOnlyMb.toFixed(1)}MB`
      );

      // Generous bounds (CI-machine variance) — the point is "single-digit to
      // low-double-digit ms per request, not hundreds of ms", which is what
      // makes this viable on the request hot path at all. Compare against the
      // SQL path's own live-measured 176.454ms (curated snapshot, cold) +
      // 2.005ms (aggregated, every request) baseline cited in the module doc
      // above.
      expect(avgMs).toBeLessThan(200);
    },
    30_000
  );

  it('a full DynamicModelSelector.findModelsByRequirements call, on a WARM catalog cache, completes well within the request budget (steady-state — the realistic case, since the cache is kept warm by the 4min refresh-ahead timer)', async () => {
    const records = buildRealisticCatalogRecords();
    findManyMock.mockResolvedValue(records);
    process.env.SELECTION_USE_FULL_CACHE_INDEX = 'true';
    try {
      // Pre-warm — matches real prod: the catalog cache is refreshed
      // fleet-wide every 4min by cache-refresh-ahead.ts, off the request
      // path, so an actual request essentially never pays the cold-hydration
      // cost (measured separately, and separately bounded, in the test
      // above: ~111,666-row mapPrismaModel projection + index build).
      await getAllCatalogModels();

      const selector = new DynamicModelSelector();
      const start = performance.now();
      const result = await selector.findModelsByRequirements({
        taskType: 'general',
        complexity: 'medium',
        contextSize: 1000,
      });
      const elapsedMs = performance.now() - start;

      // eslint-disable-next-line no-console
      console.info(
        `[SELECTION_USE_FULL_CACHE_INDEX benchmark] full findModelsByRequirements (WARM catalog cache — the realistic steady-state case): ${elapsedMs.toFixed(2)}ms, ${result.length} candidates returned`
      );

      expect(result.length).toBeGreaterThan(0);
      // Compare against the SQL path's OWN live-measured steady-state cost:
      // ~2.005ms (aggregated query, every request) + the uid-membership
      // findMany hydration round trip, typically low tens of ms end to end.
      // This bound is generous for CI-machine variance — the real claim is
      // "single-digit to low-double-digit ms", not "under 500ms".
      expect(elapsedMs).toBeLessThan(500);
    } finally {
      delete process.env.SELECTION_USE_FULL_CACHE_INDEX;
    }
  }, 30_000);
});
