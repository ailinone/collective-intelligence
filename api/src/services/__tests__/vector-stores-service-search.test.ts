// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * VectorStoresService — ingest wiring + search tenant isolation (F3/F1 §P4).
 *
 * Validates the service layer that turns vector-stores from metadata-only into
 * a real embedding store, with prisma, the file content source, and the ingest
 * engine all mocked (NO DB, NO network, NO pgvector — CI vitest config).
 *
 * Covered:
 *   - createVectorStoreFile returns status=in_progress immediately and drives the
 *     ingest in the BACKGROUND, which persists the terminal status (completed +
 *     chunk_count). Clients poll for the outcome (OpenAI-compatible async ingest).
 *   - a background ingest failure is captured (status='failed', last_error)
 *     without throwing to the caller
 *   - searchVectorStore enforces tenant isolation: a store owned by another org
 *     is "not found" (→ 404 at the route), and the org id is threaded into the
 *     ingest search call (defence in depth)
 *   - searchVectorStore returns OpenAI-shaped, score-ordered results and honors
 *     top_k
 *   - an empty query is rejected (→ 400 at the route)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    vectorStore: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    file: {
      findFirst: vi.fn(),
    },
    vectorStoreFile: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  getFileContent: vi.fn(),
  ingestFile: vi.fn(),
  search: vi.fn(),
}));

vi.mock('@/database/client', () => ({ prisma: mocks.prisma }));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('@/services/files-service', () => ({
  FilesService: class {
    getFileContent = mocks.getFileContent;
  },
}));

vi.mock('@/services/vector-store-ingest-service', () => ({
  VectorStoreIngestService: class {
    ingestFile = mocks.ingestFile;
    search = mocks.search;
  },
}));

import { VectorStoresService } from '../vector-stores-service';

const userContext = { requestId: 'req-1', organizationId: 'org-1', userId: 'user-1' };
const otherOrg = { requestId: 'req-2', organizationId: 'org-2', userId: 'user-2' };

function makeService() {
  return new VectorStoresService();
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Ingest wiring ─────────────────────────────────────────────────────────────

describe('VectorStoresService.createVectorStoreFile — real ingest', () => {
  beforeEach(() => {
    mocks.prisma.vectorStore.findFirst.mockResolvedValue({ id: 'vs_1', organizationId: 'org-1' });
    mocks.prisma.file.findFirst.mockResolvedValue({ id: 'file_1', organizationId: 'org-1' });
    mocks.prisma.vectorStoreFile.findUnique.mockResolvedValue(null);
    mocks.prisma.vectorStoreFile.create.mockResolvedValue({
      id: 'vsf_1',
      vectorStoreId: 'vs_1',
      fileId: 'file_1',
      status: 'in_progress',
      createdAt: new Date('2026-06-13T00:00:00Z'),
    });
    mocks.prisma.vectorStore.update.mockResolvedValue({});
    mocks.prisma.vectorStoreFile.update.mockResolvedValue({});
    mocks.getFileContent.mockResolvedValue({
      content: Buffer.from('Indexable document content for embedding.', 'utf-8'),
      filename: 'doc.txt',
      contentType: 'text/plain',
    });
  });

  it('returns in_progress immediately, then ingests in the background to completed + chunk_count', async () => {
    mocks.ingestFile.mockResolvedValue({ chunksCreated: 3, embeddingModel: 'm@384' });

    const result = await makeService().createVectorStoreFile({
      vectorStoreId: 'vs_1',
      fileId: 'file_1',
      userContext,
      requestId: 'req-1',
    });

    // NEW CONTRACT (async ingest): the HTTP path returns immediately with
    // status=in_progress; the embedding pipeline runs in the background and
    // writes the terminal status. Clients poll for the outcome (OpenAI-compatible).
    expect(result.status).toBe('in_progress');

    // The background ingest still runs and persists status=completed + chunk_count.
    await vi.waitFor(() => {
      const updateArg = mocks.prisma.vectorStoreFile.update.mock.calls.find(
        (c) => c[0].data?.status === 'completed',
      );
      expect(updateArg?.[0].data.chunkCount).toBe(3);
    });

    expect(mocks.ingestFile).toHaveBeenCalledTimes(1);
    // org id is threaded into the ingest (tenant stamp on chunks).
    const ingestArg = mocks.ingestFile.mock.calls[0][0];
    expect(ingestArg.organizationId).toBe('org-1');
    expect(ingestArg.vectorStoreFileId).toBe('vsf_1');
  });

  it('captures a background ingest failure as status=failed without throwing', async () => {
    mocks.ingestFile.mockRejectedValue(new Error('embedder exploded'));

    // Still returns in_progress synchronously — the failure surfaces in the
    // background and is captured on the row, never thrown to the caller.
    const result = await makeService().createVectorStoreFile({
      vectorStoreId: 'vs_1',
      fileId: 'file_1',
      userContext,
      requestId: 'req-1',
    });

    expect(result.status).toBe('in_progress');

    await vi.waitFor(() => {
      const failedUpdate = mocks.prisma.vectorStoreFile.update.mock.calls.find(
        (c) => c[0].data?.status === 'failed',
      );
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate?.[0].data.lastError).toContain('embedder exploded');
    });
  });
});

