// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Broadcast poller runner — process-level lifecycle for the broadcast outbox
 * pipeline.
 *
 * The `BroadcastOutboxPoller` itself exposes only `pollOnce()` (a single
 * claim→dispatch→finalize tick) and the metrics/stranded-reclaim probes are
 * one-shot functions. This runner is the thin scheduler that drives them on
 * intervals, mirroring `infrastructure/events/outbox-poller.ts` so the two
 * background loops have identical start/stop semantics.
 *
 * Gating: the API process only starts this when `BROADCAST_FEATURE_ENABLED`
 * is truthy (see index.ts). Nothing here constructs broadcast singletons at
 * import time — `getBroadcastPoller()` lazily builds the pipeline on first
 * `start()`.
 *
 * Safety: every tick is wrapped so a thrown error can never escape the timer
 * callback (an unhandled rejection in a setInterval callback crashes the
 * process). Broadcast is observability plumbing — it must degrade silently,
 * never take down the API.
 */

import { logger } from '@/utils/logger';
import { serializeError } from '@/utils/type-guards';

import { getBroadcastPoller } from '@/broadcast/composition/broadcast-composition-root';
import {
  runBroadcastMetricsProbe,
  runBroadcastStrandedReclaim,
} from '@/broadcast/application/broadcast-metrics-job';

const log = logger.child({ component: 'broadcast-poller-runner' });

// Poll fast enough that staged envelopes reach destinations within ~1s, but
// not so fast that idle ticks dominate the Prisma pool. 1s matches the SLO
// the metrics-job header references.
const POLL_INTERVAL_MS = Number(process.env.BROADCAST_POLL_INTERVAL_MS ?? 1000);
// Backlog gauge + head-of-line lag are allowed to lag reality; 60s is enough
// for alerting (per broadcast-metrics-job header).
const METRICS_INTERVAL_MS = Number(process.env.BROADCAST_METRICS_INTERVAL_MS ?? 60_000);
// Stranded reclaim only matters after a poller crash mid-dispatch; the
// visibility window is 5min, so sweeping every 60s is ample.
const RECLAIM_INTERVAL_MS = Number(process.env.BROADCAST_RECLAIM_INTERVAL_MS ?? 60_000);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let metricsTimer: ReturnType<typeof setInterval> | null = null;
let reclaimTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

async function pollTick(): Promise<void> {
  // Guard against overlapping ticks: a slow dispatch must not stack ticks and
  // double the pool pressure. SKIP LOCKED already makes overlap correct, but
  // serializing keeps the in-process footprint predictable.
  if (isPolling) return;
  isPolling = true;
  try {
    await getBroadcastPoller().pollOnce();
  } finally {
    isPolling = false;
  }
}

/**
 * Start the broadcast outbox poller + observer loops. Idempotent — a second
 * call while running is a no-op.
 */
export function startBroadcastPoller(): void {
  if (pollTimer) {
    log.debug('Broadcast poller already running');
    return;
  }

  pollTimer = setInterval(() => {
    pollTick().catch((err) => {
      log.error({ err: serializeError(err) }, 'Broadcast poll tick error');
    });
  }, POLL_INTERVAL_MS);

  metricsTimer = setInterval(() => {
    runBroadcastMetricsProbe().catch((err) => {
      log.debug({ err: serializeError(err) }, 'Broadcast metrics probe error');
    });
  }, METRICS_INTERVAL_MS);

  reclaimTimer = setInterval(() => {
    runBroadcastStrandedReclaim().catch((err) => {
      log.debug({ err: serializeError(err) }, 'Broadcast stranded reclaim error');
    });
  }, RECLAIM_INTERVAL_MS);

  // Timers should not keep the event loop alive on their own; the HTTP server
  // owns process lifetime. Without unref the poller would block clean exit.
  pollTimer.unref?.();
  metricsTimer.unref?.();
  reclaimTimer.unref?.();

  log.info(
    {
      pollIntervalMs: POLL_INTERVAL_MS,
      metricsIntervalMs: METRICS_INTERVAL_MS,
      reclaimIntervalMs: RECLAIM_INTERVAL_MS,
    },
    'Broadcast poller started',
  );
}

/** Stop all broadcast background loops. Idempotent. */
export function stopBroadcastPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
  if (reclaimTimer) {
    clearInterval(reclaimTimer);
    reclaimTimer = null;
  }
  log.info('Broadcast poller stopped');
}
