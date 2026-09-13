// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Bucket-fair candidate retrieval regression test (2026-09-07 catalog-
 * visibility fix + 2026-09-07 provider-fairness follow-up). Drives the REAL
 * DynamicModelSelector.findModelsByRequirements — production validation,
 * production filtering, production mapping — the same spirit as
 * selector-hard-capability-failclosed.test.ts's approach for this module: the
 * Prisma boundary is mocked with fixture rows, no selection logic is
 * reimplemented here.
 *
 * `prisma.$transaction`/`$queryRaw` turn out to be Proxy-trapped methods on
 * the generated client (confirmed while writing this test: `vi.spyOn(prisma,
 * '$transaction')` throws "does not exist", and even a direct property
 * assignment is silently swallowed by the proxy's own get/set traps) — unlike
 * `prisma.model.findMany`, which IS a plain spy-able method (the pattern the
 * sibling test uses). So this suite follows this repo's OTHER established
 * convention for mocking `$queryRaw`/`$executeRaw` (see
 * core/evaluation/__tests__/drift-detection.test.ts): `vi.mock('@/database/client')`
 * with `vi.hoisted` mock fns, so the whole module graph is imported ONCE,
 * normally, against the mock already in place — no `vi.resetModules()` +
 * dynamic re-import (measured: that pattern forces `dynamic-model-selector.ts`'s
 * large transitive graph — capability search, model catalog, central
 * discovery, its own ModelCache/Redis singleton init, ... — to re-initialize
 * from scratch on every fresh import, ~5-6s per call here vs a normal one-time
 * import cost elsewhere in this suite; that's a real risk of tripping the
 * global 30s test timeout on a loaded CI machine, and it did in the full-suite
 * run while developing this test).
 *
 * Bug being regression-tested at the BUCKET level (live-prod repro,
 * 2026-09-07): the old single-OR + ORDER BY usage_count DESC LIMIT 800 query
 * returned 0 curated / 800 aggregated candidates — every openai/anthropic/
 * google/xai/... row was structurally invisible to selection because
 * usage_count ties at 0 for every row and the ~74k-row aggregated population
 * always wins the tie over the ~37.6k-row curated population.
 * getBucketFairCandidateUids replaces that with two independently-capped
 * branches so neither bucket can starve the other regardless of relative size
 * or tie-breaking.
 *
 * Bug being regression-tested at the PROVIDER level (adversarial re-audit,
 * 2026-09-07): the same defect one level down, the curated bucket itself is
 * dominated by a single real third-party aggregator, so a plain
 * `ORDER BY usage_count DESC LIMIT curatedTake` over the curated bucket alone
 * returns effectively 100% of that one aggregator in production, leaving
 * openai/anthropic/google/xai/cohere/deepseek unreachable even after the
 * bucket-level fix above.
 * selectCuratedFairUids fixes this with a dynamic, per-provider round-robin
 * + cap — see curated-fair-selection.test.ts for pure-function coverage of
 * that mechanism in isolation; this file covers it wired end-to-end through
 * findModelsByRequirements.
 *
 * IMPORTANT (flaky-test hardening, 2026-09-07): a prior version of this
 * suite's "never-collapse" test used `mockResolvedValueOnce` call-count
 * assumptions (the Nth `$queryRaw`/`findMany` call gets the Nth fixture) and
 * failed intermittently when run as part of the FULL suite — order/
 * parallelism-dependent, because module-scope caches
 * (curatedBucketSnapshotCache / aggregatedPopularitySeedCache) can carry a
 * warm value across tests, shifting which call in a test actually hits the
 * mock. This version fixes that at the root: (1) every test calls
 * `__resetBucketFairCachesForTests()` in `beforeEach` so each test starts
 * from a guaranteed cache-miss, and (2) `mockQueryRaw`/`mockFindMany` dispatch
 * on the CONTENT of each call (which SQL text, which uids were requested)
 * rather than on call order, so an extra or reordered call cannot silently
 * consume the wrong fixture.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';

const { mockQueryRaw, mockExecuteRawUnsafe, mockFindMany } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockExecuteRawUnsafe: vi.fn().mockResolvedValue(0),
  mockFindMany: vi.fn(),
}));

vi.mock('@/database/client', () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
    $executeRawUnsafe: mockExecuteRawUnsafe,
    // getBucketFairCandidateUids/getCuratedBucketSnapshot/getAggregatedBucketUids
    // each wrap their raw SQL in $transaction — simulate a real transaction by
    // invoking the callback with this same mock object as the tx client.
    $transaction: (cb: (tx: unknown) => unknown) =>
      Promise.resolve(cb({ $queryRaw: mockQueryRaw, $executeRawUnsafe: mockExecuteRawUnsafe })),
    model: { findMany: mockFindMany },
  },
}));

