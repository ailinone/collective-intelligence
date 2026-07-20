// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * JWKS (JSON Web Key Set) Service
 * Manages RSA key pairs for RS256 JWT signing and verification
 * 
 * Security Features:
 * - RSA 2048-bit key pairs (NIST recommended minimum)
 * - Automatic key rotation with kid versioning
 * - JWKS endpoint for public key distribution
 * - Private key storage in Docker secrets or environment
 * - Key caching with TTL
 * 
 * Migration Path:
 * Phase 1: Generate keys, expose JWKS endpoint (current)
 * Phase 2: Dual signing (HS256 + RS256) for backward compatibility
 * Phase 3: RS256 only, deprecate HS256
 * 
 * Configuration:
 * - JWKS_ENABLED: Enable JWKS endpoint (default: false)
 * - JWKS_PRIVATE_KEY: PEM-encoded private key (from Docker secret)
 * - JWKS_PUBLIC_KEY: PEM-encoded public key (optional, derived from private)
 * - JWKS_KEY_ID: Key identifier for rotation (default: auto-generated)
 * - JWKS_ROTATION_DAYS: Days between key rotations (default: 90)
 */

import { generateKeyPairSync, createPublicKey, randomUUID } from 'node:crypto';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'jwks-service' });

// Configuration
const JWKS_ENABLED = process.env.JWKS_ENABLED === 'true';
const JWKS_KEY_ID = process.env.JWKS_KEY_ID || `key-${new Date().toISOString().slice(0, 7)}`; // key-2025-01
const JWKS_ALGORITHM = 'RS256';
const KEY_USE = 'sig';

// Key storage
interface RSAKeyPair {
  kid: string;
  privateKey: string;
  publicKey: string;
  createdAt: Date;
  expiresAt: Date;
  algorithm: string;
}

interface JWK {
  kty: string;
  use: string;
  kid: string;
  alg: string;
  n: string;
  e: string;
}

interface JWKS {
  keys: JWK[];
}

// In-memory key cache
let currentKeyPair: RSAKeyPair | null = null;
let previousKeyPair: RSAKeyPair | null = null;

/**
 * Generate a new RSA key pair
 */
function generateRSAKeyPair(kid: string, rotationDays: number = 90): RSAKeyPair {
  log.info({ kid, rotationDays }, 'Generating new RSA key pair');
  
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });
  
  const now = new Date();
  const expiresAt = new Date(now.getTime() + rotationDays * 24 * 60 * 60 * 1000);
  
  return {
    kid,
    privateKey,
    publicKey,
    createdAt: now,
    expiresAt,
    algorithm: JWKS_ALGORITHM,
  };
}

/**
 * Load key pair from environment or Docker secret
 */
async function loadKeyPairFromEnv(): Promise<RSAKeyPair | null> {
  const privateKeyEnv = process.env.JWKS_PRIVATE_KEY;
  
  if (!privateKeyEnv) {
    return null;
  }
  
  try {
    // Decode if base64 encoded
    let privateKey = privateKeyEnv;
    if (!privateKey.includes('-----BEGIN')) {
      privateKey = Buffer.from(privateKey, 'base64').toString('utf-8');
    }
    
    // Derive public key from private key
    const publicKeyObj = createPublicKey(privateKey);
    const publicKey = publicKeyObj.export({ type: 'spki', format: 'pem' }) as string;
    
    const rotationDays = parseInt(process.env.JWKS_ROTATION_DAYS || '90', 10);
    const now = new Date();
    
    return {
      kid: JWKS_KEY_ID,
      privateKey,
      publicKey,
      createdAt: now,
      expiresAt: new Date(now.getTime() + rotationDays * 24 * 60 * 60 * 1000),
      algorithm: JWKS_ALGORITHM,
    };
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to load key pair from environment');
    return null;
  }
}

/**
 * Initialize JWKS service
 */
export async function initializeJWKS(): Promise<void> {
  if (!JWKS_ENABLED) {
    log.info('JWKS service disabled (JWKS_ENABLED=false)');
    return;
  }
  
  // Try to load from environment first
  currentKeyPair = await loadKeyPairFromEnv();
  
  if (!currentKeyPair) {
    // Generate new key pair if not provided
    log.warn('No JWKS_PRIVATE_KEY provided, generating ephemeral key pair');
    log.warn('WARNING: Ephemeral keys will be lost on restart. Set JWKS_PRIVATE_KEY for production.');
    currentKeyPair = generateRSAKeyPair(JWKS_KEY_ID);
  }
  
  log.info({ kid: currentKeyPair.kid, expiresAt: currentKeyPair.expiresAt }, 'JWKS service initialized');
}

/**
 * Get current signing key (private)
 */
export function getSigningKey(): { privateKey: string; kid: string; algorithm: string } | null {
  if (!JWKS_ENABLED || !currentKeyPair) {
    return null;
  }
  
  return {
    privateKey: currentKeyPair.privateKey,
    kid: currentKeyPair.kid,
    algorithm: currentKeyPair.algorithm,
  };
}

/**
 * Convert PEM public key to JWK format
 */
function pemToJWK(pem: string, kid: string): JWK {
  const publicKeyObj = createPublicKey(pem);
  const keyData = publicKeyObj.export({ format: 'jwk' }) as { n: string; e: string };
  
  return {
    kty: 'RSA',
    use: KEY_USE,
    kid,
    alg: JWKS_ALGORITHM,
    n: keyData.n,
    e: keyData.e,
  };
}

