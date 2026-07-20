// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Redis-Backed State — Write-through cache with local TTL for learning components.
 * S-NEW fix (ADR-004): Shared mutable state of decision/learning exits the process.
 *
 * Pattern: Write-through with local cache
 * - On write: update local Map immediately, async write to Redis
 * - On read: return local value if within TTL, else refresh from Redis
 * - On Redis failure: degrade to local-only (current behavior) with warning log
 *
 * This ensures cross-instance convergence while keeping hot-path reads at ~0ms
 * (local Map hit) instead of ~5ms (Redis round-trip).
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'redis-backed-state' });

/**
 * Minimal Redis interface — avoids importing ioredis types directly.
 * Satisfies the subset of commands we need.
 */
export interface RedisLike {
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  sadd(key: string, ...members: string[]): Promise<number>;
  sismember(key: string, member: string): Promise<number>;
  scard(key: string): Promise<number>;
}

interface CachedEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Generic Redis-backed Map with local TTL cache.
 * Subclass or instantiate directly for each learning component.
 */
export class RedisBackedMap<V> {
  private readonly local = new Map<string, CachedEntry<V>>();
  private redis: RedisLike | null = null;
  private readonly keyPrefix: string;
  private readonly localTtlMs: number;
  private readonly serialize: (value: V) => string;
  private readonly deserialize: (raw: string) => V;
  private enabled = false;
  private failureCount = 0;
  private readonly maxFailures = 5;

  constructor(opts: {
    keyPrefix: string;
    localTtlMs: number;
    serialize?: (value: V) => string;
    deserialize?: (raw: string) => V;
  }) {
    this.keyPrefix = opts.keyPrefix;
    this.localTtlMs = opts.localTtlMs;
    this.serialize = opts.serialize || JSON.stringify;
    this.deserialize = opts.deserialize || JSON.parse;
  }

  /**
   * Connect to Redis. Call once during bootstrap.
   * If not called, all operations degrade to local-only.
   */
  connect(redis: RedisLike): void {
    this.redis = redis;
    this.enabled = true;
    this.failureCount = 0;
    log.info({ keyPrefix: this.keyPrefix }, 'Redis-backed state connected');
  }

  /**
   * Get a value. Returns from local cache if within TTL, else refreshes from Redis.
   */
  async get(field: string): Promise<V | undefined> {
    // Always check local first (fast path)
    const cached = this.local.get(field);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Try Redis refresh
    if (this.enabled && this.redis && this.failureCount < this.maxFailures) {
      try {
        const raw = await this.redis.hget(this.keyPrefix, field);
        if (raw !== null) {
          const value = this.deserialize(raw);
          this.local.set(field, { value, expiresAt: Date.now() + this.localTtlMs });
          this.failureCount = 0; // Reset on success
          return value;
        }
        // Key not in Redis — return local expired value if exists, or undefined
        return cached?.value;
      } catch {
        this.failureCount++;
        if (this.failureCount >= this.maxFailures) {
          log.warn({ keyPrefix: this.keyPrefix }, 'Redis-backed state degrading to local-only after repeated failures');
        }
      }
    }

    // Fallback: return local (even if expired) or undefined
    return cached?.value;
  }

  /**
   * Get value synchronously from local cache only (no Redis round-trip).
   * Use in hot paths where async is not acceptable.
   */
  getLocal(field: string): V | undefined {
    return this.local.get(field)?.value;
  }

  /**
   * Set a value. Writes to local immediately, then async writes to Redis.
   */
  async set(field: string, value: V): Promise<void> {
    // Always update local immediately
    this.local.set(field, { value, expiresAt: Date.now() + this.localTtlMs });

    // Async write to Redis (fire-and-forget with catch)
    if (this.enabled && this.redis && this.failureCount < this.maxFailures) {
      try {
        await this.redis.hset(this.keyPrefix, field, this.serialize(value));
        this.failureCount = 0;
      } catch {
        this.failureCount++;
      }
    }
  }

