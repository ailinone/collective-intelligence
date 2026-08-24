// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * JWKS Routes
 * Exposes public keys for RS256 JWT verification
 *
 * Endpoints:
 * - GET /.well-known/jwks.json - Standard JWKS endpoint
 * - GET /console/api/v1/jwks - Tenant-aware JWKS endpoint (for signature-verifier)
 *
 * Security:
 * - Only exposes public keys (private keys never leave the server)
 * - Cache-Control headers for efficient caching
 * - Rate limited to prevent enumeration attacks
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getJWKS, isJWKSEnabled, getJWKSStatus } from '../services/jwks-service.js';
import { rejectAnonymousGuestKeyPreHandler } from '@/services/anonymous-quota-gate';
import { rejectChatFreeTierKeyPreHandler } from '@/services/free-tier-quota-gate';

// JWKS response schema
const jwksResponseSchema = {
  type: 'object',
  properties: {
    keys: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kty: { type: 'string', description: 'Key type (RSA)' },
          use: { type: 'string', description: 'Public key use (sig)' },
          kid: { type: 'string', description: 'Key ID' },
          alg: { type: 'string', description: 'Algorithm (RS256)' },
          n: { type: 'string', description: 'RSA modulus (base64url)' },
          e: { type: 'string', description: 'RSA exponent (base64url)' },
        },
        required: ['kty', 'use', 'kid', 'alg', 'n', 'e'],
      },
    },
  },
  required: ['keys'],
};

// Status response schema
const statusResponseSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    currentKeyId: { type: 'string', nullable: true },
    previousKeyId: { type: 'string', nullable: true },
    currentKeyExpiresAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

/**
 * Register JWKS routes
 */
export async function registerJWKSRoutes(server: FastifyInstance): Promise<void> {
  /**
   * Standard JWKS endpoint (RFC 7517)
   * Used by clients to fetch public keys for JWT verification
   */
  server.get(
    '/.well-known/jwks.json',
    {
      schema: {
        tags: ['Auth', 'JWKS'],
        security: [],
        summary: 'Get JSON Web Key Set',
        description: 'Returns the public keys used to verify JWT signatures (RS256)',
        response: {
          200: jwksResponseSchema,
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
    async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!isJWKSEnabled()) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'JWKS not enabled on this server',
        });
      }

      const jwks = getJWKS();

      // Set cache headers (cache for 1 hour, allow stale for 24 hours)
      reply.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
      reply.header('Content-Type', 'application/json');

      return reply.send(jwks);
    }
  );

  /**
   * Tenant-aware JWKS endpoint
   * Used by signature-verifier service for multi-tenant JWKS
   * Compatible with signature-verifier/app.py JWKS fetch
   */
  server.get<{ Querystring: { tenant_id?: string } }>(
    '/console/api/v1/jwks',
    {
      schema: {
        tags: ['Auth', 'JWKS'],
        security: [],
        summary: 'Get tenant-aware JSON Web Key Set',
        description: 'Returns public keys for a specific tenant (for signature verification)',
        querystring: {
          type: 'object',
          properties: {
            tenant_id: { type: 'string', description: 'Tenant/Organization ID' },
          },
        },
        response: {
          200: jwksResponseSchema,
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
    async (request, reply) => {
      if (!isJWKSEnabled()) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'JWKS not enabled on this server',
        });
      }

      // For now, all tenants use the same JWKS
      // Future: Support per-tenant key pairs
      const _tenantId = request.query.tenant_id;

      const jwks = getJWKS();

      // Set cache headers
      reply.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
      reply.header('Content-Type', 'application/json');

      return reply.send(jwks);
    }
  );

  /**
   * JWKS status endpoint (internal)
   * Used for monitoring and debugging
   */
  server.get(
    '/internal/jwks/status',
    {
      // Unlike the two JWKS endpoints above (`/.well-known/jwks.json` and
      // `/console/api/v1/jwks`, both listed in `PUBLIC_ROUTES` and deliberately
      // credential-free), `/internal/jwks/status` matches the `/internal` entry
      // in `PROTECTED_ROUTE_PREFIXES` and is NOT public — the global
      // `apiKeyAuthMiddleware` authenticates it and populates `request.apiKey`,
      // so the two dedicated single-purpose M2M keys can reach it. Guard it.
      // (Intentionally NOT applied to the two public endpoints: they never
      // resolve an api key, so the guard there would be dead weight, and the
      // public JWKS contract must stay reachable without credentials.)
      preHandler: [rejectAnonymousGuestKeyPreHandler, rejectChatFreeTierKeyPreHandler],
      schema: {
        tags: ['Internal', 'JWKS'],
        summary: 'Get JWKS status',
        description: 'Returns the current status of JWKS service (internal use only)',
        response: {
          200: statusResponseSchema,
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const status = getJWKSStatus();
      return reply.send(status);
    }
  );
}

export default registerJWKSRoutes;
