// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Metadata Backfill Job — idempotent drift-catcher for `metadata.endpoint`
 * and `metadata.tools` on the Model table.
 *
 * Why a cron in addition to the manual `_backfill-metadata-*.ts` scripts:
 *
 *   - The discovery service now writes both fields at every persistence
 *     site via `withNormalizedMetadata`, so steady-state drift should be
 *     zero. But "should" is doing work in that sentence: a future seed
 *     script, a hand-rolled INSERT during incident response, or a row
 *     migrated from a legacy export can land without the fields. A nightly
 *     idempotent sweep makes the invariant self-healing instead of
 *     dependent on operator memory.
 *
 *   - The Chip 6 closure left "run the backfill with --apply" as an
 *     operator-bound step. That's a fragile dependency — if the operator
 *     forgets, the dynamic-model-selector's SQL pushdown returns zero rows
 *     for the 64K legacy entries until someone notices. Moving the work
 *     into a cron removes the human from the critical path.
 *
 * Idempotency: a row with both fields populated is selected by neither
 * predicate, so the steady-state cost is two COUNT queries (subsecond on
 * indexed JSONB). The first run after deploy is the only expensive tick.
 *
 * Why ORDER BY uid + cursor instead of OFFSET pagination: OFFSET re-reads
 * the prefix of every batch (O(N²) over the table). uid is the PK, so
 * `WHERE uid > $cursor ORDER BY uid LIMIT 500` is an index seek. At 64K
 * rows × 500/batch = 128 batches, the difference matters.
 */

import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { inferEndpoint } from '@/capability/endpoint-inference';
import { inferTools } from '@/capability/tools-inference';

const log = logger.child({ component: 'metadata-backfill-job' });

const BATCH_SIZE = 500;

export function isMetadataBackfillEnabled(): boolean {
  return process.env.METADATA_BACKFILL_DISABLED !== 'true';
}

interface BackfillStats {
  endpointMissingBefore: number;
  endpointUpdated: number;
  toolsMissingBefore: number;
  toolsUpdated: number;
  elapsedMs: number;
}

export async function runMetadataBackfillNow(): Promise<BackfillStats> {
  const startedAt = Date.now();
  const stats: BackfillStats = {
    endpointMissingBefore: 0,
    endpointUpdated: 0,
    toolsMissingBefore: 0,
    toolsUpdated: 0,
    elapsedMs: 0,
  };

  if (!isMetadataBackfillEnabled()) {
    log.info('METADATA_BACKFILL_DISABLED=true — skipping metadata backfill tick');
    return stats;
  }

  // Single combined predicate: a row is "dirty" if EITHER field is missing
  // or malformed. We pull such rows once and fix both fields per row, so
  // we don't pay two passes over the table when both fields are missing on
  // the same row (which is the common case for a legacy 64K-row backlog).
  const dirtyTotalRow = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::bigint AS count
    FROM models
    WHERE NOT (metadata ? 'endpoint')
       OR jsonb_typeof(metadata->'endpoint') <> 'string'
       OR metadata->>'endpoint' = ''
       OR NOT (metadata ? 'tools')
       OR jsonb_typeof(metadata->'tools') <> 'array'
  `;
  const dirtyTotal = Number(dirtyTotalRow[0]?.count ?? 0n);

  if (dirtyTotal === 0) {
    stats.elapsedMs = Date.now() - startedAt;
    log.info({ ...stats }, 'Metadata backfill: no dirty rows, no-op');
    return stats;
  }

  log.info({ dirtyTotal }, 'Metadata backfill: starting sweep');

  let cursor: string | null = null;

  // Cursor-paginated sweep — terminates when the batch query returns 0 rows.
  // eslint-disable-next-line no-constant-condition -- intentional infinite loop, exit via `break` on empty batch.
  while (true) {
    // Fetch a batch of dirty rows ordered by uid.
    const batch: Array<{ uid: string; capabilities: unknown; metadata: unknown }> =
      await prisma.$queryRawUnsafe(
        `SELECT uid, capabilities, metadata
           FROM models
          WHERE (
                NOT (metadata ? 'endpoint')
             OR jsonb_typeof(metadata->'endpoint') <> 'string'
             OR metadata->>'endpoint' = ''
             OR NOT (metadata ? 'tools')
             OR jsonb_typeof(metadata->'tools') <> 'array'
          )
          ${cursor ? 'AND uid > $1' : ''}
          ORDER BY uid ASC
          LIMIT ${BATCH_SIZE}`,
        ...(cursor ? [cursor] : []),
      );

    if (batch.length === 0) break;

    for (const row of batch) {
      const meta = (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {});
      const caps = Array.isArray(row.capabilities)
        ? (row.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
        : [];

      const newMeta: Record<string, unknown> = { ...meta };
      let changed = false;

      const endpointCurrent = meta.endpoint;
      if (typeof endpointCurrent !== 'string' || endpointCurrent.trim().length === 0) {
        newMeta.endpoint = inferEndpoint(caps, meta);
        stats.endpointMissingBefore += 1;
        stats.endpointUpdated += 1;
        changed = true;
      }

      if (!Array.isArray(meta.tools)) {
        newMeta.tools = inferTools(caps);
        stats.toolsMissingBefore += 1;
        stats.toolsUpdated += 1;
        changed = true;
      }

      if (changed) {
        await prisma.model.update({
          where: { uid: row.uid },
          data: { metadata: newMeta as Prisma.InputJsonValue },
        });
      }
    }

    cursor = batch[batch.length - 1].uid;
    if (batch.length < BATCH_SIZE) break;
  }

  stats.elapsedMs = Date.now() - startedAt;
  log.info({ ...stats }, 'Metadata backfill tick complete');
  return stats;
}
