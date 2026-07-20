// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Context Caching Service
 * Implements prompt/context caching compatible with Claude and Gemini APIs
 *
 * Features:
 * - Long context caching (up to 1M tokens)
 * - Configurable TTL (5min, 1h, 24h)
 * - Multi-tier storage (Redis + Database)
 * - Token counting and cost estimation
 * - Organization-scoped caching
 *
 * NO HARDCODED MODELS - All caching is model-agnostic
 * NO MOCKS/STUBS - Real implementation with Redis + PostgreSQL
 */

import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import type { Redis } from 'ioredis';
import { serializeError } from '@/utils/type-guards';
import { getRedisClient } from '@/cache/redis-client';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import {
  contextCacheHits,
  contextCacheMisses,
  contextCacheCreated,
  contextCacheTokens,
} from '@/utils/metrics';
import type { ChatMessage, OrchestrationContext } from '@/types';

const log = logger.child({ service: 'context-caching' });

// ============================================
// Types
// ============================================

export type CacheTTL = '5min' | '1h' | '24h';

export interface CachedContext {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  messages: ChatMessage[];
  tokenCount: number;
  hash: string;
  ttl: CacheTTL;
  createdAt: Date;
  expiresAt: Date;
  lastAccessedAt: Date;
  accessCount: number;
  metadata: Record<string, string>;
}

