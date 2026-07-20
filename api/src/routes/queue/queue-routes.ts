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
import { queueResultService } from '@/services/request-queue-result-service';
import { logger } from '@/utils/logger';
import { recordSecurityEvent } from '@/services/security-audit-service';

const log = logger.child({ component: 'queue-routes' });

interface QueueStatusParams {
  id: string;
}

export async function registerQueueRoutes(server: FastifyInstance): Promise<void> {
  server.get<{ Params: QueueStatusParams }>(
    '/v1/queue/status/:id',
    {
      schema: {
        tags: ['Queue'],
        description: 'Retrieve the status of a queued request',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['queued', 'processing', 'completed', 'failed'] },
              metadata: {
                type: 'object',
                properties: {
                  organizationId: { type: 'string' },
                  userId: { type: 'string' },
                  enqueueTimestamp: { type: 'number' },
                  startedAt: { type: 'number' },
                  finishedAt: { type: 'number' },
                  priority: { type: 'number' },
                  tier: { type: 'string' },
                  queueTimeMs: { type: 'number' },
                  error: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
              result: { type: 'object' },
            },
          },
          401: { type: 'object' },
          403: { type: 'object' },
          404: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext({ requireUser: false })],
    },
    async (request: FastifyRequest<{ Params: QueueStatusParams }>, reply: FastifyReply) => {
      const queueId = request.params.id;
      const tenantContext = getTenantContext(request);
      const organizationId = tenantContext.organizationId;

      const record = await queueResultService.get(queueId);
      if (!record) {
        return reply.status(404).send({
          error: {
            code: 'queue_job_not_found',
            message: 'Queue job not found or expired',
          },
        });
      }

      if (record.metadata.organizationId !== organizationId) {
        const jobOrg = record.metadata.organizationId;

        log.warn(
          {
            queueId,
            requestOrg: organizationId,
            jobOrg,
          },
          'Queue status requested for mismatched organization'
        );

        await recordSecurityEvent({
          eventType: 'organization_mismatch',
          severity: 'warning',
          message: 'Queue job accessed with mismatched tenant.',
          organizationId,
          userId: tenantContext.userId,
          metadata: {
            queueId,
            jobOrganizationId: jobOrg,
            path: request.url,
          },
        });

        return reply.status(403).send({
          error: {
            code: 'queue_job_access_denied',
            message: 'You do not have permission to access this job',
          },
        });
      }

      return reply.send(record);
    }
  );

  server.delete<{ Params: QueueStatusParams }>(
    '/v1/queue/status/:id',
    {
      schema: {
        tags: ['Queue'],
        description: 'Delete cached queue status (e.g., after consumption)',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        response: {
          204: { type: 'null' },
          403: { type: 'object' },
          404: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext({ requireUser: false })],
    },
    async (request: FastifyRequest<{ Params: QueueStatusParams }>, reply: FastifyReply) => {
      const queueId = request.params.id;
      const tenantContext = getTenantContext(request);
      const organizationId = tenantContext.organizationId;

      const record = await queueResultService.get(queueId);
      if (!record) {
        return reply.status(404).send({
          error: {
            code: 'queue_job_not_found',
            message: 'Queue job not found or expired',
          },
        });
      }

      if (record.metadata.organizationId !== organizationId) {
        const jobOrg = record.metadata.organizationId;

        await recordSecurityEvent({
          eventType: 'organization_mismatch',
          severity: 'warning',
          message: 'Queue job deletion attempted with mismatched tenant.',
          organizationId,
          userId: tenantContext.userId,
          metadata: {
            queueId,
            jobOrganizationId: jobOrg,
            path: request.url,
          },
        });

        return reply.status(403).send({
          error: {
            code: 'queue_job_access_denied',
            message: 'You do not have permission to delete this job',
          },
        });
      }

      await queueResultService.delete(queueId);
      return reply.status(204).send();
    }
  );
}
