// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RetrievalOrchestrationService — LOTE AP.
 *
 * Pins the two-stage retrieval contract:
 *   - stage 1 is the REAL pgvector kNN (`VectorStoreIngestService.search`),
 *     always org-scoped;
 *   - stage 2 (cross-encoder rerank) is opt-in, OVER-FETCHES stage 1 so it
 *     has something to reorder, and is FAIL-SOFT — an outage degrades to
 *     vector order and is reported, never raised;
 *   - a reranker returning an out-of-range index is survived, not trusted;
 *   - per-store failures are isolated;
 *   - a request with no vector store is rejected with an actionable message
 *     instead of being silently answered by a model with no corpus.
 *
 * Both collaborators are injected: no DB, no embedder, no provider calls.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { OrchestrationContext } from '@/types';
import type { SearchChunkHit } from '@/services/vector-store-ingest-service';
import {
  RetrievalOrchestrationService,
  RETRIEVAL_RERANK_OVERFETCH,
  RETRIEVAL_MAX_STORES,
} from '../retrieval-orchestration-service';
import type { RerankOrchestrationService } from '../rerank-orchestration-service';
import { ValidationError } from '@/utils/custom-errors';

const USER_CONTEXT = {
  organizationId: 'org_test',
  userId: 'user_test',
} as unknown as OrchestrationContext;

function makeHit(overrides: Partial<SearchChunkHit> = {}): SearchChunkHit {
  return {
    id: `vsc_${Math.random().toString(36).slice(2)}`,
    fileId: 'file_a',
    vectorStoreFileId: 'vsf_a',
    chunkIndex: 0,
    content: 'chunk content',
    score: 0.9,
    metadata: {},
    ...overrides,
  };
}

function makeIngest(search: Mock) {
  return { search } as unknown as import('@/services/vector-store-ingest-service').VectorStoreIngestService;
}

function makeRerankService(rerank: Mock) {
  return { rerank } as unknown as RerankOrchestrationService;
}

function build(search: Mock, rerank?: Mock) {
  return new RetrievalOrchestrationService(
    makeIngest(search),
    () => makeRerankService(rerank ?? vi.fn())
  );
}

