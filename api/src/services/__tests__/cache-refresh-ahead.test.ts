// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capacity-scaling plan (docs/CAPACITY-SCALING-PLAN-10K-USERS.md, Track 1
 * §2.3): the per-process keep-warm timer used to call
 * refreshCatalogCacheAhead() directly — a real full-catalog Postgres query
 * (all non-disabled models — 111k+ rows and growing, no static cap) —
 * unconditionally in EVERY `ci_api` replica and `ci_worker`, undeduplicated.
 *
 * These tests pin the fixed behavior: the timer now calls
 * hydrateCatalogCacheAhead() (Redis-only, never Postgres) on every tick, and
 * NEVER calls refreshCatalogCacheAhead() itself (that is now exclusively the
 * BullMQ-elected fleet-wide job's job — see
 * jobs/__tests__/register-scheduled-jobs-catalog-refresh.test.ts). The
 * selection pre-warm (engine.initializeTriageAsync) remains per-process but
 * is gated on the catalog fingerprint: it runs only when the catalog this
 * process holds changed since the last pre-warm, never as an unconditional
 * synthetic full selection every tick.
 *
 * Hermetic: model-catalog-service is fully mocked, so no Postgres/Redis I/O
 * happens. NODE_ENV is temporarily forced away from 'test' because
 * startCacheRefreshAhead() deliberately no-ops under NODE_ENV=test to avoid
 * leaking real timers into the suite — this test needs the real timer path,
 * so it opts in explicitly and restores NODE_ENV afterward (same pattern as
 * core/cost/__tests__/cost-integrity-guard.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hydrateCatalogCacheAheadMock = vi.fn().mockResolvedValue(undefined);
const refreshCatalogCacheAheadMock = vi.fn().mockResolvedValue(undefined);
// Content fingerprint of the catalog this process holds, as reported by
// model-catalog-service after each hydrate. Default 'fp-a' so the existing
// "prewarm on first tick" expectation below keeps its meaning.
const getCatalogFingerprintMock = vi.fn((): string | null => 'fp-a');

vi.mock('@/services/model-catalog-service', () => ({
  hydrateCatalogCacheAhead: (...args: unknown[]) => hydrateCatalogCacheAheadMock(...args),
  refreshCatalogCacheAhead: (...args: unknown[]) => refreshCatalogCacheAheadMock(...args),
  getCatalogFingerprint: () => getCatalogFingerprintMock(),
}));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ENABLED = process.env.CACHE_REFRESH_AHEAD_ENABLED;
const ORIGINAL_INTERVAL = process.env.CACHE_REFRESH_AHEAD_INTERVAL_MS;

function makeEngine() {
  return { initializeTriageAsync: vi.fn().mockResolvedValue(undefined) };
}

describe('cache-refresh-ahead per-process timer (Track 1 §2.3 fix)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    hydrateCatalogCacheAheadMock.mockClear();
    refreshCatalogCacheAheadMock.mockClear();
    getCatalogFingerprintMock.mockReset();
    getCatalogFingerprintMock.mockReturnValue('fp-a');
    process.env.NODE_ENV = 'production'; // bypass the NODE_ENV==='test' no-op guard
    process.env.CACHE_REFRESH_AHEAD_INTERVAL_MS = '1000';
    delete process.env.CACHE_REFRESH_AHEAD_ENABLED;
  });

  afterEach(async () => {
    const mod = await import('@/services/cache-refresh-ahead');
    mod.stopCacheRefreshAhead();
    vi.useRealTimers();
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_ENABLED === undefined) delete process.env.CACHE_REFRESH_AHEAD_ENABLED;
    else process.env.CACHE_REFRESH_AHEAD_ENABLED = ORIGINAL_ENABLED;
    if (ORIGINAL_INTERVAL === undefined) delete process.env.CACHE_REFRESH_AHEAD_INTERVAL_MS;
    else process.env.CACHE_REFRESH_AHEAD_INTERVAL_MS = ORIGINAL_INTERVAL;
  });

  it('hydrates the catalog cache from Redis on each tick and NEVER calls the Postgres-hitting refresh directly', async () => {
    const { startCacheRefreshAhead } = await import('@/services/cache-refresh-ahead');
    const engine = makeEngine();
    startCacheRefreshAhead(engine);

    await vi.advanceTimersByTimeAsync(1000);

    expect(hydrateCatalogCacheAheadMock).toHaveBeenCalledTimes(1);
    expect(refreshCatalogCacheAheadMock).not.toHaveBeenCalled();
    expect(engine.initializeTriageAsync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(hydrateCatalogCacheAheadMock).toHaveBeenCalledTimes(2);
    expect(refreshCatalogCacheAheadMock).not.toHaveBeenCalled();
  });

  it('runs the selection pre-warm only when the catalog fingerprint changed since the last pre-warm', async () => {
    getCatalogFingerprintMock
      .mockReturnValueOnce('fp-a')
      .mockReturnValueOnce('fp-a')
      .mockReturnValueOnce('fp-b')
      .mockReturnValueOnce('fp-b');
    const { startCacheRefreshAhead } = await import('@/services/cache-refresh-ahead');
    const engine = makeEngine();
    startCacheRefreshAhead(engine);

    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.initializeTriageAsync).toHaveBeenCalledTimes(1);

    // Same fingerprint: hydrate still runs (it is the cheap meta read), but
    // no synthetic full selection.
    await vi.advanceTimersByTimeAsync(1000);
    expect(hydrateCatalogCacheAheadMock).toHaveBeenCalledTimes(2);
    expect(engine.initializeTriageAsync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.initializeTriageAsync).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(hydrateCatalogCacheAheadMock).toHaveBeenCalledTimes(4);
    expect(engine.initializeTriageAsync).toHaveBeenCalledTimes(2);
    expect(refreshCatalogCacheAheadMock).not.toHaveBeenCalled();
  });

  it('never runs the selection pre-warm while the catalog fingerprint is unknown (legacy snapshot without meta, or catalog not populated yet)', async () => {
    getCatalogFingerprintMock.mockReturnValue(null);
    const { startCacheRefreshAhead } = await import('@/services/cache-refresh-ahead');
    const engine = makeEngine();
    startCacheRefreshAhead(engine);

    await vi.advanceTimersByTimeAsync(3000);

    expect(hydrateCatalogCacheAheadMock).toHaveBeenCalledTimes(3);
    expect(engine.initializeTriageAsync).not.toHaveBeenCalled();
  });

  it('does not start any timer when CACHE_REFRESH_AHEAD_ENABLED=false (kill-switch)', async () => {
    process.env.CACHE_REFRESH_AHEAD_ENABLED = 'false';
    const { startCacheRefreshAhead } = await import('@/services/cache-refresh-ahead');
    const engine = makeEngine();
    startCacheRefreshAhead(engine);

    await vi.advanceTimersByTimeAsync(5000);

    expect(hydrateCatalogCacheAheadMock).not.toHaveBeenCalled();
    expect(engine.initializeTriageAsync).not.toHaveBeenCalled();
  });

  it('a failed hydrate tick does not stop subsequent ticks', async () => {
    hydrateCatalogCacheAheadMock.mockRejectedValueOnce(new Error('redis down'));
    const { startCacheRefreshAhead } = await import('@/services/cache-refresh-ahead');
    const engine = makeEngine();
    startCacheRefreshAhead(engine);

    await vi.advanceTimersByTimeAsync(1000);
    expect(hydrateCatalogCacheAheadMock).toHaveBeenCalledTimes(1);
    // The engine prewarm should still be attempted even if the hydrate step
    // itself is caught inside tick()'s try/catch — see cache-refresh-ahead.ts.
    await vi.advanceTimersByTimeAsync(1000);
    expect(hydrateCatalogCacheAheadMock).toHaveBeenCalledTimes(2);
  });
});
