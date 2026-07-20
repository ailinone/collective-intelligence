// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * VectorStoreIngestService — unit tests for real vector search (F3/F1 §P4).
 *
 * Covers the two halves of "real vector search" with the embedder and the
 * pg.Pool both mocked (NO network calls, NO database — the CI vitest config has
 * no pgvector). We assert the ORCHESTRATION:
 *   - chunkText produces overlapping, size-bounded, paragraph-aware chunks
 *   - ingestFile chunks + embeds + persists one row per chunk (with the 384-dim
 *     vector serialized to a pgvector literal) and replaces prior chunks
 *   - search embeds the query once and issues a cosine-kNN scoped to
 *     (vector_store_id, organization_id) with the requested top_k
 *   - top_k is clamped to [1,100]; empty query short-circuits with no DB call
 *
 * The DB similarity ranking itself is exercised by mapping the rows the mocked
 * pool returns — pgvector's ordering is Postgres's job, not this module's.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { CapabilityEmbedder, EmbedResult } from '@/capability/embedder/embedder';
import { EMBEDDING_DIM } from '@/capability/embedder/embedder';
import {
  VectorStoreIngestService,
  chunkText,
  clampTopK,
  DEFAULT_CHUNK_SIZE,
} from '../vector-store-ingest-service';

// ── Test doubles ──────────────────────────────────────────────────────────────

/** Deterministic 384-dim embedder: vector depends on text length so distinct
 *  texts get distinct (but reproducible) vectors. Records every embed call. */
function makeFakeEmbedder(): CapabilityEmbedder & {
  embed: ReturnType<typeof vi.fn>;
  embedBatch: ReturnType<typeof vi.fn>;
} {
  const vecFor = (text: string): number[] => {
    const seed = (text.length % 7) + 1;
    return Array.from({ length: EMBEDDING_DIM }, (_, i) => ((i % seed) + 1) / 10);
  };
  const embed = vi.fn(async (text: string): Promise<EmbedResult> => ({ vector: vecFor(text) }));
  const embedBatch = vi.fn(
    async (texts: readonly string[]): Promise<EmbedResult[]> =>
      texts.map((t) => ({ vector: vecFor(t) })),
  );
  return {
    id: 'test/fake-embedder@384',
    embed,
    embedBatch,
  } as CapabilityEmbedder & {
    embed: ReturnType<typeof vi.fn>;
    embedBatch: ReturnType<typeof vi.fn>;
  };
}

function makeFakePool(queryImpl?: (sql: string, params?: unknown[]) => unknown) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const result = queryImpl?.(sql, params);
    if (result !== undefined) return result;
    return { rows: [] };
  });
  return { query } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}

// ── chunkText (pure) ────────────────────────────────────────────────────────────

