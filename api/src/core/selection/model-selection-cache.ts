// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Enterprise-Grade Model Selection Cache
 *
 * Provides high-performance caching for model selection results
 * with automatic TTL, memory management, and metrics tracking.
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'model-selection-cache' });

/**
 * Cache entry with metadata
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  hits: number;
  lastAccessed: number;
  size: number; // Estimated memory size in bytes
}

/**
 * Cache statistics
 */
interface CacheStats {
  totalEntries: number;
  totalHits: number;
  totalMisses: number;
  totalEvictions: number;
  totalSize: number;
  hitRate: number;
  averageEntrySize: number;
  uptime: number;
}

/**
 * Enterprise model selection cache
 */
export class ModelSelectionCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private readonly maxSize: number;
  private readonly defaultTTL: number;
  private readonly cleanupInterval: number;
  private cleanupTimer?: NodeJS.Timeout;
  private stats: CacheStats;
  private startTime: number;

  constructor(
    options: {
      maxSize?: number; // Max entries
      defaultTTL?: number; // Default TTL in ms
      cleanupInterval?: number; // Cleanup interval in ms
    } = {}
  ) {
    this.maxSize = options.maxSize || 10000;
    this.defaultTTL = options.defaultTTL || 5 * 60 * 1000; // 5 minutes
    this.cleanupInterval = options.cleanupInterval || 60 * 1000; // 1 minute
    this.startTime = Date.now();

    this.stats = {
      totalEntries: 0,
      totalHits: 0,
      totalMisses: 0,
      totalEvictions: 0,
      totalSize: 0,
      hitRate: 0,
      averageEntrySize: 0,
      uptime: 0,
    };

    this.startCleanupTimer();
    log.info({ options }, 'Model selection cache initialized');
  }

  /**
   * Get cached value with automatic TTL check
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.totalMisses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      this.stats.totalEvictions++;
      this.updateStats();
      return null;
    }

    // Update access metadata
    entry.hits++;
    entry.lastAccessed = Date.now();

    this.stats.totalHits++;
    this.updateStats();

    log.debug({ key, hits: entry.hits }, 'Cache hit');
    return entry.data as T | null;
  }

  /**
   * Set cached value with TTL
   */
  set<T>(key: string, value: T, ttl?: number): void {
    const now = Date.now();
    const actualTTL = ttl || this.defaultTTL;

    // Estimate size (rough calculation)
    const size = this.estimateSize(value);

    // Check if we need to evict entries
    if (this.cache.size >= this.maxSize) {
      this.evictEntries();
    }

    const entry: CacheEntry<T> = {
      data: value,
      timestamp: now,
      ttl: actualTTL,
      hits: 0,
      lastAccessed: now,
      size,
    };

    this.cache.set(key, entry);
    this.stats.totalSize += size;
    this.updateStats();

    log.debug({ key, ttl: actualTTL, size }, 'Cache set');
  }

  /**
   * Delete cached value
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.stats.totalSize -= entry.size;
      this.cache.delete(key);
      this.updateStats();
      log.debug({ key }, 'Cache delete');
      return true;
    }
    return false;
  }

  /**
   * Clear all cached values
   */
  clear(): void {
    this.cache.clear();
    this.stats.totalSize = 0;
    this.updateStats();
    log.info('Cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const uptime = Date.now() - this.startTime;
    const totalRequests = this.stats.totalHits + this.stats.totalMisses;

    return {
      ...this.stats,
      hitRate: totalRequests > 0 ? this.stats.totalHits / totalRequests : 0,
      averageEntrySize: this.cache.size > 0 ? this.stats.totalSize / this.cache.size : 0,
      uptime,
    };
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Check if key exists and is valid
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Check TTL
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      this.stats.totalEvictions++;
      this.updateStats();
      return false;
    }

    return true;
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      const entry = this.cache.get(key);
      if (entry) {
        this.stats.totalSize -= entry.size;
        this.cache.delete(key);
        this.stats.totalEvictions++;
      }
    }

    if (keysToDelete.length > 0) {
      log.debug({ evicted: keysToDelete.length }, 'Expired entries cleaned up');
    }

    this.updateStats();
  }

  /**
   * Evict entries using LRU strategy when cache is full
   */
  private evictEntries(): void {
    // Sort entries by last accessed time (oldest first)
    const entries = Array.from(this.cache.entries())
      .map(([key, entry]) => ({ key, entry }))
      .sort((a, b) => a.entry.lastAccessed - b.entry.lastAccessed);

    // Evict 10% of entries or at least 1
    const toEvict = Math.max(1, Math.floor(this.maxSize * 0.1));

    for (let i = 0; i < toEvict && this.cache.size >= this.maxSize; i++) {
      const { key, entry } = entries[i];
      this.stats.totalSize -= entry.size;
      this.cache.delete(key);
      this.stats.totalEvictions++;
    }

    log.debug({ evicted: toEvict }, 'LRU eviction performed');
  }

  /**
   * Estimate memory size of a value (rough approximation)
   */
  private estimateSize(value: unknown): number {
    try {
      const jsonString = JSON.stringify(value);
      return jsonString.length * 2; // Rough estimate: 2 bytes per character
    } catch {
      return 1024; // Default estimate for non-serializable objects
    }
  }

  /**
   * Update cache statistics
   */
  private updateStats(): void {
    this.stats.totalEntries = this.cache.size;
  }

  /**
   * Start automatic cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.cleanupInterval);
  }

  /**
   * Stop cleanup timer
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.clear();
    log.info('Model selection cache destroyed');
  }
}

/**
 * Global cache instance
 */
let globalCache: ModelSelectionCache | null = null;

/**
 * Get or create global cache instance
 */
export function getModelSelectionCache(): ModelSelectionCache {
  if (!globalCache) {
    globalCache = new ModelSelectionCache({
      maxSize: parseInt(process.env.MODEL_SELECTION_CACHE_SIZE || '10000'),
      defaultTTL: parseInt(process.env.MODEL_SELECTION_CACHE_TTL || '300000'), // 5 minutes
      cleanupInterval: parseInt(process.env.MODEL_SELECTION_CACHE_CLEANUP_INTERVAL || '60000'), // 1 minute
    });
  }
  return globalCache;
}

/**
 * Reset global cache
 */
export function resetModelSelectionCache(): void {
  if (globalCache) {
    globalCache.destroy();
    globalCache = null;
  }
}
