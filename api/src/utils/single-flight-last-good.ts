// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Soft-state cache with single-flight loading, stale-while-revalidate and a
 * bounded last-good fallback. For values whose absence degrades a response
 * but must never fail it (ranking signals, hints), so every failure path
 * returns `fallback` instead of throwing.
 *
 *   fresh (age < ttl)                     cached value
 *   stale (past ttl by <= maxStale)       cached value now, one background
 *                                         refresh (unless backing off)
 *   older, or nothing cached              wait for the shared load, at most
 *                                         waitTimeoutMs; on failure or
 *                                         timeout return `fallback`
 *   after a failed load                   no new load for retryBackoffMs
 *
 * `fallback` is returned by reference, so callers that memoize on input
 * identity (models-routes.ts's ranked-catalog cache) keep hitting their
 * memo while the source is down instead of recomputing on every request.
 */
import { waitWithTimeout } from './wait-with-timeout';

export interface SingleFlightLastGoodOptions<T> {
  /** What to cache. Must not depend on caller-specific input. */
  load: () => Promise<T>;
  /** Returned when no usable value exists. Keep it a stable reference. */
  fallback: T;
  ttlMs: number;
  /** How long past `ttlMs` a value may still be served while refreshing. */
  maxStaleMs: number;
  /** Quiet period after a failed load before another load may start. */
  retryBackoffMs: number;
  /** Upper bound a caller waits for a load when nothing usable is cached. */
  waitTimeoutMs: number;
  onError?: (error: unknown) => void;
  now?: () => number;
}

export interface SingleFlightLastGood<T> {
  get(): Promise<T>;
  /** Test/diagnostic hook: drop the cached value and backoff state. */
  reset(): void;
}

export function createSingleFlightLastGood<T>(
  options: SingleFlightLastGoodOptions<T>
): SingleFlightLastGood<T> {
  const now = options.now ?? Date.now;
  let entry: { value: T; expiresAt: number } | null = null;
  let inFlight: Promise<T> | null = null;
  let retryAt = 0;

  function startLoad(): Promise<T> {
    if (inFlight) return inFlight;
    const promise = options
      .load()
      .then(
        (value) => {
          entry = { value, expiresAt: now() + options.ttlMs };
          retryAt = 0;
          return value;
        },
        (error: unknown) => {
          retryAt = now() + options.retryBackoffMs;
          options.onError?.(error);
          throw error;
        }
      )
      .finally(() => {
        if (inFlight === promise) inFlight = null;
      });
    inFlight = promise;
    return promise;
  }

  async function get(): Promise<T> {
    const at = now();
    const current = entry;
    if (current && current.expiresAt > at) {
      return current.value;
    }
    const backingOff = at < retryAt;
    if (current && at - current.expiresAt <= options.maxStaleMs) {
      if (!inFlight && !backingOff) {
        startLoad().catch(() => undefined);
      }
      return current.value;
    }
    if (backingOff && !inFlight) {
      return options.fallback;
    }
    try {
      return await waitWithTimeout(startLoad(), options.waitTimeoutMs, 'Soft-state load');
    } catch {
      return options.fallback;
    }
  }

  function reset(): void {
    entry = null;
    inFlight = null;
    retryAt = 0;
  }

  return { get, reset };
}
