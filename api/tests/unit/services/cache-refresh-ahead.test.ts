// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/services/model-catalog-service', () => ({
  refreshCatalogCacheAhead: vi.fn().mockResolvedValue(undefined),
}));

import { startCacheRefreshAhead, stopCacheRefreshAhead } from '@/services/cache-refresh-ahead';
import { refreshCatalogCacheAhead } from '@/services/model-catalog-service';

describe('cache-refresh-ahead', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // The service no-ops under NODE_ENV=test (so the app's real test runs
    // never spin timers) — unset it here to exercise the real behavior.
    delete process.env.NODE_ENV;
    delete process.env.CACHE_REFRESH_AHEAD_ENABLED;
    delete process.env.CACHE_REFRESH_AHEAD_INTERVAL_MS;
  });

  afterEach(() => {
    stopCacheRefreshAhead();
    vi.useRealTimers();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('refreshes catalog + selection pre-warm on each tick', async () => {
    const engine = { initializeTriageAsync: vi.fn().mockResolvedValue(undefined) };
    process.env.CACHE_REFRESH_AHEAD_INTERVAL_MS = '1000';

    startCacheRefreshAhead(engine);

    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshCatalogCacheAhead).toHaveBeenCalledTimes(1);
    expect(engine.initializeTriageAsync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(refreshCatalogCacheAhead).toHaveBeenCalledTimes(3);
    expect(engine.initializeTriageAsync).toHaveBeenCalledTimes(3);
  });

  it('a failing tick never throws and the next tick still runs', async () => {
    const engine = { initializeTriageAsync: vi.fn().mockRejectedValue(new Error('boom')) };
    process.env.CACHE_REFRESH_AHEAD_INTERVAL_MS = '1000';

    startCacheRefreshAhead(engine);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    // Both ticks attempted despite the rejection — failures degrade to
    // normal TTL-expiry behavior, they never propagate.
    expect(engine.initializeTriageAsync).toHaveBeenCalledTimes(2);
  });

  it('is disabled by the kill-switch', async () => {
    const engine = { initializeTriageAsync: vi.fn().mockResolvedValue(undefined) };
    process.env.CACHE_REFRESH_AHEAD_ENABLED = 'false';
    process.env.CACHE_REFRESH_AHEAD_INTERVAL_MS = '1000';

    startCacheRefreshAhead(engine);

    await vi.advanceTimersByTimeAsync(3000);
    expect(refreshCatalogCacheAhead).not.toHaveBeenCalled();
    expect(engine.initializeTriageAsync).not.toHaveBeenCalled();
  });

  it('is idempotent — a second start does not double the ticks', async () => {
    const engine = { initializeTriageAsync: vi.fn().mockResolvedValue(undefined) };
    process.env.CACHE_REFRESH_AHEAD_INTERVAL_MS = '1000';

    startCacheRefreshAhead(engine);
    startCacheRefreshAhead(engine);

    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshCatalogCacheAhead).toHaveBeenCalledTimes(1);
  });
});
