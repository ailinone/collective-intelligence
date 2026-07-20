// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Token Bucket Rate Limiter
 *
 * Advanced rate limiting using token bucket algorithm.
 * Superior to simple counters because:
 * - Allows burst traffic while maintaining average rate
 * - More flexible and fair
 * - Industry-standard algorithm (used by AWS, Google, etc.)
 *
 * Algorithm:
 * - Bucket has a capacity of N tokens
 * - Tokens are added at a fixed rate R
 * - Each request consumes 1 token
 * - If no tokens available, request is rejected
 * - Allows bursts up to capacity while limiting average rate
 */

import { logger } from '@/utils/logger';
import { getRedisClient } from '@/cache/redis-client';
import { config as appConfig } from '@/config';

export interface TokenBucketConfig {
  /**
   * Maximum tokens the bucket can hold (burst capacity)
   */
  capacity: number;

  /**
   * Tokens added per second (average rate)
   */
  refillRate: number;

  /**
   * Identifier for this bucket (e.g., API key, user ID, IP)
   */
  identifier: string;

  /**
   * Scope of the bucket (e.g., 'api-key', 'ip-address')
   */
  scope: string;

  /**
   * Force distributed mode even in test/local environments
   */
  forceDistributed?: boolean;
}

export interface TokenBucketStats {
  identifier: string;
  scope: string;
  tokensAvailable: number;
  capacity: number;
  refillRate: number;
  lastRefill: number;
  totalRequests: number;
  totalRejected: number;
  rejectionRate: number;
}

/**
 * Token Bucket Implementation
 *
 * Thread-safe, distributed-ready using Redis for state
 */
export class TokenBucket {
  private config: TokenBucketConfig;
  private redisKey: string;

  // Local cache for single-instance scenarios (fallback)
  private localTokens: number;
  private localLastRefill: number;
  private localFractionalTokens: number;
  private localStats = {
    totalRequests: 0,
    totalRejected: 0,
  };

  private useLocalFallback = false;

  constructor(config: TokenBucketConfig) {
    this.config = config;
    this.redisKey = `rate-limit:token-bucket:${config.scope}:${config.identifier}`;
    this.localTokens = config.capacity;
    this.localLastRefill = Date.now();
    this.localFractionalTokens = 0;
    const shouldForceDistributed =
      config.forceDistributed === true ||
      appConfig.resilience.forceDistributedTokenBuckets ||
      process.env.FORCE_DISTRIBUTED_TOKEN_BUCKETS === 'true';

    if (
      !shouldForceDistributed &&
      (process.env.NODE_ENV === 'test' || process.env.TEST_USE_LOCAL_SERVICES === 'true')
    ) {
      this.useLocalFallback = true;
    }

    logger.debug(
      {
        identifier: config.identifier,
        scope: config.scope,
        capacity: config.capacity,
        refillRate: config.refillRate,
      },
      'Token bucket created'
    );
  }

  /**
   * Try to consume tokens from bucket
   *
   * @param tokens Number of tokens to consume (default: 1)
   * @returns true if tokens were consumed, false if rejected
   */
  async consume(tokens: number = 1): Promise<boolean> {
    this.localStats.totalRequests++;

    if (this.useLocalFallback) {
      const consumed = this.consumeLocal(tokens);
      if (!consumed) {
        logger.warn(
          {
            identifier: this.config.identifier,
            scope: this.config.scope,
            tokensRequested: tokens,
          },
          'Rate limit exceeded (token bucket)'
        );
      }
      return consumed;
    }

    try {
      // Try Redis-based bucket first (distributed)
      const consumed = await this.consumeRedis(tokens);

      if (!consumed) {
        this.localStats.totalRejected++;

        logger.warn(
          {
            identifier: this.config.identifier,
            scope: this.config.scope,
            tokensRequested: tokens,
          },
          'Rate limit exceeded (token bucket)'
        );
      }

      return consumed;
    } catch (error) {
      // Fallback to local bucket if Redis fails
      logger.warn(
        { error, identifier: this.config.identifier },
        'Redis token bucket failed, using local fallback'
      );
      this.useLocalFallback = true;

      return this.consumeLocal(tokens);
    }
  }

