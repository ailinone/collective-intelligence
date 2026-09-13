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
 *  - hydrateCatalogCacheAhead(): pulls the latest fleet-wide catalog
 *    snapshot from Redis into this process's in-process cache. Does NOT
 *    query Postgres (see the capacity-scaling-plan note below). Since
 *    2026-09 it compares the published content fingerprint with the one
 *    this process already holds and skips the >100 MB GET + JSON.parse when
 *    nothing changed (see model-catalog-service.ts);
 *  - engine.initializeTriageAsync(): the engine's existing selection
 *    pre-warm (same one that runs at boot), re-run ONLY when the catalog
 *    fingerprint this process holds changed since the last prewarm. It
 *    remains per-process (its effect is this replica's own selector/module
 *    caches), but it is not a keep-warm: the result is only logged
 *    (orchestration-engine.ts initializeTriageAsync), the selector's own
 *    caches expire every 5 minutes anyway, and the cache key it warms
 *    (fixed contextSize, no maxAverageCostPer1k) never matches the
 *    per-request criteria TriagingService builds, so real triage already
 *    resolves on demand. What a prewarm after a catalog change still buys
 *    is the module-level caches (popularity seed, curated snapshot,
 *    capability validator, learning-bucket prefetch) seeing the new pool
 *    before the first real request. Without ORCHESTRATION_TRIAGE_MODEL
 *    (unset in prod: no static model, project rule) each unconditional
 *    run was a complete synthetic selection (bucket SQL, ~800-row hydrate
 *    with every column, scoring, up to 25 live provider probes on validator
 *    cache miss) every 4 minutes in every process, with no traffic.
 *
 * Capacity-scaling plan (docs/CAPACITY-SCALING-PLAN-10K-USERS.md, Track 1
 * §2.3): this timer used to call refreshCatalogCacheAhead() directly, which
 * ran the real full-catalog Postgres query (all non-disabled models — 111k+
 * rows and growing, no static cap). Since this timer runs unconditionally
 * in EVERY `ci_api` replica AND `ci_worker` (index.ts, workers/queue-runner.ts),
 * that meant the query fired independently, undeduplicated, once per
 * process — the exact per-replica-multiplication bug class the REL-01 fix
 * (index.ts's BullMQ-cron comment) already closed for every other scheduled
 * job. The real Postgres rebuild now runs exactly once fleet-wide, via the
 * "catalog-cache-refresh" BullMQ repeatable job (jobs/register-scheduled-jobs.ts),
 * whose Redis lock elects one process per tick — not a hardcoded "worker
 * only" rule. This timer now only does the cheap part: hydrating this
 * process's own in-process cache from what that elected process published.
 *
 * Interval default 4min < the 6min catalog TTL. Kill-switch:
 * CACHE_REFRESH_AHEAD_ENABLED=false (also gates the BullMQ job — see
 * register-scheduled-jobs.ts). The timer is unref()'d so it never keeps the
 * process alive on shutdown. Complements (does not replace) the external
 * synthetic keep-warm cron, which additionally exercises the provider
 * connection end-to-end.
 */

import { logger } from '@/utils/logger';
import { getCatalogFingerprint, hydrateCatalogCacheAhead } from '@/services/model-catalog-service';

const log = logger.child({ component: 'cache-refresh-ahead' });

/** Structural shape of the one engine method this service needs — avoids a
 *  circular import of the full OrchestrationEngine class. */
interface SelectionPrewarmable {
  initializeTriageAsync(): Promise<void>;
}

let timer: NodeJS.Timeout | null = null;
// Catalog fingerprint the last selection prewarm ran against. null until the
// first tick with a known fingerprint, so the first tick after boot prewarms
// once (accepted: the boot prewarm in the engine constructor may have raced
// the first catalog hydrate). A legacy snapshot without meta, or a process
// whose catalog is not populated yet, yields null from getCatalogFingerprint
// and never triggers a synthetic selection.
let lastPrewarmedFingerprint: string | null = null;

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
      await hydrateCatalogCacheAhead();
      // getCatalogFingerprint reflects both the hydrate above and any
      // Postgres rebuild this process ran as the elected producer (both go
      // through setCatalogCache), so the gate covers every way the local
      // catalog can change.
      const fingerprint = getCatalogFingerprint();
      const prewarmed = fingerprint !== null && fingerprint !== lastPrewarmedFingerprint;
      if (prewarmed) {
        await engine.initializeTriageAsync();
        lastPrewarmedFingerprint = fingerprint;
      }
      log.debug(
        { durationMs: Date.now() - startedAt, prewarmed, fingerprint },
        'Cache refresh-ahead tick completed'
      );
    } catch (error) {
      // Never let a failed refresh disturb anything — the caches simply fall
      // back to their normal TTL-expiry behavior until the next tick.
      log.warn(
        { error, durationMs: Date.now() - startedAt },
        'Cache refresh-ahead tick failed (caches fall back to TTL expiry)'
      );
    }
  };

  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  log.info(
    { intervalMs },
    'Cache refresh-ahead started (catalog hydrate on unchanged fingerprint is a meta-only read; selection pre-warm only after a catalog change)'
  );
}

export function stopCacheRefreshAhead(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastPrewarmedFingerprint = null;
}
