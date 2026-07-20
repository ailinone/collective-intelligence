// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Token Revocation Check Middleware
 * SECURITY: Validates that JWT tokens have not been revoked (P1 fix)
 * 
 * This middleware checks if a JWT token has been revoked via Redis blacklist.
 * Works in conjunction with auth-middleware.ts to provide complete token validation.
 * 
 * Revocation Flow:
 * 1. User logs out via /auth/logout
 * 2. Token hash is added to Redis blacklist with TTL matching token expiration
 * 3. This middleware checks Redis before allowing access
 * 
 * Configuration:
 * - REDIS_URL: Redis connection string
 * - TOKEN_REVOCATION_ENABLED: Enable/disable revocation check (default: true)
 * - TOKEN_REVOCATION_FAIL_OPEN: If Redis fails, allow access (default: false)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { logger } from '@/utils/logger';
import { config } from '@/config';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { getHeaderString } from '@/utils/type-guards';

const log = logger.child({ component: 'token-revocation-middleware' });

// Redis client for revocation check (InstanceType from ioredis default export)
let redisClient: InstanceType<typeof import('ioredis').default> | null = null;

// Configuration
const REVOCATION_ENABLED = process.env.TOKEN_REVOCATION_ENABLED !== 'false';
const FAIL_OPEN = process.env.TOKEN_REVOCATION_FAIL_OPEN === 'true';
const REVOKED_TOKEN_PREFIX = 'revoked_token:';
const REVOKED_JTI_PREFIX = 'revoked_jti:';

/**
 * Initialize Redis client for revocation checks
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
      log.error({ error: err.message }, 'Redis connection error in revocation middleware');
    });
    
    redisClient.on('connect', () => {
      log.info('Redis connected for token revocation checks');
    });
    
    return redisClient;
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to initialize Redis for revocation');
    return null;
  }
}

/**
 * Hash token for lookup (SHA-256)
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Check if token is revoked
 */
async function isTokenRevoked(token: string): Promise<boolean> {
  if (!REVOCATION_ENABLED) {
    return false;
  }
  
  const redis = await getRedisClient();
  if (!redis) {
    if (FAIL_OPEN) {
      log.warn('Redis unavailable, failing open for revocation check');
      return false;
    }
    // Fail closed - treat as revoked if we can't check
    log.warn('Redis unavailable, failing closed for revocation check');
    return true;
  }
  
  try {
    const tokenHash = hashToken(token);
    const isRevoked = await redis.exists(`${REVOKED_TOKEN_PREFIX}${tokenHash}`);
    return isRevoked === 1;
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'Error checking token revocation');
    return !FAIL_OPEN; // Fail closed by default
  }
}

/**
 * Check if JTI (JWT ID) is revoked
 */
async function isJTIRevoked(jti: string): Promise<boolean> {
  if (!REVOCATION_ENABLED || !jti) {
    return false;
  }
  
  const redis = await getRedisClient();
  if (!redis) {
    return !FAIL_OPEN;
  }
  
  try {
    const isRevoked = await redis.exists(`${REVOKED_JTI_PREFIX}${jti}`);
    return isRevoked === 1;
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'Error checking JTI revocation');
    return !FAIL_OPEN;
  }
}

/**
 * Revoke a token (add to blacklist)
 * Called when user logs out or token is compromised
 */
export async function revokeToken(token: string, expiresInSeconds: number = 86400): Promise<boolean> {
  const redis = await getRedisClient();
  if (!redis) {
    log.error('Cannot revoke token - Redis unavailable');
    return false;
  }
  
  try {
    const tokenHash = hashToken(token);
    await redis.set(`${REVOKED_TOKEN_PREFIX}${tokenHash}`, '1', 'EX', expiresInSeconds);
    log.info({ tokenHashPrefix: tokenHash.substring(0, 16) }, 'Token revoked');
    return true;
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'Error revoking token');
    return false;
  }
}

/**
 * Revoke a JTI (JWT ID)
 */
export async function revokeJTI(jti: string, expiresInSeconds: number = 86400): Promise<boolean> {
  const redis = await getRedisClient();
  if (!redis) {
    log.error('Cannot revoke JTI - Redis unavailable');
    return false;
  }
  
  try {
    await redis.set(`${REVOKED_JTI_PREFIX}${jti}`, '1', 'EX', expiresInSeconds);
    log.info({ jti }, 'JTI revoked');
    return true;
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'Error revoking JTI');
    return false;
  }
}

/**
 * Token Revocation Check Middleware
 * 
 * Should be called AFTER auth-middleware.ts has validated the token signature.
 * Checks if the token has been revoked via Redis blacklist.
 */
export async function checkTokenRevocation(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Skip if revocation is disabled
  if (!REVOCATION_ENABLED) {
    return;
  }
  
  // Get the token from Authorization header
  const authHeader = getHeaderString(request.headers, 'authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return; // No JWT token, skip revocation check (might be API key)
  }
  
  const token = authHeader.substring(7);
  
  // Check if token is revoked
  const revoked = await isTokenRevoked(token);
  if (revoked) {
    log.warn({
      url: request.url,
      method: request.method,
      tokenHashPrefix: hashToken(token).substring(0, 16),
    }, 'Revoked token used');
    
    return reply.code(401).send({
      error: 'Token revoked',
      message: 'This token has been revoked. Please login again.',
    });
  }
  
  // Check if we have a JTI in the user context
  const extendedRequest = request as ExtendedFastifyRequest;
  const user = extendedRequest.user;
  if (user && typeof user === 'object' && 'jti' in user && typeof user.jti === 'string') {
    const jtiRevoked = await isJTIRevoked(user.jti);
    if (jtiRevoked) {
      log.warn({
        url: request.url,
        method: request.method,
        jti: user.jti,
      }, 'Revoked JTI used');
      
      return reply.code(401).send({
        error: 'Token revoked',
        message: 'This token has been revoked. Please login again.',
      });
    }
  }
}

/**
 * Cleanup function to close Redis connection
 */
export async function closeRevocationClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