  /**
   * Consume tokens AND return the resulting stats in one call — used by callers
   * (the rate-limit middleware) that need both the allow/deny decision and the
   * `X-RateLimit-*` header values. Saves a second Redis round-trip vs.
   * `consume()` followed by `getStats()`, since the Lua script already computes
   * the post-consume token count atomically (see `consumeRedisWithState`).
   */
  async consumeWithStats(tokens: number = 1): Promise<{ allowed: boolean; stats: TokenBucketStats }> {
    this.localStats.totalRequests++;

    if (this.useLocalFallback) {
      const allowed = this.consumeLocal(tokens);
      return { allowed, stats: await this.getStats() };
    }

    try {
      const { allowed, tokensAvailable, totalRequests, totalRejected } =
        await this.consumeRedisWithState(tokens);

      if (!allowed) {
        this.localStats.totalRejected++;
        logger.warn(
          { identifier: this.config.identifier, scope: this.config.scope, tokensRequested: tokens },
          'Rate limit exceeded (token bucket)'
        );
      }

      return {
        allowed,
        stats: {
          identifier: this.config.identifier,
          scope: this.config.scope,
          tokensAvailable,
          capacity: this.config.capacity,
          refillRate: this.config.refillRate,
          lastRefill: Date.now(),
          totalRequests,
          totalRejected,
          rejectionRate: totalRequests > 0 ? totalRejected / totalRequests : 0,
        },
      };
    } catch (error) {
      logger.warn(
        { error, identifier: this.config.identifier },
        'Redis token bucket failed, using local fallback'
      );
      this.useLocalFallback = true;
      const allowed = this.consumeLocal(tokens);
      return { allowed, stats: await this.getStats() };
    }
  }

  /**
   * Consume tokens using Redis (distributed)
   */
  /**
   * Atomically consume tokens AND return the post-consume bucket state, in
   * ONE Redis round-trip. The Lua script already computes `tokens` (after
   * refill+consume) and `totalRequests`/`totalRejected` — returning them here
   * lets the caller build rate-limit headers without a second `getStats()`
   * round-trip (HGETALL) immediately after. `consume()` still calls this and
   * discards the extra fields for callers that only need the boolean.
   */
  private async consumeRedisWithState(
    tokens: number
  ): Promise<{ allowed: boolean; tokensAvailable: number; totalRequests: number; totalRejected: number }> {
    const redis = getRedisClient();
    const now = Date.now();
    const key = this.redisKey;

    // Lua script for atomic token bucket operation
    const script = `
      local key = KEYS[1]
      local capacity = tonumber(ARGV[1])
      local refillRate = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])
      local tokensRequested = tonumber(ARGV[4])

      -- Get current state or initialize
      local state = redis.call('HMGET', key, 'tokens', 'lastRefill')
      local tokens = tonumber(state[1]) or capacity
      local lastRefill = tonumber(state[2]) or now

      -- Calculate tokens to add based on time elapsed
      local elapsedSeconds = (now - lastRefill) / 1000
      local tokensToAdd = elapsedSeconds * refillRate
      tokens = math.min(capacity, tokens + tokensToAdd)

      -- Try to consume tokens
      local allowed
      if tokens >= tokensRequested then
        tokens = tokens - tokensRequested
        redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', now)
        redis.call('EXPIRE', key, 3600) -- 1 hour TTL
        redis.call('HINCRBY', key, 'totalRequests', 1)
        allowed = 1
      else
        redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', now)
        redis.call('EXPIRE', key, 3600)
        redis.call('HINCRBY', key, 'totalRequests', 1)
        redis.call('HINCRBY', key, 'totalRejected', 1)
        allowed = 0
      end

      local finalState = redis.call('HMGET', key, 'totalRequests', 'totalRejected')
      return {allowed, tostring(tokens), finalState[1] or '0', finalState[2] or '0'}
    `;

    const result = (await redis.eval(
      script,
      1,
      key,
      this.config.capacity.toString(),
      this.config.refillRate.toString(),
      now.toString(),
      tokens.toString()
    )) as [number, string, string, string];

    return {
      allowed: result[0] === 1,
      tokensAvailable: parseFloat(result[1]),
      totalRequests: parseInt(result[2], 10),
      totalRejected: parseInt(result[3], 10),
    };
  }

