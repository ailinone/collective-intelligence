// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { FastifyPluginAsync } from 'fastify';
import { config } from '@/config';
import { API_VERSIONS, LATEST_VERSION } from '@/api/versioning/version-manager';
import { getCacheRuntimeState } from '@/cache/cache-runtime-state';
import { requestQueueService } from '@/services/request-queue-service';
import { getQueueRuntimeState } from '@/queue/queue-runtime-state';
import { checkDatabaseHealth } from '@/database/client';
import { checkRedisHealth } from '@/cache/redis-client';
import { circuitBreakers } from '@/utils/circuit-breaker';

export const registerStatusRoutes: FastifyPluginAsync = async (fastify) => {
  // WHY: Expose OpenAPI-compatible health routes under /v1/status/*
  // so runtime behavior matches the published contract.
  fastify.get('/v1/status/health', async (_request, reply) => {
    const dbHealthy = await checkDatabaseHealth();
    const redisHealth = await checkRedisHealth();
    const openCriticalBreakers = Object.values(circuitBreakers.getAllStatus()).filter(
      (breaker) => breaker.state === 'OPEN' && (breaker.name === 'database' || breaker.name === 'redis')
    );

    const healthy = dbHealthy && openCriticalBreakers.length === 0;

    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'healthy' : 'degraded',
      checks: {
        database: dbHealthy ? 'healthy' : 'unhealthy',
        redis: redisHealth.healthy ? 'healthy' : 'degraded',
      },
      timestamp: new Date().toISOString(),
    });
  });

  // WHY: Keep readiness endpoint aligned with Kubernetes readiness logic while
  // preserving the OpenAPI path expected by clients and contract tests.
  fastify.get('/v1/status/ready', async (_request, reply) => {
    const dbHealthy = await checkDatabaseHealth();
    const redisHealth = await checkRedisHealth();
    const openCriticalBreakers = Object.values(circuitBreakers.getAllStatus()).filter(
      (breaker) => breaker.state === 'OPEN' && (breaker.name === 'database' || breaker.name === 'redis')
    );

    const ready = dbHealthy && openCriticalBreakers.length === 0;

    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        database: dbHealthy ? 'healthy' : 'unhealthy',
        redis: redisHealth.healthy ? 'healthy' : 'degraded',
      },
      timestamp: new Date().toISOString(),
    });
  });

  fastify.get(
    '/v1/status',
    {
      schema: {
        tags: ['Health'],
        security: [],
        summary: 'Service status and capability negotiation endpoint',
        response: {
          200: {
            type: 'object',
            properties: {
              service: { type: 'string' },
              environment: { type: 'string' },
              version: { type: 'string' },
              build: {
                type: 'object',
                properties: {
                  commitSha: { type: ['string', 'null'] },
                  buildTimestamp: { type: ['string', 'null'] },
                },
              },
              apiVersion: { type: 'string' },
              supportedVersions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string' },
                    version: { type: 'string' },
                    status: { type: 'string' },
                    breaking: { type: 'boolean' },
                    supportedUntil: { type: 'string', nullable: true },
                  },
                },
              },
              cli: {
                type: 'object',
                properties: {
                  minVersion: { type: 'string' },
                  latestVersion: { type: 'string' },
                },
              },
              services: {
                type: 'object',
                properties: {
                  api: { type: 'string' },
                  database: { type: 'string' },
                  redis: { type: 'string' },
                  queue: { type: 'string' },
                  billing: { type: 'string' },
                },
                additionalProperties: true,
              },
              features: {
                type: 'object',
                properties: {
                  queue: { type: 'object', additionalProperties: true },
                  orchestration: { type: 'object', additionalProperties: true },
                  billing: { type: ['boolean', 'object'] },
                  cache: { type: 'object', additionalProperties: true },
                  secretsManager: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  observability: { type: 'object', additionalProperties: true },
                },
                additionalProperties: true,
              },
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async () => {
      const supportedVersions = Object.entries(API_VERSIONS).map(([key, info]) => ({
        key,
        version: info.version,
        status: info.status,
        breaking: info.breaking,
        supportedUntil: info.supportedUntil?.toISOString(),
      }));

      const cacheRuntime = getCacheRuntimeState();
      const queueRuntime = getQueueRuntimeState();
      const queueConfig = queueRuntime.configuration;
      const queueStats = queueRuntime.enabled
        ? await requestQueueService.getStatistics().catch(() => null)
        : null;
      const queueHealth = queueRuntime.enabled
        ? await requestQueueService.healthCheck().catch(() => null)
        : null;

      const features = {
        queue: {
          enabled: queueRuntime.enabled,
          disabledReason: queueRuntime.enabled ? undefined : queueRuntime.reason,
          configuredWorkers: queueConfig.workerCount,
          workerConcurrency: queueConfig.workerConcurrency,
          autoscale: {
            enabled: queueConfig.scale.enabled,
            minWorkers: queueConfig.scale.minWorkers,
            maxWorkers: queueConfig.scale.maxWorkers,
            scaleStep: queueConfig.scale.scaleStep,
            scaleUpUtilizationPercent: queueConfig.scale.scaleUpUtilizationPercent,
            scaleDownUtilizationPercent: queueConfig.scale.scaleDownUtilizationPercent,
            scaleUpQueueSize: queueConfig.scale.scaleUpQueueSize,
            scaleDownQueueSize: queueConfig.scale.scaleDownQueueSize,
            monitorIntervalMs: queueConfig.scale.monitorIntervalMs,
            cooldownMs: queueConfig.scale.cooldownMs,
          },
          stats: queueStats && {
            waiting: queueStats.waiting,
            active: queueStats.active,
            completed: queueStats.completed,
            failed: queueStats.failed,
            capacity: queueStats.capacity,
            utilizationPercent: Number(queueStats.utilizationPercent.toFixed(2)),
            workerCount: queueStats.workerCount,
          },
          health: queueHealth && {
            healthy: queueHealth.healthy,
            queueSize: queueHealth.queueSize,
            workersActive: queueHealth.workersActive,
            utilizationPercent: Number(queueHealth.utilizationPercent.toFixed(2)),
            workerCount: queueHealth.workerCount,
          },
        },
        orchestration: {
          defaultStrategy: config.orchestration.defaultStrategy,
          triageEnabled: config.orchestration.enableTriaging,
          maxModels: config.orchestration.maxModels,
        },
        billing: config.payments.stripe.enabled,
        cache: cacheRuntime,
        secretsManager: config.secrets.providers.map(
          (provider: (typeof config.secrets.providers)[number]) => provider.type
        ),
        observability: {
          otelEnabled: config.observability.otelEnabled,
          prometheusPort: config.observability.prometheusPort,
        },
      };

      const services = {
        api: 'ok',
        database: 'ok',
        redis: 'ok',
        queue: queueRuntime.enabled
          ? queueHealth && queueHealth.healthy === false
            ? 'degraded'
            : 'ok'
          : 'disabled',
        billing: config.payments.stripe.enabled ? 'enabled' : 'disabled',
      };

      return {
        service: config.observability.serviceName,
        environment: config.env,
        version: config.app.version,
        build: {
          commitSha: config.app.commitSha ?? null,
          buildTimestamp: config.app.buildTimestamp ?? null,
        },
        apiVersion: LATEST_VERSION,
        supportedVersions,
        cli: {
          minVersion: config.app.cliMinVersion,
          latestVersion: config.app.cliLatestVersion,
        },
        services,
        features,
        timestamp: new Date().toISOString(),
      };
    }
  );
};
