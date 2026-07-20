// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Embedding Worker (ADR-022, Sprint 3)
 *
 * Fills `capability_ontology.embedding` and `models.embedding` so the L3
 * Search API can do vector recall via HNSW. Designed to run on a schedule
 * (cron/nightly) AND be invoked ad-hoc after schema changes (e.g. swapping
 * the embedder model).
 *
 * Idempotency
 * -----------
 * A row is processed iff:
 *   - its embedding is NULL, OR
 *   - its embedding_model differs from the current Embedder.modelVersion, OR
 *   - its updated_at is more recent than its embedding_updated_at
 *     (payload changed AFTER last embed run).
 *
 * Each chunk processed runs in its own short-lived transaction. A crashed
 * worker leaves at most one chunk in flight; the next run picks it up via
 * the same staleness predicate.
 *
 * Payload composition
 * -------------------
 * Capabilities embed: `preferred_label + description + synonyms.join(' / ')`.
 * Models embed: `id + display_name + capability_uris[*].preferred_label`.
 * The intent is that both rows live in the SAME embedding space so a query
 * like "function calling with images" hits both ontology entries (vision,
 * function_calling) and models that materialised those caps.
 *
 * Payload deduplication is intentional: identical payloads → identical
 * embeddings, but we still issue the API call so the backend can cache.
 * If we ever need cross-row dedup, hash the payload and store the
 * embedding once (a separate `embedding_cache` table). Out of scope for
 * the current scale.
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { EMBEDDING_DIMS, getEmbedder, type Embedder } from './embedder';

const log = logger.child({ component: 'embedding-worker' });

export interface EmbeddingWorkerStats {
  capabilities: { processed: number; failed: number };
  models:       { processed: number; failed: number };
  modelVersion: string;
  elapsedMs:    number;
}

export interface RunEmbeddingsOptions {
  /** Override the env-configured embedder (testing / one-off reprocess with a different model). */
  embedder?: Embedder;
  /** Process at most this many capability rows. Default: all stale. */
  capabilityLimit?: number;
  /** Process at most this many model rows. Default: all stale. */
  modelLimit?: number;
  /** Chunk size per HTTP call to the embedder (overrides embedder's own batchSize). */
  chunkSize?: number;
  /** Skip ontology pass entirely (use when only refreshing models). */
  skipCapabilities?: boolean;
  /** Skip model pass entirely. */
  skipModels?: boolean;
}

const DEFAULT_CHUNK = 32;

interface CapabilityRow {
  uri: string;
  preferred_label: string;
  description: string | null;
  synonyms: string[];
  embedding_model: string | null;
  updated_at: Date;
  embedding_updated_at: Date | null;
}

interface ModelRow {
  uid: string;
  id: string;
  display_name: string;
  capability_uris: string[];
  embedding_model: string | null;
  updated_at: Date;
  embedding_updated_at: Date | null;
}

export async function runEmbeddingWorker(
  opts: RunEmbeddingsOptions = {},
): Promise<EmbeddingWorkerStats> {
  const start = Date.now();
  const embedder = opts.embedder ?? getEmbedder();
  if (embedder.dimensions !== EMBEDDING_DIMS) {
    throw new Error(
      `Embedder dimensions mismatch: vector(${EMBEDDING_DIMS}) column vs embedder ${embedder.dimensions}`,
    );
  }
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  const stats: EmbeddingWorkerStats = {
    capabilities: { processed: 0, failed: 0 },
    models: { processed: 0, failed: 0 },
    modelVersion: embedder.modelVersion,
    elapsedMs: 0,
  };

  if (!opts.skipCapabilities) {
    await processCapabilities(embedder, opts.capabilityLimit, chunkSize, stats);
  }
  if (!opts.skipModels) {
    await processModels(embedder, opts.modelLimit, chunkSize, stats);
  }

  stats.elapsedMs = Date.now() - start;
  log.info(stats, 'Embedding worker complete');
  return stats;
}

// ─── Capability ontology ──────────────────────────────────────────────────────

async function processCapabilities(
  embedder: Embedder,
  limit: number | undefined,
  chunkSize: number,
  stats: EmbeddingWorkerStats,
): Promise<void> {
  const limitClause = limit && limit > 0 ? `LIMIT ${Math.floor(limit)}` : '';
  const rows = await prisma.$queryRawUnsafe<CapabilityRow[]>(
    `SELECT uri, preferred_label, description, synonyms,
            embedding_model, updated_at, embedding_updated_at
     FROM capability_ontology
     WHERE status = 'active'
       AND (
         embedding IS NULL
         OR embedding_model IS NULL
         OR embedding_model <> $1
         OR (embedding_updated_at IS NOT NULL AND updated_at > embedding_updated_at)
       )
     ORDER BY uri
     ${limitClause}`,
    embedder.modelVersion,
  );

  if (rows.length === 0) {
    log.debug('No stale capabilities to embed');
    return;
  }

  log.info({ count: rows.length, modelVersion: embedder.modelVersion }, 'Embedding capabilities');

  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const payloads = slice.map(buildCapabilityPayload);
    try {
      const result = await embedder.embed({ inputs: payloads });
      await persistCapabilityEmbeddings(slice, result.vectors, embedder.modelVersion);
      stats.capabilities.processed += slice.length;
    } catch (err) {
      stats.capabilities.failed += slice.length;
      log.warn(
        { error: err instanceof Error ? err.message : String(err), chunkStart: i, chunkSize: slice.length },
        'Capability embedding chunk failed; will retry on next run',
      );
    }
  }
}

