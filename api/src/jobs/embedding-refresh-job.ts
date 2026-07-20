// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Embedding Refresh Job (ADR-022, Chip 5)
 *
 * Drives the HCRA L3 capability search by keeping `models.embedding` and
 * `capability_ontology.embedding` populated. Without this job running, the
 * `applySemanticRerank` path in `dynamic-model-selector.ts` degrades silently
 * to lexical-only — the wiring stays intact but RRF's vector arm contributes
 * zero rank.
 *
 * Why a thin wrapper around `runEmbedWorker`:
 *   - The worker module is pg/embedder-only; it shouldn't know about BullMQ
 *     or the cron infrastructure. This file is the boundary between the
 *     scheduling concern and the embedding concern.
 *   - Bounded per-tick processing (`maxRowsPerRun`): on first run after
 *     deploy, ~64K models need backfilling. We cap each tick at 5,000 so a
 *     single misbehaving cron run can't monopolise the embedder for an hour.
 *     Subsequent ticks pick up the remainder via the worker's idempotent
 *     staleness predicate.
 *   - Embedder absent ⇒ no-op log: `runEmbedWorker` would throw in the
 *     factory if HCRA_EMBEDDER_URL isn't set. The cron registry checks the
 *     env var via the `enabled` guard, but we double-check here so manual
 *     `runEmbeddingRefreshNow()` calls don't fail loudly in dev.
 */

import { logger } from '@/utils/logger';
import { runEmbedWorker } from '@/capability/embedder/embed-worker';
import { getCapabilityPool } from '@/capability/db/capability-pool';

const log = logger.child({ component: 'embedding-refresh-job' });

const DEFAULT_MAX_ROWS_PER_RUN = 5_000;

/**
 * Whether the embedder is configured. Cron registration uses this to gate
 * the job, and the runner uses it as a defensive check.
 */
export function isEmbeddingRefreshEnabled(): boolean {
  return Boolean(process.env.HCRA_EMBEDDER_URL);
}

export async function runEmbeddingRefreshNow(): Promise<void> {
  if (!isEmbeddingRefreshEnabled()) {
    log.info(
      'HCRA_EMBEDDER_URL is unset — skipping embedding refresh (semantic rerank degrades to lexical-only)',
    );
    return;
  }

  const maxRowsRaw = process.env.HCRA_EMBEDDER_MAX_ROWS_PER_RUN;
  const parsed = maxRowsRaw ? Number.parseInt(maxRowsRaw, 10) : NaN;
  const maxRowsPerRun = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ROWS_PER_RUN;

  const pool = getCapabilityPool();
  const stats = await runEmbedWorker(pool, { maxRowsPerRun });

  log.info(
    {
      ontologyEmbedded: stats.ontologyEmbedded,
      modelsEmbedded: stats.modelsEmbedded,
      apiCalls: stats.apiCalls,
      elapsedMs: stats.elapsedMs,
      maxRowsPerRun,
    },
    'Embedding refresh tick complete',
  );
}