export interface CreateCachedContextParams {
  name: string;
  messages: ChatMessage[];
  ttl?: CacheTTL;
  metadata?: Record<string, string>;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface CreateCachedContextResult {
  id: string;
  name: string;
  tokenCount: number;
  ttl: CacheTTL;
  expiresAt: string;
  hash: string;
}

export interface GetCachedContextParams {
  contextId: string;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface ListCachedContextsParams {
  limit?: number;
  offset?: number;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface ListCachedContextsResult {
  contexts: Array<{
    id: string;
    name: string;
    tokenCount: number;
    ttl: CacheTTL;
    createdAt: string;
    expiresAt: string;
    lastAccessedAt: string;
    accessCount: number;
  }>;
  total: number;
  hasMore: boolean;
}

export interface DeleteCachedContextParams {
  contextId: string;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface DeleteCachedContextResult {
  id: string;
  deleted: boolean;
}

export interface UseCachedContextParams {
  contextId: string;
  additionalMessages?: ChatMessage[];
  userContext: OrchestrationContext;
  requestId: string;
}

export interface UseCachedContextResult {
  messages: ChatMessage[];
  cachedTokenCount: number;
  totalTokenCount: number;
  cacheHit: boolean;
}

// ============================================
// Constants
// ============================================

const TTL_SECONDS: Record<CacheTTL, number> = {
  '5min': 5 * 60,
  '1h': 60 * 60,
  '24h': 24 * 60 * 60,
};

const REDIS_KEY_PREFIX = 'context-cache';
const MAX_CONTEXT_SIZE_TOKENS = 1_000_000; // 1M tokens max

// ============================================
// Service Implementation
// ============================================

export class ContextCachingService {
  private redis: Redis;

  constructor() {
    this.redis = getRedisClient();
  }

  /**
   * Create a new cached context
   * Stores in Redis (hot cache) and PostgreSQL (persistent)
   */
  async createCachedContext(
    params: CreateCachedContextParams
  ): Promise<CreateCachedContextResult> {
    const { name, messages, ttl = '1h', metadata = {}, userContext, requestId } = params;

    const organizationId = userContext.organizationId;
    const userId = userContext.userId;

    if (!organizationId || !userId) {
      throw new Error('Organization ID and User ID are required for context caching');
    }

    // Estimate token count (simple approximation: ~4 chars per token)
    const tokenCount = this.estimateTokenCount(messages);

    if (tokenCount > MAX_CONTEXT_SIZE_TOKENS) {
      throw new Error(
        `Context size (${tokenCount} tokens) exceeds maximum allowed (${MAX_CONTEXT_SIZE_TOKENS} tokens)`
      );
    }

    // Generate unique ID and content hash
    const id = `ctx_${nanoid(24)}`;
    const hash = this.generateContentHash(messages);

    // Calculate expiration
    const ttlSeconds = TTL_SECONDS[ttl];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    // Store in PostgreSQL (persistent storage)
    await prisma.cachedContext.create({
      data: {
        id,
        organizationId,
        userId,
        name,
        messages: JSON.stringify(messages),
        tokenCount,
        hash,
        ttl,
        expiresAt,
        lastAccessedAt: now,
        accessCount: 0,
        metadata: JSON.stringify(metadata),
      },
    });

    // Store in Redis (hot cache)
    const redisKey = this.buildRedisKey(organizationId, id);
    const redisValue: CachedContext = {
      id,
      organizationId,
      userId,
      name,
      messages,
      tokenCount,
      hash,
      ttl,
      createdAt: now,
      expiresAt,
      lastAccessedAt: now,
      accessCount: 0,
      metadata,
    };

    await this.redis.setex(redisKey, ttlSeconds, JSON.stringify(redisValue));

    log.info(
      {
        requestId,
        contextId: id,
        tokenCount,
        ttl,
        expiresAt: expiresAt.toISOString(),
      },
      'Created cached context'
    );

    // Record metrics
    contextCacheCreated.inc({ ttl });
    contextCacheTokens.inc({ operation: 'create' }, tokenCount);

    return {
      id,
      name,
      tokenCount,
      ttl,
      expiresAt: expiresAt.toISOString(),
      hash,
    };
  }

  /**
   * Get a cached context by ID
   * First checks Redis, then falls back to PostgreSQL
   */
  async getCachedContext(params: GetCachedContextParams): Promise<CachedContext | null> {
    const { contextId, userContext, requestId } = params;
    const organizationId = userContext.organizationId;

    if (!organizationId) {
      throw new Error('Organization ID is required');
    }

    // Try Redis first (hot cache)
    const redisKey = this.buildRedisKey(organizationId, contextId);
    const redisValue = await this.redis.get(redisKey);

    if (redisValue) {
      const cached = JSON.parse(redisValue) as CachedContext;

      // Update access stats
      cached.lastAccessedAt = new Date();
      cached.accessCount += 1;

      // Update Redis with new access time (keep same TTL)
      const remainingTtl = await this.redis.ttl(redisKey);
      if (remainingTtl > 0) {
        await this.redis.setex(redisKey, remainingTtl, JSON.stringify(cached));
      }

      // Update PostgreSQL access stats asynchronously
      this.updateAccessStats(contextId, cached.accessCount).catch((err) => {
        log.warn({ error: serializeError(err), contextId }, 'Failed to update access stats in database');
      });

      log.debug({ requestId, contextId, cacheHit: 'redis' }, 'Cache hit from Redis');
      contextCacheHits.inc({ cache_layer: 'redis', ttl: cached.ttl });
      return cached;
    }

    // Fall back to PostgreSQL
    const dbRecord = await prisma.cachedContext.findFirst({
      where: {
        id: contextId,
        organizationId,
        expiresAt: { gt: new Date() },
      },
    });

    if (!dbRecord) {
      log.debug({ requestId, contextId }, 'Cache miss - context not found or expired');
      contextCacheMisses.inc();
      return null;
    }

    // Reconstruct cached context from database
    const cached: CachedContext = {
      id: dbRecord.id,
      organizationId: dbRecord.organizationId,
      userId: dbRecord.userId,
      name: dbRecord.name,
      messages: JSON.parse(dbRecord.messages as string) as ChatMessage[],
      tokenCount: dbRecord.tokenCount,
      hash: dbRecord.hash,
      ttl: dbRecord.ttl as CacheTTL,
      createdAt: dbRecord.createdAt,
      expiresAt: dbRecord.expiresAt,
      lastAccessedAt: new Date(),
      accessCount: dbRecord.accessCount + 1,
      metadata: JSON.parse(dbRecord.metadata as string) as Record<string, string>,
    };

    // Re-populate Redis cache
    const remainingTtlMs = dbRecord.expiresAt.getTime() - Date.now();
    if (remainingTtlMs > 0) {
      const remainingTtlSeconds = Math.ceil(remainingTtlMs / 1000);
      await this.redis.setex(redisKey, remainingTtlSeconds, JSON.stringify(cached));
    }

    // Update PostgreSQL access stats
    await this.updateAccessStats(contextId, cached.accessCount);

    log.debug({ requestId, contextId, cacheHit: 'database' }, 'Cache hit from database');
    contextCacheHits.inc({ cache_layer: 'database', ttl: cached.ttl });
    return cached;
  }

  /**
   * List all cached contexts for an organization
   */
  async listCachedContexts(params: ListCachedContextsParams): Promise<ListCachedContextsResult> {
    const { limit = 20, offset = 0, userContext, requestId } = params;
    const organizationId = userContext.organizationId;

    if (!organizationId) {
      throw new Error('Organization ID is required');
    }

    const [contexts, total] = await Promise.all([
      prisma.cachedContext.findMany({
        where: {
          organizationId,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          name: true,
          tokenCount: true,
          ttl: true,
          createdAt: true,
          expiresAt: true,
          lastAccessedAt: true,
          accessCount: true,
        },
      }),
      prisma.cachedContext.count({
        where: {
          organizationId,
          expiresAt: { gt: new Date() },
        },
      }),
    ]);

    log.debug({ requestId, organizationId, count: contexts.length, total }, 'Listed cached contexts');

    return {
      contexts: contexts.map((ctx: {
        id: string;
        name: string;
        tokenCount: number;
        ttl: string;
        createdAt: Date;
        expiresAt: Date;
        lastAccessedAt: Date;
        accessCount: number;
      }) => ({
        id: ctx.id,
        name: ctx.name,
        tokenCount: ctx.tokenCount,
        ttl: ctx.ttl as CacheTTL,
        createdAt: ctx.createdAt.toISOString(),
        expiresAt: ctx.expiresAt.toISOString(),
        lastAccessedAt: ctx.lastAccessedAt.toISOString(),
        accessCount: ctx.accessCount,
      })),
      total,
      hasMore: offset + contexts.length < total,
    };
  }

  /**
   * Delete a cached context
   */
  async deleteCachedContext(params: DeleteCachedContextParams): Promise<DeleteCachedContextResult> {
    const { contextId, userContext, requestId } = params;
    const organizationId = userContext.organizationId;

    if (!organizationId) {
      throw new Error('Organization ID is required');
    }

    // Delete from Redis
    const redisKey = this.buildRedisKey(organizationId, contextId);
    await this.redis.del(redisKey);

    // Delete from PostgreSQL
    const result = await prisma.cachedContext.deleteMany({
      where: {
        id: contextId,
        organizationId,
      },
    });

    const deleted = result.count > 0;

    log.info({ requestId, contextId, deleted }, 'Deleted cached context');

    return { id: contextId, deleted };
  }

  /**
   * Use a cached context with additional messages
   * Returns the full message array with cached prefix
   */
  async useCachedContext(params: UseCachedContextParams): Promise<UseCachedContextResult> {
    const { contextId, additionalMessages = [], userContext, requestId } = params;

    const cached = await this.getCachedContext({
      contextId,
      userContext,
      requestId,
    });

    if (!cached) {
      log.warn({ requestId, contextId }, 'Attempted to use non-existent cached context');
      return {
        messages: additionalMessages,
        cachedTokenCount: 0,
        totalTokenCount: this.estimateTokenCount(additionalMessages),
        cacheHit: false,
      };
    }

    const combinedMessages = [...cached.messages, ...additionalMessages];
    const additionalTokenCount = this.estimateTokenCount(additionalMessages);

    log.info(
      {
        requestId,
        contextId,
        cachedTokenCount: cached.tokenCount,
        additionalTokenCount,
        totalTokenCount: cached.tokenCount + additionalTokenCount,
      },
      'Used cached context'
    );

    return {
      messages: combinedMessages,
      cachedTokenCount: cached.tokenCount,
      totalTokenCount: cached.tokenCount + additionalTokenCount,
      cacheHit: true,
    };
  }

  /**
   * Clean up expired contexts from PostgreSQL
   * This should be called periodically (e.g., via cron job)
   */
  async cleanupExpiredContexts(): Promise<number> {
    const result = await prisma.cachedContext.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });

    if (result.count > 0) {
      log.info({ deletedCount: result.count }, 'Cleaned up expired cached contexts');
    }

    return result.count;
  }

  // ============================================
  // Private Helpers
  // ============================================

  private buildRedisKey(organizationId: string, contextId: string): string {
    return `${REDIS_KEY_PREFIX}:${organizationId}:${contextId}`;
  }

  private generateContentHash(messages: ChatMessage[]): string {
    const content = JSON.stringify(messages);
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  private estimateTokenCount(messages: ChatMessage[]): number {
    // Approximation: ~4 characters per token for English text
    // This is a simplified estimation; production would use tiktoken or similar
    let charCount = 0;

    for (const message of messages) {
      if (typeof message.content === 'string') {
        charCount += message.content.length;
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'text') {
            charCount += part.text.length;
          }
        }
      }
      // Add overhead for role and other fields
      charCount += 10;
    }

    return Math.ceil(charCount / 4);
  }

  private async updateAccessStats(contextId: string, accessCount: number): Promise<void> {
    await prisma.cachedContext.update({
      where: { id: contextId },
      data: {
        lastAccessedAt: new Date(),
        accessCount,
      },
    });
  }
}

// Singleton instance
let contextCachingServiceInstance: ContextCachingService | null = null;

export function getContextCachingService(): ContextCachingService {
  if (!contextCachingServiceInstance) {
    contextCachingServiceInstance = new ContextCachingService();
  }
  return contextCachingServiceInstance;
}

