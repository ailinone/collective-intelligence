// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Token Bucket Rate Limiter Tests
 *
 * Tests the token bucket algorithm implementation
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import Redis from 'ioredis';
import type {
  TokenBucket as TokenBucketClass,
  TokenBucketManager as TokenBucketManagerClass,
  TokenBucketConfig,
} from '@/core/resilience/token-bucket-limiter';
import { startTestEnvironment, stopTestEnvironment } from '../../../utils/test-environment';

let redis: ReturnType<typeof import('@/cache/redis-client').getRedisClient>;
let TokenBucket: typeof TokenBucketClass;
let TokenBucketManager: typeof TokenBucketManagerClass;
let getRedisClient: typeof import('@/cache/redis-client').getRedisClient;
const bucketKeysToCleanup = new Set<string>();

async function ensureRedisConnectivity(): Promise<void> {
  if (process.env.TEST_USE_LOCAL_SERVICES !== 'true') {
    return;
  }

  const host = process.env.REDIS_HOST ?? 'localhost';
  const port = Number(process.env.REDIS_PORT ?? '6379');

  const probe = new Redis({
    host,
    port,
    lazyConnect: false,
    enableReadyCheck: false,
    connectTimeout: 3_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  });

  probe.on('error', () => {
    // swallow connection errors during probe to avoid noisy logs
  });

  try {
    await probe.ping();
    // eslint-disable-next-line no-console
    console.log('Using externally managed Redis for token bucket tests', { host, port });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      'Local Redis unavailable, falling back to Testcontainers-managed instance',
      error instanceof Error ? error.message : error,
    );
    process.env.TEST_USE_LOCAL_SERVICES = 'false';
  } finally {
    await probe.quit().catch(() => undefined);
  }
}

beforeAll(async () => {
  process.env.FORCE_DISTRIBUTED_TOKEN_BUCKETS = 'true';
  await ensureRedisConnectivity();
  await startTestEnvironment();
  vi.resetModules();
  const { config: appConfig } = await import('@/config');
  const module = await import('@/core/resilience/token-bucket-limiter');
  TokenBucket = module.TokenBucket;
  TokenBucketManager = module.TokenBucketManager;
  const redisModule = await import('@/cache/redis-client');
  getRedisClient = redisModule.getRedisClient;
  redis = getRedisClient();
  await redis.ping();
}, 120_000);

afterAll(async () => {
  for (const key of bucketKeysToCleanup) {
    await redis.del(`rate-limit:token-bucket:${key}`);
  }
  delete process.env.FORCE_DISTRIBUTED_TOKEN_BUCKETS;
  await stopTestEnvironment();
}, 60_000);

