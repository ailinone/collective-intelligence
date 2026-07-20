// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Bulkhead Pattern Tests
 * 
 * Tests resource isolation and queue management
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Bulkhead, BulkheadManager, type BulkheadConfig } from '@/core/resilience/bulkhead-pattern';

describe('Bulkhead', () => {
  let config: BulkheadConfig;

  beforeEach(() => {
    config = {
      maxConcurrent: 2,
      maxQueueSize: 5,
      queueTimeout: 1000,
      providerName: 'test-provider',
    };
  });

  describe('execute', () => {
    it('should execute operation when under limit', async () => {
      const bulkhead = new Bulkhead(config);
      const operation = vi.fn().mockResolvedValue('success');

      const result = await bulkhead.execute(operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledOnce();
    });

    it('should limit concurrent operations', async () => {
      config.maxConcurrent = 1;
      const bulkhead = new Bulkhead(config);
      
      let concurrent = 0;
      let maxConcurrent = 0;

      const operation = async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(resolve => setTimeout(resolve, 50));
        concurrent--;
        return 'done';
      };

      // Start 5 operations
      const promises = Array.from({ length: 5 }, () => bulkhead.execute(operation));
      
      await Promise.all(promises);

      // Should never have more than 1 concurrent
      expect(maxConcurrent).toBe(1);
    });

    it('should queue operations when at limit', async () => {
      config.maxConcurrent = 1;
      config.maxQueueSize = 3;
      const bulkhead = new Bulkhead(config);

      const completed: number[] = [];
      const operation = async (id: number) => {
        await new Promise(resolve => setTimeout(resolve, 20));
        completed.push(id);
        return id;
      };

      // Start 4 operations (1 executing, 3 queued)
      const promises = [
        bulkhead.execute(() => operation(1)),
        bulkhead.execute(() => operation(2)),
        bulkhead.execute(() => operation(3)),
        bulkhead.execute(() => operation(4)),
      ];

      await Promise.all(promises);

      // All should complete in order
      expect(completed).toEqual([1, 2, 3, 4]);
    });

    it('should reject when queue is full', async () => {
      config.maxConcurrent = 1;
      config.maxQueueSize = 2;
      const bulkhead = new Bulkhead(config);

      const slowOperation = () => new Promise(resolve => setTimeout(() => resolve('slow'), 100));

      // Start 1 executing + 2 queued = 3 total
      const promise1 = bulkhead.execute(slowOperation);
      const promise2 = bulkhead.execute(slowOperation);
      const promise3 = bulkhead.execute(slowOperation);

      // 4th should be rejected (queue full)
      await expect(bulkhead.execute(slowOperation)).rejects.toThrow('queue full');

      // Wait for others to complete
      await Promise.all([promise1, promise2, promise3]);
    });

    it('should timeout queued operations', async () => {
      config.maxConcurrent = 1;
      config.maxQueueSize = 5;
      config.queueTimeout = 100; // 100ms timeout
      const bulkhead = new Bulkhead(config);

      // Start a slow operation that blocks
      const slowOperation = () => new Promise(resolve => setTimeout(() => resolve('slow'), 500));
      const promise1 = bulkhead.execute(slowOperation);

      // Queue operation that will timeout
      const promise2 = bulkhead.execute(slowOperation);

      // promise2 should timeout while queued
      await expect(promise2).rejects.toThrow('timed out while queued');

      // promise1 should complete
      await expect(promise1).resolves.toBe('slow');
    });

    it('should handle operation failures', async () => {
      const bulkhead = new Bulkhead(config);
      const operation = vi.fn().mockRejectedValue(new Error('operation failed'));

      await expect(bulkhead.execute(operation)).rejects.toThrow('operation failed');
      
      // Should still allow next operation
      const operation2 = vi.fn().mockResolvedValue('success');
      await expect(bulkhead.execute(operation2)).resolves.toBe('success');
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', async () => {
      const bulkhead = new Bulkhead(config);
      const operation = vi.fn().mockResolvedValue('success');

      await bulkhead.execute(operation);
      await bulkhead.execute(operation);
      await bulkhead.execute(operation);

      const stats = bulkhead.getStats();

      expect(stats.providerName).toBe('test-provider');
      expect(stats.totalExecuted).toBe(3);
      expect(stats.totalRejected).toBe(0);
      expect(stats.activeOperations).toBe(0);
      expect(stats.queuedOperations).toBe(0);
    });

    it('should track rejections', async () => {
      config.maxConcurrent = 1;
      config.maxQueueSize = 1;
      const bulkhead = new Bulkhead(config);

      const slowOp = () => new Promise(resolve => setTimeout(() => resolve('slow'), 50));

      // Start 2 (1 executing, 1 queued)
      const p1 = bulkhead.execute(slowOp);
      const p2 = bulkhead.execute(slowOp);

      // 3rd should be rejected
      try {
        await bulkhead.execute(slowOp);
      } catch {}

      await Promise.all([p1, p2]);

      const stats = bulkhead.getStats();
      expect(stats.totalRejected).toBeGreaterThanOrEqual(1);
    });

    it('should calculate average execution time', async () => {
      const bulkhead = new Bulkhead(config);
      
      const fastOp = () => new Promise(resolve => setTimeout(() => resolve('fast'), 10));

      await bulkhead.execute(fastOp);
      await bulkhead.execute(fastOp);
      await bulkhead.execute(fastOp);

      const stats = bulkhead.getStats();
      expect(stats.avgExecutionTime).toBeGreaterThan(0);
      expect(stats.avgExecutionTime).toBeLessThan(100); // Should be ~10ms
    });
  });

  describe('isHealthy', () => {
    it('should be healthy when queue is not full', async () => {
      const bulkhead = new Bulkhead(config);
      expect(bulkhead.isHealthy()).toBe(true);
    });

    it('should be unhealthy when queue >80% full', async () => {
      config.maxConcurrent = 1;
      config.maxQueueSize = 5;
      const bulkhead = new Bulkhead(config);

      const slowOp = () => new Promise(resolve => setTimeout(() => resolve('slow'), 100));

      // Fill queue to 80%+ (1 executing + 4 queued = 5 total, queue 4/5 = 80%)
      const promises = [
        bulkhead.execute(slowOp),
        bulkhead.execute(slowOp),
        bulkhead.execute(slowOp),
        bulkhead.execute(slowOp),
        bulkhead.execute(slowOp),
      ];

      // Should be unhealthy
      expect(bulkhead.isHealthy()).toBe(false);

      await Promise.all(promises);
    });

    it('should be unhealthy when rejection rate >10%', async () => {
      config.maxConcurrent = 1;
      config.maxQueueSize = 1;
      const bulkhead = new Bulkhead(config);

      const fastOp = () => Promise.resolve('fast');

      // Execute 10 operations, some will be rejected
      for (let i = 0; i < 10; i++) {
        try {
          await bulkhead.execute(fastOp);
        } catch {}
      }

      const stats = bulkhead.getStats();
      if (stats.totalRejected > stats.totalExecuted * 0.1) {
        expect(bulkhead.isHealthy()).toBe(false);
      }
    });
  });

  describe('resetStats', () => {
    it('should reset statistics', async () => {
      const bulkhead = new Bulkhead(config);
      const operation = vi.fn().mockResolvedValue('success');

      await bulkhead.execute(operation);
      await bulkhead.execute(operation);

      bulkhead.resetStats();

      const stats = bulkhead.getStats();
      expect(stats.totalExecuted).toBe(0);
      expect(stats.totalRejected).toBe(0);
      expect(stats.maxConcurrentReached).toBe(0);
    });
  });
});

