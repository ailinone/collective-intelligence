// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Kubernetes Health Probes
 * Liveness and Readiness endpoints for K8s
 */

import { FastifyPluginAsync } from 'fastify';
import { checkDatabaseHealth } from '@/database/client';
import { checkRedisHealth } from '@/cache/redis-client';
import { circuitBreakers } from '@/utils/circuit-breaker';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';
import { distributedBulkheadManager } from '@/core/resilience/distributed-bulkhead';
import { config } from '@/config';

/**
 * Health Probes Routes
 * /health/live - Liveness probe (is app running?)
 * /health/ready - Readiness probe (can handle requests?)
 */
export const healthProbesRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Base Health Endpoint
   * Returns 200 if application is running with basic metadata
   */
  fastify.get('/health', async (_request, reply) => {
    return reply.status(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: config.app.version,
    });
  });

  /**
   * Liveness Probe
   * Returns 200 if application is running
   * K8s will restart pod if this fails
   */
  fastify.get('/health/live', async (request, reply) => {
    // Simple check: if we can respond, we're alive
    return reply.status(200).send({
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  /**
   * Readiness Probe
   * Returns 200 if application can handle requests
   * K8s will remove from load balancer if this fails
   */
  fastify.get('/health/ready', async (request, reply) => {
    const checks: Record<string, boolean> = {};
    let ready = true;

    // Check database
    checks.database = await checkDatabaseHealth();
    if (!checks.database) {
      ready = false;
    }

    // Check Redis (non-critical, can degrade gracefully)
    const redisHealth = await checkRedisHealth();
    checks.redis = redisHealth.healthy;
    // Redis failure doesn't make us not-ready (cache can be bypassed)

    // Check circuit breakers (if too many are open, not ready)
    const breakerStatus = circuitBreakers.getAllStatus();
    const openBreakers = Object.values(breakerStatus).filter((b) => b.state === 'OPEN');
    checks.circuitBreakers = openBreakers.length === 0;

    // If critical circuit breakers are open, not ready
    const criticalOpen = openBreakers.filter((b) => b.name === 'database' || b.name === 'redis');
    if (criticalOpen.length > 0) {
      ready = false;
    }

    const statusCode = ready ? 200 : 503;

    return reply.status(statusCode).send({
      status: ready ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks,
      circuitBreakers: breakerStatus,
    });
  });

  /**
   * Provider Resilience Health (scale-to-100k Phase 2 follow-up, issue #152)
   *
   * Surfaces per-provider LLM circuit-breaker and bulkhead state, which
   * /health/ready deliberately does NOT factor into its ready/not_ready
   * verdict — a single degraded provider shouldn't pull this replica out of
   * the load-balancer rotation when other providers are still healthy.
   * This is purely observational, for operators/dashboards.
   */
  fastify.get('/health/providers', async (_request, reply) => {
    const [circuitBreakerStats, bulkheadStats] = await Promise.all([
      distributedCircuitBreakerManager.getAllStats(),
      distributedBulkheadManager.getAllStats(),
    ]);

    return reply.status(200).send({
      timestamp: new Date().toISOString(),
      circuitBreakers: circuitBreakerStats,
      bulkheads: bulkheadStats,
    });
  });

  /**
   * Startup Probe
   * Returns 200 when application has fully started
   * K8s will kill pod if this takes too long
   */
  fastify.get('/health/startup', async (request, reply) => {
    // Check if critical dependencies are initialized
    const dbReady = await checkDatabaseHealth();

    if (!dbReady) {
      return reply.status(503).send({
        status: 'starting',
        message: 'Database not ready',
        timestamp: new Date().toISOString(),
      });
    }

    return reply.status(200).send({
      status: 'started',
      timestamp: new Date().toISOString(),
    });
  });
};

/**
 * Register health probes
 */
import type { FastifyInstance } from 'fastify';

export function registerHealthProbes(fastify: FastifyInstance): void {
  fastify.register(healthProbesRoutes);
}
