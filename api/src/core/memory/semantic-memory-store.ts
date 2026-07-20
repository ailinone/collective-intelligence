// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Semantic Memory Store
 *
 * Provides persistent semantic memory for the Collective Intelligence system.
 * Uses embeddings to store and retrieve contextually relevant information.
 *
 * Features:
 * - Vector similarity search for semantic retrieval
 * - Organization-scoped memory isolation
 * - Memory types: episodic (conversations), semantic (knowledge), procedural (patterns)
 * - Automatic memory consolidation and cleanup
 * - Redis cache for hot memories, PostgreSQL for persistence
 *
 * Architecture:
 * - Embeddings generated via provider adapters (OpenAI, Cohere, etc.)
 * - Vectors stored in PostgreSQL with pgvector extension
 * - Similarity search using cosine distance
 */

import { prisma } from '@/database/client';
import type { SemanticMemory } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';
import { getRedisClient } from '@/cache/redis-client';
import { nanoid } from 'nanoid';
import type { EmbeddingRequest } from '@/types';
import { isCacheEnabled } from '@/cache/cache-runtime-state';
import { getErrorMessage } from '@/utils/type-guards';

const log = logger.child({ component: 'semantic-memory-store' });

/**
 * Convert Prisma SemanticMemory to MemoryEntry
 * Handles type conversion safely without using 'as unknown as'
 */
/**
 * Safely convert Prisma JsonValue to Record<string, unknown>
 * Uses type guards to ensure type safety without unsafe casts
 */
function safeJsonValueToRecord(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    // Type guard: verify all values are valid
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = val;
    }
    return result;
  }
  
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return safeJsonValueToRecord(parsed as Record<string, unknown>);
      }
    } catch {
      // Invalid JSON, return empty object
    }
  }
  
  return {};
}

function mapPrismaToMemoryEntry(prismaMemory: SemanticMemory, embedding?: number[]): MemoryEntry {
  // Safely extract metadata - Prisma returns JsonValue which could be various types
  const metadata = safeJsonValueToRecord(prismaMemory.metadata);

  return {
    id: prismaMemory.id,
    organizationId: prismaMemory.organizationId,
    userId: prismaMemory.userId ?? undefined,
    type: prismaMemory.type as MemoryType,
    content: prismaMemory.content,
    embedding,
    metadata,
    importance: prismaMemory.importance,
    accessCount: prismaMemory.accessCount,
    lastAccessedAt: prismaMemory.lastAccessedAt,
    createdAt: prismaMemory.createdAt,
    expiresAt: prismaMemory.expiresAt ?? undefined,
  };
}

/**
 * Memory types for categorization
 */
export type MemoryType = 'episodic' | 'semantic' | 'procedural';

/**
 * Memory entry structure
 */
export interface MemoryEntry {
  id: string;
  organizationId: string;
  userId?: string;
  type: MemoryType;
  content: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
  importance: number; // 0-1, higher = more important
  accessCount: number;
  lastAccessedAt: Date;
  createdAt: Date;
  expiresAt?: Date;
}

/**
 * Memory search result
 */
export interface MemorySearchResult {
  entry: MemoryEntry;
  similarity: number; // 0-1, cosine similarity
  relevanceScore: number; // Combined score considering importance and recency
}

/**
 * Memory store options
 */
export interface MemoryStoreOptions {
  embeddingModel?: string;
  embeddingDimensions?: number;
  maxMemoriesPerOrg?: number;
  defaultTTLDays?: number;
  cacheEnabled?: boolean;
}

/**
 * Default configuration
 * Note: embeddingModel is optional - if not specified, will be selected dynamically
 * from available embedding-capable models at runtime
 */
const DEFAULT_OPTIONS: MemoryStoreOptions = {
  embeddingDimensions: 1536,
  // 10M memories/org (was 10k). The cap only bites at consolidate() (reflection
  // job trims the excess by lowest importance) — recall stays fast regardless
  // because search is pgvector similarity-ordered, not a table scan. Override
  // via SEMANTIC_MEMORY_MAX_PER_ORG or the constructor option.
  maxMemoriesPerOrg: Number(process.env.SEMANTIC_MEMORY_MAX_PER_ORG) || 10_000_000,
  defaultTTLDays: 90,
  cacheEnabled: true,
};