describe('chunkText', () => {
  it('returns zero chunks for empty / whitespace-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  \t ')).toEqual([]);
  });

  it('returns a single chunk for short text', () => {
    const chunks = chunkText('Hello world. This is a short document.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Hello world');
  });

  it('splits long text into multiple size-bounded chunks', () => {
    // 50 paragraphs of ~100 chars => ~5000 chars => several chunks at size 1000.
    const para = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do.';
    const text = Array.from({ length: 50 }, () => para).join('\n\n');
    const chunks = chunkText(text, { chunkSize: 1000, chunkOverlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Allow a small slack for the joining newline + overlap carry.
      expect(c.length).toBeLessThanOrEqual(1000 + 200);
    }
  });

  it('hard-splits a single oversized paragraph', () => {
    const huge = 'x'.repeat(3000);
    const chunks = chunkText(huge, { chunkSize: 1000, chunkOverlap: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('respects maxChunks cap', () => {
    const para = 'word '.repeat(50);
    const text = Array.from({ length: 200 }, () => para).join('\n\n');
    const chunks = chunkText(text, { chunkSize: 500, chunkOverlap: 50, maxChunks: 5 });
    expect(chunks).toHaveLength(5);
  });

  it('uses sensible defaults', () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(1000);
    const chunks = chunkText('a'.repeat(2500));
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ── clampTopK ────────────────────────────────────────────────────────────────

describe('clampTopK', () => {
  it('defaults to 10 when unset or invalid', () => {
    expect(clampTopK(undefined)).toBe(10);
    expect(clampTopK(NaN)).toBe(10);
    expect(clampTopK(Infinity)).toBe(10);
  });
  it('clamps to [1,100]', () => {
    expect(clampTopK(0)).toBe(1);
    expect(clampTopK(-5)).toBe(1);
    expect(clampTopK(7)).toBe(7);
    expect(clampTopK(500)).toBe(100);
  });
});

// ── ingestFile ────────────────────────────────────────────────────────────────

describe('VectorStoreIngestService.ingestFile', () => {
  let embedder: ReturnType<typeof makeFakeEmbedder>;
  let pool: ReturnType<typeof makeFakePool>;
  let service: VectorStoreIngestService;

  beforeEach(() => {
    embedder = makeFakeEmbedder();
    pool = makeFakePool();
    service = new VectorStoreIngestService(pool, embedder);
  });

  it('chunks, embeds, and persists one INSERT per chunk', async () => {
    const para = 'The quick brown fox jumps over the lazy dog repeatedly today.';
    const content = Array.from({ length: 30 }, () => para).join('\n\n');

    const result = await service.ingestFile({
      vectorStoreId: 'vs_1',
      vectorStoreFileId: 'vsf_1',
      fileId: 'file_1',
      organizationId: 'org-1',
      content,
      chunkOptions: { chunkSize: 500, chunkOverlap: 50 },
    });

    expect(result.chunksCreated).toBeGreaterThan(1);
    expect(result.embeddingModel).toBe('test/fake-embedder@384');

    // Embedder called once in batch with all chunks.
    expect(embedder.embedBatch).toHaveBeenCalledTimes(1);
    const embeddedTexts = embedder.embedBatch.mock.calls[0][0] as string[];
    expect(embeddedTexts).toHaveLength(result.chunksCreated);

    // One DELETE (idempotent replace) + one INSERT per chunk.
    const inserts = pool.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO vector_store_chunks'),
    );
    const deletes = pool.query.mock.calls.filter((c) =>
      String(c[0]).includes('DELETE FROM vector_store_chunks'),
    );
    expect(deletes).toHaveLength(1);
    expect(inserts).toHaveLength(result.chunksCreated);

    // Each INSERT carries a pgvector literal and the org id (tenant stamp).
    const firstInsert = inserts[0];
    const params = firstInsert[1] as unknown[];
    expect(params[1]).toBe('vs_1'); // vector_store_id
    expect(params[4]).toBe('org-1'); // organization_id
    const vectorLiteral = params[7] as string;
    expect(vectorLiteral.startsWith('[')).toBe(true);
    expect(vectorLiteral.split(',')).toHaveLength(EMBEDDING_DIM);
  });

  it('deletes prior chunks before inserting (idempotent re-ingest)', async () => {
    await service.ingestFile({
      vectorStoreId: 'vs_1',
      vectorStoreFileId: 'vsf_1',
      fileId: 'file_1',
      organizationId: 'org-1',
      content: 'Some indexable content here.',
    });
    // First query must be the DELETE for the association.
    expect(String(pool.query.mock.calls[0][0])).toContain('DELETE FROM vector_store_chunks');
    expect((pool.query.mock.calls[0][1] as unknown[])[0]).toBe('vsf_1');
  });

  it('creates 0 chunks for empty content and skips embedding', async () => {
    const result = await service.ingestFile({
      vectorStoreId: 'vs_1',
      vectorStoreFileId: 'vsf_1',
      fileId: 'file_1',
      organizationId: 'org-1',
      content: '   \n\n  ',
    });
    expect(result.chunksCreated).toBe(0);
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    // Only the DELETE ran; no INSERTs.
    const inserts = pool.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO'),
    );
    expect(inserts).toHaveLength(0);
  });

  it('throws if the embedder returns the wrong dimension', async () => {
    embedder.embedBatch.mockResolvedValueOnce([{ vector: [0.1, 0.2, 0.3] }]);
    await expect(
      service.ingestFile({
        vectorStoreId: 'vs_1',
        vectorStoreFileId: 'vsf_1',
        fileId: 'file_1',
        organizationId: 'org-1',
        content: 'short text',
      }),
    ).rejects.toThrow(/dim/i);
  });
});

// ── search ────────────────────────────────────────────────────────────────────

describe('VectorStoreIngestService.search', () => {
  let embedder: ReturnType<typeof makeFakeEmbedder>;

  beforeEach(() => {
    embedder = makeFakeEmbedder();
  });

  it('embeds the query once and returns chunks ordered by score', async () => {
    // The mocked pool returns rows already ordered by score desc (as Postgres
    // would via ORDER BY embedding <=> query). We assert the mapping preserves
    // order and shape.
    const pool = makeFakePool((sql) => {
      if (sql.includes('SELECT') && sql.includes('vector_store_chunks')) {
        return {
          rows: [
            { id: 'c1', file_id: 'f1', vector_store_file_id: 'vsf1', chunk_index: 0, content: 'most relevant', score: 0.97, metadata: { filename: 'a.txt' } },
            { id: 'c2', file_id: 'f1', vector_store_file_id: 'vsf1', chunk_index: 1, content: 'less relevant', score: 0.61, metadata: {} },
          ],
        };
      }
      return undefined;
    });
    const service = new VectorStoreIngestService(pool, embedder);

    const hits = await service.search({
      vectorStoreId: 'vs_1',
      organizationId: 'org-1',
      query: 'what is relevant?',
      topK: 5,
    });

    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(hits).toHaveLength(2);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].content).toBe('most relevant');
    expect(hits[0].metadata).toEqual({ filename: 'a.txt' });

    // The SQL must scope to BOTH store and org (tenant isolation) and pass top_k.
    const selectCall = pool.query.mock.calls.find((c) =>
      String(c[0]).includes('SELECT') && String(c[0]).includes('vector_store_chunks'),
    );
    const sql = String(selectCall?.[0]);
    expect(sql).toContain('vector_store_id = $2');
    expect(sql).toContain('organization_id = $3');
    expect(sql).toContain('embedding <=> $1::vector');
    const params = selectCall?.[1] as unknown[];
    expect(params[1]).toBe('vs_1');
    expect(params[2]).toBe('org-1');
    expect(params[3]).toBe(5); // top_k
  });

  it('clamps top_k into [1,100]', async () => {
    const pool = makeFakePool(() => ({ rows: [] }));
    const service = new VectorStoreIngestService(pool, embedder);
    await service.search({ vectorStoreId: 'vs_1', organizationId: 'org-1', query: 'q', topK: 9999 });
    const selectCall = pool.query.mock.calls.find((c) =>
      String(c[0]).includes('vector_store_chunks'),
    );
    expect((selectCall?.[1] as unknown[])[3]).toBe(100);
  });

  it('returns [] and does not hit the DB for an empty query', async () => {
    const pool = makeFakePool();
    const service = new VectorStoreIngestService(pool, embedder);
    const hits = await service.search({ vectorStoreId: 'vs_1', organizationId: 'org-1', query: '   ' });
    expect(hits).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it('adds a file_ids filter when provided', async () => {
    const pool = makeFakePool(() => ({ rows: [] }));
    const service = new VectorStoreIngestService(pool, embedder);
    await service.search({
      vectorStoreId: 'vs_1',
      organizationId: 'org-1',
      query: 'q',
      fileIds: ['f1', 'f2'],
    });
    const selectCall = pool.query.mock.calls.find((c) =>
      String(c[0]).includes('vector_store_chunks'),
    );
    expect(String(selectCall?.[0])).toContain('file_id = ANY');
    expect((selectCall?.[1] as unknown[])[4]).toEqual(['f1', 'f2']);
  });
});
