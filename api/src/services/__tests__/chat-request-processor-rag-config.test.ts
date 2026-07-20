// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * P5 — Native RAG (`rag_config`) tests for chat-request-processor.
 *
 * These pin the retrieve → inject → expose pipeline built on top of the P4
 * vector-search service (`VectorStoreIngestService.search`):
 *   - rag_config triggers retrieval and injects a grounding `system` message
 *     BEFORE the user's question (original messages preserved);
 *   - `ailin_metadata.retrieval` provenance is populated with real chunk data;
 *   - `top_k` is passed through to the search service;
 *   - `score_threshold` filters out low-similarity chunks;
 *   - `max_chunks` caps the number of injected chunks;
 *   - tenant scoping: the request's `organizationId` is always passed to search;
 *   - no rag_config → no retrieval, request untouched;
 *   - multiple stores aggregate, and a single failing store is skipped (fail-soft).
 *
 * The vector-search service is fully mocked — these are pure unit tests with no
 * DB, no embedder, and no provider calls.
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import type { Logger } from 'pino';
import type { ChatRequest } from '@/types';
import type { SearchChunkHit } from '@/services/vector-store-ingest-service';
import { retrieveRagContext } from '../chat-request-processor';

function makeLog(): Logger {
  const noop = () => undefined;
  const log = {
    info: vi.fn(noop),
    warn: vi.fn(noop),
    error: vi.fn(noop),
    debug: vi.fn(noop),
    trace: vi.fn(noop),
    fatal: vi.fn(noop),
    child: () => log,
    level: 'info',
  };
  return log as unknown as Logger;
}

function makeHit(overrides: Partial<SearchChunkHit> = {}): SearchChunkHit {
  return {
    id: `vsc_${Math.random().toString(36).slice(2)}`,
    fileId: 'file_a',
    vectorStoreFileId: 'vsf_a',
    chunkIndex: 0,
    content: 'The capital of France is Paris.',
    score: 0.9,
    metadata: {},
    ...overrides,
  };
}

/** A stub service exposing `.search` with the same shape the real service has. */
function makeService(search: Mock) {
  return { search } as unknown as import('@/services/vector-store-ingest-service').VectorStoreIngestService;
}

const ORG = 'org_test_123';

function baseRequest(rag?: Record<string, unknown>): ChatRequest {
  return {
    model: 'auto',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is the capital of France?' },
    ],
    ...(rag ? ({ rag_config: rag } as Record<string, unknown>) : {}),
  } as ChatRequest;
}