describe('TokenBucket', () => {
  let config: TokenBucketConfig;

  beforeEach(() => {
    const identifier = `test-user-${randomUUID()}`;
    config = {
      capacity: 10,
      refillRate: 1, // 1 token per second
      identifier,
      scope: 'user',
      forceDistributed: true,
    };
    bucketKeysToCleanup.add(`${config.scope}:${identifier}`);
  });

  describe('consume', () => {
    it('should allow requests when tokens are available', async () => {
      const bucket = new TokenBucket(config);
      
      // Should allow first request
      const result1 = await bucket.consume();
      expect(result1).toBe(true);
      
      // Should allow second request
      const result2 = await bucket.consume();
      expect(result2).toBe(true);
    });

    it('should reject requests when bucket is empty', async () => {
      config.capacity = 2;
      const bucket = new TokenBucket(config);
      
      // Consume all tokens
      await bucket.consume();
      await bucket.consume();
      
      // Should reject next request
      const result = await bucket.consume();
      expect(result).toBe(false);
    });

    it('should refill tokens over time', async () => {
      config.capacity = 5;
      config.refillRate = 10; // 10 tokens per second
      const bucket = new TokenBucket(config);
      
      // Consume all tokens in an atomic operation to avoid early refills
      expect(await bucket.consume(5)).toBe(true);

      const statsAfterDrain = await bucket.getStats();
      expect(statsAfterDrain.tokensAvailable).toBe(0);

      // Should be empty
      expect(await bucket.consume()).toBe(false);
       
      // Wait 200ms (should add ~2 tokens, allow small variation)
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should allow at least two requests
      const firstRefill = await bucket.consume();
      const secondRefill = await bucket.consume();
      expect(firstRefill).toBe(true);
      expect(secondRefill).toBe(true);

      // Third attempt may succeed depending on timing, ensure bucket eventually drains
      const thirdAttempt = await bucket.consume();
      const fourthAttempt = await bucket.consume();
      expect(fourthAttempt).toBe(false);
    });

    it('should not exceed capacity when refilling', async () => {
      config.capacity = 5;
      config.refillRate = 100; // Very fast refill
      const bucket = new TokenBucket(config);
      
      // Wait for refill (more than enough time)
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Should still only have capacity tokens
      const stats = await bucket.getStats();
      expect(stats.tokensAvailable).toBeLessThanOrEqual(config.capacity);
    });

    it('should handle multiple token consumption', async () => {
      config.capacity = 10;
      const bucket = new TokenBucket(config);
      
      // Consume 5 tokens at once
      const result = await bucket.consume(5);
      expect(result).toBe(true);
      
      // Try to consume 6 more (should fail, only 5 left)
      const result2 = await bucket.consume(6);
      expect(result2).toBe(false);
      
      // Consume 5 more (should succeed)
      const result3 = await bucket.consume(5);
      expect(result3).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', async () => {
      const bucket = new TokenBucket(config);
      
      // Consume some tokens
      await bucket.consume();
      await bucket.consume();
      await bucket.consume();
      
      const stats = await bucket.getStats();
      
      expect(stats.identifier).toBe(config.identifier);
      expect(stats.scope).toBe('user');
      expect(stats.capacity).toBe(10);
      expect(stats.refillRate).toBe(1);
      expect(stats.totalRequests).toBeGreaterThanOrEqual(3);
    });

    it('should track rejection rate', async () => {
      config.capacity = 2;
      const bucket = new TokenBucket(config);
      
      // Consume all and try more
      await bucket.consume();
      await bucket.consume();
      await bucket.consume(); // Rejected
      await bucket.consume(); // Rejected
      
      const stats = await bucket.getStats();
      
      expect(stats.totalRequests).toBe(4);
      expect(stats.totalRejected).toBeGreaterThanOrEqual(2);
      expect(stats.rejectionRate).toBeGreaterThan(0);
    });
  });

  describe('reset', () => {
    it('should reset bucket to full capacity', async () => {
      const bucket = new TokenBucket(config);
      
      // Consume some tokens
      await bucket.consume();
      await bucket.consume();
      await bucket.consume();
      
      // Reset
      await bucket.reset();
      
      const stats = await bucket.getStats();
      expect(stats.tokensAvailable).toBe(config.capacity);
      expect(stats.totalRequests).toBe(0);
      expect(stats.totalRejected).toBe(0);
    });
  });

  describe('getRetryAfter', () => {
    it('should return 0 when tokens are available', async () => {
      const bucket = new TokenBucket(config);
      
      const retryAfter = await bucket.getRetryAfter();
      expect(retryAfter).toBe(0);
    });

    it('should calculate correct retry time when tokens unavailable', async () => {
      config.capacity = 2;
      config.refillRate = 1; // 1 token per second
      const bucket = new TokenBucket(config);
      
      // Consume all
      await bucket.consume();
      await bucket.consume();
      
      // Need 1 token, refill rate is 1/s
      const retryAfter = await bucket.getRetryAfter(1);
      
      // Should be approximately 1000ms
      expect(retryAfter).toBeGreaterThan(900);
      expect(retryAfter).toBeLessThan(1100);
    });
  });
});

