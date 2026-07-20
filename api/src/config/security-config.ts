// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Security Configuration
 * Validates security settings at startup
 */

import { validateJWTSecret } from '@/utils/security';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'security-config' });

/**
 * Validate security configuration at startup
 * Throws error if critical security issues found
 */
export function validateSecurityConfig(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Validate JWT Secret
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    errors.push('JWT_SECRET is not set in environment variables');
  } else {
    const validation = validateJWTSecret(jwtSecret);
    if (!validation.valid) {
      errors.push(`JWT_SECRET is weak: ${validation.reason}`);
    }
  }

  // 2. Validate CORS Origin
  const corsOrigin = process.env.CORS_ORIGIN;

  if (corsOrigin === '*' && process.env.NODE_ENV === 'production') {
    warnings.push('CORS_ORIGIN=* allows all origins. Set specific origins for production.');
  }

  // 3. Validate Database URL (no plain text passwords in logs)
  const dbUrl = process.env.DATABASE_URL;

  if (process.env.NODE_ENV === 'production' && dbUrl) {
    let hasEmbeddedCredentials = false;
    try {
      const parsed = new URL(dbUrl);
      hasEmbeddedCredentials = Boolean(parsed.username) && Boolean(parsed.password);
    } catch {
      // Fallback for non-standard URLs
      hasEmbeddedCredentials = /:\/\/[^@]+@/.test(dbUrl);
    }

    if (hasEmbeddedCredentials) {
      warnings.push('DATABASE_URL includes embedded credentials. Ensure logs always redact connection strings.');
    }
  }

  // 4. Check if running in production without HTTPS
  if (process.env.NODE_ENV === 'production' && !process.env.HTTPS_ENABLED) {
    warnings.push('Running in production without HTTPS. Enable HTTPS/TLS.');
  }

  // 5. Validate API Keys presence (100% dynamic - no hardcoded provider list)
  // Check if at least ONE provider API key is configured
  // Providers are discovered dynamically, not hardcoded
  const providerKeyPatterns = ['_API_KEY', '_SECRET_KEY', '_ACCESS_KEY'];
  const configuredProviders = Object.keys(process.env).filter(key =>
    providerKeyPatterns.some(pattern => key.endsWith(pattern)) && process.env[key]
  );

  if (configuredProviders.length === 0) {
    warnings.push(
      'No LLM provider API keys detected. At least one provider key (e.g., *_API_KEY) should be configured.'
    );
  }

  // 6. Check Helmet enabled
  if (process.env.NODE_ENV === 'production' && process.env.HELMET_ENABLED !== 'true') {
    warnings.push('Helmet (security headers) is disabled. Enable for production.');
  }

  // Log results
  if (errors.length > 0) {
    log.error({ errors }, 'CRITICAL SECURITY ERRORS - Cannot start server');
    errors.forEach((err) => log.error(err));
    throw new Error(`Security validation failed: ${errors.join('; ')}`);
  }

  if (warnings.length > 0) {
    log.warn({ warnings }, 'Security warnings found');
    warnings.forEach((warn) => log.warn(warn));
  } else {
    log.info('✅ Security configuration validated successfully');
  }
}

/**
 * Get secure CORS configuration
 */
export function getCORSConfig() {
  const origin = process.env.CORS_ORIGIN || 'http://localhost:3000';

  // Parse comma-separated origins
  const origins = origin.split(',').map((o) => o.trim());

  return {
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Organization-ID',
      'X-User-ID',
    ],
  };
}
