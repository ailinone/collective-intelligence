// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Paging contract of the worker's Postgres fallback (`postgres-paged-fetch.ts`)
 * against an in-memory querier that honors the same keyset predicate the
 * real Prisma querier in `worker.ts` issues (`uid > afterUid`, ordered by
 * `uid`, `take` rows). The real query itself is exercised end to end by
 * `sab-worker-concurrent-load-benchmark.test.ts` (Testcontainers).
 */
import { describe, expect, it, vi } from 'vitest';
import { mapPrismaModel } from '@/services/catalog-hot-path';
import {
  fetchCatalogModelsPaged,
  type CatalogHotPathRecordWithUid,
  type CatalogPageQuerier,
} from '../postgres-paged-fetch';

function record(i: number): CatalogHotPathRecordWithUid {
  const uid = `uid-${String(i).padStart(6, '0')}`;
  return {
    uid,
    id: `model-${i}`,
    providerId: `provider-${i % 7}`,
    name: `model-${i}`,
    displayName: `model-${i}`,
    contextWindow: 8_000,
    maxOutputTokens: 1_000,
    inputCostPer1k: 0.01 as unknown as CatalogHotPathRecordWithUid['inputCostPer1k'],
    outputCostPer1k: 0.02 as unknown as CatalogHotPathRecordWithUid['outputCostPer1k'],
    capabilities: ['chat', i % 3 === 0 ? 'vision' : 'reasoning'],
    performance: { latencyMs: 100, throughput: 10, quality: 0.5, reliability: 0.9 },
    status: 'active',
    metadata: { i },
    lastSyncedAt: new Date('2026-09-11T00:00:00Z'),
    provider: { name: `provider-${i % 7}` },
  };
}

function makeQuerier(rows: CatalogHotPathRecordWithUid[]): CatalogPageQuerier & { calls: Array<[string | null, number]> } {
  const sorted = [...rows].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  const calls: Array<[string | null, number]> = [];
  return {
    calls,
    fetchPage: vi.fn(async (afterUid: string | null, take: number) => {
      calls.push([afterUid, take]);
      return sorted.filter((r) => afterUid === null || r.uid > afterUid).slice(0, take);
    }),
  };
}

describe('fetchCatalogModelsPaged', () => {
  it('returns every row exactly once, mapped identically to mapPrismaModel, across ceil(n/pageSize) pages', async () => {
    const rows = Array.from({ length: 12_345 }, (_, i) => record(i));
    const querier = makeQuerier(rows);

    const { models, pages } = await fetchCatalogModelsPaged(querier, 1_000);

    expect(models.length).toBe(rows.length);
    expect(pages).toBe(13);
    expect(new Set(models.map((m) => m.id)).size).toBe(rows.length);
    expect(models).toEqual(rows.map(mapPrismaModel));
    expect(querier.calls[0]).toEqual([null, 1_000]);
    expect(querier.calls[1][0]).toBe('uid-000999');
    // The `lastSyncedAt` stamp `mapPrismaModel` folds into metadata must
    // survive the paged path unchanged (same mapper, same select shape).
    expect(models[0].metadata?.lastSyncedAt).toBe('2026-09-11T00:00:00.000Z');
  });

  it('terminates on an exact page-size multiple with one extra empty page', async () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => record(i));
    const { models, pages } = await fetchCatalogModelsPaged(makeQuerier(rows), 1_000);
    expect(models.length).toBe(2_000);
    expect(pages).toBe(3);
  });

  it('is unaffected by the cursor row being deleted between pages (keyset, not Prisma cursor)', async () => {
    const rows = Array.from({ length: 3_000 }, (_, i) => record(i));
    const live = [...rows];
    let fetches = 0;
    const querier: CatalogPageQuerier = {
      fetchPage: async (afterUid, take) => {
        fetches += 1;
        if (fetches === 2) {
          // Simulate discovery deleting the last row of page 1 and one row
          // deep inside page 2 while the worker is between pages.
          const victims = new Set(['uid-000999', 'uid-001500']);
          for (let i = live.length - 1; i >= 0; i--) if (victims.has(live[i].uid)) live.splice(i, 1);
        }
        return live
          .filter((r) => afterUid === null || r.uid > afterUid)
          .sort((a, b) => (a.uid < b.uid ? -1 : 1))
          .slice(0, take);
      },
    };

    const { models } = await fetchCatalogModelsPaged(querier, 1_000);
    const ids = models.map((m) => m.id);
    expect(ids.length).toBe(2_999);
    expect(new Set(ids).size).toBe(2_999);
    expect(ids).not.toContain('model-1500');
  });

  it('fails loudly instead of looping when the querier ignores the keyset predicate', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => record(i));
    const stuck: CatalogPageQuerier = { fetchPage: async (_afterUid, take) => rows.slice(0, take) };
    await expect(fetchCatalogModelsPaged(stuck, 10)).rejects.toThrow(/cursor did not advance/);
  });

  it('rejects a non-positive page size', async () => {
    await expect(fetchCatalogModelsPaged(makeQuerier([]), 0)).rejects.toThrow(/invalid page size/);
  });
});