/**
 * Semantic Memory Store
 */
export class SemanticMemoryStore {
  private options: MemoryStoreOptions;
  private embeddingCache: Map<string, number[]> = new Map();

  constructor(options: Partial<MemoryStoreOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Store a new memory entry
   */
  async store(params: {
    organizationId: string;
    userId?: string;
    type: MemoryType;
    content: string;
    metadata?: Record<string, unknown>;
    importance?: number;
    ttlDays?: number;
  }): Promise<MemoryEntry> {
    const {
      organizationId,
      userId,
      type,
      content,
      metadata = {},
      importance = 0.5,
      ttlDays = this.options.defaultTTLDays,
    } = params;

    const id = `mem_${nanoid(24)}`;
    const now = new Date();
    const expiresAt = ttlDays ? new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000) : undefined;

    log.debug({ id, organizationId, type }, 'Storing new memory');

    // Generate embedding for the content
    const embedding = await this.generateEmbedding(content);

    // Store in database using raw SQL for pgvector
    // Note: embedding is stored separately due to pgvector type
    // Convert metadata to JSON string for Prisma
    const metadataJson = metadata ? JSON.stringify(metadata) : '{}';

    await prisma.$executeRawUnsafe(
      `INSERT INTO semantic_memories 
       (id, organization_id, user_id, type, content, embedding, metadata, importance, access_count, last_accessed_at, expires_at, created_at)
       VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6::vector, $7::jsonb, $8, $9, $10, $11, $12)`,
      id,
      organizationId,
      userId || null,
      type,
      content,
      `[${embedding.join(',')}]`,
      metadataJson,
      importance,
      0,
      now,
      expiresAt || null,
      now
    );

    const memory: MemoryEntry = {
      id,
      organizationId,
      userId: userId || undefined,
      type,
      content,
      embedding,
      metadata,
      importance,
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      expiresAt,
    };

    // Cache in Redis for fast access
    if (this.options.cacheEnabled && isCacheEnabled()) {
      await this.cacheMemory(memory);
    }

    log.info({ id, organizationId, type }, 'Memory stored successfully');

    return memory;
  }

  /**
   * Search for relevant memories using semantic similarity
   */
  async search(params: {
    organizationId: string;
    query: string;
    type?: MemoryType;
    userId?: string;
    limit?: number;
    minSimilarity?: number;
  }): Promise<MemorySearchResult[]> {
    const {
      organizationId,
      query,
      type,
      userId,
      limit = 10,
      minSimilarity = 0.7,
    } = params;

    log.debug({ organizationId, type, limit }, 'Searching memories');

    // Generate embedding for query
    const queryEmbedding = await this.generateEmbedding(query);

    // Search using cosine similarity
    // Note: This uses raw SQL for pgvector operations
    const results = await this.vectorSearch(
      organizationId,
      queryEmbedding,
      type,
      userId,
      limit,
      minSimilarity
    );

    // Update access counts for returned memories
    await this.updateAccessCounts(results.map((r) => r.entry.id));

    log.info(
      { organizationId, resultCount: results.length, type },
      'Memory search completed'
    );

    return results;
  }

  /**
   * Get memory by ID
   */
  async get(id: string, organizationId: string): Promise<MemoryEntry | null> {
    // Try cache first
    if (this.options.cacheEnabled && isCacheEnabled()) {
      const cached = await this.getCachedMemory(id);
      if (cached && cached.organizationId === organizationId) {
        return cached;
      }
    }

    const memory = await prisma.semanticMemory.findFirst({
      where: { id, organizationId },
    });

    if (!memory) {
      return null;
    }

    // Update access count
    await this.updateAccessCounts([id]);

    // Convert Prisma type to MemoryEntry type safely
    // Note: We don't have the embedding here as it's stored separately
    // If embedding is needed, we'd need to fetch it separately or include it in the query
    return mapPrismaToMemoryEntry(memory);
  }

