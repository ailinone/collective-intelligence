// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Nonce Routes
 * Provides nonces for replay attack protection on sensitive operations
 * 
 * Endpoints:
 * - GET /v1/nonce - Generate a new nonce
 * 
 * Security:
 * - Requires authentication
 * - Rate limited to prevent abuse
 * - Nonces expire after 5 minutes
 * - One-time use only
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '@/middleware/auth-middleware';
import { generateNonce, storeNonce } from '@/middleware/nonce-middleware';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

const nonceResponseSchema = {
  type: 'object',
  properties: {
    nonce: { type: 'string', description: 'Cryptographically secure nonce' },
    expires_at: { type: 'string', format: 'date-time', description: 'Nonce expiration time' },
    ttl_seconds: { type: 'number', description: 'Time to live in seconds' },
  },
  required: ['nonce', 'expires_at', 'ttl_seconds'],
};

/**
 * Register nonce routes
 */
export async function registerNonceRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /v1/nonce
   * Generate a new nonce for sensitive operations
   */
  server.get(
    '/v1/nonce',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Auth', 'Security'],
        summary: 'Generate nonce for sensitive operations',
        description: `Generates a cryptographically secure nonce for use in sensitive operations.
        
The nonce must be included in the X-Nonce header when making requests to protected endpoints such as:
- Password changes
- Email changes
- API key rotation
- Payment operations
- Organization settings changes

Nonces are valid for 5 minutes and can only be used once.`,
        response: {
          200: nonceResponseSchema,
          401: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
          503: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const extendedRequest = request as ExtendedFastifyRequest;
        
        // Generate nonce
        const nonce = generateNonce();
        
        // Store nonce with metadata
        const stored = await storeNonce(nonce, {
          user_id: extendedRequest.userId,
          organization_id: extendedRequest.organizationId,
          ip: request.ip,
          user_agent: request.headers['user-agent'],
        });
        
        if (!stored) {
          return reply.code(503).send({
            error: 'Service Unavailable',
            message: 'Unable to generate nonce at this time',
          });
        }
        
        const ttlSeconds = parseInt(process.env.NONCE_TTL_SECONDS || '300', 10);
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        
        return reply.send({
          nonce,
          expires_at: expiresAt.toISOString(),
          ttl_seconds: ttlSeconds,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Error generating nonce');
        
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to generate nonce',
        });
      }
    }
  );
}
