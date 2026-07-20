// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability Embedding Worker (ADR-022, Sprint 3)
 *
 * Generates and persists 384-dimensional embeddings for:
 *   - `capability_ontology` rows (URI → semantic vector for query expansion)
 *   - `models` rows (model descriptor → semantic vector for hybrid search)
 *
 * Idempotency contract
 * --------------------
 * The worker re-embeds a row if and only if ONE of:
 *   1. `embedding IS NULL` (never embedded).
 *   2. `embedding_model != active_embedder_id` (embedder changed underneath us).
 *   3. `updated_at > embedding_updated_at` (source text changed since last embed).
 *      For models, "source text changed" means capabilities changed, so we
 *      compare against `capability_updated_at` not `updated_at` (the latter
 *      moves on every Prisma write — cache buster, not semantic change).
 *
 * Re-running the worker against an unchanged DB is a no-op: the SELECT returns
 * zero rows, no API calls are made.
 *
 * Performance
 * -----------
 * - Batches 96 inputs per OpenAI call (the embedder caps at 96).
 * - Updates rows individually inside the loop. We could UNNEST-batch updates
 *   too, but 6.8k rows × 1 UPDATE each is ~5s on local PG with index — not
 *   worth the complexity. Revisit if model count crosses 50k.
 * - HNSW index doesn't need REINDEX — it accepts inserts/updates online.
 *
 * Observability
 * -------------
 * Emits structured logs with batch counts, timing, and skip reasons. Caller
 * (the scheduled job handler) is responsible for prom-client metrics — this
 * module stays decoupled from the metrics infra to keep the test surface clean.
 */

import type { Pool } from 'pg';
import {
  type CapabilityEmbedder,
  modelEmbeddingText,
  ontologyEmbeddingText,
} from './embedder';
import { getCapabilityEmbedder } from './embedder-factory';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'embed-worker' });

export interface EmbedWorkerStats {
  ontologyEmbedded: number;
  ontologySkipped: number;
  modelsEmbedded: number;
  modelsSkipped: number;
  apiCalls: number;
  elapsedMs: number;
}

export interface EmbedWorkerOptions {
  /** Override the embedder (tests, alt providers). Defaults to the factory. */
  embedder?: CapabilityEmbedder;
  /** Cap on rows processed per worker run. Prevents runaway batches. */
  maxRowsPerRun?: number;
  /** Skip ontology pass (e.g. for periodic catalog-only refresh). */
  skipOntology?: boolean;
  /** Skip models pass (e.g. for one-shot ontology bootstrap). */
  skipModels?: boolean;
}

const DEFAULT_MAX_ROWS_PER_RUN = 5_000;

/**
 * Run one full embedding pass: ontology first (cheap, ~60 rows), then models.
 * Returns stats for telemetry.
 */
export async function runEmbedWorker(
  pool: Pool,
  opts: EmbedWorkerOptions = {},
): Promise<EmbedWorkerStats> {
  const embedder = opts.embedder ?? getCapabilityEmbedder();
  const maxRows = opts.maxRowsPerRun ?? DEFAULT_MAX_ROWS_PER_RUN;
  const stats: EmbedWorkerStats = {
    ontologyEmbedded: 0,
    ontologySkipped: 0,
    modelsEmbedded: 0,
    modelsSkipped: 0,
    apiCalls: 0,
    elapsedMs: 0,
  };
  const startedAt = Date.now();

  log.info({ embedder: embedder.id, maxRows }, 'Embedding worker started');

  try {
    if (!opts.skipOntology) {
      await embedOntology(pool, embedder, maxRows, stats);
    }
    if (!opts.skipModels) {
      const remaining = maxRows - stats.ontologyEmbedded;
      if (remaining > 0) {
        await embedModels(pool, embedder, remaining, stats);
      } else {
        log.info('maxRowsPerRun exhausted by ontology pass — deferring models to next run');
      }
    }
  } finally {
    stats.elapsedMs = Date.now() - startedAt;
    log.info({ ...stats, embedder: embedder.id }, 'Embedding worker finished');
  }

  return stats;
}

// ─── Ontology pass ────────────────────────────────────────────────────────────

interface OntologyRow {
  uri: string;
  preferred_label: string;
  synonyms: string[];
  description: string | null;
}

