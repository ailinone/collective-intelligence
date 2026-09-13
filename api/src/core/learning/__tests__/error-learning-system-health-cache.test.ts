// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * getProviderHealthScores() is called (via getRecommendations) on EVERY
 * model=auto selection and used to run a 7-day aggregate over request_logs
 * each time. These tests pin the per-process TTL cache + in-flight
 * coalescing that turns that into at most one query per TTL window, and the
 * fail-open behaviour (a failed query yields [] and is not retried inside the
 * window).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQueryRaw } = vi.hoisted(() => ({ mockQueryRaw: vi.fn() }));

vi.mock('@/database/client', () => ({
  prisma: { $queryRaw: mockQueryRaw },
}));

vi.mock('@/utils/logger', () => {
  const child = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return {
    logger: { ...child, child: vi.fn(() => child) },
  };
});

import {
  errorLearningSystem,
  __resetErrorLearningCachesForTests,
} from '@/core/learning/error-learning-system';

function row(provider: string, successes: number, errors: number, tasks: string[] = []) {
  return {
    provider,
    total_requests: BigInt(successes + errors),
    success_count: BigInt(successes),
    error_count: BigInt(errors),
    rate_limit_count: BigInt(0),
    avg_latency: 100,
    last_error_epoch: null,
    recommended_tasks: tasks,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
  mockQueryRaw.mockReset();
  __resetErrorLearningCachesForTests();
  delete process.env.PROVIDER_HEALTH_SCORES_TTL_MS;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getProviderHealthScores cache', () => {
  it('serves the second call from cache with an independent array', async () => {
    mockQueryRaw.mockResolvedValue([row('alpha', 90, 10), row('beta', 50, 50)]);

    const first = await errorLearningSystem.getProviderHealthScores();
    const second = await errorLearningSystem.getProviderHealthScores();

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(first.map((s) => s.provider)).toEqual(['alpha', 'beta']);
    expect(first[0].reliability).toBe(0.9);
  });

  it('coalesces concurrent callers onto a single in-flight query', async () => {
    let resolveQuery: (rows: unknown[]) => void = () => {};
    mockQueryRaw.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        })
    );

    const calls = Array.from({ length: 5 }, () => errorLearningSystem.getProviderHealthScores());
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);

    resolveQuery([row('alpha', 100, 0)]);
    const results = await Promise.all(calls);

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toEqual([expect.objectContaining({ provider: 'alpha', reliability: 1 })]);
    }
    expect(new Set(results).size).toBe(5);
  });

  it('re-queries once the TTL has elapsed', async () => {
    mockQueryRaw.mockResolvedValue([row('alpha', 100, 0)]);

    await errorLearningSystem.getProviderHealthScores();
    vi.advanceTimersByTime(29_000);
    await errorLearningSystem.getProviderHealthScores();
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await errorLearningSystem.getProviderHealthScores();
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
  });

  it('honours PROVIDER_HEALTH_SCORES_TTL_MS', async () => {
    process.env.PROVIDER_HEALTH_SCORES_TTL_MS = '5000';
    mockQueryRaw.mockResolvedValue([]);

    await errorLearningSystem.getProviderHealthScores();
    vi.advanceTimersByTime(6_000);
    await errorLearningSystem.getProviderHealthScores();

    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
  });

  it('fails open to [] and does not retry inside the TTL window', async () => {
    mockQueryRaw.mockRejectedValue(new Error('out of memory'));

    expect(await errorLearningSystem.getProviderHealthScores()).toEqual([]);
    expect(await errorLearningSystem.getProviderHealthScores()).toEqual([]);

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('getRecommendations on top of the cache', () => {
  it("filters by task and never leaks one call's in-place sort into the next", async () => {
    mockQueryRaw.mockResolvedValue([
      row('flaky', 60, 40, ['code']),
      row('solid', 100, 0, ['code', 'chat']),
      row('other', 100, 0, ['chat']),
    ]);

    const code = await errorLearningSystem.getRecommendations('code');
    expect(code.avoidProviders).toEqual(['flaky']);
    expect(code.preferProviders).toEqual(['solid']);

    const chat = await errorLearningSystem.getRecommendations('chat');
    expect(chat.preferProviders).toEqual(['solid', 'other']);
    expect(chat.avoidProviders).toEqual([]);

    // The cached array keeps its original (query) order regardless of the
    // sorts performed by the two calls above.
    const scores = await errorLearningSystem.getProviderHealthScores();
    expect(scores.map((s) => s.provider)).toEqual(['flaky', 'solid', 'other']);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });
});
