// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { FastifyInstance } from 'fastify';
import { getModelAutoDiscovery } from '@/services/model-discovery-service';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { logger } from '@/utils/logger';

/**
 * Admin routes for model discovery
 * Allows manual triggering and monitoring of auto-discovery
 */
export async function discoveryRoutes(fastify: FastifyInstance): Promise<void> {
  const modelAutoDiscovery = getModelAutoDiscovery(logger);

  // SECURITY (RBAC): these endpoints trigger expensive discovery across every
  // provider (POST /trigger, POST /scheduled) and expose discovery internals
  // (GET /stats). The global api-key-auth middleware authenticates `/v1/...`
  // requests but does NOT enforce role, so any authenticated tenant could fire
  // them. Gate each route behind admin/owner role explicitly.
  const adminPreHandler = [authenticate, requireRole('admin', 'owner')];

  /**
   * Trigger manual model discovery
   * POST /v1/admin/discovery/trigger
   */
  fastify.post('/v1/admin/discovery/trigger', {
    preHandler: adminPreHandler,
    schema: {
      description: 'Manually trigger model discovery from all providers',
      tags: ['admin', 'discovery'],
      response: {
        200: {
          type: 'object',
          properties: {
            discovered: { type: 'number' },
            updated: { type: 'number' },
            failed: { type: 'number' },
            providers: { type: 'number' },
            models: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  provider: { type: 'string' },
                  action: { type: 'string', enum: ['discovered', 'updated', 'unchanged'] },
                },
              },
            },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const result = await modelAutoDiscovery.discoverNewModels();
      return reply.send(result);
    },
  });

  /**
   * Get discovery statistics
   * GET /v1/admin/discovery/stats
   */
  fastify.get('/v1/admin/discovery/stats', {
    preHandler: adminPreHandler,
    schema: {
      description: 'Get model discovery statistics',
      tags: ['admin', 'discovery'],
      response: {
        200: {
          type: 'object',
          properties: {
            totalModels: { type: 'number' },
            byProvider: { type: 'object' },
            lastDiscovery: { type: 'string', format: 'date-time', nullable: true },
            nextScheduled: { type: 'string', format: 'date-time', nullable: true },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const stats = await modelAutoDiscovery.getDiscoveryStats();
      return reply.send(stats);
    },
  });

  /**
   * Run scheduled discovery (cron endpoint)
   * POST /v1/admin/discovery/scheduled
   */
  fastify.post('/v1/admin/discovery/scheduled', {
    preHandler: adminPreHandler,
    schema: {
      description: 'Run scheduled discovery (called by cron job)',
      tags: ['admin', 'discovery'],
      response: {
        200: {
          type: 'object',
          properties: {
            discovered: { type: 'number' },
            updated: { type: 'number' },
            failed: { type: 'number' },
            providers: { type: 'number' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const result = await modelAutoDiscovery.discoverNewModels();
      return reply.send({
        discovered: result.models.length,
        updated: 0,
        failed: result.errors.length,
        providers: 0,
      });
    },
  });
}
