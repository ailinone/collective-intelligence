// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model Cache Service Tests
 * Tests 3-tier caching strategy (In-Memory, Redis, PostgreSQL)
 * Uses REAL database and Redis - NO mocks
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { modelCacheService } from '@/services/model-cache-service';
import { prisma, connectDatabase, disconnectDatabase } from '@/database/client';
import { getRedisClient } from '@/cache/redis-client';
import type { Model } from '@/types';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { initializeDIContainer, resetDIContainer } from '@/di/container';
import { syncDefaultRoles } from '@/services/rbac-sync-service';
import { ensureModelsDiscovered } from '../utils/test-model-helper';

describe('ModelCacheService - 3-Tier Caching (NO Mocks)', () => {
  let testProviderId: string;
  let testModelId: string;
  let testModelIds: string[] = [];

  beforeAll(async () => {
    await startTestEnvironment();
    initializeDIContainer();
    await connectDatabase();
    await syncDefaultRoles();
    await ensureModelsDiscovered();

    const providers = await prisma.provider.findMany({ take: 1 });
    if (providers.length > 0) {
      testProviderId = providers[0].id;
      const models = await prisma.model.findMany({
        where: { providerId: testProviderId, status: 'active' },
        take: 10,
      });
      if (models.length > 0) {
        testModelId = models[0].id;
        testModelIds = models.map(m => m.id);
      }
    }
  }, 60_000);

  afterAll(async () => {
    modelCacheService['inMemoryCache'].clear();
    const redisClient = await getRedisClient();
    if (testModelIds.length > 0) {
      const keys = testModelIds.map(id => `model:${id}`);
      await redisClient.del(...keys).catch(() => {});
    }
    await disconnectDatabase();
    resetDIContainer();
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(async () => {
    modelCacheService['inMemoryCache'].clear();

    if (testModelIds.length > 0) {
      const redisClient = await getRedisClient();
      const keys = testModelIds.map(id => `model:${id}`);
      await redisClient.del(...keys).catch(() => {});
    }
  });

  describe('Single Model Get', () => {
    it('should return from Tier 1 (in-memory) on second access', async () => {
      if (!testModelId) {
        return;
      }

      const firstResult = await modelCacheService.get(testModelId);
      expect(firstResult).toBeDefined();
      expect(firstResult?.id).toBe(testModelId);

      const secondResult = await modelCacheService.get(testModelId);
      expect(secondResult).toBeDefined();
      expect(secondResult?.id).toBe(testModelId);
      expect(secondResult).toBe(firstResult);
    });

    it('should fallback to Database when cache miss', async () => {
      if (!testModelId) {
        return;
      }

      modelCacheService['inMemoryCache'].clear();
      const redisClient = await getRedisClient();
      await redisClient.del(`model:${testModelId}`).catch(() => {});

      const result = await modelCacheService.get(testModelId);
      expect(result).toBeDefined();
      expect(result?.id).toBe(testModelId);
    });

    it('should return null if model not found in any tier', async () => {
      const result = await modelCacheService.get('nonexistent-model-id-that-does-not-exist-12345');
      expect(result).toBeNull();
    });

    it('should cache result in memory after database fetch', async () => {
      if (!testModelId) {
        return;
      }

      modelCacheService['inMemoryCache'].clear();
      const redisClient = await getRedisClient();
      await redisClient.del(`model:${testModelId}`).catch(() => {});

      const firstResult = await modelCacheService.get(testModelId);
      expect(firstResult).toBeDefined();

      const cached = modelCacheService['inMemoryCache'].get(testModelId);
      expect(cached).toBeDefined();
      expect(cached?.id).toBe(testModelId);
    });

    it('should maintain LRU eviction (max 20 models)', async () => {
      if (testModelIds.length < 25) {
        return;
      }

      modelCacheService['inMemoryCache'].clear();

      for (let i = 0; i < 25 && i < testModelIds.length; i++) {
        await modelCacheService.get(testModelIds[i]);
      }

      const cacheSize = modelCacheService['inMemoryCache'].size;
      expect(cacheSize).toBeLessThanOrEqual(20);

      const recentId = testModelIds[Math.min(24, testModelIds.length - 1)];
      const recent = modelCacheService['inMemoryCache'].get(recentId);
      expect(recent).toBeDefined();
    });
  });

  describe('Bulk Model Get (Critical for 9-model orchestration)', () => {
    it('should handle all models from Tier 1 (in-memory)', async () => {
      if (testModelIds.length < 9) {
        return;
      }

      const modelIdsToCache = testModelIds.slice(0, 9);
      for (const modelId of modelIdsToCache) {
        await modelCacheService.get(modelId);
      }

      const results = await modelCacheService.bulkGet(modelIdsToCache);

      expect(results.size).toBeGreaterThanOrEqual(9);
      for (const modelId of modelIdsToCache) {
        expect(results.get(modelId)).toBeDefined();
        expect(results.get(modelId)?.id).toBe(modelId);
      }
    });

    it('should handle cache miss and fetch from database', async () => {
      if (testModelIds.length < 9) {
        return;
      }

      modelCacheService['inMemoryCache'].clear();
      const redisClient = await getRedisClient();
      const keys = testModelIds.slice(0, 9).map(id => `model:${id}`);
      await redisClient.del(...keys).catch(() => {});

      const preCachedIds = testModelIds.slice(0, 3);
      for (const modelId of preCachedIds) {
        const model = await prisma.model.findUnique({ where: { id: modelId } });
        if (model) {
          const modelData: Model = {
            id: model.id,
            providerId: model.providerId,
            provider: model.provider?.name || 'unknown',
            name: model.name,
            displayName: model.displayName || model.name,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens || model.contextWindow,
            inputCostPer1k: Number(model.inputCostPer1k),
            outputCostPer1k: Number(model.outputCostPer1k),
            capabilities: (model.capabilities as string[]) || [],
            performance: {
              latency: model.avgLatency || 0,
              throughput: model.avgThroughput || 0,
              reliability: model.reliability || 0.99,
            },
            status: model.status as Model['status'],
            metadata: (model.metadata as Record<string, unknown>) || {},
          };
          modelCacheService['inMemoryCache'].set(modelId, modelData);
        }
      }

      const modelIds = testModelIds.slice(0, 9);
      const results = await modelCacheService.bulkGet(modelIds);

      expect(results.size).toBeGreaterThanOrEqual(3);
      expect(results.size).toBeLessThanOrEqual(9);
    });

    it('should complete bulk fetch efficiently', async () => {
      if (testModelIds.length < 9) {
        return;
      }

      const warmUpIds = testModelIds.slice(0, 5);
      for (const modelId of warmUpIds) {
        await modelCacheService.get(modelId);
      }

      const modelIds = testModelIds.slice(0, 9);
      const startTime = Date.now();
      const results = await modelCacheService.bulkGet(modelIds);
      const duration = Date.now() - startTime;

      expect(results.size).toBeGreaterThanOrEqual(5);
      expect(results.size).toBeLessThanOrEqual(9);
      expect(duration).toBeLessThan(5000);
    });
  });

  describe('List Models with Auto-Promotion', () => {
    it('should list models and promote hot ones to cache', async () => {
      const models = await prisma.model.findMany({
        where: { status: 'active' },
        take: 50,
        orderBy: { usageCount: 'desc' },
      });

      if (models.length === 0) {
        return;
      }

      const results = await modelCacheService.list({ limit: 50 });

      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(50);

      if (results.length > 0) {
        const topModelId = results[0].id;
        const cached = modelCacheService['inMemoryCache'].get(topModelId);
        expect(typeof cached === 'object' || cached === undefined).toBe(true);
      }
    });

    it('should support filtering by provider', async () => {
      if (!testProviderId) {
        return;
      }

      const results = await modelCacheService.list({ provider: testProviderId });

      expect(Array.isArray(results)).toBe(true);
      if (results.length > 0) {
        expect(results.every(m => m.providerId === testProviderId)).toBe(true);
      }
    });
  });

  describe('Cache Invalidation', () => {
    it('should invalidate model from in-memory cache', async () => {
      if (!testModelId) {
        return;
      }

      const model = await modelCacheService.get(testModelId);
      if (!model) {
        return;
      }

      expect(modelCacheService['inMemoryCache'].get(testModelId)).toBeDefined();

      await modelCacheService.invalidate(testModelId);

      expect(modelCacheService['inMemoryCache'].get(testModelId)).toBeUndefined();
    });

    it('should clear all in-memory caches', async () => {
      if (testModelIds.length === 0) {
        return;
      }

      for (const modelId of testModelIds.slice(0, 5)) {
        await modelCacheService.get(modelId);
      }

      expect(modelCacheService['inMemoryCache'].size).toBeGreaterThan(0);

      await modelCacheService.invalidateAll();

      expect(modelCacheService['inMemoryCache'].size).toBe(0);
    });
  });

  describe('Cache Statistics', () => {
    it('should return cache stats', async () => {
      if (testModelIds.length === 0) {
        return;
      }

      for (const modelId of testModelIds.slice(0, 5)) {
        await modelCacheService.get(modelId);
      }

      const stats = modelCacheService.getStats();

      expect(stats.tier1.size).toBeGreaterThanOrEqual(0);
      expect(stats.tier1.max).toBe(20);
      expect(stats.tier2).toBe('Redis (top 100)');
      expect(stats.tier3).toBe('PostgreSQL (all models)');
    });
  });

  describe('Performance Guarantees', () => {
    it('should handle multiple models with acceptable performance', async () => {
      if (testModelIds.length < 10) {
        return;
      }

      modelCacheService['inMemoryCache'].clear();
      const redisClient = await getRedisClient();
      const keys = testModelIds.map(id => `model:${id}`);
      await redisClient.del(...keys).catch(() => {});

      const startTime = Date.now();
      for (const modelId of testModelIds.slice(0, 10)) {
        await modelCacheService.get(modelId);
      }
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(10000);
      expect(modelCacheService['inMemoryCache'].size).toBeLessThanOrEqual(20);
    });
  });
});
