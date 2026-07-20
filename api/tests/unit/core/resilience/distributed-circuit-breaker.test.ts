// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Distributed Circuit Breaker Tests
 * 
 * Tests distributed state management and circuit breaker logic
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import Redis from 'ioredis';
import type {
  DistributedCircuitBreaker as DistributedCircuitBreakerClass,
  DistributedCircuitBreakerManager as DistributedCircuitBreakerManagerClass,
  DistributedCircuitBreakerConfig,
  CircuitState,
} from '@/core/resilience/distributed-circuit-breaker';
import { startTestEnvironment, stopTestEnvironment } from '../../../utils/test-environment';

let redis: ReturnType<typeof import('@/cache/redis-client').getRedisClient>;
let DistributedCircuitBreaker: typeof DistributedCircuitBreakerClass;
let DistributedCircuitBreakerManager: typeof DistributedCircuitBreakerManagerClass;
let getRedisClient: typeof import('@/cache/redis-client').getRedisClient;
const circuitNamesToCleanup = new Set<string>();

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
    console.log('Using externally managed Redis for circuit breaker tests', { host, port });
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
  process.env.FORCE_DISTRIBUTED_CIRCUITS = 'true';
  await ensureRedisConnectivity();
  await startTestEnvironment();
  vi.resetModules();
  const module = await import('@/core/resilience/distributed-circuit-breaker');
  DistributedCircuitBreaker = module.DistributedCircuitBreaker;
  DistributedCircuitBreakerManager = module.DistributedCircuitBreakerManager;
  const redisModule = await import('@/cache/redis-client');
  getRedisClient = redisModule.getRedisClient;
  redis = getRedisClient();
  await redis.ping();
}, 120_000);

