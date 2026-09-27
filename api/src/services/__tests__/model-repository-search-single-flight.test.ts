// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `ModelRepository.searchModels` single-flight.
 *
 * On 2026-09-24 one cold-cache selection (the triage pre-warm) scored ~39
 * models concurrently, each asking `searchModels` for the same criteria, and
 * the api ran 39 identical `WITH page AS` queries at once (66 connections in
 * its Prisma pool). With the Phase 1f pool of 23 that stampede would queue
 * every other query behind it. Concurrent identical searches must share one
 * L2 lookup and one database query, across repository instances (the
 * factory returns a fresh instance per call).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQueryRawUnsafe, mockGetValue, mockSetValue, l1 } = vi.hoisted(() => ({
  mockQueryRawUnsafe: vi.fn(),
  mockGetValue: vi.fn(),
  mockSetValue: vi.fn(),
  l1: new Map<string, unknown>(),
}));

vi.mock('@/database/client', () => ({
  prisma: { $queryRawUnsafe: mockQueryRawUnsafe },
}));

vi.mock('@/cache/distributed-cache-service', () => ({
  getDistributedCacheService: () => ({ getValue: mockGetValue, setValue: mockSetValue }),
}));

vi.mock('@/core/selection/model-selection-cache', () => ({
  getModelSelectionCache: () => ({
    get: (key: string) => l1.get(key),
    set: (key: string, value: unknown) => {
      l1.set(key, value);
    },
  }),
}));

import { ModelRepository, type ModelSearchCriteria } from '../model-repository';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// The shape of the stampede: capabilities force the raw-SQL path.
const TRIAGE_CRITERIA = {
  capabilities: ['chat', 'analysis'],
  limit: 100,
} as ModelSearchCriteria;

describe('ModelRepository.searchModels single-flight', () => {
  beforeEach(() => {
    l1.clear();
    mockQueryRawUnsafe.mockReset();
    mockGetValue.mockReset().mockResolvedValue({ hit: false });
    mockSetValue.mockReset().mockResolvedValue(undefined);
  });

  it('runs one L2 lookup and one query for concurrent identical searches', async () => {
    const db = deferred<unknown[]>();
    mockQueryRawUnsafe.mockReturnValueOnce(db.promise);

    const searches = Array.from({ length: 39 }, () =>
      new ModelRepository().searchModels(TRIAGE_CRITERIA)
    );
    await vi.waitFor(() => expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(1));
    db.resolve([]);
    const results = await Promise.all(searches);

    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mockGetValue).toHaveBeenCalledTimes(1);
    expect(mockSetValue).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toBe(results[0]);
    }
  });

  it('serves later callers from the L1 cache once the shared search settles', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);
    const repository = new ModelRepository();

    const first = await repository.searchModels(TRIAGE_CRITERIA);
    const second = await repository.searchModels(TRIAGE_CRITERIA);

    expect(second).toBe(first);
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('keeps different criteria apart', async () => {
    mockQueryRawUnsafe.mockResolvedValue([]);
    const repository = new ModelRepository();

    await Promise.all([
      repository.searchModels(TRIAGE_CRITERIA),
      repository.searchModels({ ...TRIAGE_CRITERIA, limit: 50 }),
      repository.searchModels(TRIAGE_CRITERIA),
    ]);

    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('shares a failure with the concurrent callers but lets the next call retry', async () => {
    mockQueryRawUnsafe
      .mockRejectedValueOnce(new Error('canceling statement due to statement timeout'))
      .mockResolvedValueOnce([]);
    const repository = new ModelRepository();

    const settled = await Promise.allSettled([
      repository.searchModels(TRIAGE_CRITERIA),
      repository.searchModels(TRIAGE_CRITERIA),
    ]);
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(1);

    await expect(repository.searchModels(TRIAGE_CRITERIA)).resolves.toEqual([]);
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(2);
  });
});
