// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '@/middleware/auth-middleware';
import { requireTenantContext, getTenantContext } from '@/api/middleware/tenant-isolation-middleware';
import { getUsageMetrics, recordUsageEvents } from '@/services/usage-analytics-service';
import type { UsageEvent, UsageMetrics, UsageMetricsRequest } from '@/types';
import { recordSecurityEvent } from '@/services/security-audit-service';

export async function registerEnterpriseUsageAnalyticsRoutes(
  server: FastifyInstance
): Promise<void> {
  server.post<{ Body: { events: UsageEvent[] } }>(
    '/v1/enterprise/usage/events',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Record usage analytics events',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['events'],
          properties: {
            events: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['eventType'],
                properties: {
                  userId: { type: 'string' },
                  teamId: { type: 'string' },
                  eventType: { type: 'string' },
                  timestamp: { type: 'integer' },
                  metadata: { type: 'object' },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request: FastifyRequest<{ Body: { events: UsageEvent[] } }>, reply: FastifyReply) => {
      const tenantContext = getTenantContext(request);
      const organizationId = tenantContext.organizationId;

      const invalidEvent = request.body.events.find(
        (event: UsageEvent) => event.organizationId && event.organizationId !== organizationId
      );

      if (invalidEvent) {
        await recordSecurityEvent({
          eventType: 'organization_mismatch',
          severity: 'critical',
          message: 'Usage analytics event contained mismatched organizationId.',
          organizationId,
          userId: tenantContext.userId,
          metadata: {
            attemptedOrganizationId: invalidEvent.organizationId,
            eventType: invalidEvent.eventType,
            route: request.url,
          },
        });
        return reply.status(403).send({
          error: {
            code: 'organization_mismatch',
            message: 'Event organizationId does not match authenticated tenant.',
          },
        });
      }

      await recordUsageEvents({
        organizationId,
        events: request.body.events.map((event: UsageEvent) => ({
          ...event,
          organizationId,
        })),
      });

      return reply.status(204).send();
    }
  );

  server.get<{ Querystring: UsageMetricsRequest; Reply: { metrics: UsageMetrics } }>(
    '/v1/enterprise/usage/metrics',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Get aggregated usage analytics metrics',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            start: { type: 'integer' },
            end: { type: 'integer' },
            userId: { type: 'string' },
            teamId: { type: 'string' },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request: FastifyRequest<{ Querystring: UsageMetricsRequest }>, reply: FastifyReply) => {
      const tenantContext = getTenantContext(request);
      const organizationId = tenantContext.organizationId;

      const metrics = await getUsageMetrics({
        ...request.query,
        organizationId,
      });

      return reply.send({ metrics });
    }
  );
}
