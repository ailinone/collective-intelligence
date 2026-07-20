// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Key Rate Limiting Middleware
 * SECURITY: Prevents abuse via API key rate limiting (T7 mitigation)
 * 
 * This middleware enforces rate limits per API key to prevent:
 * - Replay attacks with stolen API keys
 * - Resource exhaustion attacks
 * - Credential stuffing
 * 
 * Rate Limiting Strategy:
 * - Sliding window algorithm (Redis sorted sets)
 * - Per-key limits (configurable per organization tier)
 * - Burst allowance for legitimate traffic spikes
 * 
 * Configuration:
 * - API_KEY_RATE_LIMIT_ENABLED: Enable/disable rate limiting (default: true)
 * - API_KEY_RATE_LIMIT_WINDOW_SECONDS: Time window for rate limiting (default: 60)
 * - API_KEY_RATE_LIMIT_MAX_REQUESTS: Max requests per window (default: 100)
 * - API_KEY_RATE_LIMIT_BURST_ALLOWANCE: Burst multiplier (default: 1.5)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '@/utils/logger';
import { config } from '@/config';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

const log = logger.child({ component: 'api-key-rate-limit-middleware' });

// Redis client for rate limiting
let redisClient: InstanceType<typeof import('ioredis').default> | null = null;

// Configuration
const RATE_LIMIT_ENABLED = process.env.API_KEY_RATE_LIMIT_ENABLED !== 'false';
const WINDOW_SECONDS = parseInt(process.env.API_KEY_RATE_LIMIT_WINDOW_SECONDS || '60', 10);
const RATE_LIMIT_PREFIX = 'api_key_rate_limit:';

// Rate limits by tier (requests per minute)
const TIER_RATE_LIMITS: Record<string, number> = {
  'free': 20,
  'starter': 60,
  'professional': 120,
  'business': 300,
  'enterprise': 600,
};

// Burst allowance multiplier
const BURST_MULTIPLIER = parseFloat(process.env.API_KEY_RATE_LIMIT_BURST_ALLOWANCE || '1.5');

/**
 * Scale-to-100k Phase 3 (issue #148): local in-process fallback state, used
 * ONLY when Redis is unavailable. Previously this middleware failed OPEN
 * (unlimited traffic) whenever Redis errored — exactly the moment rate
 * limiting matters most, since Redis saturation correlates with high load.
 * Given Redis is a documented SPOF in this stack (docker-compose.production.yml),
 * flipping straight to fail-CLOSED (block everything) would turn a transient
 * Redis hiccup into a total outage — an even worse failure mode. Instead,
 * degrade to a per-replica in-memory sliding window: same idiom already used
 * by distributed-circuit-breaker.ts/distributed-bulkhead.ts/
 * token-bucket-limiter.ts (try distributed, fall back to local rather than
 * either extreme). Less precise (per-replica, not fleet-wide) but real
 * throttling continues instead of none at all.
 */
const localFallbackWindows = new Map<string, number[]>();
const LOCAL_FALLBACK_MAX_KEYS = 50_000; // safety cap against unbounded growth

function checkRateLimitLocal(
  apiKeyId: string,
  tier: string
): { allowed: boolean; remaining: number; resetAt: Date; limit: number } {
  const now = Date.now();
  const windowStart = now - WINDOW_SECONDS * 1000;
  const baseLimit = TIER_RATE_LIMITS[tier] || TIER_RATE_LIMITS['free'];
  const limit = Math.floor(baseLimit * BURST_MULTIPLIER);

  let timestamps = localFallbackWindows.get(apiKeyId);
  if (!timestamps) {
    if (localFallbackWindows.size >= LOCAL_FALLBACK_MAX_KEYS) {
      // Evict an arbitrary (oldest-inserted, per Map iteration order) entry
      // rather than let this grow unbounded during a sustained Redis outage.
      const oldestKey = localFallbackWindows.keys().next().value;
      if (oldestKey !== undefined) localFallbackWindows.delete(oldestKey);
    }
    timestamps = [];
    localFallbackWindows.set(apiKeyId, timestamps);
  }

  const pruned = timestamps.filter((t) => t > windowStart);

  if (pruned.length >= limit) {
    localFallbackWindows.set(apiKeyId, pruned);
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date((pruned[0] ?? now) + WINDOW_SECONDS * 1000),
      limit,
    };
  }

  pruned.push(now);
  localFallbackWindows.set(apiKeyId, pruned);

  return {
    allowed: true,
    remaining: limit - pruned.length,
    resetAt: new Date(now + WINDOW_SECONDS * 1000),
    limit,
  };
}

