// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Jobs Routes
 * Lists and manages background jobs (fine-tuning, batch processing, etc.)
 */

import type { FastifyInstance } from 'fastify';
import { authenticate } from '@/middleware/auth-middleware';
import { prisma } from '@/database/client';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

export async function registerJobsRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /v1/jobs
   * List all jobs (fine-tuning, batch, etc.)
   */
  server.get(
    '/v1/jobs',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Jobs'],
        summary: 'List all jobs',
        description: 'Returns a list of all jobs (fine-tuning, batch processing) for the authenticated user\'s organization',
        querystring: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['fine-tuning', 'batch', 'all'] },
            status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] },
            limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
            offset: { type: 'number', minimum: 0, default: 0 },
          },
        },
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    type: { type: 'string' },
                    status: { type: 'string' },
                    createdAt: { type: 'string' },
                    updatedAt: { type: 'string' },
                  },
                },
              },
              hasMore: { type: 'boolean' },
              total: { type: 'number' },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
          500: {
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
      try {
        const extendedRequest = request as ExtendedFastifyRequest;
        const user = extendedRequest.user;

        if (!user || typeof user !== 'object' || !('organizationId' in user) || typeof user.organizationId !== 'string') {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: 'Authentication required',
          });
        }

        const query = request.query as {
          type?: 'fine-tuning' | 'batch' | 'all';
          status?: string;
          limit?: number;
          offset?: number;
        };

        const limit = Math.min(query.limit || 20, 100);
        const offset = query.offset || 0;

        // Fine-tuning jobs are not stored in database yet
        // Return empty list for now
        const fineTuningJobs: Array<{ id: string; status: string; createdAt: Date; updatedAt: Date }> = [];

        const hasMore = fineTuningJobs.length > limit;
        const jobs = fineTuningJobs.slice(0, limit).map((job: { id: string; status: string; createdAt: Date; updatedAt: Date }) => ({
          id: job.id,
          type: 'fine-tuning',
          status: job.status,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
        }));

        // Get batch jobs if requested
        let batchJobs: Array<{ id: string; type: string; status: string; createdAt: string; updatedAt: string }> = [];
        if (query.type === 'batch' || query.type === 'all') {
          const batches = await prisma.batch.findMany({
            where: {
              organizationId: user.organizationId,
              ...(query.status ? { status: query.status } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: limit + 1,
            skip: offset,
            select: {
              id: true,
              status: true,
              createdAt: true,
              completedAt: true,
            },
          });

          batchJobs = batches.map((batch) => ({
            id: batch.id,
            type: 'batch',
            status: batch.status,
            createdAt: batch.createdAt.toISOString(),
            updatedAt: (batch.completedAt || batch.createdAt).toISOString(),
          }));
        }

        const allJobs = query.type === 'batch' ? batchJobs : query.type === 'all' ? [...jobs, ...batchJobs] : jobs;

        return reply.send({
          data: allJobs,
          hasMore: hasMore || (query.type === 'all' && batchJobs.length > limit),
          total: allJobs.length,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Failed to list jobs');
        return reply.code(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );

  /**
   * GET /v1/jobs/:id
   * Get details about a specific job
   */
  server.get(
    '/v1/jobs/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Jobs'],
        summary: 'Get job details',
        description: 'Returns detailed information about a specific job',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        response: {
          200: {
            type: 'object',
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
          500: {
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
      try {
        const extendedRequest = request as ExtendedFastifyRequest;
        const user = extendedRequest.user;

        if (!user || typeof user !== 'object' || !('organizationId' in user) || typeof user.organizationId !== 'string') {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: 'Authentication required',
          });
        }

        const { id } = request.params as { id: string };

        // Try batch job (fine-tuning jobs not in DB yet)
        const batchJob = await prisma.batch.findFirst({
          where: {
            id,
            organizationId: user.organizationId,
          },
        });

        if (batchJob) {
          return reply.send({
            ...batchJob,
            type: 'batch',
          });
        }

        return reply.code(404).send({
          error: 'Job not found',
          message: `Job with ID "${id}" not found`,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Failed to get job details');
        return reply.code(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );
}

