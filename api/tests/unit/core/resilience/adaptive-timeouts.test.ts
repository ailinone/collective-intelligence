// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Adaptive Timeouts Tests
 * 
 * Tests P95-based dynamic timeout adjustment
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AdaptiveTimeoutTracker,
  AdaptiveTimeoutManager,
  type AdaptiveTimeoutConfig,
} from '@/core/resilience/adaptive-timeouts';

const redisStore = new Map<string, Array<{ score: number; value: string }>>();

const redisClientMock = {
  zadd: vi.fn(async (key: string, score: number, value: string) => {
    const entries = redisStore.get(key) ?? [];
    entries.push({ score: Number(score), value: String(value) });
    redisStore.set(key, entries);
    return 1;
  }),
  zremrangebyscore: vi.fn(async (key: string, min: string | number, max: string | number) => {
    const entries = redisStore.get(key) ?? [];
    const minScore = min === '-inf' ? -Infinity : Number(min);
    const maxScore = max === '+inf' ? Infinity : Number(max);
    const filtered = entries.filter(entry => entry.score < minScore || entry.score > maxScore);
    redisStore.set(key, filtered);
    return entries.length - filtered.length;
  }),
  expire: vi.fn(async () => true),
  zrange: vi.fn(async (key: string, start: number, end: number) => {
    const entries = (redisStore.get(key) ?? []).slice().sort((a, b) => a.score - b.score);
    const begin = start < 0 ? 0 : start;
    const finish = end === -1 ? entries.length : end + 1;
    return entries.slice(begin, finish).map(entry => entry.value);
  }),
  del: vi.fn(async (key: string) => (redisStore.delete(key) ? 1 : 0)),
};

vi.mock('@/cache/redis-client', () => ({
  getRedisClient: vi.fn(() => redisClientMock),
}));

describe('AdaptiveTimeoutTracker', () => {
  let config: AdaptiveTimeoutConfig;

  beforeEach(() => {
    config = {
      name: 'test-operation',
      p95Multiplier: 2.0,
      minTimeout: 1000,
      maxTimeout: 10000,
      sampleSize: 10,
      updateInterval: 100,
    };
    redisStore.clear();
    Object.values(redisClientMock).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
  });

  describe('recordLatency and adaptive adjustment', () => {
    it('should start with minimum timeout', async () => {
      const tracker = new AdaptiveTimeoutTracker(config);
      
      const timeout = await tracker.getTimeout();
      expect(timeout).toBe(config.minTimeout);
    });

    it('should adjust timeout based on recorded latencies', async () => {
      config.updateInterval = 10; // Fast updates for testing
      const tracker = new AdaptiveTimeoutTracker(config);
      
      // Record consistent 2000ms latencies
      for (let i = 0; i < 10; i++) {
        await tracker.recordLatency(2000);
      }

      // Wait for update
      await new Promise(resolve => setTimeout(resolve, 20));

      const timeout = await tracker.getTimeout();
      
      // Should be around P95 (2000) * 2 = 4000
      expect(timeout).toBeGreaterThan(3000);
      expect(timeout).toBeLessThan(5000);
    });

    it('should not go below minimum timeout', async () => {
      config.updateInterval = 10;
      const tracker = new AdaptiveTimeoutTracker(config);
      
      // Record very fast latencies
      for (let i = 0; i < 10; i++) {
        await tracker.recordLatency(10); // 10ms
      }

      await new Promise(resolve => setTimeout(resolve, 20));

      const timeout = await tracker.getTimeout();
      
      // Should be at minimum
      expect(timeout).toBe(config.minTimeout);
    });

    it('should not exceed maximum timeout', async () => {
      config.updateInterval = 10;
      config.maxTimeout = 5000;
      const tracker = new AdaptiveTimeoutTracker(config);
      
      // Record very slow latencies
      for (let i = 0; i < 10; i++) {
        await tracker.recordLatency(10000); // 10s
      }

      await new Promise(resolve => setTimeout(resolve, 20));

      const timeout = await tracker.getTimeout();
      
      // Should be at maximum
      expect(timeout).toBe(config.maxTimeout);
    });

    it('should adapt to changing latencies', async () => {
      config.updateInterval = 10;
      const tracker = new AdaptiveTimeoutTracker(config);
      
      // Start with fast latencies
      for (let i = 0; i < 5; i++) {
        await tracker.recordLatency(1000);
      }

      await new Promise(resolve => setTimeout(resolve, 20));
      const timeout1 = await tracker.getTimeout();

      // Change to slow latencies
      for (let i = 0; i < 5; i++) {
        await tracker.recordLatency(5000);
      }

      await new Promise(resolve => setTimeout(resolve, 20));
      const timeout2 = await tracker.getTimeout();

      // Timeout should have increased
      expect(timeout2).toBeGreaterThan(timeout1);
    });
  });

  describe('getStats', () => {
    it('should return accurate percentile statistics', async () => {
      const tracker = new AdaptiveTimeoutTracker(config);
      
      // Record latencies: 1000, 2000, 3000, 4000, 5000
      const latencies = [1000, 2000, 3000, 4000, 5000];
      for (const lat of latencies) {
        await tracker.recordLatency(lat);
      }

      const stats = await tracker.getStats();

      expect(stats.name).toBe('test-operation');
      expect(stats.p50).toBeGreaterThan(2500);
      expect(stats.p50).toBeLessThan(3500);
      expect(stats.p95).toBeGreaterThan(4500);
      expect(stats.min).toBe(1000);
      expect(stats.max).toBe(5000);
      expect(stats.sampleSize).toBe(5);
    });

    it('should handle empty latencies', async () => {
      const tracker = new AdaptiveTimeoutTracker(config);
      
      const stats = await tracker.getStats();

      expect(stats.sampleSize).toBe(0);
      expect(stats.p50).toBe(0);
      expect(stats.p95).toBeGreaterThan(0); // Should use default
    });
  });

  describe('reset', () => {
    it('should reset to initial state', async () => {
      const tracker = new AdaptiveTimeoutTracker(config);
      
      // Record some latencies
      await tracker.recordLatency(5000);
      await tracker.recordLatency(5000);
      await tracker.recordLatency(5000);

      // Reset
      await tracker.reset();

      const stats = await tracker.getStats();
      expect(stats.sampleSize).toBe(0);
      
      const timeout = await tracker.getTimeout();
      expect(timeout).toBe(config.minTimeout);
    });
  });
});