describe('RetrievalOrchestrationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('stage 1 — vector search', () => {
    it('searches every named store, always scoped to the caller org', async () => {
      const search = vi.fn().mockResolvedValue([makeHit()]);
      const service = build(search);

      await service.retrieve({
        query: 'what is in the docs?',
        vectorStoreIds: ['vs_1', 'vs_2'],
        userContext: USER_CONTEXT,
        requestId: 'req_1',
      });

      expect(search).toHaveBeenCalledTimes(2);
      for (const call of search.mock.calls) {
        expect(call[0].organizationId).toBe('org_test');
        expect(call[0].query).toBe('what is in the docs?');
      }
      expect(search.mock.calls.map((c) => c[0].vectorStoreId)).toEqual(['vs_1', 'vs_2']);
    });

    it('ranks by descending similarity and caps at max_chunks', async () => {
      const search = vi.fn().mockResolvedValue([
        makeHit({ content: 'low', score: 0.2 }),
        makeHit({ content: 'high', score: 0.95 }),
        makeHit({ content: 'mid', score: 0.6 }),
      ]);
      const service = build(search);

      const result = await service.retrieve({
        query: 'q',
        vectorStoreIds: ['vs_1'],
        maxChunks: 2,
        userContext: USER_CONTEXT,
        requestId: 'req_2',
      });

      expect(result.chunks.map((c) => c.content)).toEqual(['high', 'mid']);
      expect(result.retrievedCount).toBe(3);
    });

    it('drops chunks below score_threshold', async () => {
      const search = vi.fn().mockResolvedValue([
        makeHit({ content: 'keep', score: 0.8 }),
        makeHit({ content: 'drop', score: 0.1 }),
      ]);
      const service = build(search);

      const result = await service.retrieve({
        query: 'q',
        vectorStoreIds: ['vs_1'],
        scoreThreshold: 0.5,
        userContext: USER_CONTEXT,
        requestId: 'req_3',
      });

      expect(result.chunks.map((c) => c.content)).toEqual(['keep']);
    });

    it('isolates a failing store instead of failing the whole retrieval', async () => {
      const search = vi
        .fn()
        .mockResolvedValueOnce([makeHit({ content: 'from healthy store' })])
        .mockRejectedValueOnce(new Error('store offline'));
      const service = build(search);

      const result = await service.retrieve({
        query: 'q',
        vectorStoreIds: ['vs_ok', 'vs_broken'],
        userContext: USER_CONTEXT,
        requestId: 'req_4',
      });

      expect(result.chunks).toHaveLength(1);
      expect(result.failedStoreIds).toEqual(['vs_broken']);
    });

    it('does NOT over-fetch when no rerank stage will run', async () => {
      const search = vi.fn().mockResolvedValue([makeHit()]);
      const service = build(search);

      await service.retrieve({
        query: 'q',
        vectorStoreIds: ['vs_1'],
        topK: 5,
        userContext: USER_CONTEXT,
        requestId: 'req_5',
      });

      expect(search.mock.calls[0][0].topK).toBe(5);
    });
  });

  describe('stage 2 — cross-encoder rerank', () => {
    it('over-fetches stage 1 so the reranker has candidates to reorder', async () => {
      const search = vi.fn().mockResolvedValue([makeHit()]);
      const rerank = vi.fn().mockResolvedValue({
        results: [{ index: 0, relevanceScore: 0.9 }],
        modelUsed: 'rerank-fixture',
        provider: 'fixture',
        durationMs: 1,
        strategyUsed: 'dynamic',
        fallbackUsed: false,
      });
      const service = build(search, rerank);

      await service.retrieve({
        query: 'q',
        vectorStoreIds: ['vs_1'],
        topK: 5,
        rerank: true,
        userContext: USER_CONTEXT,
        requestId: 'req_6',
      });

      expect(search.mock.calls[0][0].topK).toBe(5 * RETRIEVAL_RERANK_OVERFETCH);
    });

    it('reorders by cross-encoder score and reports the model that did it', async () => {
      const search = vi.fn().mockResolvedValue([
        makeHit({ content: 'vector-first', score: 0.95 }),
        makeHit({ content: 'vector-second', score: 0.4 }),
      ]);
      // The reranker disagrees with the embedding — that is the entire point
      // of a second stage.
      const rerank = vi.fn().mockResolvedValue({
        results: [
          { index: 1, relevanceScore: 0.99 },
          { index: 0, relevanceScore: 0.02 },
        ],
        modelUsed: 'rerank-fixture',
        provider: 'fixture',
        durationMs: 1,
        strategyUsed: 'dynamic',
        fallbackUsed: false,
      });
      const service = build(search, rerank);

      const result = await service.retrieve({
        query: 'q',
        vectorStoreIds: ['vs_1'],
        rerank: true,
        userContext: USER_CONTEXT,
        requestId: 'req_7',
      });

      expect(result.chunks.map((c) => c.content)).toEqual(['vector-second', 'vector-first']);
      expect(result.chunks[0].rerankScore).toBe(0.99);
      // The stage-1 score is preserved alongside, so callers can audit the swap.
      expect(result.chunks[0].vectorScore).toBe(0.4);
      expect(result.rerank).toMatchObject({
        requested: true,
        applied: true,
        model: 'rerank-fixture',
        provider: 'fixture',
      });
    });

    it('degrades to vector order when the reranker fails, and says so', async () => {
      const search = vi.fn().mockResolvedValue([
        makeHit({ content: 'a', score: 0.9 }),
        makeHit({ content: 'b', score: 0.3 }),
      ]);
      const rerank = vi.fn().mockRejectedValue(new Error('no reranker available'));
      const service = build(search, rerank);

      const result = await service.retrieve({
        query: 'q',
        vectorStoreIds: ['vs_1'],
        rerank: true,
        userContext: USER_CONTEXT,
        requestId: 'req_8',
      });

      expect(result.chunks.map((c) => c.content)).toEqual(['a', 'b']);
      expect(result.rerank.requested).toBe(true);
      expect(result.rerank.applied).toBe(false);
      expect(result.rerank.reason).toMatch(/rerank_unavailable/);
      expect(result.chunks[0].rerankScore).toBeUndefined();
    });

    it('survives a reranker that returns an out-of-range document index', async () => {
      const search = vi.fn().mockResolvedValue([makeHit({ content: 'only' })]);
      const rerank = vi.fn().mockResolvedValue({
        results: [
          { index: 7, relevanceScore: 0.99 },
          { index: 0, relevanceScore: 0.5 },
        ],
        modelUsed: 'rerank-fixture',
        provider: 'fixture',
        durationMs: 1,
        strategyUsed: 'dynamic',
        fallbackUsed: false,
      });
      const service = build(search, rerank);

      const result = await service.retrieve({
        query: 'q',
        vectorStoreIds: ['vs_1'],
        rerank: true,
        userContext: USER_CONTEXT,
        requestId: 'req_9',
      });

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content).toBe('only');
      expect(result.rerank.applied).toBe(true);
    });

    it('does not call the reranker at all when stage 1 found nothing', async () => {
      const search = vi.fn().mockResolvedValue([]);
      const rerank = vi.fn();
      const service = build(search, rerank);

      const result = await service.retrieve({
        query: 'q',
        vectorStoreIds: ['vs_1'],
        rerank: true,
        userContext: USER_CONTEXT,
        requestId: 'req_10',
      });

      expect(rerank).not.toHaveBeenCalled();
      expect(result.chunks).toEqual([]);
      expect(result.rerank.reason).toBe('no_candidates');
    });
  });

  describe('input validation', () => {
    it('rejects a retrieval with no corpus, naming the fix', async () => {
      const search = vi.fn();
      const service = build(search);

      await expect(
        service.retrieve({
          query: 'q',
          vectorStoreIds: [],
          userContext: USER_CONTEXT,
          requestId: 'req_11',
        })
      ).rejects.toThrow(/vector_store_ids is required/);
      expect(search).not.toHaveBeenCalled();
    });

    it('rejects an empty query', async () => {
      const service = build(vi.fn());
      await expect(
        service.retrieve({
          query: '  ',
          vectorStoreIds: ['vs_1'],
          userContext: USER_CONTEXT,
          requestId: 'req_12',
        })
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('caps the number of stores per request', async () => {
      const service = build(vi.fn());
      const ids = Array.from({ length: RETRIEVAL_MAX_STORES + 1 }, (_, i) => `vs_${i}`);
      await expect(
        service.retrieve({
          query: 'q',
          vectorStoreIds: ids,
          userContext: USER_CONTEXT,
          requestId: 'req_13',
        })
      ).rejects.toThrow(/exceeds the maximum/);
    });

    it('refuses to run without an organization-scoped context', async () => {
      const search = vi.fn();
      const service = build(search);

      await expect(
        service.retrieve({
          query: 'q',
          vectorStoreIds: ['vs_1'],
          userContext: {} as unknown as OrchestrationContext,
          requestId: 'req_14',
        })
      ).rejects.toThrow(/organization-scoped/);
      expect(search).not.toHaveBeenCalled();
    });
  });
});