  private async consumeRedis(tokens: number): Promise<boolean> {
    const { allowed } = await this.consumeRedisWithState(tokens);
    return allowed;
  }

  /**
   * Consume tokens using local state (fallback)
   */
  private consumeLocal(tokens: number): boolean {
    const now = Date.now();
    const elapsedSeconds = (now - this.localLastRefill) / 1000;

    // Refill tokens based on elapsed time
    const tokensToAdd = elapsedSeconds * this.config.refillRate;
    this.localFractionalTokens += tokensToAdd;

    if (this.localFractionalTokens >= 1) {
      const wholeTokens = Math.floor(this.localFractionalTokens);
      const availableCapacity = this.config.capacity - this.localTokens;
      const tokensApplied = Math.min(wholeTokens, availableCapacity);

      if (tokensApplied > 0) {
        this.localTokens += tokensApplied;
        this.localFractionalTokens -= tokensApplied;
      } else {
        // Bucket is already at capacity, discard fractional overflow
        this.localFractionalTokens = Math.min(this.localFractionalTokens, this.config.capacity);
      }
    }

    // Prevent fractional accumulation from growing when bucket is full
    if (this.localTokens >= this.config.capacity) {
      this.localFractionalTokens = 0;
    }

    this.localLastRefill = now;

    // Try to consume
    if (this.localTokens >= tokens) {
      this.localTokens -= tokens;
      return true;
    } else {
      this.localStats.totalRejected++;
      return false;
    }
  }

  /**
   * Get current bucket statistics
   */
  async getStats(): Promise<TokenBucketStats> {
    if (this.useLocalFallback) {
      return {
        identifier: this.config.identifier,
        scope: this.config.scope,
        tokensAvailable: this.localTokens,
        capacity: this.config.capacity,
        refillRate: this.config.refillRate,
        lastRefill: this.localLastRefill,
        totalRequests: this.localStats.totalRequests,
        totalRejected: this.localStats.totalRejected,
        rejectionRate:
          this.localStats.totalRequests > 0
            ? this.localStats.totalRejected / this.localStats.totalRequests
            : 0,
      };
    }

    try {
      const redis = getRedisClient();
      const state = await redis.hgetall(this.redisKey);

      return {
        identifier: this.config.identifier,
        scope: this.config.scope,
        tokensAvailable: parseFloat(state.tokens || this.config.capacity.toString()),
        capacity: this.config.capacity,
        refillRate: this.config.refillRate,
        lastRefill: parseInt(state.lastRefill || Date.now().toString()),
        totalRequests: parseInt(state.totalRequests || '0'),
        totalRejected: parseInt(state.totalRejected || '0'),
        rejectionRate:
          parseInt(state.totalRequests || '0') > 0
            ? parseInt(state.totalRejected || '0') / parseInt(state.totalRequests || '0')
            : 0,
      };
    } catch (error) {
      // Fallback to local stats
      return {
        identifier: this.config.identifier,
        scope: this.config.scope,
        tokensAvailable: this.localTokens,
        capacity: this.config.capacity,
        refillRate: this.config.refillRate,
        lastRefill: this.localLastRefill,
        totalRequests: this.localStats.totalRequests,
        totalRejected: this.localStats.totalRejected,
        rejectionRate:
          this.localStats.totalRequests > 0
            ? this.localStats.totalRejected / this.localStats.totalRequests
            : 0,
      };
    }
  }

  /**
   * Reset bucket to full capacity
   */
  async reset(): Promise<void> {
    if (this.useLocalFallback) {
      this.localTokens = this.config.capacity;
      this.localLastRefill = Date.now();
      this.localFractionalTokens = 0;
      this.localStats = {
        totalRequests: 0,
        totalRejected: 0,
      };
      logger.info(
        { identifier: this.config.identifier, scope: this.config.scope, mode: 'local' },
        'Token bucket reset (local fallback)'
      );
      return;
    }

    try {
      const redis = getRedisClient();
      await redis.del(this.redisKey);
    } catch (error) {
      logger.warn({ error }, 'Failed to reset Redis bucket, resetting local');
      this.useLocalFallback = true;
    }

    this.localTokens = this.config.capacity;
    this.localLastRefill = Date.now();
    this.localFractionalTokens = 0;
    this.localStats = {
      totalRequests: 0,
      totalRejected: 0,
    };

    logger.info(
      { identifier: this.config.identifier, scope: this.config.scope },
      'Token bucket reset'
    );
  }

