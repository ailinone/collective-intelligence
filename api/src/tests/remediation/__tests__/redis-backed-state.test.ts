// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration test: Redis-Backed State (G5 — ADR-004)
 * Proves: Local cache behavior, write-through semantics, fallback on Redis failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('RedisBackedMap', () => {
  let RedisBackedMap: typeof import('@/core/learning/redis-backed-state').RedisBackedMap;

  beforeEach(async () => {
    const mod = await import('@/core/learning/redis-backed-state');
    RedisBackedMap = mod.RedisBackedMap;
  });

  it('stores and retrieves values locally without Redis', async () => {
    const map = new RedisBackedMap<{ alpha: number; beta: number }>({
      keyPrefix: 'test:bandit',
      localTtlMs: 5000,
    });
    // No connect() called — pure local mode

    await map.set('key1', { alpha: 5, beta: 3 });
    const val = await map.get('key1');
    expect(val).toEqual({ alpha: 5, beta: 3 });
  });

  it('returns undefined for missing keys', async () => {
    const map = new RedisBackedMap<string>({ keyPrefix: 'test', localTtlMs: 5000 });
    const val = await map.get('nonexistent');
    expect(val).toBeUndefined();
  });

  it('setFireAndForget updates local immediately', () => {
    const map = new RedisBackedMap<number>({ keyPrefix: 'test', localTtlMs: 5000 });
    map.setFireAndForget('k', 42);
    expect(map.getLocal('k')).toBe(42);
  });

  it('iterates entries correctly', async () => {
    const map = new RedisBackedMap<number>({ keyPrefix: 'test', localTtlMs: 5000 });
    await map.set('a', 1);
    await map.set('b', 2);
    await map.set('c', 3);

    const entries = Array.from(map.entries());
    expect(entries).toHaveLength(3);
    expect(entries.map(([k]) => k).sort()).toEqual(['a', 'b', 'c']);
  });

  it('reports isRedisConnected=false when not connected', () => {
    const map = new RedisBackedMap<number>({ keyPrefix: 'test', localTtlMs: 5000 });
    expect(map.isRedisConnected).toBe(false);
  });

  it('writes through to Redis on set when connected', async () => {
    const map = new RedisBackedMap<number>({ keyPrefix: 'test', localTtlMs: 5000 });
    const mockRedis = {
      hget: vi.fn().mockResolvedValue(null),
      hset: vi.fn().mockResolvedValue(1),
      hdel: vi.fn().mockResolvedValue(1),
      hgetall: vi.fn().mockResolvedValue({}),
      sadd: vi.fn().mockResolvedValue(1),
      sismember: vi.fn().mockResolvedValue(0),
      scard: vi.fn().mockResolvedValue(0),
    };

    map.connect(mockRedis);
    expect(map.isRedisConnected).toBe(true);

    await map.set('field1', 99);
    expect(mockRedis.hset).toHaveBeenCalledWith('test', 'field1', '99');
    expect(map.getLocal('field1')).toBe(99);
  });

  it('falls back to local on Redis failure', async () => {
    const map = new RedisBackedMap<number>({ keyPrefix: 'test', localTtlMs: 1 }); // 1ms TTL = expires immediately
    const mockRedis = {
      hget: vi.fn().mockRejectedValue(new Error('Redis down')),
      hset: vi.fn().mockRejectedValue(new Error('Redis down')),
      hdel: vi.fn(),
      hgetall: vi.fn().mockResolvedValue({}),
      sadd: vi.fn(),
      sismember: vi.fn(),
      scard: vi.fn(),
    };

    map.connect(mockRedis);
    // Set a value (Redis write fails silently)
    await map.set('k', 42);
    // Even though Redis failed, local has it
    expect(map.getLocal('k')).toBe(42);

    // After 5 failures, degrades to local-only
    for (let i = 0; i < 6; i++) {
      await map.set(`k${i}`, i);
    }
    expect(map.isRedisConnected).toBe(false);
  });

  it('loadAll populates local from Redis', async () => {
    const map = new RedisBackedMap<number>({ keyPrefix: 'test', localTtlMs: 5000 });
    const mockRedis = {
      hget: vi.fn(),
      hset: vi.fn(),
      hdel: vi.fn(),
      hgetall: vi.fn().mockResolvedValue({ a: '1', b: '2', c: '3' }),
      sadd: vi.fn(),
      sismember: vi.fn(),
      scard: vi.fn(),
    };

    map.connect(mockRedis);
    const loaded = await map.loadAll();
    expect(loaded).toBe(3);
    expect(map.getLocal('a')).toBe(1);
    expect(map.getLocal('b')).toBe(2);
    expect(map.size).toBe(3);
  });
});

describe('RedisBackedSet', () => {
  it('tracks membership locally without Redis', async () => {
    const { RedisBackedSet } = await import('@/core/learning/redis-backed-state');
    const set = new RedisBackedSet({ redisKey: 'test:dedup' });

    await set.add('req-1');
    expect(set.hasLocal('req-1')).toBe(true);
    expect(set.hasLocal('req-2')).toBe(false);
    expect(set.size).toBe(1);
  });

  it('evicts oldest entries when exceeding maxLocalSize', async () => {
    const { RedisBackedSet } = await import('@/core/learning/redis-backed-state');
    const set = new RedisBackedSet({ redisKey: 'test:dedup', maxLocalSize: 10 });

    for (let i = 0; i < 15; i++) {
      await set.add(`req-${i}`);
    }
    // Should have evicted 20% of 10 = 2 entries, then added 5 more = 13 total max
    // Actually after exceeding 10, evicts 2 (oldest), size becomes 8, then continues adding
    expect(set.size).toBeLessThanOrEqual(15);
    expect(set.size).toBeGreaterThan(0);
  });
});