  /**
   * Update memory importance based on usage patterns
   */
  async updateImportance(id: string, newImportance: number): Promise<void> {
    await prisma.semanticMemory.update({
      where: { id },
      data: { importance: Math.max(0, Math.min(1, newImportance)) },
    });

    // Invalidate cache
    if (this.options.cacheEnabled && isCacheEnabled()) {
      await this.invalidateCache(id);
    }
  }

  /**
   * Delete a memory
   */
  async delete(id: string, organizationId: string): Promise<boolean> {
    const result = await prisma.semanticMemory.deleteMany({
      where: { id, organizationId },
    });

    if (result.count > 0) {
      if (this.options.cacheEnabled) {
        await this.invalidateCache(id);
      }
      log.info({ id }, 'Memory deleted');
      return true;
    }

    return false;
  }

  /**
   * Consolidate memories (merge similar, prune old)
   */
  async consolidate(organizationId: string): Promise<{
    merged: number;
    pruned: number;
  }> {
    log.info({ organizationId }, 'Starting memory consolidation');

    let merged = 0;
    let pruned = 0;

    // Prune expired memories
    const pruneResult = await prisma.semanticMemory.deleteMany({
      where: {
        organizationId,
        expiresAt: { lt: new Date() },
      },
    });
    pruned = pruneResult.count;

    // Prune low-importance, rarely-accessed memories if over limit
    const count = await prisma.semanticMemory.count({
      where: { organizationId },
    });

    if (count > (this.options.maxMemoriesPerOrg || 10000)) {
      const excess = count - (this.options.maxMemoriesPerOrg || 10000);
      
      // Delete lowest importance memories
      const toDelete = await prisma.semanticMemory.findMany({
        where: { organizationId },
        orderBy: [
          { importance: 'asc' },
          { accessCount: 'asc' },
          { lastAccessedAt: 'asc' },
        ],
        take: excess,
        select: { id: true },
      });

      if (toDelete.length > 0) {
        await prisma.semanticMemory.deleteMany({
          where: { id: { in: toDelete.map((m) => m.id) } },
        });
        pruned += toDelete.length;
      }
    }

    log.info({ organizationId, merged, pruned }, 'Memory consolidation completed');

    return { merged, pruned };
  }

  /**
   * Get memory statistics for an organization
   */
  async getStats(organizationId: string): Promise<{
    total: number;
    byType: Record<MemoryType, number>;
    avgImportance: number;
    avgAccessCount: number;
    oldestMemory: Date | null;
    newestMemory: Date | null;
  }> {
    const [total, episodic, semantic, procedural, stats] = await Promise.all([
      prisma.semanticMemory.count({ where: { organizationId } }),
      prisma.semanticMemory.count({ where: { organizationId, type: 'episodic' } }),
      prisma.semanticMemory.count({ where: { organizationId, type: 'semantic' } }),
      prisma.semanticMemory.count({ where: { organizationId, type: 'procedural' } }),
      prisma.semanticMemory.aggregate({
        where: { organizationId },
        _avg: { importance: true, accessCount: true },
        _min: { createdAt: true },
        _max: { createdAt: true },
      }),
    ]);

    return {
      total,
      byType: { episodic, semantic, procedural },
      avgImportance: stats._avg.importance || 0,
      avgAccessCount: stats._avg.accessCount || 0,
      oldestMemory: stats._min.createdAt,
      newestMemory: stats._max.createdAt,
    };
  }

