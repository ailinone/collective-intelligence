// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Input Sanitization Middleware (v5.0)
 *
 * Automatic sanitization for all incoming requests
 * Prevents OWASP Top 10 injection attacks
 *
 * Applied to ALL routes (defense-in-depth with schema validation)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { sanitizeRequestBody, sanitizeInput, SanitizeOptions } from '../../utils/sanitizers.js';
import { logger } from '../../utils/logger.js';

// ============================================
// Configuration
// ============================================

const SANITIZATION_ENABLED = process.env.INPUT_SANITIZATION_ENABLED !== 'false';

const DEFAULT_OPTIONS: SanitizeOptions = {
  stripHTML: true,
  escapeSQL: false, // Prisma handles this, but can enable for extra safety
  normalizeUnicode: true,
  normalizeWhitespace: true,
  maxLength: 1000000, // 1MB
};

// Routes that skip sanitization (if needed)
const SKIP_ROUTES: string[] = ['/health', '/health/ready', '/health/live', '/metrics'];

// ============================================
// Middleware
// ============================================

/**
 * Create sanitization middleware with custom options
 */
export function createSanitizationMiddleware(options: SanitizeOptions = DEFAULT_OPTIONS) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip if disabled
    if (!SANITIZATION_ENABLED) {
      return;
    }

    // Skip certain routes
    if (SKIP_ROUTES.includes(request.url)) {
      return;
    }

    try {
      // Sanitize request body
      if (request.body && typeof request.body === 'object') {
        const original = JSON.stringify(request.body).length;

        request.body = sanitizeRequestBody(request.body, options);

        const sanitized = JSON.stringify(request.body).length;

        if (original !== sanitized) {
          logger.debug(
            {
              url: request.url,
              method: request.method,
              originalSize: original,
              sanitizedSize: sanitized,
              diff: original - sanitized,
            },
            'Request body sanitized'
          );
        }
      }

      // Sanitize query parameters
      if (request.query && typeof request.query === 'object') {
        request.query = sanitizeRequestBody(request.query, options);
      }

      // Sanitize specific headers (don't sanitize auth headers!)
      const sanitizableHeaders = ['user-agent', 'referer', 'x-forwarded-for', 'x-real-ip'];
      for (const headerName of sanitizableHeaders) {
        const headerValue = request.headers[headerName];
        if (headerValue && typeof headerValue === 'string') {
          const sanitized = sanitizeInput(headerValue, {
            maxLength: 500,
            normalizeWhitespace: true,
          });
          request.headers[headerName] = sanitized;
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          error: errorMessage,
          url: request.url,
          method: request.method,
        },
        'Error sanitizing request'
      );

      // Fail-safe: reject request if sanitization fails
      reply.status(400).send({
        error: 'INVALID_INPUT',
        message: 'Request contains invalid or dangerous content',
        code: 'SANITIZATION_FAILED',
      });
    }
  };
}

/**
 * Default middleware (uses DEFAULT_OPTIONS)
 */
export const sanitizationMiddleware = createSanitizationMiddleware();