  /**
   * Get time until tokens are available (ms)
   */
  async getRetryAfter(tokensNeeded: number = 1): Promise<number> {
    const stats = await this.getStats();

    if (stats.tokensAvailable >= tokensNeeded) {
      return 0;
    }

    const tokensShort = tokensNeeded - stats.tokensAvailable;
    const secondsToWait = tokensShort / this.config.refillRate;

    return Math.ceil(secondsToWait * 1000);
  }
}

/**
 * Token Bucket Manager
 *
 * Manages buckets for multiple identifiers with different scopes
 */
export class TokenBucketManager {
  private buckets = new Map<string, TokenBucket>();

  /**
   * Default configurations by scope
   */
  private defaultConfigs: Record<string, Omit<TokenBucketConfig, 'identifier' | 'scope'>> = {
    // API Key rate limiting
    'api-key': {
      capacity: 1000, // Burst of 1000 requests
      refillRate: 10, // 10 req/s sustained (36K req/hour)
    },

    // IP Address rate limiting
    'ip-address': {
      capacity: 100, // Burst of 100 requests
      refillRate: 1, // 1 req/s sustained (3.6K req/hour)
    },

    // User rate limiting
    user: {
      capacity: 500, // Burst of 500 requests
      refillRate: 5, // 5 req/s sustained (18K req/hour)
    },

    // Organization rate limiting
    organization: {
      capacity: 5000, // Burst of 5000 requests
      refillRate: 50, // 50 req/s sustained (180K req/hour)
    },
  };

  /**
   * Get or create bucket for identifier
   */
  getBucket(scope: string, identifier: string, config?: Partial<TokenBucketConfig>): TokenBucket {
    const key = `${scope}:${identifier}`;

    if (!this.buckets.has(key)) {
      const bucketConfig: TokenBucketConfig = {
        ...this.getDefaultConfig(scope),
        ...config,
        scope,
        identifier,
      };

      if (
        bucketConfig.forceDistributed === undefined &&
        (appConfig.resilience.forceDistributedTokenBuckets ||
          process.env.FORCE_DISTRIBUTED_TOKEN_BUCKETS === 'true')
      ) {
        bucketConfig.forceDistributed = true;
      }

      const bucket = new TokenBucket(bucketConfig);
      this.buckets.set(key, bucket);

      logger.debug({ scope, identifier, config: bucketConfig }, 'Token bucket created');
    }

    return this.buckets.get(key)!;
  }

  getDefaultConfig(scope: string): Omit<TokenBucketConfig, 'identifier' | 'scope'> {
    return this.defaultConfigs[scope] || { capacity: 100, refillRate: 1 };
  }

  /**
   * Try to consume tokens from bucket
   */
  async consume(scope: string, identifier: string, tokens: number = 1): Promise<boolean> {
    const bucket = this.getBucket(scope, identifier);
    return bucket.consume(tokens);
  }

  /**
   * Get statistics for all buckets
   */
  async getAllStats(): Promise<TokenBucketStats[]> {
    const stats: TokenBucketStats[] = [];

    for (const bucket of this.buckets.values()) {
      stats.push(await bucket.getStats());
    }

    return stats;
  }

  /**
   * Get retry-after time for identifier
   */
  async getRetryAfter(
    scope: string,
    identifier: string,
    tokensNeeded: number = 1
  ): Promise<number> {
    const bucket = this.getBucket(scope, identifier);
    return bucket.getRetryAfter(tokensNeeded);
  }

  /**
   * Reset bucket for identifier
   */
  async resetBucket(scope: string, identifier: string): Promise<void> {
    const key = `${scope}:${identifier}`;
    const bucket = this.buckets.get(key);

    if (bucket) {
      await bucket.reset();
    }
  }

  /**
   * Clear all buckets
   */
  clearAll(): void {
    this.buckets.clear();
    logger.info('All token buckets cleared');
  }
}

// Singleton instance
export const tokenBucketManager = new TokenBucketManager();