// ── Search ────────────────────────────────────────────────────────────────────

describe('VectorStoresService.searchVectorStore', () => {
  beforeEach(() => {
    mocks.prisma.vectorStore.update.mockResolvedValue({});
  });

  it('returns OpenAI-shaped, score-ordered results and threads top_k + org', async () => {
    mocks.prisma.vectorStore.findFirst.mockResolvedValue({ id: 'vs_1', organizationId: 'org-1' });
    mocks.search.mockResolvedValue([
      { id: 'c1', fileId: 'f1', vectorStoreFileId: 'vsf1', chunkIndex: 0, content: 'top hit', score: 0.95, metadata: { filename: 'a.txt' } },
      { id: 'c2', fileId: 'f1', vectorStoreFileId: 'vsf1', chunkIndex: 1, content: 'second', score: 0.5, metadata: {} },
    ]);

    const res = await makeService().searchVectorStore({
      vectorStoreId: 'vs_1',
      query: 'find something',
      top_k: 5,
      userContext,
      requestId: 'req-1',
    });

    expect(res.object).toBe('vector_store.search_results');
    expect(res.search_query).toBe('find something');
    expect(res.data).toHaveLength(2);
    expect(res.data[0].score).toBeGreaterThan(res.data[1].score);
    expect(res.data[0].content).toEqual([{ type: 'text', text: 'top hit' }]);
    expect(res.data[0].file_id).toBe('f1');

    const searchArg = mocks.search.mock.calls[0][0];
    expect(searchArg.organizationId).toBe('org-1');
    expect(searchArg.topK).toBe(5);
    expect(searchArg.vectorStoreId).toBe('vs_1');
  });

  it('enforces tenant isolation: a store owned by another org is not found', async () => {
    // The findFirst is scoped by organizationId, so a cross-tenant lookup
    // returns null → the service throws "not found" (route maps to 404).
    mocks.prisma.vectorStore.findFirst.mockResolvedValue(null);

    await expect(
      makeService().searchVectorStore({
        vectorStoreId: 'vs_1',
        query: 'q',
        userContext: otherOrg,
        requestId: 'req-2',
      }),
    ).rejects.toThrow(/not found/i);

    // The org filter was applied in the lookup.
    const whereArg = mocks.prisma.vectorStore.findFirst.mock.calls[0][0].where;
    expect(whereArg.organizationId).toBe('org-2');
    // And we never reached the embedding/search layer.
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('rejects an empty query (route maps to 400)', async () => {
    mocks.prisma.vectorStore.findFirst.mockResolvedValue({ id: 'vs_1', organizationId: 'org-1' });

    await expect(
      makeService().searchVectorStore({
        vectorStoreId: 'vs_1',
        query: '   ',
        userContext,
        requestId: 'req-1',
      }),
    ).rejects.toThrow(/query is required/i);
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
