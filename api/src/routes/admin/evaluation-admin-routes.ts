// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Evaluation Admin Routes
 *
 * Admin-only endpoints for the closed-loop adaptive system:
 * - GET  /v1/admin/evaluation/drift           — Open drift events
 * - POST /v1/admin/evaluation/drift/detect    — Force drift detection
 * - GET  /v1/admin/evaluation/learning         — Learning validation reports
 * - POST /v1/admin/evaluation/learning/validate — Force learning validation
 * - GET  /v1/admin/evaluation/outcomes         — Recent execution outcomes
 * - GET  /v1/admin/evaluation/health           — System health summary
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import { detectDrift, getOpenDriftEvents } from '@/core/evaluation/drift-detection';
import { validateAllStrategies } from '@/core/evaluation/learning-validation';
import { getRecentOutcomes } from '@/core/evaluation/outcome-measurement';
import { getShadowEvalStats, getShadowEvalConfig } from '@/core/evaluation/shadow-evaluation';
import { getCompetitiveBenchmark } from '@/core/evaluation/performance-snapshots';
import { getRecentRollbacks } from '@/core/evaluation/rollback-service';
import { runEvaluationPipeline } from '@/jobs/evaluation-cron-job';

const log = logger.child({ component: 'evaluation-admin' });

export async function registerEvaluationAdminRoutes(server: FastifyInstance): Promise<void> {
  const adminPreHandler = [authenticate, requireRole('admin', 'owner')];

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/evaluation/drift — Open drift events
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/evaluation/drift',
    { preHandler: adminPreHandler, schema: { tags: ['Admin', 'Evaluation'] } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const events = await getOpenDriftEvents();
      return reply.send({
        openEvents: events,
        count: events.length,
        severity: {
          critical: events.filter(e => e.severity === 'critical').length,
          high: events.filter(e => e.severity === 'high').length,
          medium: events.filter(e => e.severity === 'medium').length,
          low: events.filter(e => e.severity === 'low').length,
        },
      });
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /v1/admin/evaluation/drift/detect — Force drift detection
  // ═══════════════════════════════════════════════════════════════════════════

  server.post(
    '/v1/admin/evaluation/drift/detect',
    { preHandler: adminPreHandler, schema: { tags: ['Admin', 'Evaluation'] } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      log.info('Admin-triggered drift detection');
      const result = await detectDrift();
      return reply.send(result);
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/evaluation/learning — Learning validation reports
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/evaluation/learning',
    { preHandler: adminPreHandler, schema: { tags: ['Admin', 'Evaluation'] } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const reports = await validateAllStrategies();
      const verdictCounts = {
        improving: reports.filter(r => r.verdict === 'improving').length,
        stable: reports.filter(r => r.verdict === 'stable').length,
        degrading: reports.filter(r => r.verdict === 'degrading').length,
        inconclusive: reports.filter(r => r.verdict === 'inconclusive').length,
      };
      return reply.send({
        reports,
        summary: verdictCounts,
        totalStrategies: reports.length,
        systemVerdict: verdictCounts.degrading > 0 ? 'degrading' :
          verdictCounts.improving > 0 ? 'improving' : 'stable',
      });
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /v1/admin/evaluation/learning/validate — Force learning validation
  // ═══════════════════════════════════════════════════════════════════════════

  server.post(
    '/v1/admin/evaluation/learning/validate',
    { preHandler: adminPreHandler, schema: { tags: ['Admin', 'Evaluation'] } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      log.info('Admin-triggered learning validation');
      const reports = await validateAllStrategies();
      return reply.send({ reports, count: reports.length });
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/evaluation/outcomes — Recent execution outcomes
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/evaluation/outcomes',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Evaluation'],
        querystring: {
          type: 'object',
          properties: {
            strategy: { type: 'string', nullable: true },
            hours: { type: 'number', minimum: 1, maximum: 168, default: 24 },
            limit: { type: 'number', minimum: 1, maximum: 500, default: 50 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { strategy?: string; hours?: number; limit?: number };
      const hours = query.hours ?? 24;
      const limit = query.limit ?? 50;

      const outcomes = await getRecentOutcomes({
        strategy: query.strategy,
        since: new Date(Date.now() - hours * 3_600_000),
        limit,
      });

      return reply.send({
        outcomes,
        count: outcomes.length,
        window: { hours, strategy: query.strategy ?? 'all' },
      });
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/evaluation/health — System health summary
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/evaluation/health',
    { preHandler: adminPreHandler, schema: { tags: ['Admin', 'Evaluation'] } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const [driftEvents, learningReports] = await Promise.all([
        getOpenDriftEvents(),
        validateAllStrategies(),
      ]);

      const hasCriticalDrift = driftEvents.some(e => e.severity === 'critical');
      const hasDegrading = learningReports.some(r => r.verdict === 'degrading');
      const hasImproving = learningReports.some(r => r.verdict === 'improving');

      let healthStatus: string;
      if (hasCriticalDrift || hasDegrading) {
        healthStatus = 'unhealthy';
      } else if (driftEvents.length > 0) {
        healthStatus = 'warning';
      } else if (hasImproving) {
        healthStatus = 'healthy-improving';
      } else {
        healthStatus = 'healthy-stable';
      }

      return reply.send({
        status: healthStatus,
        drift: {
          openEvents: driftEvents.length,
          criticalCount: driftEvents.filter(e => e.severity === 'critical').length,
        },
        learning: {
          improving: learningReports.filter(r => r.verdict === 'improving').length,
          stable: learningReports.filter(r => r.verdict === 'stable').length,
          degrading: learningReports.filter(r => r.verdict === 'degrading').length,
          inconclusive: learningReports.filter(r => r.verdict === 'inconclusive').length,
        },
        timestamp: new Date().toISOString(),
      });
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/evaluation/shadow — Shadow evaluation stats
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/evaluation/shadow',
    { preHandler: adminPreHandler, schema: { tags: ['Admin', 'Evaluation'] } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const [stats, config] = await Promise.all([
        getShadowEvalStats(24),
        Promise.resolve(getShadowEvalConfig()),
      ]);
      return reply.send({ stats, config });
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/evaluation/competitive — Competitive benchmarking
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/evaluation/competitive',
    { preHandler: adminPreHandler, schema: { tags: ['Admin', 'Evaluation'] } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { taskType?: string; days?: number };
      const data = await getCompetitiveBenchmark({
        taskType: query.taskType,
        windowDays: query.days ?? 7,
      });
      return reply.send({ rankings: data, count: data.length });
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /v1/admin/evaluation/rollbacks — Recent rollback events
  // ═══════════════════════════════════════════════════════════════════════════

  server.get(
    '/v1/admin/evaluation/rollbacks',
    { preHandler: adminPreHandler, schema: { tags: ['Admin', 'Evaluation'] } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const rollbacks = await getRecentRollbacks();
      return reply.send({ rollbacks, count: rollbacks.length });
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /v1/admin/evaluation/pipeline — Force full evaluation pipeline
  // ═══════════════════════════════════════════════════════════════════════════

  server.post(
    '/v1/admin/evaluation/pipeline',
    { preHandler: adminPreHandler, schema: { tags: ['Admin', 'Evaluation'] } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      log.info('Admin-triggered full evaluation pipeline');
      const result = await runEvaluationPipeline();
      return reply.send(result);
    },
  );
}