/**
 * Get JWKS (JSON Web Key Set) containing public keys
 */
export function getJWKS(): JWKS {
  const keys: JWK[] = [];
  
  if (currentKeyPair) {
    keys.push(pemToJWK(currentKeyPair.publicKey, currentKeyPair.kid));
  }
  
  // Include previous key for rotation grace period
  if (previousKeyPair) {
    keys.push(pemToJWK(previousKeyPair.publicKey, previousKeyPair.kid));
  }
  
  return { keys };
}

/**
 * Get public key by kid (for verification)
 */
export function getPublicKeyByKid(kid: string): string | null {
  if (currentKeyPair && currentKeyPair.kid === kid) {
    return currentKeyPair.publicKey;
  }
  
  if (previousKeyPair && previousKeyPair.kid === kid) {
    return previousKeyPair.publicKey;
  }
  
  return null;
}

/**
 * Rotate keys (move current to previous, generate new current)
 */
export function rotateKeys(): void {
  if (!JWKS_ENABLED) {
    log.warn('Cannot rotate keys - JWKS service disabled');
    return;
  }
  
  const newKid = `key-${new Date().toISOString().slice(0, 7)}-${randomUUID().slice(0, 8)}`;
  
  // Move current to previous
  previousKeyPair = currentKeyPair;
  
  // Generate new key pair
  currentKeyPair = generateRSAKeyPair(newKid);
  
  log.info({
    newKid: currentKeyPair.kid,
    previousKid: previousKeyPair?.kid,
  }, 'Keys rotated successfully');
}

/**
 * Check if JWKS is enabled
 */
export function isJWKSEnabled(): boolean {
  return JWKS_ENABLED;
}

/**
 * Get JWKS status
 */
export function getJWKSStatus(): {
  enabled: boolean;
  currentKeyId: string | null;
  previousKeyId: string | null;
  currentKeyExpiresAt: Date | null;
} {
  return {
    enabled: JWKS_ENABLED,
    currentKeyId: currentKeyPair?.kid || null,
    previousKeyId: previousKeyPair?.kid || null,
    currentKeyExpiresAt: currentKeyPair?.expiresAt || null,
  };
}

/**
 * Parse expiresIn string (e.g. "1h", "30m") to seconds for JWT SignOptions.
 */
function parseExpiresInToSeconds(value: string): number {
  const match = value.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 3600;
  const num = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return num;
    case 'm': return num * 60;
    case 'h': return num * 3600;
    case 'd': return num * 86400;
    default: return 3600;
  }
}

/**
 * Sign JWT with RS256 (for migration)
 * Use this instead of jwt.sign() when migrating to RS256
 */
export async function signJWTWithRS256(
  payload: Record<string, unknown>,
  options: { expiresIn?: string; issuer?: string; audience?: string } = {}
): Promise<string | null> {
  const signingKey = getSigningKey();
  if (!signingKey) {
    log.warn('Cannot sign JWT with RS256 - JWKS not enabled or no key available');
    return null;
  }
  
  const jwt = await import('jsonwebtoken');
  type JwtSecret = import('jsonwebtoken').Secret;
  type JwtSignOptions = import('jsonwebtoken').SignOptions;
  const secretKey: JwtSecret = signingKey.privateKey;
  const expiresInSeconds = parseExpiresInToSeconds(options.expiresIn || '1h');
  const signOptions: JwtSignOptions = {
    algorithm: 'RS256',
    keyid: signingKey.kid,
    issuer: options.issuer || 'https://ailin.id',
    audience: options.audience || 'https://api.ailin.one',
    expiresIn: expiresInSeconds,
  };
  return jwt.default.sign(payload, secretKey, signOptions);
}

/**
 * Verify JWT with RS256 (for migration)
 */
export async function verifyJWTWithRS256(
  token: string,
  options: { issuer?: string | string[]; audience?: string | string[] } = {}
): Promise<Record<string, unknown> | null> {
  const jwt = await import('jsonwebtoken');
  
  // Decode header to get kid
  const decoded = jwt.default.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string') {
    return null;
  }
  
  const kid = decoded.header.kid;
  if (!kid) {
    log.warn('JWT missing kid in header');
    return null;
  }
  
  const publicKey = getPublicKeyByKid(kid);
  if (!publicKey) {
    log.warn({ kid }, 'Unknown kid in JWT header');
    return null;
  }
  
  const defaultIssuers: [string, ...string[]] = ['https://ailin.id', 'ci-api'];
  const defaultAudiences: [string, ...string[]] = ['https://api.ailin.one', 'ci-api'];
  const issuerVal = options.issuer ?? defaultIssuers;
  const audienceVal = options.audience ?? defaultAudiences;
  const issuerOpt: string | [string, ...string[]] | undefined =
    typeof issuerVal === 'string'
      ? issuerVal
      : issuerVal.length > 0
        ? [issuerVal[0], ...issuerVal.slice(1)]
        : undefined;
  const audienceOpt: string | RegExp | [string | RegExp, ...(string | RegExp)[]] | undefined =
    typeof audienceVal === 'string'
      ? audienceVal
      : audienceVal.length > 0
        ? [audienceVal[0], ...audienceVal.slice(1)]
        : undefined;

  try {
    return jwt.default.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: issuerOpt,
      audience: audienceOpt,
      clockTolerance: 30,
    }) as Record<string, unknown>;
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, 'RS256 JWT verification failed');
    return null;
  }
}

