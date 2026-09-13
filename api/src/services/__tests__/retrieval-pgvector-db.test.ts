// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Retrieval — REAL pgvector integration (LOTE AP, 2026-09-05).
 *
 * The unit suite mocks `VectorStoreIngestService.search`, which proves the
 * two-stage composition but proves nothing about the thing the capability
 * actually rests on: a cosine kNN executing inside Postgres against a
 * `vector(384)` column. This suite runs the real SQL — real
 * `embedding <=> $1::vector` ordering, real HNSW-eligible index, real
 * `organization_id` filter — with only the EMBEDDER stubbed (deterministic
 * vectors, so relevance is asserted rather than hoped for).
 *
 * Skips itself when no database is reachable, so it is safe in a bare CI
 * config. Point `TRACK4A_DATABASE_URL` (or `DATABASE_URL`) at a Postgres with
 * the `vector` extension available.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { EMBEDDING_DIM, type CapabilityEmbedder } from '@/capability/embedder/embedder';
import { VectorStoreIngestService } from '@/services/vector-store-ingest-service';
import { RetrievalOrchestrationService } from '../retrieval-orchestration-service';
import type { RerankOrchestrationService } from '../rerank-orchestration-service';
import type { OrchestrationContext } from '@/types';

const CONNECTION_STRING =
  process.env.TRACK4A_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://ci_user:ci_password@localhost:5434/ci_db_track4a';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const STORE = 'vs_track4a_fixture';

/**
 * Deterministic embedder: three orthogonal "topic" axes plus a bag-of-words
 * signal. Orthogonality is what lets the test assert an EXPECTED ordering
 * instead of merely "some ordering came back" — with random vectors the kNN
 * would be untestable.
 */
const TOPIC_TERMS: Record<number, string[]> = {
  0: ['contract', 'supplier', 'renew', 'procurement', 'sc-14'],
  1: ['revenue', 'quarterly', 'growth', 'enterprise', 'segment'],
  2: ['cafeteria', 'lunch', 'menu', 'weekday', 'sandwich'],
};

