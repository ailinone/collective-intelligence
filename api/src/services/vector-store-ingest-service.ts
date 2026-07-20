// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Vector Store Ingest + Search Service (F3/F1 §P4)
 *
 * Turns vector-stores from metadata-only into a real embedding store. This
 * module owns the two halves of "real vector search":
 *
 *   1. INGEST — chunk a file's text content, embed each chunk (384-dim, via the
 *      HCRA embedder — OpenAI text-embedding-3-small@384 or a TEI sidecar), and
 *      persist the chunks + vectors into `vector_store_chunks`.
 *   2. SEARCH — embed the query once, run a pgvector cosine kNN over the store's
 *      chunks (HNSW index), return ranked chunks with similarity scores.
 *
 * Infrastructure reuse (no reinvention):
 *   - The embedder is the SAME `getCapabilityEmbedder()` that capability-search
 *     uses (EMBEDDING_DIM = 384, swappable via HCRA_EMBEDDER*).
 *   - Vector persistence + kNN go through the SAME shared `getCapabilityPool()`
 *     pg.Pool with raw SQL (`embedding <=> $1::vector`), because Prisma has no
 *     first-class pgvector type. This mirrors embed-worker.ts and
 *     capability-search-service.ts exactly.
 *
 * Tenant isolation: every write stamps `organization_id`; every search filters
 * on both `vector_store_id` AND `organization_id`, so a chunk can never leak
 * across orgs even if a store id is guessed.
 */

import type { Pool } from 'pg';
import { nanoid } from 'nanoid';
import { logger } from '@/utils/logger';
import {
  type CapabilityEmbedder,
  EMBEDDING_DIM,
} from '@/capability/embedder/embedder';
import { getCapabilityEmbedder } from '@/capability/embedder/embedder-factory';
import { getCapabilityPool } from '@/capability/db/capability-pool';

const log = logger.child({ service: 'vector-store-ingest' });

// ─── Chunking ───────────────────────────────────────────────────────────────

/** Target characters per chunk. ~250 tokens at ~4 chars/token. */
export const DEFAULT_CHUNK_SIZE = 1_000;
/** Overlap between adjacent chunks to preserve cross-boundary context. */
export const DEFAULT_CHUNK_OVERLAP = 200;
/** Hard cap on chunks per file to bound ingest cost/latency. */
export const MAX_CHUNKS_PER_FILE = 1_000;

export interface ChunkOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  maxChunks?: number;
}

/**
 * Split text into overlapping, paragraph-aware chunks.
 *
 * Strategy: greedily accumulate paragraphs (split on blank lines) until the
 * running buffer would exceed `chunkSize`, emit, then carry a trailing
 * `chunkOverlap` window into the next chunk so a fact spanning a boundary is
 * still retrievable. Paragraphs longer than `chunkSize` are hard-split by
 * character window. Whitespace-only input yields zero chunks.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.min(
    Math.max(0, opts.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP),
    chunkSize - 1,
  );
  const maxChunks = Math.max(1, opts.maxChunks ?? MAX_CHUNKS_PER_FILE);

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return [];

  // Split into paragraph-ish units, then re-pack to target size.
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const units: string[] = [];
  for (const p of paragraphs.length > 0 ? paragraphs : [normalized]) {
    if (p.length <= chunkSize) {
      units.push(p);
    } else {
      // Hard-split oversized paragraph by character window (with overlap).
      for (let i = 0; i < p.length; i += chunkSize - overlap) {
        units.push(p.slice(i, i + chunkSize));
        if (i + chunkSize >= p.length) break;
      }
    }
  }

  const chunks: string[] = [];
  let buffer = '';
  for (const unit of units) {
    if (buffer.length > 0 && buffer.length + 1 + unit.length > chunkSize) {
      chunks.push(buffer);
      if (chunks.length >= maxChunks) return chunks;
      // Carry an overlap tail from the emitted chunk.
      buffer = overlap > 0 ? buffer.slice(-overlap) : '';
      buffer = buffer.length > 0 ? `${buffer}\n${unit}` : unit;
    } else {
      buffer = buffer.length > 0 ? `${buffer}\n${unit}` : unit;
    }
  }
  if (buffer.length > 0 && chunks.length < maxChunks) {
    chunks.push(buffer);
  }

  return chunks;
}

// ─── pgvector serialization ──────────────────────────────────────────────────

/**
 * pgvector accepts `'[1.0,2.0,...]'::vector`. The pg driver has no native
 * vector type, so we serialise to text and cast. Mirrors embed-worker.ts.
 */