describe('TokenBucketManager', () => {
  let manager: TokenBucketManager;
  let managerPrefix: string;

  const trackedIdentifier = (scope: string, identifier: string) => {
    const finalId = `${managerPrefix}-${identifier}`;
    bucketKeysToCleanup.add(`${scope}:${finalId}`);
    return finalId;
  };

  beforeEach(() => {
    manager = new TokenBucketManager();
    manager.clearAll();
    managerPrefix = randomUUID();
  });

  describe('getBucket', () => {
    it('should create bucket with default config for scope', () => {
      const bucket = manager.getBucket('api-key', trackedIdentifier('api-key', 'test-key'));
      expect(bucket).toBeDefined();
    });

    it('should reuse existing bucket for same identifier', () => {
      const id = trackedIdentifier('api-key', 'test-key');
      const bucket1 = manager.getBucket('api-key', id);
      const bucket2 = manager.getBucket('api-key', id);
      
      expect(bucket1).toBe(bucket2);
    });

    it('should create separate buckets for different scopes', () => {
      const bucket1 = manager.getBucket('api-key', trackedIdentifier('api-key', 'test'));
      const bucket2 = manager.getBucket('user', trackedIdentifier('user', 'test'));
      
      expect(bucket1).not.toBe(bucket2);
    });

    it('should allow custom config override', () => {
      const customConfig = {
        capacity: 999,
        refillRate: 99,
      };
      
      const bucket = manager.getBucket('api-key', trackedIdentifier('api-key', 'test'), customConfig);
      expect(bucket).toBeDefined();
    });
  });

  describe('consume', () => {
    it('should consume tokens from correct bucket', async () => {
      const key1 = trackedIdentifier('api-key', 'key1');
      const key2 = trackedIdentifier('api-key', 'key2');
      const result1 = await manager.consume('api-key', key1);
      expect(result1).toBe(true);
      
      const result2 = await manager.consume('api-key', key2);
      expect(result2).toBe(true);
    });

    it('should isolate buckets per identifier', async () => {
      // Configure small bucket for testing
      const user1 = trackedIdentifier('user', 'user1');
      const user2 = trackedIdentifier('user', 'user2');
      const bucket1 = manager.getBucket('user', user1, { capacity: 2, refillRate: 0 });
      const bucket2 = manager.getBucket('user', user2, { capacity: 2, refillRate: 0 });
      
      // Exhaust user1 bucket
      await manager.consume('user', user1);
      await manager.consume('user', user1);
      
      // user1 should be rejected
      expect(await manager.consume('user', user1)).toBe(false);
      
      // user2 should still work
      expect(await manager.consume('user', user2)).toBe(true);
    });
  });

  describe('getAllStats', () => {
    it('should return stats for all buckets', async () => {
      await manager.consume('api-key', trackedIdentifier('api-key', 'key1'));
      await manager.consume('api-key', trackedIdentifier('api-key', 'key2'));
      await manager.consume('user', trackedIdentifier('user', 'user1'));
      
      const stats = await manager.getAllStats();
      
      expect(stats.length).toBeGreaterThanOrEqual(3);
      expect(stats.every(s => s.totalRequests > 0)).toBe(true);
    });
  });

  describe('resetBucket', () => {
    it('should reset specific bucket', async () => {
      const key1 = trackedIdentifier('api-key', 'key1');
      await manager.consume('api-key', key1);
      await manager.resetBucket('api-key', key1);
      
      const bucket = manager.getBucket('api-key', key1);
      const stats = await bucket.getStats();
      
      expect(stats.totalRequests).toBe(0);
    });
  });

  describe('clearAll', () => {
    it('should clear all buckets', () => {
      manager.getBucket('api-key', trackedIdentifier('api-key', 'key1'));
      manager.getBucket('api-key', trackedIdentifier('api-key', 'key2'));
      manager.getBucket('user', trackedIdentifier('user', 'user1'));
      
      manager.clearAll();
      
      // After clear, new buckets should be created
      const bucket = manager.getBucket('api-key', 'key1');
      expect(bucket).toBeDefined();
    });
  });
});