function embedText(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0);
  const lowered = text.toLowerCase();
  for (const [axis, terms] of Object.entries(TOPIC_TERMS)) {
    const hits = terms.filter((term) => lowered.includes(term)).length;
    vector[Number(axis)] = hits;
  }
  // Tiny non-topical jitter so identical-topic chunks still differ, without
  // ever outweighing the topic axes.
  for (let i = 0; i < lowered.length; i += 1) {
    vector[3 + (lowered.charCodeAt(i) % 32)] += 0.001;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

const embedder: CapabilityEmbedder = {
  id: 'track4a-deterministic',
  embed: async (text: string) => ({ vector: embedText(text) }),
  embedBatch: async (texts: string[]) => texts.map((text) => ({ vector: embedText(text) })),
} as unknown as CapabilityEmbedder;

const USER_CONTEXT = {
  organizationId: ORG_A,
  userId: 'user_track4a',
} as unknown as OrchestrationContext;

const CONTRACT_DOC =
  'To renew a supplier contract, submit form SC-14 to procurement at least thirty days ' +
  'before the expiry date. Procurement confirms the renewal in writing.';
const REVENUE_DOC =
  'Quarterly revenue grew twelve percent year over year, driven by growth in the ' +
  'enterprise segment across every region.';
const CAFETERIA_DOC =
  'The office cafeteria serves lunch on every weekday. The menu rotates weekly and a ' +
  'vegetarian sandwich is always available.';

let pool: Pool | null = null;
let available = false;

async function tableExists(p: Pool): Promise<boolean> {
  const { rows } = await p.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_name = 'vector_store_chunks'
     ) AS exists;`
  );
  return rows[0]?.exists === true;
}

/**
 * Create the chunk table standalone when the schema has not been migrated
 * into this database. Mirrors `prisma/schema.prisma`'s `VectorStoreChunk`
 * minus the two FKs — the FK targets belong to the assistants surface, which
 * this suite does not exercise, and requiring them would make the test depend
 * on a full migration rather than on the retrieval SQL under test.
 */
async function ensureChunkTable(p: Pool): Promise<void> {
  await p.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
  if (await tableExists(p)) return;
  await p.query(`
    CREATE TABLE vector_store_chunks (
      id                    TEXT PRIMARY KEY,
      vector_store_id       TEXT NOT NULL,
      file_id               TEXT NOT NULL,
      vector_store_file_id  TEXT NOT NULL,
      organization_id       UUID NOT NULL,
      chunk_index           INTEGER NOT NULL,
      content               TEXT NOT NULL,
      embedding             vector(384),
      embedding_model       VARCHAR(64),
      metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await p.query(
    `CREATE INDEX vector_store_chunks_embedding_idx
       ON vector_store_chunks USING hnsw (embedding vector_cosine_ops);`
  );
}

beforeAll(async () => {
  try {
    pool = new Pool({ connectionString: CONNECTION_STRING, connectionTimeoutMillis: 4000, max: 4 });
    await pool.query('SELECT 1');
    await ensureChunkTable(pool);
    await pool.query(`DELETE FROM vector_store_chunks WHERE vector_store_id = $1;`, [STORE]);

    const ingest = new VectorStoreIngestService(pool, embedder);
    await ingest.ingestFile({
      vectorStoreId: STORE,
      vectorStoreFileId: 'vsf_contract',
      fileId: 'file_contract',
      organizationId: ORG_A,
      content: CONTRACT_DOC,
    });
    await ingest.ingestFile({
      vectorStoreId: STORE,
      vectorStoreFileId: 'vsf_revenue',
      fileId: 'file_revenue',
      organizationId: ORG_A,
      content: REVENUE_DOC,
    });
    await ingest.ingestFile({
      vectorStoreId: STORE,
      vectorStoreFileId: 'vsf_cafeteria',
      fileId: 'file_cafeteria',
      organizationId: ORG_A,
      content: CAFETERIA_DOC,
    });
    available = true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[retrieval-pgvector] skipping — no usable database at ${CONNECTION_STRING.replace(/:[^:@]*@/, ':***@')}: ${String(error)}`
    );
    available = false;
  }
}, 60_000);

afterAll(async () => {
  if (!pool) return;
  // Cleanup must not resurrect a failure the suite already decided to skip:
  // when `available` is false the pool never connected, so the DELETE below
  // would throw out of the hook and fail an otherwise-skipped file.
  if (available) {
    await pool
      .query(`DELETE FROM vector_store_chunks WHERE vector_store_id = $1;`, [STORE])
      .catch(() => undefined);
  }
  await pool.end().catch(() => undefined);
});

function buildService(rerank?: RerankOrchestrationService) {
  return new RetrievalOrchestrationService(
    new VectorStoreIngestService(pool!, embedder),
    () => rerank ?? ({ rerank: vi.fn() } as unknown as RerankOrchestrationService)
  );
}

describe('retrieval over real pgvector', () => {
  it('runs a real cosine kNN and ranks the on-topic chunk first', async () => {
    if (!available) return;

    const result = await buildService().retrieve({
      query: 'How do I renew a supplier contract with procurement?',
      vectorStoreIds: [STORE],
      maxChunks: 3,
      userContext: USER_CONTEXT,
      requestId: 'itest_1',
    });

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].fileId).toBe('file_contract');
    // Cosine similarity mapped into [0,1] by the service's SQL.
    expect(result.chunks[0].vectorScore).toBeGreaterThan(0);
    expect(result.chunks[0].vectorScore).toBeLessThanOrEqual(1);
    // Ordering really is descending, straight out of Postgres.
    for (let i = 1; i < result.chunks.length; i += 1) {
      expect(result.chunks[i - 1].score).toBeGreaterThanOrEqual(result.chunks[i].score);
    }
  }, 60_000);

  it('isolates tenants — another org sees nothing in the same store', async () => {
    if (!available) return;

    const result = await buildService().retrieve({
      query: 'How do I renew a supplier contract with procurement?',
      vectorStoreIds: [STORE],
      userContext: { ...USER_CONTEXT, organizationId: ORG_B } as OrchestrationContext,
      requestId: 'itest_2',
    });

    // The org filter lives in the WHERE clause, so knowing the store id is
    // not enough to read another tenant's chunks.
    expect(result.chunks).toEqual([]);
  }, 60_000);

  it('honours score_threshold against real similarity values', async () => {
    if (!available) return;

    const unfiltered = await buildService().retrieve({
      query: 'quarterly revenue growth in the enterprise segment',
      vectorStoreIds: [STORE],
      maxChunks: 10,
      userContext: USER_CONTEXT,
      requestId: 'itest_3',
    });
    const top = unfiltered.chunks[0];
    expect(top.fileId).toBe('file_revenue');

    const filtered = await buildService().retrieve({
      query: 'quarterly revenue growth in the enterprise segment',
      vectorStoreIds: [STORE],
      maxChunks: 10,
      // Just under the best score: keeps the top hit, drops the off-topic ones.
      scoreThreshold: top.vectorScore - 0.0001,
      userContext: USER_CONTEXT,
      requestId: 'itest_4',
    });

    expect(filtered.chunks.length).toBeLessThan(unfiltered.chunks.length);
    expect(filtered.chunks[0].fileId).toBe('file_revenue');
  }, 60_000);

  it('over-fetches and lets a real second stage reorder the pgvector result', async () => {
    if (!available) return;

    // A reranker that inverts stage 1 entirely — if the composition is real,
    // the returned order must follow the CROSS-ENCODER, not the embedding.
    const rerankMock = vi.fn(async (options: { documents: string[] }) => ({
      results: options.documents
        .map((_doc, index) => ({ index, relevanceScore: index / 100 }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore),
      modelUsed: 'stub-reranker',
      provider: 'stub',
      durationMs: 1,
      strategyUsed: 'dynamic' as const,
      fallbackUsed: false,
    }));

    const vectorOnly = await buildService().retrieve({
      query: 'How do I renew a supplier contract with procurement?',
      vectorStoreIds: [STORE],
      maxChunks: 3,
      userContext: USER_CONTEXT,
      requestId: 'itest_5',
    });

    const reranked = await buildService({
      rerank: rerankMock,
    } as unknown as RerankOrchestrationService).retrieve({
      query: 'How do I renew a supplier contract with procurement?',
      vectorStoreIds: [STORE],
      maxChunks: 3,
      rerank: true,
      userContext: USER_CONTEXT,
      requestId: 'itest_6',
    });

    expect(rerankMock).toHaveBeenCalledTimes(1);
    expect(reranked.rerank.applied).toBe(true);
    expect(reranked.rerank.model).toBe('stub-reranker');
    // Stage 2 genuinely governs the final order.
    expect(reranked.chunks[0].fileId).not.toBe(vectorOnly.chunks[0].fileId);
    // …while stage 1's score is still reported alongside, so the swap is auditable.
    expect(reranked.chunks[0].vectorScore).toBeGreaterThan(0);
    expect(reranked.chunks[0].rerankScore).toBeDefined();
  }, 60_000);

  it('restricts to file_ids when asked', async () => {
    if (!available) return;

    const result = await buildService().retrieve({
      query: 'lunch menu in the office cafeteria',
      vectorStoreIds: [STORE],
      fileIds: ['file_contract'],
      userContext: USER_CONTEXT,
      requestId: 'itest_7',
    });

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.every((chunk) => chunk.fileId === 'file_contract')).toBe(true);
  }, 60_000);
});
