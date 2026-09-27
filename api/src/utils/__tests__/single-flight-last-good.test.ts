// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * createSingleFlightLastGood: the soft-state cache behind models-routes.ts's
 * runtime signals (catalog load audit 2026-09-24, R10). Before it, the 48 h request_logs
 * aggregate had no single-flight (every concurrent request after expiry ran
 * its own copy) and every failure returned a fresh empty Map, which also
 * defeated the ranked-catalog memo keyed on that reference.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSingleFlightLastGood } from '../single-flight-last-good';

const TTL_MS = 1_000;
const MAX_STALE_MS = 2_000;
const BACKOFF_MS = 3_000;
const WAIT_TIMEOUT_MS = 500;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
}

const FALLBACK: Map<string, number> = new Map();

function build(load: () => Promise<Map<string, number>>, onError = vi.fn()) {
  return createSingleFlightLastGood<Map<string, number>>({
    load,
    fallback: FALLBACK,
    ttlMs: TTL_MS,
    maxStaleMs: MAX_STALE_MS,
    retryBackoffMs: BACKOFF_MS,
    waitTimeoutMs: WAIT_TIMEOUT_MS,
    onError,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSingleFlightLastGood', () => {
  it('coalesces concurrent cold callers onto one load and returns the same reference while fresh', async () => {
    const pending = deferred<Map<string, number>>();
    const load = vi.fn(() => pending.promise);
    const cache = build(load);

    const calls = [cache.get(), cache.get(), cache.get()];
    const value = new Map([['m', 1]]);
    pending.resolve(value);
    const results = await Promise.all(calls);

    expect(load).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result).toBe(value);
    expect(await cache.get()).toBe(value);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves the stale value immediately within max-stale and refreshes once in the background', async () => {
    const first = new Map([['v', 1]]);
    const second = new Map([['v', 2]]);
    const refresh = deferred<Map<string, number>>();
    const load = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(refresh.promise);
    const cache = build(load);
    await cache.get();

    await vi.advanceTimersByTimeAsync(TTL_MS + 100);
    expect(await cache.get()).toBe(first);
    expect(await cache.get()).toBe(first);
    expect(load).toHaveBeenCalledTimes(2);

    refresh.resolve(second);
    await settle();
    expect(await cache.get()).toBe(second);
  });

  it('beyond max-stale it waits for the load instead of serving the old value', async () => {
    const first = new Map([['v', 1]]);
    const second = new Map([['v', 2]]);
    const load = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const cache = build(load);
    await cache.get();

    await vi.advanceTimersByTimeAsync(TTL_MS + MAX_STALE_MS + 1);
    expect(await cache.get()).toBe(second);
  });

  it('keeps the last-good value on failure, reports the error once, and does not retry inside the backoff', async () => {
    const good = new Map([['v', 1]]);
    const onError = vi.fn();
    const load = vi.fn().mockResolvedValueOnce(good).mockRejectedValueOnce(new Error('db down'));
    const cache = build(load, onError);
    await cache.get();

    await vi.advanceTimersByTimeAsync(TTL_MS + 100);
    expect(await cache.get()).toBe(good);
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);

    expect(await cache.get()).toBe(good);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('with nothing usable, a failed load returns the stable fallback reference and backs off', async () => {
    const load = vi.fn().mockRejectedValue(new Error('db down'));
    const cache = build(load);

    expect(await cache.get()).toBe(FALLBACK);
    expect(await cache.get()).toBe(FALLBACK);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BACKOFF_MS);
    expect(await cache.get()).toBe(FALLBACK);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a slow first load returns the fallback after the wait timeout, and the value once it lands', async () => {
    const pending = deferred<Map<string, number>>();
    const load = vi.fn(() => pending.promise);
    const cache = build(load);

    const waiting = cache.get();
    await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS);
    expect(await waiting).toBe(FALLBACK);

    const value = new Map([['v', 1]]);
    pending.resolve(value);
    await settle();
    expect(await cache.get()).toBe(value);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