describe('AdaptiveTimeoutManager', () => {
  let manager: AdaptiveTimeoutManager;

  beforeEach(() => {
    manager = new AdaptiveTimeoutManager();
  });

  describe('getTracker', () => {
    it('should create tracker with default config for type', () => {
      const tracker = manager.getTracker('test-op', 'llm-chat');
      expect(tracker).toBeDefined();
    });

    it('should reuse existing tracker', () => {
      const tracker1 = manager.getTracker('test-op', 'llm-chat');
      const tracker2 = manager.getTracker('test-op', 'llm-chat');
      
      expect(tracker1).toBe(tracker2);
    });

    it('should create separate trackers for different operations', () => {
      const tracker1 = manager.getTracker('op1', 'llm-chat');
      const tracker2 = manager.getTracker('op2', 'llm-chat');
      
      expect(tracker1).not.toBe(tracker2);
    });
  });

  describe('recordLatency', () => {
    it('should record latency for operation', async () => {
      await manager.recordLatency('test-op', 2000, 'llm-chat');
      
      const stats = await manager.getTracker('test-op', 'llm-chat').getStats();
      expect(stats.sampleSize).toBeGreaterThan(0);
    });
  });

  describe('getTimeout', () => {
    it('should return timeout for operation', async () => {
      const timeout = await manager.getTimeout('test-op', 'llm-chat');
      expect(timeout).toBeGreaterThan(0);
    });

    it('should return different timeouts for different types', async () => {
      const chatTimeout = await manager.getTimeout('op1', 'llm-chat');
      const dbTimeout = await manager.getTimeout('op2', 'database');
      
      // LLM chat has higher min timeout than database
      expect(chatTimeout).toBeGreaterThan(dbTimeout);
    });
  });

  describe('getAllStats', () => {
    it('should return stats for all trackers', async () => {
      manager.getTracker('op1', 'llm-chat');
      manager.getTracker('op2', 'database');
      manager.getTracker('op3', 'redis');

      const stats = await manager.getAllStats();
      
      expect(stats.length).toBeGreaterThanOrEqual(3);
      expect(stats.every(s => s.name)).toBe(true);
    });
  });

  describe('resetAll', () => {
    it('should reset all trackers', async () => {
      const tracker1 = manager.getTracker('op1');
      const tracker2 = manager.getTracker('op2');

      await tracker1.recordLatency(5000);
      await tracker2.recordLatency(5000);

      await manager.resetAll();

      const stats1 = await tracker1.getStats();
      const stats2 = await tracker2.getStats();

      expect(stats1.sampleSize).toBe(0);
      expect(stats2.sampleSize).toBe(0);
    });
  });
});