/**
 * Initialize Redis client for rate limiting
 */
async function getRedisClient(): Promise<typeof redisClient> {
  if (redisClient) {
    return redisClient;
  }
  
  try {
    const Redis = (await import('ioredis')).default;
    const redisUrl = config.redis.password 
      ? `redis://:${config.redis.password}@${config.redis.host}:${config.redis.port}/${config.redis.db}`
      : `redis://${config.redis.host}:${config.redis.port}/${config.redis.db}`;
    
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 100, 1000);
      },
      enableReadyCheck: true,
      connectTimeout: 5000,
    });
    
    redisClient.on('error', (err) => {
      log.error({ error: err.message }, 'Redis connection error in rate limit middleware');
    });
    
    redisClient.on('connect', () => {
      log.info('Redis connected for API key rate limiting');
    });
    
    return redisClient;
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to initialize Redis for rate limiting');
    return null;
  }
}

/**
 * Check rate limit for API key using sliding window algorithm
 * Returns { allowed: boolean, remaining: number, resetAt: Date }
 */
async function checkRateLimit(
  apiKeyId: string,
  tier: string
): Promise<{ allowed: boolean; remaining: number; resetAt: Date; limit: number }> {
  const redis = await getRedisClient();
  if (!redis) {
    log.warn({ apiKeyId }, 'Redis unavailable, falling back to local in-memory rate limiting');
    return checkRateLimitLocal(apiKeyId, tier);
  }
  
  try {
    const now = Date.now();
    const windowStart = now - (WINDOW_SECONDS * 1000);
    const key = `${RATE_LIMIT_PREFIX}${apiKeyId}`;
    
    // Get rate limit for tier
    const baseLimit = TIER_RATE_LIMITS[tier] || TIER_RATE_LIMITS['free'];
    const limit = Math.floor(baseLimit * BURST_MULTIPLIER);
    
    // Sliding window: Remove old entries and count current window
    await redis.zremrangebyscore(key, 0, windowStart);
    const currentCount = await redis.zcard(key);
    
    if (currentCount >= limit) {
      // Rate limit exceeded
      const oldestEntry = await redis.zrange(key, 0, 0, 'WITHSCORES');
      const resetAt = oldestEntry.length > 1 
        ? new Date(parseInt(oldestEntry[1], 10) + (WINDOW_SECONDS * 1000))
        : new Date(now + WINDOW_SECONDS * 1000);
      
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        limit,
      };
    }
    
    // Add current request to window
    await redis.zadd(key, now, `${now}-${Math.random()}`);
    await redis.expire(key, WINDOW_SECONDS * 2); // TTL = 2x window for cleanup
    
    return {
      allowed: true,
      remaining: limit - currentCount - 1,
      resetAt: new Date(now + WINDOW_SECONDS * 1000),
      limit,
    };
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error), apiKeyId },
      'Error checking rate limit — falling back to local in-memory rate limiting'
    );
    return checkRateLimitLocal(apiKeyId, tier);
  }
}

/**
 * API Key Rate Limiting Middleware
 * 
 * Should be called AFTER api-key-auth-middleware has validated the API key.
 * Enforces rate limits per API key based on organization tier.
 */
export async function enforceApiKeyRateLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Skip if rate limiting is disabled
  if (!RATE_LIMIT_ENABLED) {
    return;
  }
  
  const extendedRequest = request as ExtendedFastifyRequest;
  
  // Only apply to API key authenticated requests
  if (!extendedRequest.apiKey?.id) {
    return;
  }
  
  const apiKeyId = extendedRequest.apiKey.id;
  const tier = extendedRequest.tenantContext?.tier || 'free';
  
  // Check rate limit
  const result = await checkRateLimit(apiKeyId, tier);
  
  // Add rate limit headers to response
  reply.header('X-RateLimit-Limit', result.limit.toString());
  reply.header('X-RateLimit-Remaining', result.remaining.toString());
  reply.header('X-RateLimit-Reset', Math.floor(result.resetAt.getTime() / 1000).toString());
  
  if (!result.allowed) {
    log.warn({
      apiKeyId,
      tier,
      url: request.url,
      method: request.method,
    }, 'API key rate limit exceeded');
    
    return reply.code(429).send({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Limit: ${result.limit} requests per ${WINDOW_SECONDS}s. Try again at ${result.resetAt.toISOString()}`,
      retry_after: Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
    });
  }
  
  log.debug({
    apiKeyId,
    tier,
    remaining: result.remaining,
  }, 'API key rate limit check passed');
}

/**
 * Cleanup function to close Redis connection
 */
export async function closeRateLimitClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
