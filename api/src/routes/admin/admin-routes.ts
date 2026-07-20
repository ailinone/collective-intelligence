// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Admin Routes
 * 
 * Admin-only endpoints for user and organization management
 * 
 * Endpoints:
 * - GET /v1/admin/users - List all users (admin only, alias for /v1/users)
 * - DELETE /v1/admin/users/:id - Delete user (admin only, alias for /v1/users/:id)
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { requirePermission } from '@/middleware/require-permission-middleware';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

/**
 * Register admin routes
 */
export async function registerAdminRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /v1/admin/users
   * List all users in organization (admin only)
   * This is an alias for /v1/users but with explicit admin path
   */
  server.get(
    '/v1/admin/users',
    {
      preHandler: [authenticate, requireRole('admin', 'owner'), requirePermission('users:read')],
      schema: {
        tags: ['Admin'],
        description: 'List users in organization (admin only)',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'number', minimum: 1, default: 1 },
            limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
            status: { type: 'string', enum: ['active', 'suspended', 'inactive'] },
          },
        },
        response: {
          200: {
            description: 'List of users',
            type: 'object',
            properties: {
              users: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    name: { type: 'string' },
                    role: { type: 'string' },
                    status: { type: 'string' },
                    lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
                    createdAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
              pagination: {
                type: 'object',
                properties: {
                  page: { type: 'number' },
                  limit: { type: 'number' },
                  total: { type: 'number' },
                  totalPages: { type: 'number' },
                },
              },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
          403: {
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
        if (!user || typeof user !== 'object' || !('organizationId' in user)) {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: 'User not authenticated',
          });
        }
        const query = request.query as { page?: number; limit?: number; status?: 'active' | 'suspended' | 'inactive' };
        const { page = 1, limit = 20, status } = query;
        const organizationId = user.organizationId as string;

        const where: {
          organizationId: string;
          status?: 'active' | 'suspended' | 'inactive';
        } = {
          organizationId,
        };
        if (status) {
          where.status = status;
        }

        const [users, total] = await Promise.all([
          prisma.user.findMany({
            where,
            select: {
              id: true,
              email: true,
              name: true,
              role: true,
              status: true,
              lastLoginAt: true,
              createdAt: true,
            },
            skip: (page - 1) * limit,
            take: limit,
            orderBy: { createdAt: 'desc' },
          }),
          prisma.user.count({ where }),
        ]);

        return reply.send({
          users,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, 'Failed to list users');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to retrieve users',
        });
      }
    },
  );

  /**
   * DELETE /v1/admin/users/:id
   * Delete a user (admin only)
   * This is an alias for /v1/users/:id but with explicit admin path
   */
  server.delete(
    '/v1/admin/users/:id',
    {
      preHandler: [authenticate, requireRole('admin', 'owner'), requirePermission('users:role_assign')],
      schema: {
        tags: ['Admin'],
        description: 'Delete a user (admin only)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            description: 'User deleted successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
          403: {
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
        if (!user || typeof user !== 'object' || !('organizationId' in user)) {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: 'User not authenticated',
          });
        }
        const params = request.params as { id: string };
        const { id } = params;
        const organizationId = user.organizationId as string;

        // Check if user exists and belongs to the same organization
        const targetUser = await prisma.user.findFirst({
          where: {
            id,
            organizationId,
          },
        });

        if (!targetUser) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'User not found',
          });
        }

        // Prevent self-deletion
        // Type guard to safely access userId
        const currentUserId = 
          typeof user === 'object' && 
          user !== null && 
          'userId' in user && 
          typeof user.userId === 'string'
            ? user.userId
            : undefined;
        if (!currentUserId) {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: 'User ID not found',
          });
        }
        if (targetUser.id === currentUserId) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Cannot delete your own account',
          });
        }

        // Delete the user
        await prisma.user.delete({
          where: { id },
        });

        logger.info({ userId: id, deletedBy: currentUserId }, 'User deleted by admin');

        return reply.send({
          success: true,
          message: 'User deleted successfully',
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, 'Failed to delete user');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to delete user',
        });
      }
    },
  );

  logger.info('Admin routes registered');
}