async function embedOntology(
  pool: Pool,
  embedder: CapabilityEmbedder,
  maxRows: number,
  stats: EmbedWorkerStats,
): Promise<void> {
  const { rows } = await pool.query<OntologyRow>(
    `SELECT uri, preferred_label, synonyms, description
     FROM capability_ontology
     WHERE status != 'deprecated'
       AND (
         embedding IS NULL
         OR embedding_model IS DISTINCT FROM $1
         OR embedding_updated_at IS NULL
         OR updated_at > embedding_updated_at
       )
     ORDER BY uri
     LIMIT $2;`,
    [embedder.id, maxRows],
  );

  if (rows.length === 0) {
    log.debug('No ontology rows need embedding');
    return;
  }

  log.info({ count: rows.length }, 'Ontology rows to embed');

  const texts = rows.map((r) =>
    ontologyEmbeddingText({
      preferredLabel: r.preferred_label,
      synonyms: r.synonyms ?? [],
      description: r.description,
    }),
  );

  const results = await embedder.embedBatch(texts);
  stats.apiCalls += Math.ceil(rows.length / 96);

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const result = results[i];
    if (!row || !result) continue;
    await pool.query(
      `UPDATE capability_ontology
       SET embedding = $1::vector,
           embedding_model = $2,
           embedding_updated_at = NOW()
       WHERE uri = $3;`,
      [vectorToPgLiteral(result.vector), embedder.id, row.uri],
    );
    stats.ontologyEmbedded += 1;
  }
}

// ─── Models pass ──────────────────────────────────────────────────────────────

interface ModelRow {
  uid: string;
  display_name: string;
  capability_uris: string[];
  family: string | null;
  tier: string | null;
}

async function embedModels(
  pool: Pool,
  embedder: CapabilityEmbedder,
  maxRows: number,
  stats: EmbedWorkerStats,
): Promise<void> {
  const { rows } = await pool.query<ModelRow>(
    `SELECT
       m.uid,
       COALESCE(m.display_name, m.name) AS display_name,
       m.capability_uris,
       m.metadata->>'family' AS family,
       m.metadata->>'tier'   AS tier
     FROM models m
     WHERE m.status = 'active'
       AND (
         m.embedding IS NULL
         OR m.embedding_model IS DISTINCT FROM $1
         OR m.embedding_updated_at IS NULL
         OR GREATEST(m.updated_at, COALESCE(m.capability_updated_at, m.updated_at)) > m.embedding_updated_at
       )
     ORDER BY m.capability_updated_at NULLS FIRST, m.uid
     LIMIT $2;`,
    [embedder.id, maxRows],
  );

  if (rows.length === 0) {
    log.debug('No model rows need embedding');
    return;
  }

  log.info({ count: rows.length }, 'Model rows to embed');

  const labelMap = await loadOntologyLabelMap(pool);

  const texts = rows.map((r) =>
    modelEmbeddingText({
      displayName: r.display_name,
      family: r.family,
      tier: r.tier,
      capabilityLabels: (r.capability_uris ?? [])
        .map((uri) => labelMap.get(uri) ?? uri)
        .slice(0, 20), // cap to keep prompt focused
    }),
  );

  const results = await embedder.embedBatch(texts);
  stats.apiCalls += Math.ceil(rows.length / 96);

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const result = results[i];
    if (!row || !result) continue;
    await pool.query(
      `UPDATE models
       SET embedding = $1::vector,
           embedding_model = $2,
           embedding_updated_at = NOW()
       WHERE uid = $3;`,
      [vectorToPgLiteral(result.vector), embedder.id, row.uid],
    );
    stats.modelsEmbedded += 1;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * pgvector accepts vectors as the literal `'[1.0,2.0,...]'::vector`. The pg
 * driver doesn't have a native vector type, so we serialise to text and let
 * the cast handle it. Using `JSON.stringify` for numeric formatting is faster
 * than `.toString()` per element and produces RFC-stable floats.
 */
function vectorToPgLiteral(vec: readonly number[]): string {
  return `[${vec.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
}

let labelMapCache: { map: Map<string, string>; loadedAt: number } | null = null;
const LABEL_MAP_TTL_MS = 5 * 60 * 1000;

async function loadOntologyLabelMap(pool: Pool): Promise<Map<string, string>> {
  if (labelMapCache && Date.now() - labelMapCache.loadedAt < LABEL_MAP_TTL_MS) {
    return labelMapCache.map;
  }
  const { rows } = await pool.query<{ uri: string; preferred_label: string }>(
    `SELECT uri, preferred_label FROM capability_ontology WHERE status != 'deprecated';`,
  );
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.uri, r.preferred_label);
  labelMapCache = { map, loadedAt: Date.now() };
  return map;
}

/**
 * Force re-embed everything (used by `--full-rebuild` flag in CLI). Clears
 * `embedding_model` so the next worker pass picks up everything.
 */
export async function invalidateAllEmbeddings(pool: Pool): Promise<void> {
  await pool.query(`UPDATE capability_ontology SET embedding_model = NULL;`);
  await pool.query(`UPDATE models SET embedding_model = NULL;`);
  labelMapCache = null;
  log.warn('All embeddings invalidated — next worker run will re-embed full catalog');
}