process.env.SELECTION_POPULARITY_SEED = 'false';

// Import AFTER the mock/env setup above — this is a normal static import
// (ES import declarations hoist to the top of the module regardless of
// source position, and vitest hoists the `vi.mock` call itself above every
// import), so DynamicModelSelector's top-level `import { prisma }` resolves
// against the mock from the very first (and only) module evaluation.
import {
  DynamicModelSelector,
  __resetBucketFairCachesForTests,
} from '@/core/selection/dynamic-model-selector';

function randomUid(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

/** Extract the static SQL text Prisma's tagged-template `Sql` object carries
 *  (`.sql`, with `?` placeholders) so mocks can dispatch on WHAT a raw query
 *  is, not on call order. */
function sqlTextOf(query: unknown): string {
  if (query && typeof query === 'object' && 'sql' in query) {
    return String((query as { sql: unknown }).sql);
  }
  return String(query);
}

interface CuratedSnapshotFixtureRow {
  uid: string;
  providerId: string;
  providerName: string;
  contextWindow: number;
  usageCount: number;
}

/** Wires mockQueryRaw to dispatch by SQL shape instead of call order —
 *  content-based, so it stays correct regardless of how many raw queries a
 *  request actually issues or in what order they resolve. */
function mockRawQueries(fixtures: {
  curatedSnapshot?: CuratedSnapshotFixtureRow[];
  aggregated?: Array<{ uid: string }>;
  popularitySeed?: Array<{ uid: string }>;
}): void {
  mockQueryRaw.mockImplementation((query: unknown) => {
    const text = sqlTextOf(query);
    if (text.includes('hubInventoryClass')) {
      return Promise.resolve(fixtures.curatedSnapshot ?? []);
    }
    if (text.includes('downloads')) {
      return Promise.resolve(fixtures.popularitySeed ?? []);
    }
    if (text.includes('serverless_callable')) {
      return Promise.resolve(fixtures.aggregated ?? []);
    }
    return Promise.resolve([]);
  });
}

/** Wires mockFindMany to dispatch on the requested uid set (or the general
 *  never-collapse fallback shape with no uid filter) against an in-memory
 *  catalog, instead of a fixed call-count queue. */
function mockHydration(catalogRows: Array<Record<string, unknown> & { uid: string }>, fallbackPool: Array<Record<string, unknown>> = []): void {
  const catalog = new Map(catalogRows.map((r) => [r.uid, r]));
  mockFindMany.mockImplementation(async (args: { where?: { uid?: { in?: string[] } } }) => {
    const inUids = args?.where?.uid?.in;
    if (inUids) {
      return inUids.map((u) => catalog.get(u)).filter((r): r is NonNullable<typeof r> => Boolean(r));
    }
    return fallbackPool;
  });
}

/** A curated/native row: no `serverless_callable` flag, no hubInventoryClass
 *  marker (the real shape openai/anthropic/google/xai rows carry). */
function curatedRecord(uid: string, providerName: string) {
  return {
    id: uid,
    uid,
    providerId: `${providerName}-provider-id`,
    provider: { name: providerName },
    name: uid,
    displayName: uid,
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
    capabilities: ['chat', 'reasoning'],
    capabilityUris: [],
    performance: { latencyMs: 500, throughput: 100, quality: 0.9, reliability: 0.99 },
    status: 'active',
    metadata: {}, // curated rows legitimately carry no HF metadata at all
    usageCount: 0,
  };
}

/** An aggregated/HF-index row: serverless_callable + hubInventoryClass — the
 *  real shape the ~74k HuggingFace hub rows carry. */
function aggregatedRecord(uid: string) {
  return {
    id: uid,
    uid,
    providerId: 'huggingface-provider-id',
    provider: { name: 'huggingface' },
    name: uid,
    displayName: uid,
    contextWindow: 32_000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat'],
    capabilityUris: [],
    performance: { latencyMs: 800, throughput: 50, quality: 0.6, reliability: 0.9 },
    status: 'active',
    metadata: { serverless_callable: true, hubInventoryClass: 'aggregated_index' },
    usageCount: 0,
  };
}

/** A curated-snapshot row (the shape getCuratedBucketSnapshot's raw query
 *  returns — uid/providerId/providerName/contextWindow/usageCount only). */
function snapshotRow(
  uid: string,
  providerName: string,
  overrides: Partial<CuratedSnapshotFixtureRow> = {}
): CuratedSnapshotFixtureRow {
  return {
    uid,
    providerId: `${providerName}-provider-id`,
    providerName,
    contextWindow: 128_000,
    usageCount: 0,
    ...overrides,
  };
}

const baseCriteria = {
  taskType: 'general' as const,
  complexity: 'medium' as const,
  contextSize: 1000,
};

describe('bucket-fair candidate retrieval', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRawUnsafe.mockReset().mockResolvedValue(0);
    mockFindMany.mockReset();
    // See the file-level doc: guarantees every test starts from a real
    // cache-miss on both the curated-bucket snapshot and the popularity-seed
    // pool, regardless of what ran earlier in this worker/suite.
    __resetBucketFairCachesForTests();
    process.env.SELECTION_POPULARITY_SEED = 'false';
  });

  it('(a) a representative request returns a MIX of curated/native and aggregated-index candidates, not 100% one bucket', async () => {
    const openaiUid = randomUid('openai');
    const anthropicUid = randomUid('anthropic');
    const agg1 = randomUid('hf');
    const agg2 = randomUid('hf');
    const agg3 = randomUid('hf'); // pad past the terminal never-collapse floor (<5 total)

    // Simulates the real curated-snapshot + aggregated-bucket queries: the
    // curated bucket surfaces openai/anthropic on their own (independent
    // fairness selection), the aggregated bucket its own rows — exactly the
    // shape that fixes the bug (the OLD single OR+LIMIT query would have
    // returned 0 curated rows here).
    mockRawQueries({
      curatedSnapshot: [snapshotRow(openaiUid, 'openai'), snapshotRow(anthropicUid, 'anthropic')],
      aggregated: [{ uid: agg1 }, { uid: agg2 }, { uid: agg3 }],
    });
    mockHydration([
      curatedRecord(openaiUid, 'openai'),
      curatedRecord(anthropicUid, 'anthropic'),
      aggregatedRecord(agg1),
      aggregatedRecord(agg2),
      aggregatedRecord(agg3),
    ]);

    const selector = new DynamicModelSelector();
    const result = await selector.findModelsByRequirements(baseCriteria);

    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('SET LOCAL statement_timeout')
    );

    const resultIds = result.map((m) => m.id);
    const curatedInResult = resultIds.filter((id) => id === openaiUid || id === anthropicUid);
    const aggregatedInResult = resultIds.filter((id) => id === agg1 || id === agg2);

    // The regression this test locks: BOTH buckets are represented. Before
    // the fix, curatedInResult would always be [] (0/N curated survivors).
    expect(curatedInResult.length).toBeGreaterThan(0);
    expect(aggregatedInResult.length).toBeGreaterThan(0);
    expect(curatedInResult).not.toHaveLength(resultIds.length); // not 100% curated
    expect(aggregatedInResult).not.toHaveLength(resultIds.length); // not 100% aggregated
  });

  it('(b) a curated model with NO serverless_callable flag is reachable when it is a strong real match', async () => {
    // This is the exact shape that was structurally invisible before the fix:
    // a real openai/anthropic/google/xai row that legitimately has no
    // serverless_callable metadata (that flag is only ever written by the HF
    // fetcher's transform) and is tagged non-aggregated_index.
    const anthropicUid = randomUid('anthropic-strong-match');
    // Filler candidates so the pool clears the terminal never-collapse floor
    // (<5 total) and this test genuinely exercises the bucket-fair hydration
    // path, not the unrelated full-catalog fallback.
    const fillerUids = [randomUid('filler'), randomUid('filler'), randomUid('filler'), randomUid('filler')];

    mockRawQueries({
      curatedSnapshot: [snapshotRow(anthropicUid, 'anthropic')],
      aggregated: fillerUids.map((uid) => ({ uid })),
    });
    mockHydration([curatedRecord(anthropicUid, 'anthropic'), ...fillerUids.map((uid) => aggregatedRecord(uid))]);

    const selector = new DynamicModelSelector();
    const result = await selector.findModelsByRequirements({
      ...baseCriteria,
      requiredCapabilities: ['reasoning'],
    });

    expect(result.map((m) => m.id)).toContain(anthropicUid);
    const found = result.find((m) => m.id === anthropicUid)!;
    expect(found.provider).toBe('anthropic');
    // Confirms this candidate reached the ranker with no serverless_callable
    // in its metadata at all — it was never excluded for lacking that field.
    expect(found.metadata?.serverless_callable).toBeUndefined();
  });

  it('(c) provider-fairness: openai/anthropic/google are reachable even when one provider supplies 59% of the curated bucket', async () => {
    // Reproduces the real live-prod shape found by the adversarial review:
    // one non-premium aggregator (here: "dominant-aggregator") supplies
    // the overwhelming majority of curated rows,
    // with openai/anthropic/google each contributing only a handful — exactly
    // the ratio (~59% / a few dozen each) measured in production. Before the
    // per-provider fairness fix, a plain `ORDER BY usage_count DESC LIMIT N`
    // over this shape returns 100% dominant-aggregator; every real request
    // shape this fix exists for must still surface the minority providers.
    const dominantRows = Array.from({ length: 300 }, (_, i) =>
      snapshotRow(randomUid(`dominant-${i}`), 'dominant-aggregator')
    );
    const openaiUid = randomUid('openai');
    const anthropicUid = randomUid('anthropic');
    const googleUid = randomUid('google');

    mockRawQueries({
      curatedSnapshot: [
        ...dominantRows,
        snapshotRow(openaiUid, 'openai'),
        snapshotRow(anthropicUid, 'anthropic'),
        snapshotRow(googleUid, 'google'),
      ],
      aggregated: [],
    });
    mockHydration([
      ...dominantRows.map((r) => curatedRecord(r.uid, 'dominant-aggregator')),
      curatedRecord(openaiUid, 'openai'),
      curatedRecord(anthropicUid, 'anthropic'),
      curatedRecord(googleUid, 'google'),
    ]);

    const selector = new DynamicModelSelector();
    const result = await selector.findModelsByRequirements(baseCriteria);
    const resultIds = new Set(result.map((m) => m.id));

    expect(resultIds.has(openaiUid)).toBe(true);
    expect(resultIds.has(anthropicUid)).toBe(true);
    expect(resultIds.has(googleUid)).toBe(true);

    // The dominant aggregator must not have consumed the whole curated take —
    // its per-provider cap (default 15% of curatedCandidateTake = 60, a HARD
    // cap that is never relaxed even though it has far more supply available)
    // must hold exactly.
    const dominantInResult = result.filter((m) => m.provider === 'dominant-aggregator');
    const curatedTake = 400; // default config
    expect(dominantInResult.length).toBeLessThanOrEqual(Math.ceil(curatedTake * 0.15));
  });

  it('never-collapse: both buckets empty falls back to the full unrestricted pool', async () => {
    const fallbackUid = randomUid('fallback');
    // getCuratedBucketSnapshot and getAggregatedBucketUids both return zero
    // rows (dispatched by content, not by call order/count).
    mockRawQueries({ curatedSnapshot: [], aggregated: [] });
    // The terminal never-collapse query is a plain findMany with NO uid
    // filter — mockHydration's fallbackPool argument serves that shape.
    mockHydration([], [curatedRecord(fallbackUid, 'openai')]);

    const selector = new DynamicModelSelector();
    const result = await selector.findModelsByRequirements(baseCriteria);

    expect(result.map((m) => m.id)).toContain(fallbackUid);
  });

  it('popularity backstop: the seed pool hydration is cached, not re-queried on every request', async () => {
    process.env.SELECTION_POPULARITY_SEED = 'true';
    try {
      const openaiUid = randomUid('openai');
      const seedUid = randomUid('seed-popular');

      mockRawQueries({
        curatedSnapshot: [snapshotRow(openaiUid, 'openai')],
        aggregated: [],
        popularitySeed: [{ uid: seedUid }],
      });
      mockHydration(
        [curatedRecord(openaiUid, 'openai'), { ...aggregatedRecord(seedUid), contextWindow: 200_000 }],
        [curatedRecord(openaiUid, 'openai')]
      );

      const selector = new DynamicModelSelector();
      await selector.findModelsByRequirements(baseCriteria);
      const findManyCallsAfterFirst = mockFindMany.mock.calls.length;
      const queryRawCallsAfterFirst = mockQueryRaw.mock.calls.length;

      await selector.findModelsByRequirements(baseCriteria);
      const findManyCallsAfterSecond = mockFindMany.mock.calls.length;
      const queryRawCallsAfterSecond = mockQueryRaw.mock.calls.length;

      // The primary hydration (uid-membership findMany) and the aggregated
      // bucket's own live query DO run every request — only the
      // popularity-seed pool's raw query + hydration must be cache-hit on the
      // second call, i.e. the SAME (not doubled) number of underlying seed
      // queries fire relative to the first request's cache-miss baseline.
      // A regression back to the uncached-per-request hydration would show up
      // here as findMany call count roughly doubling between the two rounds.
      expect(findManyCallsAfterSecond - findManyCallsAfterFirst).toBeLessThan(findManyCallsAfterFirst);
      expect(queryRawCallsAfterSecond - queryRawCallsAfterFirst).toBeLessThan(queryRawCallsAfterFirst);
    } finally {
      process.env.SELECTION_POPULARITY_SEED = 'false';
    }
  });
});
