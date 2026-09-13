// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * calculateRecentTrend() used to fire TWO model_performance_metrics findMany
 * per candidate with history on every model=auto selection. This suite pins
 * the batched prefetch (one IN-list query per selection, cached per model id
 * for a short TTL) and, above all, proves the numbers are unchanged: for the
 * same fixture rows the legacy per-candidate path and the batched path yield
 * bit-identical trends.
 *
 * Same mocking convention as bucket-fair-candidate-retrieval.test.ts:
 * `vi.mock('@/database/client')` with hoisted fns and ONE static import of the
 * selector (its module graph is expensive to re-initialise).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMetricFindMany } = vi.hoisted(() => ({ mockMetricFindMany: vi.fn() }));

vi.mock('@/database/client', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $transaction: (cb: (tx: unknown) => unknown) => Promise.resolve(cb({ $queryRaw: vi.fn() })),
    model: { findMany: vi.fn().mockResolvedValue([]) },
    learningBucket: { findMany: vi.fn().mockResolvedValue([]) },
    modelPerformanceMetric: { findMany: mockMetricFindMany },
  },
}));

process.env.SELECTION_POPULARITY_SEED = 'false';

import { DynamicModelSelector, computeRecentTrend } from '@/core/selection/dynamic-model-selector';

const NOW = new Date('2026-09-11T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

interface MetricRow {
  modelId: string;
  timeBucket: Date;
  qualityScore: number | null;
  successRate: number;
}

const FIXTURE: MetricRow[] = [
  // improving: recent 0.8 vs historical 0.5 -> +0.6
  { modelId: 'm-up', timeBucket: daysAgo(2), qualityScore: 0.8, successRate: 1 },
  { modelId: 'm-up', timeBucket: daysAgo(10), qualityScore: 0.4, successRate: 1 },
  { modelId: 'm-up', timeBucket: daysAgo(25), qualityScore: 0.6, successRate: 1 },
  { modelId: 'm-up', timeBucket: daysAgo(40), qualityScore: 0.0, successRate: 1 }, // outside 30d
  // degrading: recent 0.2 vs historical 0.8 -> -0.75
  { modelId: 'm-down', timeBucket: daysAgo(1), qualityScore: 0.2, successRate: 1 },
  { modelId: 'm-down', timeBucket: daysAgo(8), qualityScore: 0.8, successRate: 1 },
  // clamp: recent 0.9 vs historical 0.1 -> 8, clamped to 1
  { modelId: 'm-clamp', timeBucket: daysAgo(3), qualityScore: 0.9, successRate: 1 },
  { modelId: 'm-clamp', timeBucket: daysAgo(20), qualityScore: 0.1, successRate: 1 },
  // recent only -> 0
  { modelId: 'm-recent-only', timeBucket: daysAgo(4), qualityScore: 0.7, successRate: 1 },
  // null quality in the historical window -> historical avg 0 -> 0
  { modelId: 'm-null-hist', timeBucket: daysAgo(5), qualityScore: 0.7, successRate: 1 },
  { modelId: 'm-null-hist', timeBucket: daysAgo(15), qualityScore: null, successRate: 1 },
  // null quality in the recent window counts as 0: (0 - 0.5) / 0.5 -> -1
  { modelId: 'm-null-recent', timeBucket: daysAgo(6), qualityScore: null, successRate: 1 },
  { modelId: 'm-null-recent', timeBucket: daysAgo(16), qualityScore: 0.5, successRate: 1 },
];
const FIXTURE_IDS = ['m-up', 'm-down', 'm-clamp', 'm-recent-only', 'm-null-hist', 'm-null-recent'];

/** Emulates Prisma's where-clause on the in-memory fixture for BOTH shapes
 *  the selector issues: `modelId: string` (legacy per-candidate, gte and
 *  optional lt) and `modelId: { in }` (batched prefetch, gte only). */
function fixtureFindMany(rows: MetricRow[] = FIXTURE) {
  return (args: {
    where: {
      modelId: string | { in: string[] };
      timeBucket: { gte: Date; lt?: Date };
    };
  }) => {
    const { modelId, timeBucket } = args.where;
    const ids = typeof modelId === 'string' ? [modelId] : modelId.in;
    return Promise.resolve(
      rows.filter(
        (r) =>
          ids.includes(r.modelId) &&
          r.timeBucket >= timeBucket.gte &&
          (timeBucket.lt === undefined || r.timeBucket < timeBucket.lt)
      )
    );
  };
}

type SelectorInternals = {
  calculateRecentTrend(modelId: string): Promise<number>;
  prefetchRecentTrends(modelIds: string[]): Promise<void>;
};
const internals = (selector: DynamicModelSelector): SelectorInternals =>
  selector as unknown as SelectorInternals;

const batchCalls = () =>
  mockMetricFindMany.mock.calls.filter(
    (call) => typeof (call[0] as { where: { modelId: unknown } }).where.modelId !== 'string'
  );
const perCandidateCalls = () =>
  mockMetricFindMany.mock.calls.filter(
    (call) => typeof (call[0] as { where: { modelId: unknown } }).where.modelId === 'string'
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockMetricFindMany.mockReset();
  mockMetricFindMany.mockImplementation(fixtureFindMany());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('computeRecentTrend (pure)', () => {
  const q = (...scores: Array<number | null>) => scores.map((qualityScore) => ({ qualityScore }));

  it('is the relative change of the recent average over the historical average', () => {
    expect(computeRecentTrend(q(0.8), q(0.5))).toBeCloseTo(0.6, 12);
    expect(computeRecentTrend(q(0.2), q(0.8))).toBeCloseTo(-0.75, 12);
  });

  it('clamps to [-1, 1]', () => {
    expect(computeRecentTrend(q(0.9), q(0.1))).toBe(1);
    expect(computeRecentTrend(q(0), q(0.5))).toBe(-1);
  });

  it('returns 0 when either side is empty or the historical average is 0', () => {
    expect(computeRecentTrend([], q(0.5))).toBe(0);
    expect(computeRecentTrend(q(0.5), [])).toBe(0);
    expect(computeRecentTrend(q(0.5), q(0, null))).toBe(0);
  });

  it('treats a null qualityScore as 0', () => {
    expect(computeRecentTrend(q(null, 0.4), q(0.4))).toBe(-0.5);
  });
});

describe('prefetchRecentTrends', () => {
  it('yields exactly the trends the legacy per-candidate path computes', async () => {
    const legacy = internals(new DynamicModelSelector());
    const legacyTrends: Record<string, number> = {};
    for (const id of FIXTURE_IDS) {
      legacyTrends[id] = await legacy.calculateRecentTrend(id);
    }
    expect(perCandidateCalls()).toHaveLength(FIXTURE_IDS.length * 2);
    expect(batchCalls()).toHaveLength(0);

    mockMetricFindMany.mockClear();
    const batched = internals(new DynamicModelSelector());
    await batched.prefetchRecentTrends(FIXTURE_IDS);
    expect(batchCalls()).toHaveLength(1);

    for (const id of FIXTURE_IDS) {
      expect(await batched.calculateRecentTrend(id)).toBe(legacyTrends[id]);
    }
    expect(perCandidateCalls()).toHaveLength(0);

    // Sanity on the fixture itself so a broken mock cannot pass as "0 === 0".
    expect(legacyTrends['m-up']).toBeCloseTo(0.6, 12);
    expect(legacyTrends['m-down']).toBeCloseTo(-0.75, 12);
    expect(legacyTrends['m-clamp']).toBe(1);
    expect(legacyTrends['m-recent-only']).toBe(0);
    expect(legacyTrends['m-null-hist']).toBe(0);
    expect(legacyTrends['m-null-recent']).toBe(-1);
  });

  it('issues a single IN-list query over the 30-day window', async () => {
    const selector = internals(new DynamicModelSelector());
    await selector.prefetchRecentTrends(['m-up', 'm-down', 'm-up']);

    expect(mockMetricFindMany).toHaveBeenCalledTimes(1);
    const args = mockMetricFindMany.mock.calls[0][0] as {
      where: { modelId: { in: string[] }; timeBucket: { gte: Date; lt?: Date } };
      select: Record<string, boolean>;
    };
    expect(args.where.modelId.in).toEqual(['m-up', 'm-down']);
    expect(args.where.timeBucket.gte.getTime()).toBe(daysAgo(30).getTime());
    expect(args.where.timeBucket.lt).toBeUndefined();
    expect(args.select).toEqual({ modelId: true, timeBucket: true, qualityScore: true });
  });

  it('caches per id: no query inside the TTL, one query after it', async () => {
    const selector = internals(new DynamicModelSelector());
    await selector.prefetchRecentTrends(FIXTURE_IDS);
    expect(mockMetricFindMany).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(59_000);
    await selector.prefetchRecentTrends(FIXTURE_IDS);
    expect(mockMetricFindMany).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await selector.prefetchRecentTrends(FIXTURE_IDS);
    expect(mockMetricFindMany).toHaveBeenCalledTimes(2);
  });

  it('only fetches ids that are not already cached', async () => {
    const selector = internals(new DynamicModelSelector());
    await selector.prefetchRecentTrends(['m-up']);
    await selector.prefetchRecentTrends(['m-up', 'm-down']);

    expect(mockMetricFindMany).toHaveBeenCalledTimes(2);
    const second = mockMetricFindMany.mock.calls[1][0] as { where: { modelId: { in: string[] } } };
    expect(second.where.modelId.in).toEqual(['m-down']);
  });

  it('caches 0 for ids without rows so they are not re-queried per candidate', async () => {
    const selector = internals(new DynamicModelSelector());
    await selector.prefetchRecentTrends(['m-missing']);
    mockMetricFindMany.mockClear();

    expect(await selector.calculateRecentTrend('m-missing')).toBe(0);
    expect(mockMetricFindMany).not.toHaveBeenCalled();
  });

  it('fails open: a rejected batch leaves the per-candidate path intact', async () => {
    mockMetricFindMany.mockRejectedValueOnce(new Error('connection reset'));
    const selector = internals(new DynamicModelSelector());

    await expect(selector.prefetchRecentTrends(['m-up'])).resolves.toBeUndefined();

    expect(await selector.calculateRecentTrend('m-up')).toBeCloseTo(0.6, 12);
    expect(perCandidateCalls()).toHaveLength(2);
  });

  it('per-candidate fallback also populates the cache', async () => {
    const selector = internals(new DynamicModelSelector());
    await selector.calculateRecentTrend('m-down');
    await selector.calculateRecentTrend('m-down');

    expect(mockMetricFindMany).toHaveBeenCalledTimes(2);
  });
});
