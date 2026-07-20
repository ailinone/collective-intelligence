// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Nonce Middleware for Replay Attack Protection
 * SECURITY: Prevents replay attacks on sensitive operations (T7 mitigation)
 * 
 * This middleware enforces one-time use nonces for sensitive operations like:
 * - Password changes
 * - Email changes
 * - Payment operations
 * - API key rotation
 * - Organization settings changes
 * 
 * Flow:
 * 1. Client requests nonce via GET /v1/nonce
 * 2. Server generates unique nonce and stores in Redis with TTL
 * 3. Client includes nonce in sensitive request header (X-Nonce)
 * 4. Server validates nonce exists and hasn't been used
 * 5. Server marks nonce as used (atomic operation)
 * 
 * Configuration:
 * - NONCE_ENABLED: Enable/disable nonce validation (default: true)
 * - NONCE_TTL_SECONDS: Nonce validity period (default: 300 = 5 minutes)
 * - NONCE_REQUIRED_PATHS: Paths that require nonce (regex patterns)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { logger } from '@/utils/logger';
import { config } from '@/config';
import { getHeaderString } from '@/utils/type-guards';

const log = logger.child({ component: 'nonce-middleware' });

// Redis client for nonce storage
let redisClient: InstanceType<typeof import('ioredis').default> | null = null;

// Configuration
const NONCE_ENABLED = process.env.NONCE_ENABLED !== 'false';
const NONCE_TTL_SECONDS = parseInt(process.env.NONCE_TTL_SECONDS || '300', 10);
const NONCE_PREFIX = 'nonce:';

// Paths that require nonce validation (regex patterns)
const NONCE_REQUIRED_PATHS = [
  /^\/v1\/auth\/change-password$/,
  /^\/v1\/auth\/change-email$/,
  /^\/v1\/users\/[^/]+\/password$/,
  /^\/v1\/users\/[^/]+\/email$/,
  /^\/v1\/api-keys\/[^/]+\/rotate$/,
  /^\/v1\/organizations\/[^/]+\/settings$/,
  /^\/v1\/payment\//,
  /^\/v1\/billing\//,
];

/**
 * Initialize Redis client for nonce storage
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
      log.error({ error: err.message }, 'Redis connection error in nonce middleware');
    });
    
    redisClient.on('connect', () => {
      log.info('Redis connected for nonce validation');
    });
    
    return redisClient;
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to initialize Redis for nonce');
    return null;
  }
}

/**
 * Generate a cryptographically secure nonce
 */
export function generateNonce(): string {
  // Generate 32 bytes (256 bits) of random data
  // Base64url encode for URL-safe transmission
  return randomBytes(32).toString('base64url');
}

/**
 * Store nonce in Redis with TTL
 */
export async function storeNonce(nonce: string, metadata?: Record<string, unknown>): Promise<boolean> {
  const redis = await getRedisClient();
  if (!redis) {
    log.error('Cannot store nonce - Redis unavailable');
    return false;
  }
  
  try {
    const key = `${NONCE_PREFIX}${nonce}`;
    const value = JSON.stringify({
      created_at: Date.now(),
      metadata: metadata || {},
    });
    
    await redis.set(key, value, 'EX', NONCE_TTL_SECONDS);
    log.debug({ noncePrefix: nonce.substring(0, 16) }, 'Nonce stored');
    return true;
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'Error storing nonce');
    return false;
  }
}

/**
 * Validate and consume nonce (atomic operation)
 * Returns true if nonce is valid and hasn't been used
 * Marks nonce as used to prevent replay
 */
export async function validateAndConsumeNonce(nonce: string): Promise<boolean> {
  const redis = await getRedisClient();
  if (!redis) {
    log.error('Cannot validate nonce - Redis unavailable');
    // Fail closed - reject request if we can't validate nonce
    return false;
  }
  
  try {
    const key = `${NONCE_PREFIX}${nonce}`;
    
    // Atomic operation: check existence and delete in one command
    // DEL returns 1 if key existed, 0 if not
    const deleted = await redis.del(key);
    
    if (deleted === 1) {
      log.info({ noncePrefix: nonce.substring(0, 16) }, 'Nonce validated and consumed');
      return true;
    }
    
    log.warn({ noncePrefix: nonce.substring(0, 16) }, 'Nonce not found or already used');
    return false;
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'Error validating nonce');
    // Fail closed
    return false;
  }
}

/**
 * Check if path requires nonce validation
 */
function requiresNonce(path: string, method: string): boolean {
  // Only check for state-changing methods
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    return false;
  }
  
  // Check if path matches any required pattern
  return NONCE_REQUIRED_PATHS.some(pattern => pattern.test(path));
}

/**
 * Nonce Validation Middleware
 * 
 * Should be called AFTER authentication middleware.
 * Validates nonce for sensitive operations to prevent replay attacks.
 */
export async function validateNonce(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Skip if nonce validation is disabled
  if (!NONCE_ENABLED) {
    return;
  }
  
  // Check if this path requires nonce
  if (!requiresNonce(request.url, request.method)) {
    return;
  }
  
  // Get nonce from header
  const nonce = getHeaderString(request.headers, 'x-nonce');
  if (!nonce) {
    log.warn({
      url: request.url,
      method: request.method,
    }, 'Nonce required but not provided');
    
    return reply.code(400).send({
      error: 'Nonce Required',
      message: 'This operation requires a nonce. Request one via GET /v1/nonce',
    });
  }
  
  // Validate and consume nonce
  const valid = await validateAndConsumeNonce(nonce);
  if (!valid) {
    log.warn({
      url: request.url,
      method: request.method,
      noncePrefix: nonce.substring(0, 16),
    }, 'Invalid or already used nonce');
    
    return reply.code(403).send({
      error: 'Invalid Nonce',
      message: 'Nonce is invalid or has already been used. Request a new one via GET /v1/nonce',
    });
  }
  
  log.debug({
    url: request.url,
    method: request.method,
  }, 'Nonce validated successfully');
}

/**
 * Cleanup function to close Redis connection
 */
export async function closeNonceClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