afterAll(async () => {
  for (const circuitName of circuitNamesToCleanup) {
    const keys = await redis.keys(`circuit-breaker:${circuitName}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
  delete process.env.FORCE_DISTRIBUTED_CIRCUITS;
  await stopTestEnvironment();
}, 60_000);

describe('DistributedCircuitBreaker', () => {
  let config: DistributedCircuitBreakerConfig;

  beforeEach(() => {
    const uniqueName = `test-circuit-${randomUUID()}`;
    config = {
      name: uniqueName,
      failureThreshold: 3,
      successThreshold: 2,
      failureWindow: 10000,
      openDuration: 1000,
      halfOpenMaxAttempts: 3,
      timeout: 500,
      forceDistributed: true,
    };
    circuitNamesToCleanup.add(uniqueName);
  });

  describe('execute', () => {
    it('should execute operation when circuit is closed', async () => {
      const breaker = new DistributedCircuitBreaker(config);
      const operation = vi.fn().mockResolvedValue('success');

      const result = await breaker.execute(operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledOnce();
    });

    it('should timeout long-running operations', async () => {
      config.timeout = 100;
      const breaker = new DistributedCircuitBreaker(config);
      
      const slowOperation = () => new Promise(resolve => setTimeout(() => resolve('slow'), 500));

      await expect(breaker.execute(slowOperation)).rejects.toThrow('timed out');
    });

    it('should open circuit after threshold failures', async () => {
      config.failureThreshold = 3;
      const breaker = new DistributedCircuitBreaker(config);
      
      const failingOperation = vi.fn().mockRejectedValue(new Error('fail'));

      // Fail 3 times
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(failingOperation);
        } catch {}
      }

      const stats = await breaker.getStats();
      expect(stats.state).toBe('OPEN');
      expect(stats.consecutiveFailures).toBe(3);
    });

    it('should reject immediately when circuit is open', async () => {
      config.failureThreshold = 2;
      config.openDuration = 10000; // 10 seconds
      const breaker = new DistributedCircuitBreaker(config);
      
      const operation = vi.fn().mockRejectedValue(new Error('fail'));

      // Fail twice to open circuit
      try { await breaker.execute(operation); } catch {}
      try { await breaker.execute(operation); } catch {}

      // Circuit should be open now
      const successOperation = vi.fn().mockResolvedValue('success');
      await expect(breaker.execute(successOperation)).rejects.toThrow('Circuit breaker');
      
      // Success operation should NOT have been called
      expect(successOperation).not.toHaveBeenCalled();
    });

    it('should transition to half-open after open duration', async () => {
      config.failureThreshold = 2;
      config.openDuration = 200; // 200ms
      const breaker = new DistributedCircuitBreaker(config);
      
      const operation = vi.fn().mockRejectedValue(new Error('fail'));

      // Open circuit
      try { await breaker.execute(operation); } catch {}
      try { await breaker.execute(operation); } catch {}

      // Wait for open duration
      await new Promise(resolve => setTimeout(resolve, 250));

      // Next request should transition to HALF_OPEN and be allowed
      const successOperation = vi.fn().mockResolvedValue('success');
      await breaker.execute(successOperation);

      const stats = await breaker.getStats();
      expect(stats.state).toBe('HALF_OPEN');
    });

    it('should close circuit after successful recoveries in half-open', async () => {
      config.failureThreshold = 2;
      config.successThreshold = 2;
      config.openDuration = 100;
      const breaker = new DistributedCircuitBreaker(config);
      
      // Open circuit
      const failOp = vi.fn().mockRejectedValue(new Error('fail'));
      try { await breaker.execute(failOp); } catch {}
      try { await breaker.execute(failOp); } catch {}

      // Wait for open duration
      await new Promise(resolve => setTimeout(resolve, 150));

      // Execute successful operations
      const successOp = vi.fn().mockResolvedValue('success');
      await breaker.execute(successOp);
      await breaker.execute(successOp);

      // Circuit should be closed now
      const stats = await breaker.getStats();
      expect(stats.state).toBe('CLOSED');
    });

    it('should reopen circuit if failure in half-open', async () => {
      config.failureThreshold = 2;
      config.openDuration = 100;
      const breaker = new DistributedCircuitBreaker(config);
      
      // Open circuit
      const failOp = vi.fn().mockRejectedValue(new Error('fail'));
      try { await breaker.execute(failOp); } catch {}
      try { await breaker.execute(failOp); } catch {}

      // Wait for transition to HALF_OPEN
      await new Promise(resolve => setTimeout(resolve, 150));

      // Fail in HALF_OPEN
      try {
        await breaker.execute(failOp);
      } catch {}

      // Should be OPEN again
      const stats = await breaker.getStats();
      expect(stats.state).toBe('OPEN');
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', async () => {
      const breaker = new DistributedCircuitBreaker(config);
      const operation = vi.fn().mockResolvedValue('success');

      await breaker.execute(operation);
      await breaker.execute(operation);

      const stats = await breaker.getStats();

      expect(stats.name).toBe(config.name);
      expect(stats.state).toBe('CLOSED');
      expect(stats.successes).toBeGreaterThanOrEqual(2);
      expect(stats.totalRequests).toBeGreaterThanOrEqual(2);
    });

    it('should track consecutive failures', async () => {
      const breaker = new DistributedCircuitBreaker(config);
      const operation = vi.fn().mockRejectedValue(new Error('fail'));

      try { await breaker.execute(operation); } catch {}
      try { await breaker.execute(operation); } catch {}

      const stats = await breaker.getStats();
      expect(stats.consecutiveFailures).toBe(2);
    });
  });

  describe('manual control', () => {
    it('should allow manual open', async () => {
      const breaker = new DistributedCircuitBreaker(config);
      
      await breaker.open();

      const stats = await breaker.getStats();
      expect(stats.state).toBe('OPEN');
    });

    it('should allow manual close', async () => {
      const breaker = new DistributedCircuitBreaker(config);
      
      await breaker.open();
      await breaker.close();

      const stats = await breaker.getStats();
      expect(stats.state).toBe('CLOSED');
    });

    it('should reset circuit completely', async () => {
      const breaker = new DistributedCircuitBreaker(config);
      const operation = vi.fn().mockRejectedValue(new Error('fail'));

      // Generate some stats
      try { await breaker.execute(operation); } catch {}
      try { await breaker.execute(operation); } catch {}

      // Reset
      await breaker.reset();

      const stats = await breaker.getStats();
      expect(stats.state).toBe('CLOSED');
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
    });
  });
});

describe('DistributedCircuitBreakerManager', () => {
  let manager: DistributedCircuitBreakerManager;
  let managerNamePrefix: string;

  function trackBreaker(name: string, serviceType: string, override?: Partial<DistributedCircuitBreakerConfig>) {
    const fullName = `${managerNamePrefix}-${name}`;
    circuitNamesToCleanup.add(fullName);
    return manager.getBreaker(fullName, serviceType, override);
  }

  beforeEach(() => {
    manager = new DistributedCircuitBreakerManager();
    managerNamePrefix = randomUUID();
  });

  describe('getBreaker', () => {
    it('should create breaker with default config', () => {
      const breaker = trackBreaker('test-service', 'llm-provider', { forceDistributed: true });
      expect(breaker).toBeDefined();
    });

    it('should reuse existing breaker', () => {
      const breaker1 = trackBreaker('test-service', 'llm-provider', { forceDistributed: true });
      const breaker2 = trackBreaker('test-service', 'llm-provider', { forceDistributed: true });
      
      expect(breaker1).toBe(breaker2);
    });

    it('should create separate breakers for different services', () => {
      const breaker1 = trackBreaker('service1', 'llm-provider', { forceDistributed: true });
      const breaker2 = trackBreaker('service2', 'llm-provider', { forceDistributed: true });
      
      expect(breaker1).not.toBe(breaker2);
    });

    it('should allow custom config override', () => {
      const customConfig = {
        failureThreshold: 99,
        timeout: 9999,
        forceDistributed: true,
      };

      const breaker = trackBreaker('custom-service', 'llm-provider', customConfig);
      expect(breaker).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should execute through correct breaker', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      
      const serviceName = `${managerNamePrefix}-test-service`;
      circuitNamesToCleanup.add(serviceName);
      const result = await manager.execute(serviceName, operation, 'llm-provider');
      
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledOnce();
    });
  });

  describe('getAllStats', () => {
    it('should return stats for all breakers', async () => {
      trackBreaker('service1', 'llm-provider', { forceDistributed: true });
      trackBreaker('service2', 'llm-provider', { forceDistributed: true });
      trackBreaker('service3', 'llm-provider', { forceDistributed: true });

      const stats = await manager.getAllStats();
      
      expect(stats.length).toBeGreaterThanOrEqual(3);
      expect(stats.every(s => s.name)).toBe(true);
    });
  });

  describe('getOpenCircuits', () => {
    it('should return only open circuits', async () => {
      const breaker1 = trackBreaker('service1', 'llm-provider', { forceDistributed: true });
      trackBreaker('service2', 'llm-provider', { forceDistributed: true });

      await breaker1.open();

      const openCircuits = await manager.getOpenCircuits();
      
      expect(openCircuits.length).toBeGreaterThanOrEqual(1);
      expect(openCircuits.every(c => c.state === 'OPEN')).toBe(true);
    });
  });

  describe('areAllClosed', () => {
    it('should return true when all circuits closed', async () => {
      trackBreaker('service1', 'llm-provider', { forceDistributed: true });
      trackBreaker('service2', 'llm-provider', { forceDistributed: true });

      const allClosed = await manager.areAllClosed();
      expect(allClosed).toBe(true);
    });

    it('should return false when any circuit open', async () => {
      const breaker1 = trackBreaker('service1', 'llm-provider', { forceDistributed: true });
      trackBreaker('service2', 'llm-provider', { forceDistributed: true });

      await breaker1.open();

      const allClosed = await manager.areAllClosed();
      expect(allClosed).toBe(false);
    });
  });
});

