// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Semantic Cache
 *
 * Provides intelligent caching based on semantic similarity of requests.
 * Unlike traditional exact-match caching, semantic cache can return cached
 * responses for semantically similar (but not identical) requests.
 *
 * Scale-to-100k Phase 5 (issue #150): storage moved from Redis to
 * Postgres+pgvector. The prior implementation kept every organization's
 * entries in one Redis SET and, on every similarity lookup, fetched EVERY
 * member (up to maxEntriesPerOrg, default 10,000) and computed cosine
 * similarity in application code — an O(N) scan in both Redis round-trips
 * and CPU that grew unbounded with cache size. This reuses the SAME
 * pgvector(384) + HNSW(vector_cosine_ops) infrastructure as
 * vector_store_chunks / semantic_memories (see
 * prisma/migrations/20260718000000_semantic_cache_pgvector): the ANN search
 * is sub-linear via the HNSW index instead of scanning every candidate row,
 * and the exact-match path is a plain indexed equality lookup instead of a
 * derived-key Redis GET.
 *
 * Embeddings now come from the shared capability embedder (`getCapabilityEmbedder()`,
 * 384-dim — the same one backing RAG/HCRA search) instead of a bespoke
 * provider-registry lookup, for consistency with the rest of the vector
 * infrastructure. The resilience shape (in-memory embedding cache, circuit
 * breaker for a down/slow embedder, hash-based fallback) is preserved from
 * the prior implementation.
 *
 * Features:
 * - Embedding-based similarity matching
 * - Configurable similarity threshold
 * - TTL-based expiration
 * - Organization-scoped isolation
 * - Cache warming and invalidation
 *
 * Use Cases:
 * - Similar questions get instant responses
 * - Reduces API costs for repeated similar queries
 * - Improves response time for common patterns
 */

import { nanoid } from 'nanoid';
import type { Pool } from 'pg';
import type { ChatRequest, ChatResponse } from '@/types';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { canonicalizeStrategyInput } from '@/core/orchestration/strategy-contract';
import { createHash } from 'node:crypto';
import { getCapabilityPool } from '@/capability/db/capability-pool';
import { getCapabilityEmbedder } from '@/capability/embedder/embedder-factory';
import { EMBEDDING_DIM, type CapabilityEmbedder } from '@/capability/embedder/embedder';

const log = logger.child({ component: 'semantic-cache' });

/**
 * Cache entry as read back from Postgres.
 */
interface SemanticCacheEntry {
  id: string;
  requestHash: string;
  response: ChatResponse;
  model: string;
  organizationId: string;
  hitCount: number;
  createdAt: number;
  expiresAt: number;
  metadata: {
    originalRequest: string;
    tokensSaved: number;
    costSaved: number;
    strategyKey: string;
  };
}

/**
 * Cache search result
 */
interface CacheSearchResult {
  entry: SemanticCacheEntry;
  similarity: number;
  isExactMatch: boolean;
}

/**
 * Cache options
 */
export interface SemanticCacheOptions {
  enabled: boolean;
  similarityThreshold: number; // 0-1, minimum similarity for cache hit
  defaultTTLSeconds: number;
  maxEntriesPerOrg: number;
  embeddingModel?: string;
  exactMatchOnly?: boolean; // Disable semantic matching, use only exact
}

/**
 * Default configuration
 */
const DEFAULT_OPTIONS: SemanticCacheOptions = {
  enabled: true,
  similarityThreshold: 0.92, // High threshold for quality
  defaultTTLSeconds: 3600, // 1 hour
  maxEntriesPerOrg: 10000,
  exactMatchOnly: false,
};

interface CacheRow {
  id: string;
  request_hash: string;
  response: ChatResponse;
  model: string;
  organization_id: string;
  hit_count: number;
  created_at: Date;
  expires_at: Date;
  original_request: string;
  tokens_saved: number;
  cost_saved_usd: string;
  strategy_key: string;
}

function rowToEntry(row: CacheRow): SemanticCacheEntry {
  return {
    id: row.id,
    requestHash: row.request_hash,
    response: row.response,
    model: row.model,
    organizationId: row.organization_id,
    hitCount: row.hit_count,
    createdAt: row.created_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    metadata: {
      originalRequest: row.original_request,
      tokensSaved: row.tokens_saved,
      costSaved: Number(row.cost_saved_usd),
      strategyKey: row.strategy_key,
    },
  };
}

/** pgvector text-literal format. Mirrors vector-store-ingest-service.ts/embed-worker.ts. */
function vectorToPgLiteral(vec: readonly number[]): string {
  return `[${vec.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
}

/**
 * Semantic Cache Service
 */
export class SemanticCache {
  private options: SemanticCacheOptions;
  private embeddingCache: Map<string, number[]> = new Map();
  // Circuit breaker for embedding generation: a down/slow embedder (e.g. the
  // TEI sidecar being unreachable) otherwise taxes EVERY semantic lookup with
  // the full EMBED_TIMEOUT_MS wait before falling back. After repeated failures
  // we open the circuit and skip straight to the hash fallback for a TTL.
  private embedCircuitOpenUntil = 0;
  private embedConsecutiveFailures = 0;

  constructor(
    options: Partial<SemanticCacheOptions> = {},
    private readonly pool: Pool = getCapabilityPool(),
    private readonly embedder: CapabilityEmbedder = getCapabilityEmbedder(),
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Check if request is enabled
   */
  isEnabled(): boolean {
    return this.options.enabled;
  }

  /**
   * Look up cache for a request
   */
  async lookup(params: {
    request: ChatRequest;
    organizationId: string;
  }): Promise<CacheSearchResult | null> {
    if (!this.options.enabled) {
      return null;
    }

    const { request, organizationId } = params;
    const startTime = Date.now();

    try {
      const strategyKey = this.getStrategyKey(request);
      const requestHash = this.generateRequestHash(request);

      // Try exact match first (fastest) — plain indexed equality lookup.
      const exactMatch = await this.lookupExact(requestHash, organizationId);
      if (exactMatch) {
        log.debug(
          { organizationId, lookupMs: Date.now() - startTime },
          'Semantic cache exact hit'
        );
        return {
          entry: exactMatch,
          similarity: 1.0,
          isExactMatch: true,
        };
      }

      if (this.options.exactMatchOnly) {
        return null;
      }

      const requestText = this.extractRequestText(request);
      const embeddingResult = await this.generateEmbedding(requestText);
      if (embeddingResult.source !== 'provider') {
        log.debug(
          { organizationId },
          'Semantic cache lookup skipped due to fallback embedding'
        );
        return null;
      }

      // ANN search — HNSW-backed, sub-linear (replaces the prior O(N) scan).
      const similar = await this.searchSimilar(
        embeddingResult.embedding,
        organizationId,
        strategyKey
      );

      if (similar && similar.similarity >= this.options.similarityThreshold) {
        log.debug(
          {
            organizationId,
            similarity: similar.similarity,
            lookupMs: Date.now() - startTime,
          },
          'Semantic cache similar hit'
        );
        return similar;
      }

      log.debug(
        { organizationId, lookupMs: Date.now() - startTime },
        'Semantic cache miss'
      );
      return null;
    } catch (error) {
      log.warn(
        { error: getErrorMessage(error) },
        'Semantic cache lookup failed'
      );
      return null;
    }
  }

  /**
   * Store response in cache
   */
  async store(params: {
    request: ChatRequest;
    response: ChatResponse;
    organizationId: string;
    ttlSeconds?: number;
    metadata?: {
      tokensSaved?: number;
      costSaved?: number;
    };
  }): Promise<string | null> {
    if (!this.options.enabled) {
      return null;
    }

    const { request, response, organizationId, ttlSeconds, metadata } = params;

    try {
      const requestHash = this.generateRequestHash(request);
      const strategyKey = this.getStrategyKey(request);
      const requestText = this.extractRequestText(request);
      const embeddingResult = await this.generateEmbedding(requestText);

      const id = `sc_${nanoid(16)}`;
      const now = new Date();
      const ttl = ttlSeconds || this.options.defaultTTLSeconds;
      const expiresAt = new Date(now.getTime() + ttl * 1000);

      await this.pool.query(
        `INSERT INTO semantic_cache_entries
           (id, organization_id, request_hash, strategy_key, model, embedding,
            embedding_model, original_request, response, tokens_saved,
            cost_saved_usd, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9::jsonb, $10, $11, $12, $13);`,
        [
          id,
          organizationId,
          requestHash,
          strategyKey,
          request.model || 'auto',
          // NULL (not a hash-based sentinel) when only the fallback
          // "embedding" was available — keeps the HNSW index meaningful,
          // since a fallback vector isn't semantically comparable.
          embeddingResult.source === 'provider' ? vectorToPgLiteral(embeddingResult.embedding) : null,
          embeddingResult.source === 'provider' ? this.embedder.id : null,
          requestText.substring(0, 500),
          JSON.stringify(response),
          metadata?.tokensSaved || 0,
          metadata?.costSaved || 0,
          now,
          expiresAt,
        ],
      );

      log.debug({ id, organizationId, ttl }, 'Stored in semantic cache');

      return id;
    } catch (error) {
      log.warn(
        { error: getErrorMessage(error) },
        'Semantic cache store failed'
      );
      return null;
    }
  }

  /**
   * Invalidate cache entries
   */
  async invalidate(params: {
    organizationId: string;
    pattern?: string; // Optional: invalidate only matching patterns
  }): Promise<number> {
    const { organizationId, pattern } = params;

    try {
      const result = pattern
        ? await this.pool.query(
            `DELETE FROM semantic_cache_entries WHERE organization_id = $1 AND original_request LIKE $2;`,
            [organizationId, `%${pattern}%`],
          )
        : await this.pool.query(
            `DELETE FROM semantic_cache_entries WHERE organization_id = $1;`,
            [organizationId],
          );

      const invalidated = result.rowCount ?? 0;
      log.info({ organizationId, invalidated, pattern }, 'Cache entries invalidated');
      return invalidated;
    } catch (error) {
      log.warn({ error: getErrorMessage(error) }, 'Cache invalidation failed');
      return 0;
    }
  }

  /**
   * Get cache statistics — single aggregate query, not a per-entry fetch loop.
   */
  async getStats(organizationId: string): Promise<{
    totalEntries: number;
    totalHits: number;
    estimatedCostSaved: number;
    oldestEntry: number | null;
    newestEntry: number | null;
  }> {
    try {
      const { rows } = await this.pool.query<{
        total_entries: string;
        total_hits: string | null;
        estimated_cost_saved: string | null;
        oldest_entry: Date | null;
        newest_entry: Date | null;
      }>(
        `SELECT
           COUNT(*)                                   AS total_entries,
           COALESCE(SUM(hit_count), 0)                AS total_hits,
           COALESCE(SUM(cost_saved_usd * hit_count), 0) AS estimated_cost_saved,
           MIN(created_at)                            AS oldest_entry,
           MAX(created_at)                            AS newest_entry
         FROM semantic_cache_entries
         WHERE organization_id = $1;`,
        [organizationId],
      );

      const row = rows[0];
      return {
        totalEntries: row ? Number(row.total_entries) : 0,
        totalHits: row?.total_hits ? Number(row.total_hits) : 0,
        estimatedCostSaved: row?.estimated_cost_saved ? Number(row.estimated_cost_saved) : 0,
        oldestEntry: row?.oldest_entry ? row.oldest_entry.getTime() : null,
        newestEntry: row?.newest_entry ? row.newest_entry.getTime() : null,
      };
    } catch (error) {
      log.warn({ error: getErrorMessage(error) }, 'Failed to get cache stats');
      return {
        totalEntries: 0,
        totalHits: 0,
        estimatedCostSaved: 0,
        oldestEntry: null,
        newestEntry: null,
      };
    }
  }

  /**
   * Record a cache hit (atomic increment — single UPDATE, no read-modify-write).
   */
  async recordHit(entryId: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE semantic_cache_entries SET hit_count = hit_count + 1 WHERE id = $1;`,
        [entryId],
      );
    } catch (error) {
      log.warn({ error: getErrorMessage(error) }, 'Failed to record cache hit');
    }
  }

  /**
   * Sweep expired entries. Postgres has no native per-row TTL (unlike Redis);
   * expired rows are already excluded from lookups (expires_at filters), this
   * just reclaims storage. Intended to be called periodically by a scheduled
   * job (not wired to one yet — follow-up, matches this repo's existing
   * context-cache-cleanup-job.ts pattern for a similar TTL'd table).
   */
  async cleanupExpired(): Promise<number> {
    try {
      const result = await this.pool.query(`DELETE FROM semantic_cache_entries WHERE expires_at <= NOW();`);
      const deleted = result.rowCount ?? 0;
      if (deleted > 0) {
        log.info({ deleted }, 'Swept expired semantic cache entries');
      }
      return deleted;
    } catch (error) {
      log.warn({ error: getErrorMessage(error) }, 'Semantic cache cleanup failed');
      return 0;
    }
  }

  /**
   * Look up exact match by hash — plain indexed equality lookup.
   */
  private async lookupExact(
    requestHash: string,
    organizationId: string
  ): Promise<SemanticCacheEntry | null> {
    try {
      const { rows } = await this.pool.query<CacheRow>(
        `SELECT * FROM semantic_cache_entries
         WHERE organization_id = $1 AND request_hash = $2 AND expires_at > NOW()
         LIMIT 1;`,
        [organizationId, requestHash],
      );
      return rows[0] ? rowToEntry(rows[0]) : null;
    } catch (error) {
      log.warn({ error: getErrorMessage(error) }, 'Exact lookup failed');
      return null;
    }
  }

  /**
   * ANN search for the single best similar entry — HNSW-backed cosine kNN,
   * scoped to (organization, strategyKey, not expired, has an embedding).
   * Sub-linear via the index instead of scanning every candidate row.
   */
  private async searchSimilar(
    embedding: number[],
    organizationId: string,
    strategyKey: string
  ): Promise<CacheSearchResult | null> {
    try {
      const { rows } = await this.pool.query<CacheRow & { score: number }>(
        `SELECT *, (1 - (embedding <=> $1::vector)) AS score
         FROM semantic_cache_entries
         WHERE organization_id = $2
           AND strategy_key = $3
           AND expires_at > NOW()
           AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT 1;`,
        [vectorToPgLiteral(embedding), organizationId, strategyKey],
      );

      const row = rows[0];
      if (!row) return null;

      return {
        entry: rowToEntry(row),
        similarity: Number(row.score),
        isExactMatch: false,
      };
    } catch (error) {
      log.warn({ error: getErrorMessage(error) }, 'Similar search failed');
      return null;
    }
  }

  /**
   * Generate hash for exact matching
   */
  private generateRequestHash(request: ChatRequest): string {
    const hashInput = JSON.stringify({
      model: request.model,
      strategy: this.getStrategyKey(request),
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.top_p,
      max_tokens: request.max_tokens,
      tools: request.tools,
      tool_choice: request.tool_choice,
      response_format: request.response_format,
      quality_target: request.quality_target,
      max_cost: request.max_cost,
      task_type: request.task_type,
      webSearch: request.webSearch,
      webSearchOptions: request.webSearchOptions,
    });

    // Simple hash function
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      const char = hashInput.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    return hash.toString(16);
  }

  /**
   * Extract text from request for embedding
   */
  private extractRequestText(request: ChatRequest): string {
    const parts: string[] = [`strategy:${this.getStrategyKey(request)}`];

    for (const message of request.messages || []) {
      if (message.role === 'user' || message.role === 'system') {
        const content = typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content);
        parts.push(content);
      }
    }

    return parts.join('\n').substring(0, 2000);
  }

  private getStrategyKey(request: ChatRequest): string {
    if (typeof request.strategy !== 'string') {
      return 'dynamic';
    }
    return canonicalizeStrategyInput(request.strategy) || request.strategy;
  }

  /**
   * Generate embedding for text — via the shared 384-dim capability embedder.
   */
  private async generateEmbedding(text: string): Promise<{
    embedding: number[];
    source: 'provider' | 'fallback';
  }> {
    // Check in-memory cache
    const cacheKey = this.getEmbeddingCacheKey(text);
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) {
      return {
        embedding: cached,
        source: 'provider',
      };
    }

    // Circuit breaker: skip the (up to EMBED_TIMEOUT_MS) embedder attempt while
    // it's known to be failing, so a down/slow embedder does not tax every
    // request. Re-probe automatically after the TTL.
    if (Date.now() < this.embedCircuitOpenUntil) {
      return { embedding: this.generateFallbackEmbedding(text), source: 'fallback' };
    }

    try {
      // C3 latency fix (2026-06-11): hard 500ms cap on embedding generation so a slow or failing
      // embedder can never block the request hot path.
      const EMBED_TIMEOUT_MS = 500;
      const result = await Promise.race([
        this.embedder.embed(text),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Embedding generation timeout (${EMBED_TIMEOUT_MS}ms)`)),
            EMBED_TIMEOUT_MS
          )
        ),
      ]);

      if (!result.vector || result.vector.length !== EMBEDDING_DIM) {
        throw new Error(`Embedder returned dim ${result.vector?.length ?? 0}, expected ${EMBEDDING_DIM}`);
      }

      this.embeddingCache.set(cacheKey, result.vector);

      // Limit cache size
      if (this.embeddingCache.size > 500) {
        const firstKey = this.embeddingCache.keys().next().value;
        if (firstKey) this.embeddingCache.delete(firstKey);
      }

      this.embedConsecutiveFailures = 0;
      return {
        embedding: result.vector,
        source: 'provider',
      };
    } catch (error) {
      this.embedConsecutiveFailures += 1;
      if (this.embedConsecutiveFailures >= 3 && this.embedCircuitOpenUntil <= Date.now()) {
        this.embedCircuitOpenUntil = Date.now() + 60_000;
        log.warn(
          { consecutiveFailures: this.embedConsecutiveFailures },
          'Embedding circuit opened for 60s — using hash fallback, will re-probe'
        );
      }
      log.warn(
        { error: getErrorMessage(error) },
        'Embedding generation failed, using fallback'
      );

      return {
        embedding: this.generateFallbackEmbedding(text),
        source: 'fallback',
      };
    }
  }

  /**
   * Generate cache key for embedding vectors.
   * Use a full-text hash to avoid prefix collisions for long prompts.
   */
  private getEmbeddingCacheKey(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  /**
   * Generate fallback embedding (simple hash-based). Never stored/searched
   * via pgvector (see store()) — used only so a lookup during an embedder
   * outage safely misses instead of throwing.
   */
  private generateFallbackEmbedding(text: string): number[] {
    const embedding = new Array<number>(EMBEDDING_DIM).fill(0);

    for (let i = 0; i < text.length; i++) {
      const idx = i % EMBEDDING_DIM;
      embedding[idx] = (embedding[idx] + text.charCodeAt(i)) % 1000 / 1000;
    }

    return embedding;
  }
}

/**
 * Singleton instance
 */
let semanticCacheInstance: SemanticCache | null = null;

/**
 * Get semantic cache instance
 */
export function getSemanticCache(): SemanticCache {
  if (!semanticCacheInstance) {
    semanticCacheInstance = new SemanticCache();
  }
  return semanticCacheInstance;
}
