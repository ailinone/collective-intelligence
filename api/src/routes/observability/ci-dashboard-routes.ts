// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Collective Intelligence Observability Dashboard Routes
 *
 * Provides endpoints for monitoring and observing the Collective Intelligence system:
 * - System health and status
 * - Strategy usage statistics
 * - Model performance metrics
 * - Memory store statistics
 * - Workflow execution history
 * - Quality score distribution
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '@/database/client';
import { getSemanticCache } from '@/core/cache/semantic-cache';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { isCacheEnabled } from '@/cache/cache-runtime-state';

const log = logger.child({ component: 'ci-dashboard' });

// Helper to extract user context
function getUserContext(request: FastifyRequest): { organizationId: string; userId?: string } {
  const extendedRequest = request as ExtendedFastifyRequest;
  return {
    organizationId: extendedRequest.organizationId || '',
    userId: extendedRequest.userId,
  };
}

/**
 * Register Collective Intelligence Dashboard routes
 */
export async function registerCIDashboardRoutes(server: FastifyInstance): Promise<void> {
  const authenticatedServer = server as FastifyInstance & {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  };

  /**
   * Get overall CI system health and status
   * GET /v1/ci/dashboard/health
   */
  server.get(
    '/v1/ci/dashboard/health',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Get Collective Intelligence system health and status',
        tags: ['Observability'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              components: { type: 'object' },
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const components: Record<string, { status: string; details?: unknown }> = {};

        // Check database connection
        try {
          await prisma.$queryRaw`SELECT 1`;
          components.database = { status: 'healthy' };
        } catch {
          components.database = { status: 'unhealthy' };
        }

        // Check cache status
        components.cache = {
          status: isCacheEnabled() ? 'enabled' : 'disabled',
        };

        // Check semantic cache
        if (isCacheEnabled()) {
          try {
            const semanticCache = getSemanticCache();
            components.semanticCache = {
              status: semanticCache.isEnabled() ? 'enabled' : 'disabled',
            };
          } catch {
            components.semanticCache = { status: 'unavailable' };
          }
        }

        // Get active strategies count
        try {
          const strategyCount = await prisma.strategyWeight.count();
          components.strategies = {
            status: 'healthy',
            details: { count: strategyCount },
          };
        } catch {
          components.strategies = { status: 'unknown' };
        }

        // Get model count
        try {
          const modelCount = await prisma.model.count({
            where: { status: 'active' },
          });
          components.models = {
            status: modelCount > 0 ? 'healthy' : 'warning',
            details: { activeCount: modelCount },
          };
        } catch {
          components.models = { status: 'unknown' };
        }

        const allHealthy = Object.values(components).every(
          (c) => c.status === 'healthy' || c.status === 'enabled'
        );

        return reply.send({
          status: allHealthy ? 'healthy' : 'degraded',
          components,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to get CI health');
        return reply.status(500).send({ error: 'Failed to get CI health' });
      }
    }
  );

  /**
   * Get strategy usage statistics
   * GET /v1/ci/dashboard/strategies
   */
  server.get(
    '/v1/ci/dashboard/strategies',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Get orchestration strategy usage statistics',
        tags: ['Observability'],
        response: {
          200: {
            type: 'object',
            properties: {
              strategies: { type: 'array' },
              period: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Get strategy weights and performance data
        const strategyData = await prisma.strategyWeight.findMany({
          orderBy: { weight: 'desc' },
          take: 20,
        });

        const strategies = strategyData.map((s) => ({
          id: s.strategy,
          taskType: s.taskType,
          weight: Number(s.weight),
          avgQuality: Number(s.avgQuality),
          avgCostEfficiency: Number(s.avgCostEfficiency),
          successRate: Number(s.successRate),
          sampleCount: s.sampleCount,
        }));

        return reply.send({
          strategies,
          period: 'all_time',
        });
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to get strategy stats');
        return reply.status(500).send({ error: 'Failed to get strategy stats' });
      }
    }
  );

  /**
   * Get model performance metrics
   * GET /v1/ci/dashboard/models
   */
  server.get(
    '/v1/ci/dashboard/models',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Get model performance metrics',
        tags: ['Observability'],
        response: {
          200: {
            type: 'object',
            properties: {
              models: { type: 'array' },
              summary: { type: 'object' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Get models with performance data
        const models = await prisma.model.findMany({
          where: { status: 'active' },
          select: {
            id: true,
            name: true,
            displayName: true,
            providerId: true,
            status: true,
            inputCostPer1k: true,
            outputCostPer1k: true,
            contextWindow: true,
            maxOutputTokens: true,
          },
          take: 50,
        });

        // Get model health data
        const modelHealthMap = new Map<string, unknown>();
        try {
          const healthData = await prisma.modelHealth.findMany({
            where: { modelId: { in: models.map((m) => m.id) } },
          });
          for (const h of healthData) {
            modelHealthMap.set(h.modelId, h);
          }
        } catch {
          // ModelHealth might not exist yet
        }

        const enrichedModels = models.map((m) => ({
          modelId: m.id,
          modelName: m.displayName || m.name,
          provider: m.providerId,
          status: m.status,
          inputCostPer1k: Number(m.inputCostPer1k),
          outputCostPer1k: Number(m.outputCostPer1k),
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          health: modelHealthMap.get(m.id) || null,
        }));

        const byProvider: Record<string, number> = {};
        for (const m of models) {
          byProvider[m.providerId] = (byProvider[m.providerId] || 0) + 1;
        }

        const summary = {
          totalModels: models.length,
          byProvider,
        };

        return reply.send({
          models: enrichedModels,
          summary,
        });
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to get model metrics');
        return reply.status(500).send({ error: 'Failed to get model metrics' });
      }
    }
  );

  /**
   * Get learning insights
   * GET /v1/ci/dashboard/learning
   */
  server.get(
    '/v1/ci/dashboard/learning',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Get auto-learning system insights and patterns',
        tags: ['Observability'],
        response: {
          200: {
            type: 'object',
            properties: {
              learningData: { type: 'array' },
              summary: { type: 'object' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Get recent learning data
        const learningData = await prisma.learningData.findMany({
          orderBy: { createdAt: 'desc' },
          take: 50,
        });

        // Aggregate by task type
        const byTaskType = new Map<string, { count: number; avgQuality: number }>();
        for (const data of learningData) {
          const existing = byTaskType.get(data.taskType) || { count: 0, avgQuality: 0 };
          existing.count += data.count;
          existing.avgQuality =
            (existing.avgQuality * (existing.count - data.count) + Number(data.avgQuality) * data.count) /
            existing.count;
          byTaskType.set(data.taskType, existing);
        }

        const patterns = Array.from(byTaskType.entries()).map(([taskType, stats]) => ({
          taskType,
          ...stats,
        }));

        const summary = {
          totalDataPoints: learningData.length,
          taskTypes: patterns.length,
          period: 'recent',
        };

        return reply.send({
          learningData: learningData.slice(0, 20).map((d) => ({
            id: d.id,
            taskType: d.taskType,
            complexity: d.complexity,
            avgQuality: Number(d.avgQuality),
            avgLatency: d.avgLatency,
            avgCost: Number(d.avgCost),
            count: d.count,
            bucket: d.bucket,
            createdAt: d.createdAt,
          })),
          patterns,
          summary,
        });
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to get learning insights');
        return reply.status(500).send({ error: 'Failed to get learning insights' });
      }
    }
  );

  /**
   * Get cache statistics
   * GET /v1/ci/dashboard/cache
   */
  server.get(
    '/v1/ci/dashboard/cache',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Get semantic cache statistics',
        tags: ['Observability'],
        response: {
          200: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              stats: { type: 'object' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userContext = getUserContext(request);

      if (!userContext.organizationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
        if (!isCacheEnabled()) {
          return reply.send({
            enabled: false,
            stats: null,
          });
        }

        const semanticCache = getSemanticCache();
        const stats = await semanticCache.getStats(userContext.organizationId);

        return reply.send({
          enabled: true,
          stats: {
            ...stats,
            hitRate: stats.totalEntries > 0 ? stats.totalHits / stats.totalEntries : 0,
          },
        });
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to get cache stats');
        return reply.status(500).send({ error: 'Failed to get cache stats' });
      }
    }
  );

  /**
   * Get comprehensive dashboard overview
   * GET /v1/ci/dashboard/overview
   */
  server.get(
    '/v1/ci/dashboard/overview',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Get comprehensive CI dashboard overview with all metrics',
        tags: ['Observability'],
        response: {
          200: {
            type: 'object',
            properties: {
              health: { type: 'object' },
              usage: { type: 'object' },
              performance: { type: 'object' },
              costs: { type: 'object' },
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userContext = getUserContext(request);

      if (!userContext.organizationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
        const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Get counts for the periods
        const [logs24hCount, logs7dCount, modelCount, strategyCount] = await Promise.all([
          prisma.requestLog.count({
            where: {
              organizationId: userContext.organizationId,
              createdAt: { gte: last24h },
            },
          }),
          prisma.requestLog.count({
            where: {
              organizationId: userContext.organizationId,
              createdAt: { gte: last7d },
            },
          }),
          prisma.model.count({ where: { status: 'active' } }),
          prisma.strategyWeight.count(),
        ]);

        // Get aggregates separately to avoid type issues
        const logs24hAgg = await prisma.requestLog.aggregate({
          where: {
            organizationId: userContext.organizationId,
            createdAt: { gte: last24h },
          },
          _sum: { totalTokens: true, costUsd: true },
          _avg: { durationMs: true, qualityScore: true },
        });

        const logs7dAgg = await prisma.requestLog.aggregate({
          where: {
            organizationId: userContext.organizationId,
            createdAt: { gte: last7d },
          },
          _sum: { totalTokens: true, costUsd: true },
          _avg: { durationMs: true, qualityScore: true },
        });

        const overview = {
          health: {
            status: 'healthy',
            activeModels: modelCount,
            activeStrategies: strategyCount,
          },
          usage: {
            last24h: {
              requests: logs24hCount,
              tokens: logs24hAgg._sum?.totalTokens || 0,
            },
            last7d: {
              requests: logs7dCount,
              tokens: logs7dAgg._sum?.totalTokens || 0,
            },
          },
          performance: {
            avgLatency24h: logs24hAgg._avg?.durationMs || 0,
            avgQuality24h: logs24hAgg._avg?.qualityScore ? Number(logs24hAgg._avg.qualityScore) : 0,
            avgLatency7d: logs7dAgg._avg?.durationMs || 0,
            avgQuality7d: logs7dAgg._avg?.qualityScore ? Number(logs7dAgg._avg.qualityScore) : 0,
          },
          costs: {
            last24h: logs24hAgg._sum?.costUsd ? Number(logs24hAgg._sum.costUsd) : 0,
            last7d: logs7dAgg._sum?.costUsd ? Number(logs7dAgg._sum.costUsd) : 0,
            avgPerRequest24h:
              logs24hCount > 0 && logs24hAgg._sum?.costUsd
                ? Number(logs24hAgg._sum.costUsd) / logs24hCount
                : 0,
          },
          timestamp: new Date().toISOString(),
        };

        return reply.send(overview);
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to get dashboard overview');
        return reply.status(500).send({ error: 'Failed to get dashboard overview' });
      }
    }
  );

  log.info('✅ CI Dashboard routes registered');
}
