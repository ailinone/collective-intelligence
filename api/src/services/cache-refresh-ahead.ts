// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cache refresh-ahead (keep-warm) — stale-while-revalidate for the hot-path
 * caches that otherwise expire between requests and make the NEXT request
 * pay the cold rebuild.
 *
 * Measured cold-start penalty (prod, 2026-07-13): first request after idle
 * took ~22s to first token vs ~1.4s warm. The dominant costs are the model
 * catalog cache (CATALOG_CACHE_TTL_MS, default 6min — full-enumeration
 * query + map) and the dynamic-selection path (pool build + capability
 * validation + performance prefetch + semantic rerank, ~2.5-5s cold).
 *
 * This timer renews both BEFORE they expire, in background, so no client
 * request ever lands on a cold cache:
 *  - refreshCatalogCacheAhead(): atomic swap, the stale cache keeps serving
 *    reads during the rebuild (no cold window);
 *  - engine.initializeTriageAsync(): the engine's existing selection
 *    pre-warm (same one that runs at boot), reused as a periodic warm.
 *
 * Interval default 4min < the 6min catalog TTL. Kill-switch:
 * CACHE_REFRESH_AHEAD_ENABLED=false. The timer is unref()'d so it never
 * keeps the process alive on shutdown. Complements (does not replace) the
 * external synthetic keep-warm cron, which additionally exercises the
 * provider connection end-to-end.
 */

import { logger } from '@/utils/logger';
import { refreshCatalogCacheAhead } from '@/services/model-catalog-service';

const log = logger.child({ component: 'cache-refresh-ahead' });

/** Structural shape of the one engine method this service needs — avoids a
 *  circular import of the full OrchestrationEngine class. */
interface SelectionPrewarmable {
  initializeTriageAsync(): Promise<void>;
}

let timer: NodeJS.Timeout | null = null;

export function startCacheRefreshAhead(engine: SelectionPrewarmable): void {
  if (process.env.CACHE_REFRESH_AHEAD_ENABLED === 'false') {
    log.info('Cache refresh-ahead disabled via CACHE_REFRESH_AHEAD_ENABLED=false');
    return;
  }
  if (process.env.NODE_ENV === 'test') return;
  if (timer) return; // idempotent — already running

  const intervalMs = Number(process.env.CACHE_REFRESH_AHEAD_INTERVAL_MS) || 4 * 60_000;

  const tick = async (): Promise<void> => {
    const startedAt = Date.now();
    try {
      await refreshCatalogCacheAhead();
      await engine.initializeTriageAsync();
      log.debug({ durationMs: Date.now() - startedAt }, 'Cache refresh-ahead tick completed');
    } catch (error) {
      // Never let a failed refresh disturb anything — the caches simply fall
      // back to their normal TTL-expiry behavior until the next tick.
      log.warn({ error, durationMs: Date.now() - startedAt }, 'Cache refresh-ahead tick failed (caches fall back to TTL expiry)');
    }
  };

  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  log.info({ intervalMs }, 'Cache refresh-ahead started (catalog + selection pre-warm)');
}

export function stopCacheRefreshAhead(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
