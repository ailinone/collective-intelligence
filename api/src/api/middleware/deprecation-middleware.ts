// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Deprecation Middleware (RFC 8594)
 * 
 * Implements:
 * - Deprecation header (RFC 8594)
 * - Sunset header (RFC 8594)
 * - Warning header (RFC 7234)
 * 
 * Reference: https://datatracker.ietf.org/doc/html/rfc8594
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '@/utils/logger';

export interface DeprecatedEndpoint {
  path: string;
  method: string;
  deprecationDate: Date;
  sunsetDate: Date;
  alternative?: string;
  reason?: string;
}

/**
 * Deprecated endpoints registry
 * 
 * INSTRUCTIONS:
 * 1. When deprecating an endpoint, add it here
 * 2. Set deprecationDate (when deprecation was announced)
 * 3. Set sunsetDate (when endpoint will be removed - typically 6-12 months after deprecation)
 * 4. Provide alternative endpoint if available
 * 5. Provide reason for deprecation
 * 
 * EXAMPLE:
 * {
 *   path: '/v1/old-endpoint',
 *   method: 'POST',
 *   deprecationDate: new Date('2025-01-01'),
 *   sunsetDate: new Date('2025-07-01'), // 6 months later
 *   alternative: '/v2/new-endpoint',
 *   reason: 'Replaced by improved version with better performance'
 * }
 */
const DEPRECATED_ENDPOINTS: DeprecatedEndpoint[] = [
  // Example (not active):
  // {
  //   path: '/v1/auth/challenge',
  //   method: 'POST',
  //   deprecationDate: new Date('2024-12-01'),
  //   sunsetDate: new Date('2025-06-01'),
  //   alternative: '/v1/auth/email-challenge',
  //   reason: 'Blocked by GCP ACME/Let\'s Encrypt infrastructure'
  // }
];

/**
 * Check if endpoint is deprecated
 */
function findDeprecatedEndpoint(
  method: string,
  path: string
): DeprecatedEndpoint | undefined {
  return DEPRECATED_ENDPOINTS.find(
    (endpoint) =>
      endpoint.method.toUpperCase() === method.toUpperCase() &&
      matchPath(endpoint.path, path)
  );
}

/**
 * Match path with path params (simple implementation)
 */
function matchPath(pattern: string, path: string): boolean {
  // Exact match
  if (pattern === path) return true;
  
  // Match with path params (e.g., /models/:id matches /models/gpt-4)
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  
  if (patternParts.length !== pathParts.length) return false;
  
  return patternParts.every((part, i) => {
    // Path param matches anything
    if (part.startsWith(':') || part.startsWith('{')) return true;
    // Literal parts must match
    return part === pathParts[i];
  });
}

/**
 * Format date for HTTP headers (RFC 7231)
 */
function formatHttpDate(date: Date): string {
  return date.toUTCString();
}

/**
 * Deprecation middleware
 * Adds deprecation headers to responses for deprecated endpoints
 */
export function deprecationMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  const deprecated = findDeprecatedEndpoint(request.method, request.url);
  
  if (!deprecated) {
    done();
    return;
  }
  
  const now = new Date();
  const isSunset = now >= deprecated.sunsetDate;
  
  // If past sunset date, return 410 Gone
  if (isSunset) {
    logger.warn(
      {
        method: request.method,
        path: request.url,
        sunsetDate: deprecated.sunsetDate,
        alternative: deprecated.alternative,
      },
      'Request to sunset endpoint'
    );
    
    reply.status(410).send({
      error: {
        code: 'endpoint_gone',
        message: `This endpoint was sunset on ${formatHttpDate(deprecated.sunsetDate)}`,
        alternative: deprecated.alternative,
        reason: deprecated.reason,
      },
    });
    return;
  }
  
  // Add deprecation headers (RFC 8594)
  reply.header('Deprecation', formatHttpDate(deprecated.deprecationDate));
  reply.header('Sunset', formatHttpDate(deprecated.sunsetDate));
  
  // Add warning header (RFC 7234)
  const daysUntilSunset = Math.ceil(
    (deprecated.sunsetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );
  
  const warningMessage = deprecated.alternative
    ? `299 - "Deprecated. Will be removed on ${formatHttpDate(deprecated.sunsetDate)}. Use ${deprecated.alternative} instead."`
    : `299 - "Deprecated. Will be removed on ${formatHttpDate(deprecated.sunsetDate)}."`;
  
  reply.header('Warning', warningMessage);
  
  // Add custom header with alternative
  if (deprecated.alternative) {
    reply.header('X-Alternative-Endpoint', deprecated.alternative);
  }
  
  // Log deprecation usage
  logger.warn(
    {
      method: request.method,
      path: request.url,
      deprecationDate: deprecated.deprecationDate,
      sunsetDate: deprecated.sunsetDate,
      daysUntilSunset,
      alternative: deprecated.alternative,
      reason: deprecated.reason,
    },
    `Request to deprecated endpoint (${daysUntilSunset} days until sunset)`
  );
  
  done();
}

/**
 * Get all deprecated endpoints (for documentation/monitoring)
 */
export function getDeprecatedEndpoints(): DeprecatedEndpoint[] {
  return DEPRECATED_ENDPOINTS;
}

/**
 * Check if deprecation is active (for admin endpoints)
 */
export function isDeprecated(method: string, path: string): boolean {
  return findDeprecatedEndpoint(method, path) !== undefined;
}

