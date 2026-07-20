// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DLQ Admin Routes
 * C3 fix: Admin endpoints for inspecting and replaying dead letter queue jobs.
 * ADR-003: These endpoints are required for production operability.
 *
 * Routes:
 *   GET  /admin/queues/dlq           — List all DLQ queues and their sizes
 *   GET  /admin/queues/dlq/:queue    — List jobs in a specific queue's DLQ
 *   POST /admin/queues/dlq/:queue/:jobId/replay — Replay a single DLQ job
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  listDLQJobs,
  replayDLQJob,
  getDLQSizes,
  getRegisteredDLQQueues,
} from '@/queue/dlq-manager';
import { narrowAs } from '@/utils/type-guards';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'dlq-admin-routes' });

export async function registerDLQAdminRoutes(server: FastifyInstance): Promise<void> {
  // SECURITY (RBAC): the `/admin/queues/dlq*` paths do NOT match
  // PROTECTED_ROUTE_PREFIXES in the global api-key-auth middleware (which only
  // covers `/v1/...`), so without an explicit preHandler these endpoints were
  // fully unauthenticated. Replaying DLQ jobs re-runs arbitrary queued work and
  // listing exposes job payloads, so gate every route behind admin/owner auth.
  const adminPreHandler = [authenticate, requireRole('admin', 'owner')];

  /**
   * GET /admin/queues/dlq — Overview of all DLQ queues and sizes
   */
  server.get('/admin/queues/dlq', { preHandler: adminPreHandler }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const queues = getRegisteredDLQQueues();
    const sizes = await getDLQSizes();

    return reply.send({
      queues: queues.map((name) => ({
        name,
        dlqName: `${name}-dlq`,
        size: sizes[name] ?? 0,
      })),
      totalDeadLetters: Object.values(sizes).reduce((sum, n) => sum + Math.max(n, 0), 0),
    });
  });

  /**
   * GET /admin/queues/dlq/:queue — List jobs in a specific queue's DLQ
   */
  server.get<{ Params: { queue: string }; Querystring: { page?: string; limit?: string } }>(
    '/admin/queues/dlq/:queue',
    { preHandler: adminPreHandler },
    async (
      request: FastifyRequest<{ Params: { queue: string }; Querystring: { page?: string; limit?: string } }>,
      reply: FastifyReply,
    ) => {
      const { queue } = request.params;
      const page = Math.max(1, parseInt(request.query.page || '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '20', 10)));

      const result = await listDLQJobs(queue, page, limit);
      return reply.send({
        queue,
        page,
        limit,
        total: result.total,
        jobs: result.jobs,
      });
    },
  );

  /**
   * POST /admin/queues/dlq/:queue/:jobId/replay — Replay a single DLQ job
   */
  server.post<{ Params: { queue: string; jobId: string } }>(
    '/admin/queues/dlq/:queue/:jobId/replay',
    { preHandler: adminPreHandler },
    async (
      request: FastifyRequest<{ Params: { queue: string; jobId: string } }>,
      reply: FastifyReply,
    ) => {
      const { queue, jobId } = request.params;

      log.info({ queue, jobId, userId: (narrowAs<{ userId?: string }>(request)).userId }, 'DLQ replay requested');

      const result = await replayDLQJob(queue, jobId);

      if (result.success) {
        return reply.send({
          status: 'replayed',
          queue,
          originalDlqJobId: jobId,
          newJobId: result.newJobId,
        });
      } else {
        return reply.status(400).send({
          error: {
            code: 'dlq_replay_failed',
            message: result.error,
          },
        });
      }
    },
  );
}
