// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Context Caching Service Tests
 * Tests for the real implementation of context caching
 * Uses REAL Redis and Database - NO mocks
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  ContextCachingService,
  type CreateCachedContextParams,
  type GetCachedContextParams,
  type ListCachedContextsParams,
  type DeleteCachedContextParams,
  type UseCachedContextParams,
} from '@/services/context-caching-service';
import type { OrchestrationContext, ChatMessage } from '@/types';
import { prisma } from '@/database/client';
import { getRedisClient } from '@/cache/redis-client';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { initializeDIContainer, resetDIContainer } from '@/di/container';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

// NO MOCKS - Uses real Redis and Database

describe('ContextCachingService - Real Tests (NO Mocks)', () => {
  let service: ContextCachingService;
  let testOrgId: string;
  let testUserId: string;
  let userContext: OrchestrationContext;
  let redis: ReturnType<typeof getRedisClient>;

  beforeAll(async () => {
    await startTestEnvironment();
    initializeDIContainer();
    await syncDefaultRoles();

    // Create test organization
    const org = await prisma.organization.create({
      data: {
        name: `Test Org ${Date.now()}`,
        slug: `test-org-${Date.now()}`,
        tier: 'enterprise',
        status: 'active',
      },
    });
    testOrgId = org.id;

    // Create test user
    const user = await prisma.user.create({
      data: {
        email: `test-${Date.now()}@example.com`,
        name: 'Test User',
        passwordHash: '$2b$12$dummyhash',
        organizationId: testOrgId,
        role: 'developer',
        status: 'active',
      },
    });
    testUserId = user.id;

    userContext = {
      organizationId: testOrgId,
      userId: testUserId,
      tier: 'pro',
      maxTokens: 100000,
      maxCost: 10,
      rateLimit: { requests: 1000, tokens: 1000000 },
    };

    redis = getRedisClient();
  }, 60_000);

  afterAll(async () => {
    // Cleanup
    if (testOrgId) {
      await prisma.cachedContext.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
      await prisma.organization.delete({ where: { id: testOrgId } }).catch(() => {});
    }
    resetDIContainer();
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(() => {
    service = new ContextCachingService();
  });

  afterEach(async () => {
    // Clean up Redis cache keys for this org
    if (testOrgId) {
      const keys = await redis.keys(`context_cache:${testOrgId}:*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
    // Clean up DB
    if (testOrgId) {
      await prisma.cachedContext.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
    }
  });

  describe('createCachedContext', () => {
    it('should create a cached context with default TTL', async () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello, how are you?' },
      ];

      const params: CreateCachedContextParams = {
        name: 'Test Context',
        messages,
        userContext,
        requestId: `req-${Date.now()}`,
      };

      const result = await service.createCachedContext(params);

      expect(result).toBeDefined();
      expect(result.id).toMatch(/^ctx_/);
      expect(result.name).toBe('Test Context');
      expect(result.tokenCount).toBeGreaterThan(0);
      expect(result.ttl).toBe('1h');
      expect(result.hash).toHaveLength(16);
      expect(result.expiresAt).toBeDefined();
    });

    it('should create a cached context with custom TTL', async () => {
      const messages: ChatMessage[] = [{ role: 'user', content: 'Test message' }];

      const params: CreateCachedContextParams = {
        name: 'Short TTL Context',
        messages,
        ttl: '5min',
        userContext: userContext,
        requestId: 'req-124',
      };

      const result = await service.createCachedContext(params);

      expect(result.ttl).toBe('5min');
    });

    it('should create a cached context with 24h TTL', async () => {
      const messages: ChatMessage[] = [{ role: 'user', content: 'Long cache test' }];

      const params: CreateCachedContextParams = {
        name: 'Long TTL Context',
        messages,
        ttl: '24h',
        userContext,
        requestId: `req-${Date.now()}`,
      };

      const result = await service.createCachedContext(params);

      expect(result.ttl).toBe('24h');
    });

    it('should throw error when organization ID is missing', async () => {
      const invalidContext: OrchestrationContext = {
        ...userContext,
        organizationId: undefined,
      };

      const params: CreateCachedContextParams = {
        name: 'Invalid Context',
        messages: [{ role: 'user', content: 'Test' }],
        userContext: invalidContext,
        requestId: `req-${Date.now()}`,
      };

      await expect(service.createCachedContext(params)).rejects.toThrow(
        'Organization ID and User ID are required for context caching'
      );
    });

    it('should include metadata when provided', async () => {
      const messages: ChatMessage[] = [{ role: 'user', content: 'Test' }];
      const metadata = { project: 'test-project', version: '1.0' };

      const params: CreateCachedContextParams = {
        name: 'Context with Metadata',
        messages,
        metadata,
        userContext: userContext,
        requestId: 'req-127',
      };

      const result = await service.createCachedContext(params);

      expect(result).toBeDefined();
      expect(result.id).toMatch(/^ctx_/);
    });
  });

  describe('getCachedContext', () => {
    it('should retrieve a cached context by ID', async () => {
      // First create a context
      const messages: ChatMessage[] = [{ role: 'user', content: 'Cached message' }];
      const createParams: CreateCachedContextParams = {
        name: 'Retrievable Context',
        messages,
        userContext: userContext,
        requestId: 'req-128',
      };

      const created = await service.createCachedContext(createParams);

      // Then retrieve it
      const getParams: GetCachedContextParams = {
        contextId: created.id,
        userContext: userContext,
        requestId: 'req-129',
      };

      const result = await service.getCachedContext(getParams);

      expect(result).toBeDefined();
      expect(result?.id).toBe(created.id);
      expect(result?.name).toBe('Retrievable Context');
      expect(result?.messages).toEqual(messages);
    });

    it('should return null for non-existent context', async () => {
      const params: GetCachedContextParams = {
        contextId: 'ctx_nonexistent',
        userContext: userContext,
        requestId: 'req-130',
      };

      const result = await service.getCachedContext(params);

      expect(result).toBeNull();
    });
  });

  describe('listCachedContexts', () => {
    it('should list all cached contexts for an organization', async () => {
      // Create multiple contexts
      for (let i = 0; i < 3; i++) {
        await service.createCachedContext({
          name: `Context ${i}`,
          messages: [{ role: 'user', content: `Message ${i}` }],
          userContext: userContext,
          requestId: `req-list-${i}`,
        });
      }

      const params: ListCachedContextsParams = {
        limit: 10,
        offset: 0,
        userContext: userContext,
        requestId: 'req-list',
      };

      const result = await service.listCachedContexts(params);

      expect(result.contexts.length).toBeGreaterThanOrEqual(3);
      expect(result.total).toBeGreaterThanOrEqual(3);
    });

    it('should support pagination', async () => {
      const params: ListCachedContextsParams = {
        limit: 2,
        offset: 0,
        userContext: userContext,
        requestId: 'req-paginate',
      };

      const result = await service.listCachedContexts(params);

      expect(result.contexts.length).toBeLessThanOrEqual(2);
    });
  });

  describe('deleteCachedContext', () => {
    it('should delete an existing cached context', async () => {
      // First create a context
      const created = await service.createCachedContext({
        name: 'To Be Deleted',
        messages: [{ role: 'user', content: 'Delete me' }],
        userContext: userContext,
        requestId: 'req-del-1',
      });

      // Then delete it
      const deleteParams: DeleteCachedContextParams = {
        contextId: created.id,
        userContext: userContext,
        requestId: 'req-del-2',
      };

      const result = await service.deleteCachedContext(deleteParams);

      expect(result.id).toBe(created.id);
      expect(result.deleted).toBe(true);

      // Verify it's gone
      const getResult = await service.getCachedContext({
        contextId: created.id,
        userContext: userContext,
        requestId: 'req-del-3',
      });

      expect(getResult).toBeNull();
    });

    it('should return deleted=false for non-existent context', async () => {
      const params: DeleteCachedContextParams = {
        contextId: 'ctx_doesnotexist',
        userContext: userContext,
        requestId: 'req-del-notexist',
      };

      const result = await service.deleteCachedContext(params);

      expect(result.deleted).toBe(false);
    });
  });

  describe('useCachedContext', () => {
    it('should use a cached context and return combined messages', async () => {
      const cachedMessages: ChatMessage[] = [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'user', content: 'I need help with TypeScript.' },
      ];

      // Create context
      const created = await service.createCachedContext({
        name: 'Coding Context',
        messages: cachedMessages,
        userContext: userContext,
        requestId: 'req-use-1',
      });

      // Use context with additional messages
      const additionalMessages: ChatMessage[] = [
        { role: 'user', content: 'How do I define a generic type?' },
      ];

      const useParams: UseCachedContextParams = {
        contextId: created.id,
        additionalMessages,
        userContext: userContext,
        requestId: 'req-use-2',
      };

      const result = await service.useCachedContext(useParams);

      expect(result.cacheHit).toBe(true);
      expect(result.messages.length).toBe(3);
      expect(result.messages[0]).toEqual(cachedMessages[0]);
      expect(result.messages[1]).toEqual(cachedMessages[1]);
      expect(result.messages[2]).toEqual(additionalMessages[0]);
      expect(result.cachedTokenCount).toBeGreaterThan(0);
      expect(result.totalTokenCount).toBeGreaterThan(result.cachedTokenCount);
    });

    it('should return cache miss for non-existent context', async () => {
      const additionalMessages: ChatMessage[] = [{ role: 'user', content: 'Test' }];

      const params: UseCachedContextParams = {
        contextId: 'ctx_invalid',
        additionalMessages,
        userContext: userContext,
        requestId: 'req-use-miss',
      };

      const result = await service.useCachedContext(params);

      expect(result.cacheHit).toBe(false);
      expect(result.cachedTokenCount).toBe(0);
      expect(result.messages).toEqual(additionalMessages);
    });
  });

  describe('token estimation', () => {
    it('should estimate tokens for simple string content', async () => {
      // 100 characters should be approximately 25 tokens
      const content = 'a'.repeat(100);
      const messages: ChatMessage[] = [{ role: 'user', content }];

      const result = await service.createCachedContext({
        name: 'Token Test',
        messages,
        userContext: userContext,
        requestId: 'req-tokens',
      });

      // Approximately 100/4 = 25 tokens + overhead
      expect(result.tokenCount).toBeGreaterThan(20);
      expect(result.tokenCount).toBeLessThan(40);
    });

    it('should estimate tokens for multipart content', async () => {
      const messages: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this image' },
            { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } },
          ],
        },
      ];

      const result = await service.createCachedContext({
        name: 'Multipart Token Test',
        messages,
        userContext: userContext,
        requestId: 'req-multipart',
      });

      expect(result.tokenCount).toBeGreaterThan(0);
    });
  });
});

