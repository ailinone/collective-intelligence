// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic unit tests for the pgvector-backed SemanticCache (scale-to-100k
 * Phase 5, issue #150) — verifies the SQL/params shape for each operation
 * (exact-match lookup, ANN similarity search, insert, atomic hit-count
 * increment, aggregate stats, invalidation) using a mocked pg.Pool and a
 * mocked CapabilityEmbedder, per the constructor's injectable dependencies
 * (mirroring VectorStoreIngestService's testability pattern).
 *
 * No real Postgres/pgvector: this proves the service issues the CORRECT
 * queries, not that the HNSW index/kNN operator work end-to-end — that is
 * covered by the migration itself following the same, already-proven
 * vector_store_chunks pattern (prisma/migrations/20260613000000_vector_store_chunks),
 * validated via this repo's real-DB integration test suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SemanticCache } from '../semantic-cache';
import type { ChatRequest, ChatResponse } from '@/types';

function makeMockPool() {
  return { query: vi.fn() } as unknown as { query: ReturnType<typeof vi.fn> };
}

function makeMockEmbedder(vector: number[] = new Array(384).fill(0.1)) {
  return {
    id: 'test-embedder@384',
    embed: vi.fn().mockResolvedValue({ vector }),
    embedBatch: vi.fn(),
  };
}

const CHAT_REQUEST: ChatRequest = {
  model: 'auto',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
} as ChatRequest;

const CHAT_RESPONSE = { id: 'resp_1', choices: [] } as unknown as ChatResponse;

describe('SemanticCache (pgvector)', () => {
  let pool: ReturnType<typeof makeMockPool>;
  let embedder: ReturnType<typeof makeMockEmbedder>;
  let cache: SemanticCache;

  beforeEach(() => {
    pool = makeMockPool();
    embedder = makeMockEmbedder();
    cache = new SemanticCache({}, pool as never, embedder as never);
  });

  describe('lookup — exact match', () => {
    it('queries by (organization_id, request_hash) and returns a hit', async () => {
      const now = new Date();
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'sc_1',
            request_hash: 'abc',
            response: CHAT_RESPONSE,
            model: 'auto',
            organization_id: 'org-1',
            hit_count: 2,
            created_at: now,
            expires_at: new Date(now.getTime() + 60_000),
            original_request: 'What is the capital of France?',
            tokens_saved: 100,
            cost_saved_usd: '0.005',
            strategy_key: 'dynamic',
          },
        ],
      });

      const result = await cache.lookup({ request: CHAT_REQUEST, organizationId: 'org-1' });

      expect(result).not.toBeNull();
      expect(result?.isExactMatch).toBe(true);
      expect(result?.similarity).toBe(1.0);
      expect(result?.entry.hitCount).toBe(2);

      const [sql, params] = pool.query.mock.calls[0]!;
      expect(sql).toMatch(/request_hash = \$2/);
      expect(sql).toMatch(/organization_id = \$1/);
      expect(params[0]).toBe('org-1');
      // Embedder must NOT be called when the exact-match path already hits.
      expect(embedder.embed).not.toHaveBeenCalled();
    });
  });

  describe('lookup — ANN similarity search', () => {
    it('falls back to vector search on exact-match miss and returns a hit above threshold', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] }); // exact match miss
      const now = new Date();
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'sc_2',
            request_hash: 'xyz',
            response: CHAT_RESPONSE,
            model: 'auto',
            organization_id: 'org-1',
            hit_count: 0,
            created_at: now,
            expires_at: new Date(now.getTime() + 60_000),
            original_request: 'What is the capital city of France?',
            tokens_saved: 50,
            cost_saved_usd: '0.002',
            strategy_key: 'dynamic',
            score: 0.97,
          },
        ],
      });

      const result = await cache.lookup({ request: CHAT_REQUEST, organizationId: 'org-1' });

      expect(result).not.toBeNull();
      expect(result?.isExactMatch).toBe(false);
      expect(result?.similarity).toBe(0.97);
      expect(embedder.embed).toHaveBeenCalledTimes(1);

      const [sql, params] = pool.query.mock.calls[1]!;
      expect(sql).toMatch(/embedding <=> \$1::vector/);
      expect(sql).toMatch(/ORDER BY embedding <=> \$1::vector/);
      expect(sql).toMatch(/strategy_key = \$3/);
      expect(params[1]).toBe('org-1');
      expect(params[2]).toBe('dynamic');
    });

    it('returns null when the best match is below the similarity threshold', async () => {
      cache = new SemanticCache({ similarityThreshold: 0.95 }, pool as never, embedder as never);
      pool.query.mockResolvedValueOnce({ rows: [] }); // exact miss
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'sc_3',
            request_hash: 'xyz',
            response: CHAT_RESPONSE,
            model: 'auto',
            organization_id: 'org-1',
            hit_count: 0,
            created_at: new Date(),
            expires_at: new Date(Date.now() + 60_000),
            original_request: 'unrelated',
            tokens_saved: 0,
            cost_saved_usd: '0',
            strategy_key: 'dynamic',
            score: 0.5, // below threshold
          },
        ],
      });

      const result = await cache.lookup({ request: CHAT_REQUEST, organizationId: 'org-1' });
      expect(result).toBeNull();
    });
  });

  describe('store', () => {
    it('inserts with the embedding as a pgvector literal', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const id = await cache.store({
        request: CHAT_REQUEST,
        response: CHAT_RESPONSE,
        organizationId: 'org-1',
        metadata: { tokensSaved: 42, costSaved: 0.01 },
      });

      expect(id).toMatch(/^sc_/);
      const [sql, params] = pool.query.mock.calls[0]!;
      expect(sql).toMatch(/INSERT INTO semantic_cache_entries/);
      expect(sql).toMatch(/\$6::vector/);
      // vector literal format: "[0.1,0.1,...]"
      expect(params[5]).toMatch(/^\[[\d.,]+\]$/);
      expect(params[9]).toBe(42); // tokens_saved
      expect(params[10]).toBe(0.01); // cost_saved_usd
    });

    it('stores NULL for the embedding when only the fallback (non-provider) vector was available', async () => {
      // Force fallback by making the embedder always reject.
      embedder.embed.mockRejectedValue(new Error('embedder down'));
      cache = new SemanticCache({}, pool as never, embedder as never);
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await cache.store({ request: CHAT_REQUEST, response: CHAT_RESPONSE, organizationId: 'org-1' });

      const [, params] = pool.query.mock.calls[0]!;
      expect(params[5]).toBeNull(); // embedding
      expect(params[6]).toBeNull(); // embedding_model
    });
  });

  describe('recordHit', () => {
    it('issues an atomic increment, not a read-modify-write', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      await cache.recordHit('sc_1');

      const [sql, params] = pool.query.mock.calls[0]!;
      expect(sql).toMatch(/hit_count = hit_count \+ 1/);
      expect(params).toEqual(['sc_1']);
    });
  });

  describe('getStats', () => {
    it('issues a single aggregate query', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            total_entries: '10',
            total_hits: '25',
            estimated_cost_saved: '1.5',
            oldest_entry: new Date('2026-01-01'),
            newest_entry: new Date('2026-01-02'),
          },
        ],
      });

      const stats = await cache.getStats('org-1');

      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(stats.totalEntries).toBe(10);
      expect(stats.totalHits).toBe(25);
      expect(stats.estimatedCostSaved).toBe(1.5);
    });

    it('returns zeroed stats for an org with no entries, without erroring', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ total_entries: '0', total_hits: null, estimated_cost_saved: null, oldest_entry: null, newest_entry: null }],
      });

      const stats = await cache.getStats('org-empty');
      expect(stats).toEqual({
        totalEntries: 0,
        totalHits: 0,
        estimatedCostSaved: 0,
        oldestEntry: null,
        newestEntry: null,
      });
    });
  });

  describe('invalidate', () => {
    it('deletes all of an org\'s entries when no pattern is given', async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 7 });
      const count = await cache.invalidate({ organizationId: 'org-1' });
      expect(count).toBe(7);
      const [sql, params] = pool.query.mock.calls[0]!;
      expect(sql).not.toMatch(/LIKE/);
      expect(params).toEqual(['org-1']);
    });

    it('scopes the delete by pattern when given', async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 2 });
      const count = await cache.invalidate({ organizationId: 'org-1', pattern: 'France' });
      expect(count).toBe(2);
      const [sql, params] = pool.query.mock.calls[0]!;
      expect(sql).toMatch(/LIKE \$2/);
      expect(params).toEqual(['org-1', '%France%']);
    });
  });

  describe('cleanupExpired', () => {
    it('deletes rows past their expiry', async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 3 });
      const deleted = await cache.cleanupExpired();
      expect(deleted).toBe(3);
      expect(pool.query.mock.calls[0]![0]).toMatch(/expires_at <= NOW\(\)/);
    });
  });

  describe('embedder circuit breaker', () => {
    it('opens the circuit after 3 consecutive embedder failures and skips the embedder thereafter', async () => {
      embedder.embed.mockRejectedValue(new Error('embedder down'));
      cache = new SemanticCache({}, pool as never, embedder as never);

      // 3 store() calls, all failing to embed — each triggers the fallback path.
      for (let i = 0; i < 3; i++) {
        pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        await cache.store({
          request: { ...CHAT_REQUEST, messages: [{ role: 'user', content: `q${i}` }] } as ChatRequest,
          response: CHAT_RESPONSE,
          organizationId: 'org-1',
        });
      }
      expect(embedder.embed).toHaveBeenCalledTimes(3);

      // 4th call: circuit should be open — embedder is not called again.
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await cache.store({
        request: { ...CHAT_REQUEST, messages: [{ role: 'user', content: 'q4' }] } as ChatRequest,
        response: CHAT_RESPONSE,
        organizationId: 'org-1',
      });
      expect(embedder.embed).toHaveBeenCalledTimes(3); // unchanged — circuit open
    });
  });
});
