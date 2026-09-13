// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Security Utilities
 * JWT secret generation, validation, and security helpers
 */

import crypto from 'crypto';

/**
 * Generate cryptographically secure JWT secret
 * 256-bit random secret (industry standard)
 */
export function generateSecureJWTSecret(): string {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * Validate JWT secret strength
 * Must be at least 256 bits (32 bytes) of entropy
 */
export function validateJWTSecret(secret: string): {
  valid: boolean;
  reason?: string;
} {
  // Check minimum length
  if (secret.length < 32) {
    return {
      valid: false,
      reason: 'JWT secret must be at least 32 characters (256 bits)',
    };
  }

  // Check for default/weak secrets.
  // Plain substring matching (`secret.includes(weak)`) is unsound for the
  // short literals below: a genuinely random secret can contain one of them
  // by pure chance. Concretely, a 64-char hex secret (`openssl rand -hex 32`,
  // 16-symbol alphabet) has a real ~1-in-220,000 chance of containing
  // "123456" as a substring purely by coincidence (union bound: 59 start
  // positions x (1/16)^6). That is exactly what made this file's own
  // 1000-trial random-secret test flaky: a 2,000,000-trial simulation
  // measured 9 real accidental hits (rate 4.5e-6/secret, all "123456" --
  // the only weak literal expressible in a hex alphabet), which over a
  // 1000-iteration test loop works out to a ~0.45% chance of a false
  // rejection per CI run (roughly 1 run in ~220). See
  // security.test.ts for a captured, deterministic repro secret.
  //
  // Fix: only treat a substring hit as meaningful when the weak literal
  // explains a large share of the secret's total length (secret no longer
  // than 6x the literal). A human-chosen "decorated but still weak" secret
  // (e.g. "password123456") stays close in length to the word it's built
  // from; a long, high-entropy random secret that coincidentally contains a
  // short weak substring does not. This keeps real weak/default secrets
  // rejected while making an accidental collision with genuine random data
  // essentially impossible (the collision-prone case above, a 64-char
  // secret, is 10-11x the length of the 6-char literals that can hit it).
  const weakSecrets = [
    'your-super-secret-jwt-key-change-this-in-production',
    'secret',
    'password',
    '123456',
    'change-me',
  ];

  const lowerSecret = secret.toLowerCase();
  const isWeak = weakSecrets.some((weak) => {
    const lowerWeak = weak.toLowerCase();
    return lowerSecret.includes(lowerWeak) && secret.length <= lowerWeak.length * 6;
  });

  if (isWeak) {
    return {
      valid: false,
      reason: 'JWT secret contains weak/default value. Generate strong random secret.',
    };
  }

  // Check entropy (rough estimate).
  // A flat "must contain all 16 hex symbols" bar is a coupon-collector trap:
  // a genuinely random `openssl rand -hex 32` secret (64 draws over a
  // 16-symbol alphabet) misses at least one symbol ~26% of the time by pure
  // chance. Scale the minimum with length instead — safe across hex/base64/
  // base64url secrets of any length >= 32 (see security.test.ts for the
  // 1000-trial regression proof) — while still rejecting low-diversity
  // patterns (e.g. a repeated or 2-4 character cycling string).
  const uniqueChars = new Set(secret).size;
  const minUniqueChars = Math.min(14, Math.floor(secret.length / 6));
  if (uniqueChars < minUniqueChars) {
    return {
      valid: false,
      reason: 'JWT secret has low entropy. Use cryptographically random string.',
    };
  }

  return { valid: true };
}

/**
 * Validate model ID to prevent injection
 * Model IDs must match safe pattern
 */
export function validateModelId(modelId: string): boolean {
  // Allow: alphanumeric, hyphens, underscores, dots
  // Reject: special chars, SQL keywords, etc
  const safePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

  if (!safePattern.test(modelId)) {
    return false;
  }

  // Block SQL keywords
  const sqlKeywords = ['select', 'insert', 'update', 'delete', 'drop', 'union', 'exec'];
  const lowerModelId = modelId.toLowerCase();

  for (const keyword of sqlKeywords) {
    if (lowerModelId.includes(keyword)) {
      return false;
    }
  }

  return true;
}

/**
 * Sanitize provider name
 */
export function validateProviderName(providerName: string): boolean {
  const safePattern = /^[a-z0-9-]{2,32}$/;
  return safePattern.test(providerName);
}

/**
 * Validate and sanitize organization ID (UUID)
 */
export function validateOrganizationId(orgId: string): boolean {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidPattern.test(orgId);
}

/**
 * Validate API key format
 */
export function validateAPIKeyFormat(apiKey: string): boolean {
  // API keys should be at least 32 characters
  if (apiKey.length < 32) {
    return false;
  }

  // Should only contain safe characters
  const safePattern = /^[a-zA-Z0-9_-]+$/;
  return safePattern.test(apiKey);
}

/**
 * Sanitize error message for external exposure
 * Remove sensitive information (stack traces, DB details, etc)
 */
export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Remove stack traces
    let message = error.message;

    // Remove file paths
    message = message.replace(/\/[^ ]+\/[^ ]+/g, '[path]');

    // Remove API keys
    message = message.replace(/sk-[a-zA-Z0-9-_]+/g, 'sk-***');
    message = message.replace(/Bearer [a-zA-Z0-9._-]+/g, 'Bearer ***');

    // Remove DB connection strings
    message = message.replace(/postgresql:\/\/[^ ]+/g, 'postgresql://***');
    message = message.replace(/redis:\/\/[^ ]+/g, 'redis://***');

    // Generic error for production
    if (process.env.NODE_ENV === 'production') {
      return 'An internal error occurred. Please contact support.';
    }

    return message;
  }

  return 'Unknown error';
}

/**
 * Rate limit key per API key (not global)
 */
export function getRateLimitKey(apiKey: string, endpoint: string): string {
  // Hash API key for privacy
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
  return `ratelimit:${hash}:${endpoint}`;
}

/**
 * Validate CORS origin
 */
export function isValidCORSOrigin(origin: string, allowedOrigins: string[]): boolean {
  // If wildcard, allow all (NOT recommended for production)
  if (allowedOrigins.includes('*')) {
    return true;
  }

  // Check exact match
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  // Check pattern match (e.g., *.ailin.dev)
  for (const allowed of allowedOrigins) {
    if (allowed.startsWith('*.')) {
      const domain = allowed.substring(2);
      if (origin.endsWith(domain)) {
        return true;
      }
    }
  }

  return false;
}
