// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Usage statistics routes
 * GET /v1/usage/stats
 */

import type { FastifyInstance } from 'fastify';
import { prisma } from '@/database/client';
import { authenticate } from '@/middleware/auth-middleware';
import { requireTenantContext, getTenantContext } from '@/api/middleware/tenant-isolation-middleware';
import { logger } from '@/utils/logger';
import { validateOrganizationId } from '@/utils/security';
import type { UsageStats } from '@/types';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

/**
 * Register usage routes
 */
export async function registerUsageRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /v1/usage/stats
   * Get usage statistics for organization
   */
  server.get<{
    Querystring: {
      period?: 'day' | 'month' | 'year';
      start_date?: string;
      end_date?: string;
    };
  }>(
    '/v1/usage/stats',
    {
      preHandler: [authenticate, requireTenantContext()],
      schema: {
        tags: ['Usage'],
        description: 'Get usage statistics for organization',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            period: {
              type: 'string',
              enum: ['day', 'month', 'year'],
              description: 'Time period for stats',
            },
            start_date: {
              type: 'string',
              format: 'date-time',
              description: 'Start date (ISO 8601)',
            },
            end_date: {
              type: 'string',
              format: 'date-time',
              description: 'End date (ISO 8601)',
            },
          },
        },
        response: {
          200: {
            description: 'Usage statistics',
            type: 'object',
            properties: {
              period: { type: 'string', enum: ['day', 'month', 'year'] },
              periodStart: { type: 'string', format: 'date-time' },
              periodEnd: { type: 'string', format: 'date-time' },
              requestCount: { type: 'number' },
              tokenCount: { type: 'number' },
              costUsd: { type: 'number' },
              avgDurationMs: { type: 'number' },
              errorRate: { type: 'number' },
              cacheHitRate: { type: 'number' },
              topModels: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    modelName: { type: 'string' },
                    requestCount: { type: 'number' },
                    tokenCount: { type: 'number' },
                    costUsd: { type: 'number' },
                  },
                  required: ['modelName', 'requestCount', 'tokenCount', 'costUsd'],
                  additionalProperties: false,
                },
              },
              topStrategies: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    strategyName: { type: 'string' },
                    executionCount: { type: 'number' },
                    avgCost: { type: 'number' },
                    avgQuality: { type: 'number' },
                    successRate: { type: 'number' },
                  },
                  required: [
                    'strategyName',
                    'executionCount',
                    'avgCost',
                    'avgQuality',
                    'successRate',
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: [
              'period',
              'periodStart',
              'periodEnd',
              'requestCount',
              'tokenCount',
              'costUsd',
              'avgDurationMs',
              'errorRate',
              'cacheHitRate',
              'topModels',
              'topStrategies',
            ],
            additionalProperties: false,
          },
          401: {
            description: 'Unauthorized',
            type: 'object',
          },
        },
      },
    },
    async (request, reply) => {
      const extendedRequest = request as ExtendedFastifyRequest;
      
      // Get organizationId from user context (set by authenticate middleware)
      let organizationId: string | undefined;
      if (extendedRequest.user && typeof extendedRequest.user === 'object' && 'organizationId' in extendedRequest.user) {
        organizationId = extendedRequest.user.organizationId as string;
      } else if (extendedRequest.organizationId) {
        organizationId = extendedRequest.organizationId;
      } else {
        const tenantContext = extendedRequest.tenantContext || getTenantContext(request);
        organizationId = tenantContext.organizationId;
      }
      const { period = 'day', start_date, end_date } = request.query;

      const requestLog = logger.child({
        endpoint: '/v1/usage/stats',
        organizationId,
        period,
      });

      requestLog.info('Usage stats request received');

      try {
        // Validate organizationId is a valid UUID
        if (!organizationId || typeof organizationId !== 'string') {
          return reply.status(400).send({
            error: {
              message: 'Invalid organization ID',
              type: 'invalid_request_error',
              code: 'invalid_organization_id',
            },
          });
        }

        // Validate UUID format
        if (!validateOrganizationId(organizationId)) {
          return reply.status(400).send({
            error: {
              message: 'Invalid organization ID format. Must be valid UUID.',
              type: 'invalid_request_error',
              code: 'invalid_organization_id',
            },
          });
        }

        // Calculate date range
        const now = new Date();
        let periodStart: Date;
        let periodEnd: Date = end_date ? new Date(end_date) : now;

        if (start_date) {
          periodStart = new Date(start_date);
        } else {
          switch (period) {
            case 'day':
              periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
              break;
            case 'month':
              periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
              break;
            case 'year':
              periodStart = new Date(now.getFullYear(), 0, 1);
              break;
            default:
              periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          }
        }

        requestLog.debug({ periodStart, periodEnd }, 'Querying usage stats');

        // Aggregate IN Postgres. The previous implementation findMany'd every
        // row in the period with NO take (a year-long window pulled the org's
        // entire request history into Node) and reduced/grouped in JS. GROUP BY
        // + SUM/AVG on the indexed (organizationId, createdAt) path returns a
        // handful of rows instead, and the five independent aggregates run
        // concurrently.
        const periodWhere = {
          organizationId,
          createdAt: { gte: periodStart, lte: periodEnd },
        };

        const [totals, errorCount, modelGroups, strategyGroups, strategySuccess] =
          await Promise.all([
            prisma.requestLog.aggregate({
              where: periodWhere,
              _count: { _all: true },
              _sum: { totalTokens: true, costUsd: true, durationMs: true },
            }),
            prisma.requestLog.count({
              where: { ...periodWhere, status: { not: 'success' } },
            }),
            prisma.requestLog.groupBy({
              by: ['modelId' as const],
              where: { ...periodWhere, modelId: { not: null } },
              _count: { _all: true },
              _sum: { totalTokens: true, costUsd: true },
              orderBy: { _count: { modelId: 'desc' } },
              take: 10,
            }),
            prisma.requestLog.groupBy({
              by: ['strategyName' as const],
              where: { ...periodWhere, strategyName: { not: null } },
              _count: { _all: true },
              _sum: { costUsd: true, qualityScore: true },
              orderBy: { _count: { strategyName: 'desc' } },
              take: 10,
            }),
            prisma.requestLog.groupBy({
              by: ['strategyName' as const],
              where: { ...periodWhere, strategyName: { not: null }, status: 'success' },
              _count: { _all: true },
            }),
          ]);

        const requestCount = totals._count._all;
        const successByStrategy = new Map(
          strategySuccess.map((row) => [row.strategyName, row._count._all])
        );

        const stats: UsageStats = {
          period,
          periodStart,
          periodEnd,
          requestCount,
          tokenCount: totals._sum.totalTokens ?? 0,
          costUsd: Number(totals._sum.costUsd ?? 0),
          avgDurationMs:
            requestCount > 0 ? Math.round(Number(totals._sum.durationMs ?? 0) / requestCount) : 0,
          errorRate: requestCount > 0 ? errorCount / requestCount : 0,
          cacheHitRate: 0, // Cache metadata ainda não é exposta nos logs agregados
          topModels: modelGroups.map((row) => ({
            modelName: row.modelId as string,
            requestCount: row._count._all,
            tokenCount: row._sum.totalTokens ?? 0,
            costUsd: Number(row._sum.costUsd ?? 0),
          })),
          // avgCost/avgQuality divide by the FULL group count (nulls contribute 0),
          // matching the previous in-JS accumulation semantics exactly.
          topStrategies: strategyGroups.map((row) => {
            const executionCount = row._count._all;
            const successCount = successByStrategy.get(row.strategyName) ?? 0;
            return {
              strategyName: row.strategyName as string,
              executionCount,
              avgCost: executionCount > 0 ? Number(row._sum.costUsd ?? 0) / executionCount : 0,
              avgQuality:
                executionCount > 0 ? Number(row._sum.qualityScore ?? 0) / executionCount : 0,
              successCount,
              successRate: executionCount > 0 ? successCount / executionCount : 0,
            };
          }),
        };

        requestLog.info(
          {
            requestCount: stats.requestCount,
            totalCost: stats.costUsd,
          },
          'Usage stats calculated'
        );

        return reply.send(stats);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        requestLog.error({ error: errorMessage }, 'Failed to fetch usage stats');

        return reply.status(500).send({
          error: {
            code: 'internal_error',
            message: errorMessage,
          },
        });
      }
    }
  );
}
