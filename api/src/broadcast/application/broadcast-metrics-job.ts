// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Broadcast metrics observer job — periodic read-only gauges that are too
 * expensive to compute per-poll-tick, plus the stranded-envelope sweeper.
 *
 * Why a separate job (not inline in `pollOnce`):
 *   - `COUNT(*)` on `broadcast_trace_outbox WHERE drained_at IS NULL` is a
 *     seq-scan-ish query at scale. We don't want it on the 1s poll tick.
 *   - Gauges are allowed to lag behind reality a bit; 60s refresh is enough
 *     for alerting (alert threshold is far bigger than one probe interval).
 *
 * Observes:
 *   - `broadcastOutboxBacklogRows` (Gauge) — count of undrained rows. The
 *     primary capacity signal — if it grows monotonically, pollers aren't
 *     keeping up.
 *   - `broadcastOutboxLagSeconds` (Histogram) — observed as head-of-line age
 *     (now - oldest_undrained.created_at). The poller also observes per-drain
 *     lag inline; this adds coverage for the case where NOTHING drains (an
 *     envelope stuck in retry loop never gets a drain observation).
 *
 * Stranded reclaim (Fase 3.1):
 *   After the poller refactor (claim-commit-then-dispatch), an envelope whose
 *   poller crashed between phase 1 (claim+drained_at=NOW()) and phase 3
 *   (finalize destinations_resolved_count) is stuck: drained_at IS NOT NULL
 *   AND destinations_resolved_count IS NULL. Inline reclaim in pollOnce covers
 *   synchronous failures; only a crashed-poller scenario reaches this sweep.
 *   We reset drained_at to NULL for such rows older than the visibility
 *   window so another poller can pick them up. The visibility window must be
 *   wider than the worst-case dispatch latency (60s is conservative).
 *
 * Non-destructive for metrics; destructive (UPDATE) for stranded reclaim.
 */

import { prisma as defaultPrisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { broadcastMetrics } from '@/broadcast/infrastructure/metrics/broadcast-metrics';

const log = logger.child({ component: 'broadcast-metrics-job' });

export interface BroadcastMetricsJobDeps {
  db?: typeof defaultPrisma;
  now?: () => Date;
}

/**
 * One metrics probe. Returns the observed values for logging/tests.
 */
export async function runBroadcastMetricsProbe(
  deps: BroadcastMetricsJobDeps = {},
): Promise<{ backlogRows: number; headOfLineLagSeconds: number | null }> {
  const db = deps.db ?? defaultPrisma;
  const now = deps.now?.() ?? new Date();

  // Single round-trip: COUNT + MIN(created_at). We use created_at (insertion
  // time) rather than occurred_at (source-timestamp) for the HOL lag since
  // the queue's SLO is measured from "when we accepted the trace" — the
  // client's own latency is not our problem to alert on.
  const rows = await db.$queryRaw<
    Array<{ backlog: bigint; oldest: Date | null }>
  >`
    SELECT
      COUNT(*)::bigint                                           AS backlog,
      MIN(created_at) FILTER (WHERE drained_at IS NULL)::timestamp
                                                                 AS oldest
      FROM broadcast_trace_outbox
     WHERE drained_at IS NULL
  `;

  const row = rows[0];
  const backlog = row ? Number(row.backlog) : 0;
  broadcastMetrics.outboxBacklog.set(backlog);

  let headOfLineLagSeconds: number | null = null;
  if (row?.oldest) {
    headOfLineLagSeconds = Math.max(
      0,
      (now.getTime() - row.oldest.getTime()) / 1000,
    );
    // A head-of-line observation is still a lag observation for the
    // histogram — it's the minimum lag any next-drain will see.
    broadcastMetrics.outboxLag.observe(headOfLineLagSeconds);
  }

  if (backlog > 0) {
    log.debug(
      { backlog, headOfLineLagSeconds },
      'broadcast outbox metrics probe tick',
    );
  }

  return { backlogRows: backlog, headOfLineLagSeconds };
}

/**
 * Visibility window after which an envelope claimed by a (presumably crashed)
 * poller is eligible for reclaim. Must be > worst-case dispatch latency to
 * avoid double-claiming live work. 5 minutes is conservative — destination
 * timeouts are capped at 10-30s.
 */
export const STRANDED_VISIBILITY_WINDOW_SECONDS = 300;

/**
 * Sweep envelopes stuck between claim and finalize. Returns the number of
 * rows reclaimed. Safe to run concurrently with pollers (the UPDATE is
 * atomic and only matches rows that cannot have been re-claimed).
 */
export async function runBroadcastStrandedReclaim(
  deps: BroadcastMetricsJobDeps = {},
): Promise<{ reclaimed: number }> {
  const db = deps.db ?? defaultPrisma;
  const cutoffSeconds = STRANDED_VISIBILITY_WINDOW_SECONDS;

  // Match ONLY rows that:
  //   1. Were claimed (drained_at IS NOT NULL)
  //   2. Were never finalized (destinations_resolved_count IS NULL)
  //   3. Have been sitting like that longer than the visibility window
  // Live pollers that are still within the window for a slow dispatch are
  // untouched — they'll finalize normally and set the resolved count.
  const reclaimed = await db.$executeRaw`
    UPDATE broadcast_trace_outbox
       SET drained_at = NULL
     WHERE drained_at IS NOT NULL
       AND destinations_resolved_count IS NULL
       AND drained_at < NOW() - (${cutoffSeconds} * INTERVAL '1 second')
  `;

  if (reclaimed > 0) {
    log.warn(
      { reclaimed, cutoffSeconds },
      'reclaimed stranded broadcast envelopes (poller likely crashed mid-dispatch)',
    );
  }

  return { reclaimed };
}
