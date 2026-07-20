// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * User Management Routes
 * GET /v1/users - List users (admin only)
 * GET /v1/users/:id - Get user details
 * PUT /v1/users/:id - Update user
 * DELETE /v1/users/:id - Delete user (admin only)
 * POST /v1/users/:id/change-password - Change password
 */

import type { FastifyInstance } from 'fastify';
import { prisma } from '@/database/client';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { getAuthService } from '@/services/auth-service';
import { logger } from '@/utils/logger';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

/**
 * Register user management routes
 */
export async function registerUserManagementRoutes(server: FastifyInstance): Promise<void> {
  const authService = getAuthService();

  /**
   * GET /v1/users
   * List all users in organization (admin only)
   */
  server.get(
    '/v1/users',
    {
      preHandler: [authenticate, requireRole('admin', 'owner')],
      schema: {
        tags: ['Users'],
        description: 'List users in organization',
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
      const extendedRequest = request as ExtendedFastifyRequest;
      const user = extendedRequest.user;
      if (!user || typeof user !== 'object' || !('organizationId' in user)) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
      }
      const query = request.query as { page?: number; limit?: number; status?: 'active' | 'suspended' | 'inactive' };
      const page = query.page ?? 1;
      const limit = query.limit ?? 20;
      const status = query.status;

      const requestLog = logger.child({
        endpoint: '/v1/users',
        userId: user.userId,
        organizationId: user.organizationId,
      });

      try {
        const skip = (page - 1) * limit;

        const where: {
          organizationId: string;
          status?: 'active' | 'suspended' | 'inactive';
        } = {
          organizationId: user.organizationId as string,
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
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
          }),
          prisma.user.count({ where }),
        ]);

        const totalPages = Math.ceil(total / limit);

        requestLog.info({ count: users.length, total }, 'Users listed');

        return reply.send({
          users,
          pagination: {
            page,
            limit,
            total,
            totalPages,
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to list users';
        requestLog.error({ error: errorMessage }, 'Failed to list users');
        return reply.code(500).send({
          error: 'Internal Error',
          message: errorMessage,
        });
      }
    },
  );

  /**
   * GET /v1/users/:id
   * Get user details
   */
  server.get(
    '/v1/users/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Users'],
        description: 'Get user details',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        response: {
          200: {
            description: 'User details',
            type: 'object',
            properties: {
              id: { type: 'string' },
              email: { type: 'string' },
              name: { type: 'string' },
              role: { type: 'string' },
              status: { type: 'string' },
              organizationId: { type: 'string' },
              lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
              organization: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  tier: { type: 'string' },
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
      const extendedRequest = request as ExtendedFastifyRequest;
      const currentUser = extendedRequest.user;
      if (!currentUser || typeof currentUser !== 'object' || !('organizationId' in currentUser) || !('userId' in currentUser)) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
      }
      const { id } = request.params as { id: string };

      const requestLog = logger.child({
        endpoint: '/v1/users/:id',
        userId: currentUser.userId,
        targetUserId: id,
      });

      try {
        // Users can view their own profile or admins can view any user
        const canView = currentUser.userId === id || (Array.isArray(currentUser.roles) && (currentUser.roles.includes('admin') || currentUser.roles.includes('owner')));

        if (!canView) {
          requestLog.warn('Forbidden: user cannot view other users');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to view this user',
          });
        }

        const user = await prisma.user.findUnique({
          where: { id },
          include: {
            organization: {
              select: {
                id: true,
                name: true,
                tier: true,
              },
            },
          },
        });

        if (!user) {
          requestLog.warn('User not found');
          return reply.code(404).send({
            error: 'Not Found',
            message: 'User not found',
          });
        }

        // Verify same organization
        if (user.organizationId !== currentUser.organizationId) {
          requestLog.warn('Forbidden: user from different organization');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'User not found',
          });
        }

        requestLog.info('User details retrieved');

        return reply.send({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          organizationId: user.organizationId,
          lastLoginAt: user.lastLoginAt,
          createdAt: user.createdAt,
          organization: user.organization,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to get user details';
        requestLog.error({ error: errorMessage }, 'Failed to get user');
        return reply.code(500).send({
          error: 'Internal Error',
          message: errorMessage,
        });
      }
    },
  );

  /**
   * PUT /v1/users/:id
   * PATCH /v1/users/:id
   * Update user (both PUT and PATCH supported)
   */
  server.put(
    '/v1/users/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Users'],
        description: 'Update user',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            role: {
              type: 'string',
              enum: ['owner', 'admin', 'developer', 'member', 'auditor', 'viewer'],
            },
            status: { type: 'string', enum: ['active', 'suspended', 'inactive'] },
          },
        },
        response: {
          200: {
            description: 'User updated',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  role: { type: 'string' },
                  status: { type: 'string' },
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
      const extendedRequest = request as ExtendedFastifyRequest;
      const currentUser = extendedRequest.user;
      if (!currentUser || typeof currentUser !== 'object' || !('organizationId' in currentUser) || !('userId' in currentUser)) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
      }
      const { id } = request.params as { id: string };
      const updates = request.body as { name?: string; role?: string; status?: string };

      const requestLog = logger.child({
        endpoint: '/v1/users/:id',
        userId: currentUser.userId,
        targetUserId: id,
      });

      try {
        // Check permissions
        const isSelf = currentUser.userId === id;
        const isAdmin = Array.isArray(currentUser.roles) && (currentUser.roles.includes('admin') || currentUser.roles.includes('owner'));

        // Users can update their own name
        // Admins can update any user
        if (!isSelf && !isAdmin) {
          requestLog.warn('Forbidden: insufficient permissions');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Insufficient permissions',
          });
        }

        // Only admins can change role and status
        if ((updates.role || updates.status) && !isAdmin) {
          requestLog.warn('Forbidden: cannot change role/status');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Only admins can change role and status',
          });
        }

        // Get user
        const user = await prisma.user.findUnique({
          where: { id },
        });

        if (!user) {
          requestLog.warn('User not found');
          return reply.code(404).send({
            error: 'Not Found',
            message: 'User not found',
          });
        }

        // Verify same organization
        if (user.organizationId !== currentUser.organizationId) {
          requestLog.warn('Forbidden: different organization');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'User not found',
          });
        }

        // Update user
        const updatedUser = await prisma.user.update({
          where: { id },
          data: {
            ...(updates.name && { name: updates.name }),
            ...(updates.role && { role: updates.role }),
            ...(updates.status && { status: updates.status }),
          },
        });

        requestLog.info({ updates }, 'User updated');

        return reply.send({
          success: true,
          user: {
            id: updatedUser.id,
            email: updatedUser.email,
            name: updatedUser.name,
            role: updatedUser.role,
            status: updatedUser.status,
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to update user';
        requestLog.error({ error: errorMessage }, 'Failed to update user');
        return reply.code(500).send({
          error: 'Internal Error',
          message: errorMessage,
        });
      }
    },
  );

  // Also support PATCH for the same endpoint
  server.patch(
    '/v1/users/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Users'],
        description: 'Update user (PATCH)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            role: {
              type: 'string',
              enum: ['owner', 'admin', 'developer', 'member', 'auditor', 'viewer'],
            },
            status: { type: 'string', enum: ['active', 'suspended', 'inactive'] },
          },
        },
        response: {
          200: {
            description: 'User updated',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  role: { type: 'string' },
                  status: { type: 'string' },
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
      const extendedRequest = request as ExtendedFastifyRequest;
      const currentUser = extendedRequest.user;
      if (!currentUser || typeof currentUser !== 'object' || !('organizationId' in currentUser) || !('userId' in currentUser)) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
      }
      const { id } = request.params as { id: string };
      const updates = request.body as { name?: string; role?: string; status?: string };

      const requestLog = logger.child({
        endpoint: '/v1/users/:id',
        userId: currentUser.userId,
        targetUserId: id,
      });

      try {
        // Check permissions
        const isSelf = currentUser.userId === id;
        const isAdmin = Array.isArray(currentUser.roles) && (currentUser.roles.includes('admin') || currentUser.roles.includes('owner'));

        // Users can update their own name
        // Admins can update any user
        if (!isSelf && !isAdmin) {
          requestLog.warn('Forbidden: insufficient permissions');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Insufficient permissions',
          });
        }

        // Only admins can change role and status
        if ((updates.role || updates.status) && !isAdmin) {
          requestLog.warn('Forbidden: cannot change role/status');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Only admins can change role and status',
          });
        }

        // Get user
        const user = await prisma.user.findUnique({
          where: { id },
        });

        if (!user) {
          requestLog.warn('User not found');
          return reply.code(404).send({
            error: 'Not Found',
            message: 'User not found',
          });
        }

        // Verify same organization
        if (user.organizationId !== currentUser.organizationId) {
          requestLog.warn('Forbidden: different organization');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'User not found',
          });
        }

        // Update user
        const updatedUser = await prisma.user.update({
          where: { id },
          data: {
            ...(updates.name && { name: updates.name }),
            ...(updates.role && { role: updates.role }),
            ...(updates.status && { status: updates.status }),
          },
        });

        // If role was updated, also update UserRole table
        if (updates.role && isAdmin) {
          const { assignRoleToUser } = await import('@/services/rbac-service.js');
          await assignRoleToUser(id, user.organizationId, updates.role);
        }

        requestLog.info({ updates }, 'User updated');

        return reply.send({
          success: true,
          user: {
            id: updatedUser.id,
            email: updatedUser.email,
            name: updatedUser.name,
            role: updatedUser.role,
            status: updatedUser.status,
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to update user';
        requestLog.error({ error: errorMessage }, 'Failed to update user');
        return reply.code(500).send({
          error: 'Internal Error',
          message: errorMessage,
        });
      }
    },
  );

  /**
   * DELETE /v1/users/:id
   * Delete user (admin only)
   */
  server.delete(
    '/v1/users/:id',
    {
      preHandler: [authenticate, requireRole('admin', 'owner')],
      schema: {
        tags: ['Users'],
        description: 'Delete user',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        response: {
          200: {
            description: 'User deleted',
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
          400: {
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
      const extendedRequest = request as ExtendedFastifyRequest;
      const currentUser = extendedRequest.user;
      if (!currentUser || typeof currentUser !== 'object' || !('organizationId' in currentUser) || !('userId' in currentUser)) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
      }
      const { id } = request.params as { id: string };

      const requestLog = logger.child({
        endpoint: '/v1/users/:id',
        userId: currentUser.userId,
        targetUserId: id,
      });

      try {
        // Cannot delete yourself
        if (currentUser.userId === id) {
          requestLog.warn('Cannot delete yourself');
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Cannot delete your own account',
          });
        }

        // Get user
        const user = await prisma.user.findUnique({
          where: { id },
        });

        if (!user) {
          requestLog.warn('User not found');
          return reply.code(404).send({
            error: 'Not Found',
            message: 'User not found',
          });
        }

        // Verify same organization
        if (user.organizationId !== currentUser.organizationId) {
          requestLog.warn('Forbidden: different organization');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'User not found',
          });
        }

        // Delete user (cascade will delete API keys)
        await prisma.user.delete({
          where: { id },
        });

        requestLog.info('User deleted');

        return reply.send({
          success: true,
          message: 'User deleted successfully',
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to delete user';
        requestLog.error({ error: errorMessage }, 'Failed to delete user');
        return reply.code(500).send({
          error: 'Internal Error',
          message: errorMessage,
        });
      }
    },
  );

  /**
   * POST /v1/users/:id/change-password
   * Change user password
   */
  server.post(
    '/v1/users/:id/change-password',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Users'],
        description: 'Change password',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: ['oldPassword', 'newPassword'],
          properties: {
            oldPassword: { type: 'string' },
            newPassword: { type: 'string', minLength: 8 },
          },
        },
        response: {
          200: {
            description: 'Password changed',
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
          400: {
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
      const extendedRequest = request as ExtendedFastifyRequest;
      const currentUser = extendedRequest.user;
      if (!currentUser || typeof currentUser !== 'object' || !('organizationId' in currentUser) || !('userId' in currentUser)) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
      }
      const { id } = request.params as { id: string };
      const { oldPassword, newPassword } = request.body as {
        oldPassword: string;
        newPassword: string;
      };

      const requestLog = logger.child({
        endpoint: '/v1/users/:id/change-password',
        userId: currentUser.userId,
        targetUserId: id,
      });

      try {
        // Users can only change their own password
        if (currentUser.userId !== id) {
          requestLog.warn('Forbidden: can only change own password');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You can only change your own password',
          });
        }

        const success = await authService.changePassword(id, oldPassword, newPassword);

        if (!success) {
          requestLog.warn('Password change failed');
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Failed to change password. Verify old password is correct.',
          });
        }

        requestLog.info('Password changed');

        return reply.send({
          success: true,
          message: 'Password changed successfully',
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to change password';
        requestLog.error({ error: errorMessage }, 'Failed to change password');
        return reply.code(500).send({
          error: 'Internal Error',
          message: errorMessage,
        });
      }
    },
  );

  /**
   * GET /v1/users/:id/api-keys
   * List user's API keys
   */
  server.get(
    '/v1/users/:id/api-keys',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Users'],
        description: "List user's API keys",
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        response: {
          200: {
            description: 'List of API keys',
            type: 'object',
            properties: {
              apiKeys: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    keyPrefix: { type: 'string' },
                    status: { type: 'string' },
                    lastUsedAt: { type: 'string', format: 'date-time' },
                    expiresAt: { type: 'string', format: 'date-time', nullable: true },
                    createdAt: { type: 'string', format: 'date-time' },
                  },
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
      const extendedRequest = request as ExtendedFastifyRequest;
      const currentUser = extendedRequest.user;
      if (!currentUser || typeof currentUser !== 'object' || !('organizationId' in currentUser) || !('userId' in currentUser)) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
      }
      const { id } = request.params as { id: string };

      const requestLog = logger.child({
        endpoint: '/v1/users/:id/api-keys',
        userId: currentUser.userId,
        targetUserId: id,
      });

      try {
        // Users can only list their own API keys
        if (currentUser.userId !== id) {
          requestLog.warn('Forbidden: can only list own API keys');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You can only list your own API keys',
          });
        }

        const apiKeys = await prisma.apiKey.findMany({
          where: {
            userId: id,
          },
          select: {
            id: true,
            name: true,
            keyPrefix: true,
            status: true,
            lastUsedAt: true,
            expiresAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        });

        requestLog.info({ count: apiKeys.length }, 'API keys listed');

        return reply.send({
          apiKeys,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to list API keys';
        requestLog.error({ error: errorMessage }, 'Failed to list API keys');
        return reply.code(500).send({
          error: 'Internal Error',
          message: errorMessage,
        });
      }
    },
  );
}
