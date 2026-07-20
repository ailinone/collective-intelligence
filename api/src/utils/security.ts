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

  // Check for default/weak secrets
  const weakSecrets = [
    'your-super-secret-jwt-key-change-this-in-production',
    'secret',
    'password',
    '123456',
    'change-me',
  ];

  if (weakSecrets.some((weak) => secret.toLowerCase().includes(weak.toLowerCase()))) {
    return {
      valid: false,
      reason: 'JWT secret contains weak/default value. Generate strong random secret.',
    };
  }

  // Check entropy (rough estimate)
  const uniqueChars = new Set(secret).size;
  if (uniqueChars < 16) {
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