function vectorToPgLiteral(vec: readonly number[]): string {
  return `[${vec.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
}

// ─── Public result types ─────────────────────────────────────────────────────

export interface IngestResult {
  /** Number of chunks persisted with embeddings. */
  chunksCreated: number;
  /** Embedder identity stamped on the chunks. */
  embeddingModel: string;
}

export interface SearchChunkHit {
  id: string;
  fileId: string;
  vectorStoreFileId: string;
  chunkIndex: number;
  content: string;
  /** Cosine similarity in [0,1] (1 = identical). */
  score: number;
  metadata: Record<string, unknown>;
}

interface ChunkRow {
  id: string;
  file_id: string;
  vector_store_file_id: string;
  chunk_index: number;
  content: string;
  score: number;
  metadata: Record<string, unknown> | null;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class VectorStoreIngestService {
  constructor(
    private readonly pool: Pool = getCapabilityPool(),
    private readonly embedder: CapabilityEmbedder = getCapabilityEmbedder(),
  ) {}

  /**
   * Chunk + embed + persist a file's content for a vector-store association.
   *
   * Idempotent per association: existing chunks for `vectorStoreFileId` are
   * deleted first, so re-ingesting the same file replaces (never duplicates)
   * its chunks. Returns the number of chunks written.
   *
   * Caller is responsible for the file↔store association row and for setting
   * its status. This method only owns the chunk/embedding side.
   */
  async ingestFile(input: {
    vectorStoreId: string;
    vectorStoreFileId: string;
    fileId: string;
    organizationId: string;
    content: string;
    chunkOptions?: ChunkOptions;
    metadata?: Record<string, unknown>;
  }): Promise<IngestResult> {
    const chunks = chunkText(input.content, input.chunkOptions);

    // Replace any prior chunks for this association (idempotent re-ingest).
    await this.pool.query(
      `DELETE FROM vector_store_chunks WHERE vector_store_file_id = $1;`,
      [input.vectorStoreFileId],
    );

    if (chunks.length === 0) {
      log.info(
        { vectorStoreFileId: input.vectorStoreFileId, fileId: input.fileId },
        'No textual content to embed — 0 chunks created',
      );
      return { chunksCreated: 0, embeddingModel: this.embedder.id };
    }

    const embeddings = await this.embedder.embedBatch(chunks);
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embedder returned ${embeddings.length} vectors for ${chunks.length} chunks`,
      );
    }

    const metadataJson = JSON.stringify(input.metadata ?? {});

    for (let i = 0; i < chunks.length; i += 1) {
      const vector = embeddings[i]?.vector;
      if (!vector || vector.length !== EMBEDDING_DIM) {
        throw new Error(
          `Embedding ${i} has dim ${vector?.length ?? 0}, expected ${EMBEDDING_DIM}`,
        );
      }
      await this.pool.query(
        `INSERT INTO vector_store_chunks
           (id, vector_store_id, file_id, vector_store_file_id, organization_id,
            chunk_index, content, embedding, embedding_model, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10::jsonb);`,
        [
          `vsc_${nanoid(24)}`,
          input.vectorStoreId,
          input.fileId,
          input.vectorStoreFileId,
          input.organizationId,
          i,
          chunks[i],
          vectorToPgLiteral(vector),
          this.embedder.id,
          metadataJson,
        ],
      );
    }

    log.info(
      {
        vectorStoreId: input.vectorStoreId,
        vectorStoreFileId: input.vectorStoreFileId,
        chunks: chunks.length,
        embedder: this.embedder.id,
      },
      'File ingested into vector store',
    );

    return { chunksCreated: chunks.length, embeddingModel: this.embedder.id };
  }

  /**
   * Semantic search over a store's chunks. Embeds `query` once, then runs a
   * pgvector cosine kNN (HNSW) scoped to (vector_store_id, organization_id).
   *
   * Tenant isolation: the organization_id filter is in the WHERE clause, so a
   * caller from org B searching a store owned by org A gets zero rows even if
   * they know the store id. Route-level resolution already 404s unknown stores;
   * this is defence in depth.
   *
   * @returns chunks ordered by descending cosine similarity.
   */
  async search(input: {
    vectorStoreId: string;
    organizationId: string;
    query: string;
    topK?: number;
    fileIds?: readonly string[];
  }): Promise<SearchChunkHit[]> {
    const topK = clampTopK(input.topK);
    const q = input.query.trim();
    if (q.length === 0) return [];

    const queryEmbedding = await this.embedder.embed(q);
    if (queryEmbedding.vector.length !== EMBEDDING_DIM) {
      throw new Error(
        `Query embedding has dim ${queryEmbedding.vector.length}, expected ${EMBEDDING_DIM}`,
      );
    }

    const params: unknown[] = [
      vectorToPgLiteral(queryEmbedding.vector),
      input.vectorStoreId,
      input.organizationId,
      topK,
    ];
    let fileClause = '';
    if (input.fileIds && input.fileIds.length > 0) {
      params.push(input.fileIds);
      fileClause = `AND file_id = ANY($${params.length}::text[])`;
    }

    const { rows } = await this.pool.query<ChunkRow>(
      `SELECT
         id,
         file_id,
         vector_store_file_id,
         chunk_index,
         content,
         (1 - (embedding <=> $1::vector)) AS score,
         metadata
       FROM vector_store_chunks
       WHERE vector_store_id = $2
         AND organization_id = $3
         AND embedding IS NOT NULL
         ${fileClause}
       ORDER BY embedding <=> $1::vector
       LIMIT $4;`,
      params,
    );

    return rows.map((r) => ({
      id: r.id,
      fileId: r.file_id,
      vectorStoreFileId: r.vector_store_file_id,
      chunkIndex: r.chunk_index,
      content: r.content,
      score: typeof r.score === 'number' ? r.score : Number(r.score),
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    }));
  }
}

/** Clamp top_k to a sane window: default 10, min 1, max 100. */
export function clampTopK(topK?: number): number {
  if (typeof topK !== 'number' || !Number.isFinite(topK)) return 10;
  return Math.min(Math.max(Math.floor(topK), 1), 100);
}