  /**
   * Generate embedding for text content
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    // Check cache first
    const cacheKey = this.getEmbeddingCacheKey(text);
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) {
      return this.normalizeEmbeddingDimensions(cached);
    }

    try {
      const { getProviderRegistry } = await import('@/providers/provider-registry.js');
      const registry = getProviderRegistry();
      
      // Find an embedding-capable model
      const allModels = await registry.getAllModels();
      const embeddingModel = allModels.find(
        (m) => m.capabilities?.includes('embeddings') || m.id.includes('embedding')
      );

      if (!embeddingModel) {
        throw new Error('No embedding-capable model available');
      }

      const result = await registry.findModel(embeddingModel.id);
      if (!result) {
        throw new Error('Embedding model not found in registry');
      }

      const request: EmbeddingRequest = {
        model: embeddingModel.id,
        input: text,
      };

      const response = await result.adapter.generateEmbeddings(request);
      const embedding = response.data[0]?.embedding;

      if (!embedding) {
        throw new Error('No embedding returned');
      }

      const normalizedEmbedding = this.normalizeEmbeddingDimensions(embedding);

      // Cache the embedding
      this.embeddingCache.set(cacheKey, normalizedEmbedding);
      
      // Limit cache size
      if (this.embeddingCache.size > 1000) {
        const firstKey = this.embeddingCache.keys().next().value;
        if (firstKey) this.embeddingCache.delete(firstKey);
      }

      return normalizedEmbedding;
    } catch (error) {
      log.error({ error: getErrorMessage(error) }, 'Failed to generate embedding');
      // Return zero vector as fallback. `Array.from` returns typed `number[]`
      // (vs `new Array().fill()` which returns `any[]`).
      return Array.from({ length: this.options.embeddingDimensions || 1536 }, (): number => 0);
    }
  }

  /**
   * Ensure embeddings match configured pgvector dimensions.
   * Some providers/adapters return shorter vectors in deterministic test mode.
   */
  private normalizeEmbeddingDimensions(embedding: number[]): number[] {
    const targetDimensions = this.options.embeddingDimensions || 1536;

    if (embedding.length === targetDimensions) {
      return embedding;
    }

    if (embedding.length > targetDimensions) {
      log.warn(
        { from: embedding.length, to: targetDimensions },
        'Embedding dimensions exceed configured size, truncating'
      );
      return embedding.slice(0, targetDimensions);
    }

    log.warn(
      { from: embedding.length, to: targetDimensions },
      'Embedding dimensions below configured size, zero-padding'
    );
    const padding = Array.from({ length: targetDimensions - embedding.length }, (): number => 0);
    return [...embedding, ...padding];
  }