describe('retrieveRagContext — retrieval + injection', () => {
  it('retrieves chunks and injects a grounding system message before the user message', async () => {
    const search = vi.fn(async () => [
      makeHit({ content: 'Paris is the capital of France.', score: 0.95 }),
      makeHit({ content: 'France is in Western Europe.', score: 0.7, fileId: 'file_b' }),
    ]);

    const { request, retrieval } = await retrieveRagContext({
      chatRequest: baseRequest({ vector_store_ids: ['vs_1'] }),
      organizationId: ORG,
      log: makeLog(),
      ingestService: makeService(search),
    });

    // Original 2 messages preserved + 1 injected context message.
    expect(request.messages).toHaveLength(3);

    // The injected message is a system message inserted right before the user turn.
    const userIdx = request.messages.findIndex((m) => m.role === 'user');
    const injected = request.messages[userIdx - 1];
    expect(injected.role).toBe('system');
    expect(typeof injected.content).toBe('string');
    expect(injected.content as string).toContain('Paris is the capital of France.');
    expect(injected.content as string).toContain('France is in Western Europe.');

    // Caller's leading system prompt is still first; original user message intact.
    expect(request.messages[0].content).toBe('You are a helpful assistant.');
    expect(request.messages[userIdx].content).toBe('What is the capital of France?');

    // Provenance is real.
    expect(retrieval).not.toBeNull();
    expect(retrieval?.chunk_count).toBe(2);
    expect(retrieval?.store_ids).toEqual(['vs_1']);
    expect(retrieval?.chunks[0]).toMatchObject({
      vector_store_id: 'vs_1',
      score: 0.95,
    });
    expect(retrieval?.chunks[0].content_preview).toContain('Paris is the capital of France.');
  });

  it('passes top_k through to the search service', async () => {
    const search = vi.fn(async () => [makeHit()]);
    await retrieveRagContext({
      chatRequest: baseRequest({ vector_store_ids: ['vs_1'], top_k: 3 }),
      organizationId: ORG,
      log: makeLog(),
      ingestService: makeService(search),
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toMatchObject({ vectorStoreId: 'vs_1', topK: 3 });
  });

  it('respects score_threshold (drops low-similarity chunks)', async () => {
    const search = vi.fn(async () => [
      makeHit({ content: 'high relevance', score: 0.9 }),
      makeHit({ content: 'low relevance', score: 0.3 }),
    ]);

    const { request, retrieval } = await retrieveRagContext({
      chatRequest: baseRequest({ vector_store_ids: ['vs_1'], score_threshold: 0.5 }),
      organizationId: ORG,
      log: makeLog(),
      ingestService: makeService(search),
    });

    expect(retrieval?.chunk_count).toBe(1);
    expect(retrieval?.chunks[0].content_preview).toContain('high relevance');
    const injected = request.messages.find((m) => m.role === 'system' && String(m.content).includes('high relevance'));
    expect(injected).toBeDefined();
    expect(String(injected?.content)).not.toContain('low relevance');
  });

  it('caps injected chunks at max_chunks (highest scores win)', async () => {
    const search = vi.fn(async () => [
      makeHit({ content: 'chunk-a', score: 0.99 }),
      makeHit({ content: 'chunk-b', score: 0.80 }),
      makeHit({ content: 'chunk-c', score: 0.60 }),
    ]);

    const { retrieval } = await retrieveRagContext({
      chatRequest: baseRequest({ vector_store_ids: ['vs_1'], max_chunks: 2 }),
      organizationId: ORG,
      log: makeLog(),
      ingestService: makeService(search),
    });

    expect(retrieval?.chunk_count).toBe(2);
    expect(retrieval?.chunks.map((c) => c.content_preview)).toEqual([
      expect.stringContaining('chunk-a'),
      expect.stringContaining('chunk-b'),
    ]);
  });

  it('tenant scoping: passes the request organizationId to the search service', async () => {
    const search = vi.fn(async () => [makeHit()]);
    await retrieveRagContext({
      chatRequest: baseRequest({ vector_store_ids: ['vs_1', 'vs_2'] }),
      organizationId: ORG,
      log: makeLog(),
      ingestService: makeService(search),
    });
    expect(search).toHaveBeenCalledTimes(2);
    for (const call of search.mock.calls) {
      expect(call[0].organizationId).toBe(ORG);
    }
  });

  it('aggregates across multiple stores and ranks by score', async () => {
    const search = vi.fn(async ({ vectorStoreId }: { vectorStoreId: string }) => {
      if (vectorStoreId === 'vs_1') return [makeHit({ content: 'from-store-1', score: 0.6 })];
      return [makeHit({ content: 'from-store-2', score: 0.95, fileId: 'file_z' })];
    });

    const { retrieval } = await retrieveRagContext({
      chatRequest: baseRequest({ vector_store_ids: ['vs_1', 'vs_2'] }),
      organizationId: ORG,
      log: makeLog(),
      ingestService: makeService(search),
    });

    expect(retrieval?.chunk_count).toBe(2);
    // Higher score first regardless of store order.
    expect(retrieval?.chunks[0].content_preview).toContain('from-store-2');
    expect(retrieval?.chunks[0].vector_store_id).toBe('vs_2');
    expect(retrieval?.chunks[1].content_preview).toContain('from-store-1');
  });

  it('fail-soft: a single failing store is skipped, others still contribute', async () => {
    const search = vi.fn(async ({ vectorStoreId }: { vectorStoreId: string }) => {
      if (vectorStoreId === 'vs_bad') throw new Error('store offline');
      return [makeHit({ content: 'good-chunk', score: 0.8 })];
    });

    const { retrieval } = await retrieveRagContext({
      chatRequest: baseRequest({ vector_store_ids: ['vs_bad', 'vs_good'] }),
      organizationId: ORG,
      log: makeLog(),
      ingestService: makeService(search),
    });

    expect(retrieval?.chunk_count).toBe(1);
    expect(retrieval?.chunks[0].content_preview).toContain('good-chunk');
    // store_ids reflects what was requested, not just what succeeded.
    expect(retrieval?.store_ids).toEqual(['vs_bad', 'vs_good']);
  });
});

describe('retrieveRagContext — no-op paths', () => {
  it('without rag_config: request is unchanged and retrieval is null', async () => {
    const search = vi.fn(async () => [makeHit()]);
    const req = baseRequest();
    const { request, retrieval } = await retrieveRagContext({
      chatRequest: req,
      organizationId: ORG,
      log: makeLog(),
      ingestService: makeService(search),
    });
    expect(retrieval).toBeNull();
    expect(request).toBe(req); // same reference — untouched
    expect(search).not.toHaveBeenCalled();
  });

  it('malformed rag_config (no vector_store_ids) is ignored', async () => {
    const search = vi.fn(async () => [makeHit()]);
    const { request, retrieval } = await retrieveRagContext({
      chatRequest: baseRequest({ top_k: 5 }),
      organizationId: ORG,
      log: makeLog(),
      ingestService: makeService(search),
    });
    expect(retrieval).toBeNull();
    expect(request.messages).toHaveLength(2);
    expect(search).not.toHaveBeenCalled();
  });

  it('rag_config present but empty user query → no retrieval', async () => {
    const search = vi.fn(async () => [makeHit()]);
    const req = {
      model: 'auto',
      messages: [{ role: 'user', content: '   ' }],
      rag_config: { vector_store_ids: ['vs_1'] },
    } as unknown as ChatRequest;
    const { retrieval } = await retrieveRagContext({
      chatRequest: req,
      organizationId: ORG,
      log: makeLog(),
      ingestService: makeService(search),
    });
    expect(retrieval).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });

  it('retrieval that returns zero chunks injects nothing but reports empty provenance', async () => {
    const search = vi.fn(async () => [] as SearchChunkHit[]);
    const { request, retrieval } = await retrieveRagContext({
      chatRequest: baseRequest({ vector_store_ids: ['vs_1'] }),
      organizationId: ORG,
      log: makeLog(),
      ingestService: makeService(search),
    });
    expect(retrieval).toEqual({ chunks: [], store_ids: ['vs_1'], chunk_count: 0 });
    expect(request.messages).toHaveLength(2); // nothing injected
  });
});