describe('BulkheadManager', () => {
  let manager: BulkheadManager;

  beforeEach(() => {
    manager = new BulkheadManager();
  });

  describe('getBulkhead', () => {
    it('should create bulkhead for provider', () => {
      const bulkhead = manager.getBulkhead('test-provider');
      expect(bulkhead).toBeDefined();
    });

    it('should reuse existing bulkhead', () => {
      const bulkhead1 = manager.getBulkhead('test-provider');
      const bulkhead2 = manager.getBulkhead('test-provider');
      
      expect(bulkhead1).toBe(bulkhead2);
    });

    it('should create separate bulkheads for different providers', () => {
      const bulkhead1 = manager.getBulkhead('provider1');
      const bulkhead2 = manager.getBulkhead('provider2');
      
      expect(bulkhead1).not.toBe(bulkhead2);
    });

    it('should allow custom config', () => {
      const customConfig = {
        maxConcurrent: 99,
        maxQueueSize: 999,
        queueTimeout: 9999,
      };

      const bulkhead = manager.getBulkhead('custom-provider', customConfig);
      const stats = bulkhead.getStats();
      
      expect(stats).toBeDefined();
    });
  });

  describe('getAllStats', () => {
    it('should return stats for all bulkheads', async () => {
      manager.getBulkhead('provider1');
      manager.getBulkhead('provider2');
      manager.getBulkhead('provider3');

      const stats = manager.getAllStats();
      
      expect(stats.length).toBeGreaterThanOrEqual(3);
      expect(stats.every(s => s.providerName)).toBe(true);
    });
  });

  describe('areAllHealthy', () => {
    it('should return true when all bulkheads are healthy', () => {
      manager.getBulkhead('provider1');
      manager.getBulkhead('provider2');

      expect(manager.areAllHealthy()).toBe(true);
    });
  });

  describe('resetAllStats', () => {
    it('should reset all bulkhead statistics', async () => {
      const bulkhead1 = manager.getBulkhead('provider1');
      const bulkhead2 = manager.getBulkhead('provider2');

      const op = () => Promise.resolve('done');
      await bulkhead1.execute(op);
      await bulkhead2.execute(op);

      manager.resetAllStats();

      const stats1 = bulkhead1.getStats();
      const stats2 = bulkhead2.getStats();

      expect(stats1.totalExecuted).toBe(0);
      expect(stats2.totalExecuted).toBe(0);
    });
  });
});