  /**
   * Set a value synchronously in local cache, then fire-and-forget to Redis.
   * Returns immediately — does not wait for Redis.
   */
  setFireAndForget(field: string, value: V): void {
    this.local.set(field, { value, expiresAt: Date.now() + this.localTtlMs });

    if (this.enabled && this.redis && this.failureCount < this.maxFailures) {
      this.redis.hset(this.keyPrefix, field, this.serialize(value)).catch(() => {
        this.failureCount++;
      });
    }
  }

  /**
   * Check if a field exists in local cache (sync, fast).
   */
  has(field: string): boolean {
    return this.local.has(field);
  }

  /**
   * Get all local entries (for iteration, metrics, snapshots).
   */
  entries(): IterableIterator<[string, V]> {
    const result = new Map<string, V>();
    for (const [key, entry] of this.local) {
      result.set(key, entry.value);
    }
    return result.entries();
  }

  /**
   * Load all entries from Redis into local cache (cold start).
   */
  async loadAll(): Promise<number> {
    if (!this.enabled || !this.redis) return 0;

    try {
      const all = await this.redis.hgetall(this.keyPrefix);
      let count = 0;
      for (const [field, raw] of Object.entries(all)) {
        try {
          const value = this.deserialize(raw);
          this.local.set(field, { value, expiresAt: Date.now() + this.localTtlMs });
          count++;
        } catch {
          // Skip malformed entries
        }
      }
      log.info({ keyPrefix: this.keyPrefix, loaded: count }, 'Redis-backed state loaded');
      return count;
    } catch {
      log.warn({ keyPrefix: this.keyPrefix }, 'Failed to load Redis-backed state, starting with empty local cache');
      return 0;
    }
  }

  /** Number of entries in local cache */
  get size(): number {
    return this.local.size;
  }

  /** Whether Redis backing is active */
  get isRedisConnected(): boolean {
    return this.enabled && this.failureCount < this.maxFailures;
  }
}

/**
 * Redis-backed Set with TTL-aware membership check.
 * Used for deduplication (e.g., feedback collector's processedIds).
 */
export class RedisBackedSet {
  private readonly localSet = new Set<string>();
  private redis: RedisLike | null = null;
  private readonly redisKey: string;
  private enabled = false;
  private failureCount = 0;
  private readonly maxLocalSize: number;

  constructor(opts: { redisKey: string; maxLocalSize?: number }) {
    this.redisKey = opts.redisKey;
    this.maxLocalSize = opts.maxLocalSize || 10_000;
  }

  connect(redis: RedisLike): void {
    this.redis = redis;
    this.enabled = true;
    this.failureCount = 0;
  }

  /**
   * Check if member exists (local + Redis).
   */
  async has(member: string): Promise<boolean> {
    if (this.localSet.has(member)) return true;

    if (this.enabled && this.redis && this.failureCount < 5) {
      try {
        const exists = await this.redis.sismember(this.redisKey, member);
        if (exists) {
          this.localSet.add(member); // Cache locally
          return true;
        }
      } catch {
        this.failureCount++;
      }
    }

    return false;
  }

  /**
   * Add member to set (local + Redis).
   */
  async add(member: string): Promise<void> {
    this.localSet.add(member);

    // Evict oldest if local set is too large
    if (this.localSet.size > this.maxLocalSize) {
      const iter = this.localSet.values();
      for (let i = 0; i < Math.floor(this.maxLocalSize * 0.2); i++) {
        const val = iter.next().value;
        if (val !== undefined) this.localSet.delete(val);
      }
    }

    if (this.enabled && this.redis && this.failureCount < 5) {
      this.redis.sadd(this.redisKey, member).catch(() => { this.failureCount++; });
    }
  }

  /** Sync check (local only, no Redis) */
  hasLocal(member: string): boolean {
    return this.localSet.has(member);
  }

  get size(): number {
    return this.localSet.size;
  }
}