function buildCapabilityPayload(row: CapabilityRow): string {
  const parts = [row.preferred_label];
  if (row.description) parts.push(row.description);
  if (row.synonyms.length > 0) parts.push(`Synonyms: ${row.synonyms.join(', ')}`);
  return parts.join('\n');
}

async function persistCapabilityEmbeddings(
  rows: CapabilityRow[],
  vectors: number[][],
  modelVersion: string,
): Promise<void> {
  if (rows.length !== vectors.length) {
    throw new Error(`persistCapabilityEmbeddings: rows=${rows.length} vectors=${vectors.length}`);
  }
  // pgvector accepts text-cast literals like '[0.1,0.2,...]'; safer than relying
  // on driver array binding for a custom column type.
  const uris = rows.map((r) => r.uri);
  const literals = vectors.map(toVectorLiteral);

  await prisma.$executeRawUnsafe(
    `UPDATE capability_ontology AS c
     SET embedding = v.embedding::vector,
         embedding_model = $3,
         embedding_updated_at = NOW(),
         updated_at = NOW()
     FROM (SELECT * FROM UNNEST($1::text[], $2::text[]) AS t(uri, embedding)) AS v
     WHERE c.uri = v.uri`,
    uris,
    literals,
    modelVersion,
  );
}

// ─── Models ───────────────────────────────────────────────────────────────────

async function processModels(
  embedder: Embedder,
  limit: number | undefined,
  chunkSize: number,
  stats: EmbeddingWorkerStats,
): Promise<void> {
  const limitClause = limit && limit > 0 ? `LIMIT ${Math.floor(limit)}` : '';
  const rows = await prisma.$queryRawUnsafe<ModelRow[]>(
    `SELECT uid, id, display_name, capability_uris,
            embedding_model, updated_at, embedding_updated_at
     FROM models
     WHERE status = 'active'
       AND (
         embedding IS NULL
         OR embedding_model IS NULL
         OR embedding_model <> $1
         OR (embedding_updated_at IS NOT NULL AND updated_at > embedding_updated_at)
       )
     ORDER BY uid
     ${limitClause}`,
    embedder.modelVersion,
  );

  if (rows.length === 0) {
    log.debug('No stale models to embed');
    return;
  }

  // Resolve URIs → preferred_label in one query so payloads carry semantic
  // text rather than opaque URLs (which would dominate the embedding).
  const allUris = Array.from(new Set(rows.flatMap((r) => r.capability_uris)));
  const labelMap = await fetchCapabilityLabels(allUris);

  log.info({ count: rows.length, modelVersion: embedder.modelVersion }, 'Embedding models');

  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const payloads = slice.map((row) => buildModelPayload(row, labelMap));
    try {
      const result = await embedder.embed({ inputs: payloads });
      await persistModelEmbeddings(slice, result.vectors, embedder.modelVersion);
      stats.models.processed += slice.length;
    } catch (err) {
      stats.models.failed += slice.length;
      log.warn(
        { error: err instanceof Error ? err.message : String(err), chunkStart: i, chunkSize: slice.length },
        'Model embedding chunk failed; will retry on next run',
      );
    }
  }
}

async function fetchCapabilityLabels(uris: string[]): Promise<Map<string, string>> {
  if (uris.length === 0) return new Map();
  const rows = await prisma.$queryRawUnsafe<{ uri: string; preferred_label: string }[]>(
    `SELECT uri, preferred_label FROM capability_ontology WHERE uri = ANY($1::text[])`,
    uris,
  );
  return new Map(rows.map((r) => [r.uri, r.preferred_label]));
}

function buildModelPayload(row: ModelRow, labelMap: Map<string, string>): string {
  const labels = row.capability_uris
    .map((uri) => labelMap.get(uri))
    .filter((s): s is string => Boolean(s));
  const parts = [row.id];
  if (row.display_name && row.display_name !== row.id) parts.push(row.display_name);
  if (labels.length > 0) parts.push(`Capabilities: ${labels.join(', ')}`);
  return parts.join('\n');
}

async function persistModelEmbeddings(
  rows: ModelRow[],
  vectors: number[][],
  modelVersion: string,
): Promise<void> {
  if (rows.length !== vectors.length) {
    throw new Error(`persistModelEmbeddings: rows=${rows.length} vectors=${vectors.length}`);
  }
  const uids = rows.map((r) => r.uid);
  const literals = vectors.map(toVectorLiteral);

  await prisma.$executeRawUnsafe(
    `UPDATE models AS m
     SET embedding = v.embedding::vector,
         embedding_model = $3,
         embedding_updated_at = NOW(),
         updated_at = NOW()
     FROM (SELECT * FROM UNNEST($1::varchar[], $2::text[]) AS t(uid, embedding)) AS v
     WHERE m.uid = v.uid`,
    uids,
    literals,
    modelVersion,
  );
}

// ─── pgvector literal serializer ──────────────────────────────────────────────

function toVectorLiteral(vector: number[]): string {
  // pgvector wire format is `[v1,v2,...,vn]`. Avoid scientific notation —
  // some pgvector versions reject `1e-7` style numbers in literals.
  const parts = new Array<string>(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    const v = vector[i]!;
    parts[i] = Number.isFinite(v) ? v.toFixed(6) : '0';
  }
  return `[${parts.join(',')}]`;
}