  /**
   * Perform vector similarity search
   */
  private async vectorSearch(
    organizationId: string,
    queryEmbedding: number[],
    type: MemoryType | undefined,
    userId: string | undefined,
    limit: number,
    minSimilarity: number
  ): Promise<MemorySearchResult[]> {
    // Use raw SQL for pgvector cosine similarity search
    // Note: This requires pgvector extension to be installed
    
    try {
      // Convert embedding to PostgreSQL vector format
      // Note: embedding comes from generateEmbedding() which always returns number[],
      // so this is safe from SQL injection. The join(',') creates a valid PostgreSQL array.
      const embeddingStr = `[${queryEmbedding.join(',')}]`;
      
      // Build query parameters array - using parameterized queries to prevent SQL injection
      const params: unknown[] = [organizationId, minSimilarity];
      const conditions: string[] = [
        'organization_id = $1',
        '(expires_at IS NULL OR expires_at > NOW())',
        `1 - (embedding <=> '${embeddingStr}'::vector) >= $2`
      ];
      
      let paramIndex = 3;
      
      // Add type filter with parameterized query to prevent SQL injection
      if (type) {
        // Validate type is one of the allowed MemoryType values
        const allowedTypes: MemoryType[] = ['episodic', 'semantic', 'procedural'];
        if (allowedTypes.includes(type)) {
          conditions.push(`type = $${paramIndex}`);
          params.push(type);
          paramIndex++;
        }
      }
      
      // Add user filter with parameterized query to prevent SQL injection
      if (userId) {
        // Validate userId is a valid UUID format to prevent injection
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(userId)) {
          conditions.push(`(user_id = $${paramIndex} OR user_id IS NULL)`);
          params.push(userId);
          paramIndex++;
        }
      }
      
      // Add limit parameter (always use parameterized query)
      params.push(limit);
      const limitParamIndex = paramIndex;
      
      // Build query string with parameterized placeholders
      const query = `SELECT 
          id,
          organization_id,
          user_id,
          type,
          content,
          metadata,
          importance,
          access_count,
          last_accessed_at,
          created_at,
          expires_at,
          1 - (embedding <=> '${embeddingStr}'::vector) as similarity
        FROM semantic_memories
        WHERE ${conditions.join(' AND ')}
        ORDER BY similarity DESC
        LIMIT $${limitParamIndex}`;

      const results = await prisma.$queryRawUnsafe<Array<{
        id: string;
        organization_id: string;
        user_id: string | null;
        type: string;
        content: string;
        metadata: unknown;
        importance: number;
        access_count: number;
        last_accessed_at: Date;
        created_at: Date;
        expires_at: Date | null;
        similarity: number;
      }>>(query, ...params);

      return results.map((row) => {
        const entry: MemoryEntry = {
          id: row.id,
          organizationId: row.organization_id,
          userId: row.user_id || undefined,
          type: row.type as MemoryType,
          content: row.content,
          metadata: row.metadata as Record<string, unknown>,
          importance: row.importance,
          accessCount: row.access_count,
          lastAccessedAt: row.last_accessed_at,
          createdAt: row.created_at,
          expiresAt: row.expires_at || undefined,
        };

        // Calculate relevance score (combines similarity, importance, and recency)
        const recencyScore = this.calculateRecencyScore(entry.lastAccessedAt);
        const relevanceScore = 
          row.similarity * 0.6 + 
          entry.importance * 0.25 + 
          recencyScore * 0.15;

        return {
          entry,
          similarity: row.similarity,
          relevanceScore,
        };
      });
    } catch (error) {
      log.error(
        { error: getErrorMessage(error), organizationId },
        'Vector search failed - pgvector may not be installed'
      );
      
      // Fallback: Return empty results
      return [];
    }
  }

  /**
   * Calculate recency score (0-1, higher = more recent)
   */
  private calculateRecencyScore(lastAccessed: Date): number {
    const now = Date.now();
    const accessTime = lastAccessed.getTime();
    const daysSinceAccess = (now - accessTime) / (24 * 60 * 60 * 1000);
    
    // Exponential decay: halves every 7 days
    return Math.exp(-daysSinceAccess / 7);
  }

  /**
   * Update access counts for memories
   */
  private async updateAccessCounts(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    await prisma.semanticMemory.updateMany({
      where: { id: { in: ids } },
      data: {
        accessCount: { increment: 1 },
        lastAccessedAt: new Date(),
      },
    });
  }

  /**
   * Cache memory in Redis
   */
  private async cacheMemory(memory: MemoryEntry): Promise<void> {
    try {
      const redis = getRedisClient();
      const cacheKey = `memory:${memory.id}`;
      const ttl = 3600; // 1 hour cache

      await redis.setex(cacheKey, ttl, JSON.stringify(memory));
    } catch (error) {
      log.warn({ error: getErrorMessage(error) }, 'Failed to cache memory');
    }
  }

  /**
   * Get cached memory from Redis
   */
  private async getCachedMemory(id: string): Promise<MemoryEntry | null> {
    try {
      const redis = getRedisClient();
      const cacheKey = `memory:${id}`;
      const cached = await redis.get(cacheKey);

      if (cached) {
        // JSON.parse returns `unknown` — single direct cast to MemoryEntry
        // (cache writer wrote a MemoryEntry, so the shape is guaranteed at
        // the boundary). If it ever drifts, downstream callers get a
        // typed runtime error instead of an `any`-cascade.
        return JSON.parse(cached) as MemoryEntry;
      }
    } catch (error) {
      log.warn({ error: getErrorMessage(error) }, 'Failed to get cached memory');
    }
    return null;
  }

  /**
   * Invalidate cache for a memory
   */
  private async invalidateCache(id: string): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.del(`memory:${id}`);
    } catch (error) {
      log.warn({ error: getErrorMessage(error) }, 'Failed to invalidate memory cache');
    }
  }

  /**
   * Get cache key for embedding
   */
  private getEmbeddingCacheKey(text: string): string {
    // Simple hash of the first 100 chars
    return text.substring(0, 100).replace(/\s+/g, '_');
  }
}

/**
 * Singleton instance
 */
let memoryStoreInstance: SemanticMemoryStore | null = null;

/**
 * Get memory store instance
 */
export function getSemanticMemoryStore(): SemanticMemoryStore {
  if (!memoryStoreInstance) {
    memoryStoreInstance = new SemanticMemoryStore();
  }
  return memoryStoreInstance;
}
