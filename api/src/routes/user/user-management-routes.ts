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
import {
  assertRoleChangeAllowed,
  getUserRoles,
  roleSetRank,
  setUserRole,
  userHasPermission,
} from '@/services/rbac-service';

interface RoleChangeDenial {
  code: 403;
  error: string;
  message: string;
}

/**
 * Outcome of {@link authorizeRoleChange}. On success it carries the
 * `allowOwner` DECISION for `setUserRole` — deliberately a value this function
 * produced after proving the caller is an owner, never `body.role === 'owner'`
 * re-derived from the request (which would make the service-level owner guard a
 * no-op for this route).
 */
type RoleChangeAuthorization =
  | { allowed: true; allowOwner: boolean }
  | { allowed: false; denial: RoleChangeDenial };

/**
 * Authorize an administrative role change.
 *
 * SECURITY (rbac-silent-role-downgrade): this used to be a bare `isAdmin` check
 * against the caller's token claims, after which the handler wrote `users.role`
 * DIRECTLY and never created a `user_roles` row — manufacturing exactly the
 * desync that made privilege silently destructible, and letting any admin mint
 * `owner` out of thin air.
 *
 * Every leg now lives HERE (it used to be split between this function and the
 * `isAdmin` check at the call site, while the doc comment described it as one
 * thing):
 *   1. the caller's CLAIMS must carry admin/owner. Since the global
 *      `apiKeyAuthMiddleware` builds those claims from the authoritative
 *      `user_roles` join and nothing else, this is no longer a second,
 *      independent "snapshot" source — it is a cheap pre-filter, and leg 2 is
 *      the check that actually decides;
 *   2. the caller must hold `users:role_assign` in the DATABASE;
 *   3. no HIERARCHY INVERSION: the caller may not act on a principal that
 *      outranks it, nor grant a role above its own rank. Without this an admin
 *      could strip an owner (whenever a second owner exists) or, worse, use the
 *      route to reshuffle authority above itself;
 *   4. granting `owner` additionally requires the caller to BE an owner, in
 *      both claims and the database. Admins may not mint owners.
 */
async function authorizeRoleChange(params: {
  actorUserId: string;
  actorRoles: string[];
  organizationId: string;
  requestedRole: string;
  targetUserId: string;
}): Promise<RoleChangeAuthorization> {
  const { actorUserId, actorRoles, organizationId, requestedRole, targetUserId } = params;

  const deny = (message: string): RoleChangeAuthorization => ({
    allowed: false,
    denial: { code: 403, error: 'Forbidden', message },
  });

  // 1. Claims pre-filter.
  if (!actorRoles.includes('admin') && !actorRoles.includes('owner')) {
    return deny('Only admins can change role and status');
  }

  // 2. Database permission — the authoritative leg.
  const hasDbPermission = await userHasPermission(actorUserId, organizationId, 'users:role_assign');
  if (!hasDbPermission) {
    return deny('Insufficient permissions to assign roles');
  }

  // 3. Rank. Both sides read from the authoritative join table.
  const actorDbRoles = await getUserRoles(actorUserId, organizationId);
  const actorRank = roleSetRank(actorDbRoles);

  if (roleSetRank([requestedRole]) > actorRank) {
    return deny('Cannot grant a role higher than your own');
  }

  if (targetUserId !== actorUserId) {
    const targetDbRoles = await getUserRoles(targetUserId, organizationId);
    if (roleSetRank(targetDbRoles) > actorRank) {
      return deny('Cannot change the role of a user who outranks you');
    }
  }

  // 4. Owner is minted only by an owner.
  if (requestedRole === 'owner') {
    if (!actorRoles.includes('owner') || !actorDbRoles.includes('owner')) {
      return deny('Only an organization owner can grant the owner role');
    }
    return { allowed: true, allowOwner: true };
  }

  return { allowed: true, allowOwner: false };
}

/**
 * Authorize an administrative STATUS change (suspend / reactivate / deactivate).
 *
 * Same shape as the role check and for the same reason: suspending an account is
 * an administrative act on another principal, so it must be backed by a DATABASE
 * permission and must respect rank — not by claims alone.
 *
 * `users:role_assign` is used as the "administer other users" permission because
 * it is the one the default seed grants to exactly admin+owner
 * (config/rbac-defaults.ts). Splitting out a dedicated `users:status_change`
 * would require a permission-catalog migration; until that is seeded everywhere
 * a check against it would lock every admin out, which is a worse failure.
 */
async function authorizeStatusChange(params: {
  actorUserId: string;
  actorRoles: string[];
  organizationId: string;
  targetUserId: string;
}): Promise<RoleChangeDenial | null> {
  const { actorUserId, actorRoles, organizationId, targetUserId } = params;

  if (!actorRoles.includes('admin') && !actorRoles.includes('owner')) {
    return { code: 403, error: 'Forbidden', message: 'Only admins can change role and status' };
  }

  const hasDbPermission = await userHasPermission(actorUserId, organizationId, 'users:role_assign');
  if (!hasDbPermission) {
    return {
      code: 403,
      error: 'Forbidden',
      message: 'Insufficient permissions to change user status',
    };
  }

  if (targetUserId !== actorUserId) {
    const actorRank = roleSetRank(await getUserRoles(actorUserId, organizationId));
    const targetRank = roleSetRank(await getUserRoles(targetUserId, organizationId));
    if (targetRank > actorRank) {
      return {
        code: 403,
        error: 'Forbidden',
        message: 'Cannot change the status of a user who outranks you',
      };
    }
  }

  return null;
}

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
      const query = request.query as {
        page?: number;
        limit?: number;
        status?: 'active' | 'suspended' | 'inactive';
      };
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
    }
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
      if (
        !currentUser ||
        typeof currentUser !== 'object' ||
        !('organizationId' in currentUser) ||
        !('userId' in currentUser)
      ) {
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
        const canView =
          currentUser.userId === id ||
          (Array.isArray(currentUser.roles) &&
            (currentUser.roles.includes('admin') || currentUser.roles.includes('owner')));

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
    }
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
          409: {
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
      if (
        !currentUser ||
        typeof currentUser !== 'object' ||
        !('organizationId' in currentUser) ||
        !('userId' in currentUser)
      ) {
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
        const isAdmin =
          Array.isArray(currentUser.roles) &&
          (currentUser.roles.includes('admin') || currentUser.roles.includes('owner'));

        // Users can update their own name
        // Admins can update any user
        if (!isSelf && !isAdmin) {
          requestLog.warn('Forbidden: insufficient permissions');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Insufficient permissions',
          });
        }

        // Role/status changes are authorized below by authorizeRoleChange /
        // authorizeStatusChange, which check claims AND the database AND rank.
        // The old bare `isAdmin` gate lived here while the doc comment claimed
        // the whole decision was in one place; it is not duplicated any more.

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

        const actorRoles = Array.isArray(currentUser.roles) ? currentUser.roles : [];
        let roleChangeAllowOwner = false;

        if (updates.role) {
          const authorization = await authorizeRoleChange({
            actorUserId: currentUser.userId,
            actorRoles,
            organizationId: user.organizationId,
            requestedRole: updates.role,
            targetUserId: id,
          });
          if (!authorization.allowed) {
            requestLog.warn(
              { requestedRole: updates.role },
              'Forbidden: role assignment not authorized'
            );
            return reply.code(authorization.denial.code).send({
              error: authorization.denial.error,
              message: authorization.denial.message,
            });
          }
          roleChangeAllowOwner = authorization.allowOwner;

          // Pre-flight the last-owner rule BEFORE anything is written. Throwing
          // out of setUserRole further down returned 409 with `name`/`status`
          // already committed and the role untouched — a half-applied request.
          await assertRoleChangeAllowed(id, user.organizationId, updates.role);
        }

        if (updates.status) {
          const statusDenial = await authorizeStatusChange({
            actorUserId: currentUser.userId,
            actorRoles,
            organizationId: user.organizationId,
            targetUserId: id,
          });
          if (statusDenial) {
            requestLog.warn(
              { requestedStatus: updates.status },
              'Forbidden: status change not authorized'
            );
            return reply.code(statusDenial.code).send({
              error: statusDenial.error,
              message: statusDenial.message,
            });
          }
        }

        // Update the plain profile fields. `role` is deliberately NOT written
        // here: the join table is the source of truth and setUserRole() below
        // keeps the denormalized `users.role` column coherent.
        const updatedUser = await prisma.user.update({
          where: { id },
          data: {
            ...(updates.name && { name: updates.name }),
            ...(updates.status && { status: updates.status }),
          },
        });

        let effectiveRole = updatedUser.role;
        if (updates.role) {
          const roles = await setUserRole(id, user.organizationId, updates.role, {
            // The DECISION from authorizeRoleChange, not a mirror of the body.
            allowOwner: roleChangeAllowOwner,
            assignedBy: currentUser.userId,
          });
          effectiveRole = roles.includes(updates.role) ? updates.role : updatedUser.role;
        }

        requestLog.info({ updates }, 'User updated');

        return reply.send({
          success: true,
          user: {
            id: updatedUser.id,
            email: updatedUser.email,
            name: updatedUser.name,
            role: effectiveRole,
            status: updatedUser.status,
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to update user';
        if (errorMessage === 'cannot_demote_last_owner') {
          requestLog.warn('Refused to demote the last owner');
          return reply.code(409).send({
            error: 'Conflict',
            message:
              'Cannot change the role of the last owner of this organization. Grant owner to another member first.',
          });
        }
        requestLog.error({ error: errorMessage }, 'Failed to update user');
        return reply.code(500).send({
          error: 'Internal Error',
          message: errorMessage,
        });
      }
    }
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
          409: {
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
      if (
        !currentUser ||
        typeof currentUser !== 'object' ||
        !('organizationId' in currentUser) ||
        !('userId' in currentUser)
      ) {
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
        const isAdmin =
          Array.isArray(currentUser.roles) &&
          (currentUser.roles.includes('admin') || currentUser.roles.includes('owner'));

        // Users can update their own name
        // Admins can update any user
        if (!isSelf && !isAdmin) {
          requestLog.warn('Forbidden: insufficient permissions');
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Insufficient permissions',
          });
        }

        // Role/status changes are authorized below by authorizeRoleChange /
        // authorizeStatusChange, which check claims AND the database AND rank.
        // The old bare `isAdmin` gate lived here while the doc comment claimed
        // the whole decision was in one place; it is not duplicated any more.

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

        const actorRoles = Array.isArray(currentUser.roles) ? currentUser.roles : [];
        let roleChangeAllowOwner = false;

        if (updates.role) {
          const authorization = await authorizeRoleChange({
            actorUserId: currentUser.userId,
            actorRoles,
            organizationId: user.organizationId,
            requestedRole: updates.role,
            targetUserId: id,
          });
          if (!authorization.allowed) {
            requestLog.warn(
              { requestedRole: updates.role },
              'Forbidden: role assignment not authorized'
            );
            return reply.code(authorization.denial.code).send({
              error: authorization.denial.error,
              message: authorization.denial.message,
            });
          }
          roleChangeAllowOwner = authorization.allowOwner;

          // Pre-flight the last-owner rule BEFORE anything is written. Throwing
          // out of setUserRole further down returned 409 with `name`/`status`
          // already committed and the role untouched — a half-applied request.
          await assertRoleChangeAllowed(id, user.organizationId, updates.role);
        }

        if (updates.status) {
          const statusDenial = await authorizeStatusChange({
            actorUserId: currentUser.userId,
            actorRoles,
            organizationId: user.organizationId,
            targetUserId: id,
          });
          if (statusDenial) {
            requestLog.warn(
              { requestedStatus: updates.status },
              'Forbidden: status change not authorized'
            );
            return reply.code(statusDenial.code).send({
              error: statusDenial.error,
              message: statusDenial.message,
            });
          }
        }

        // `role` is deliberately NOT written here — see the PUT twin above.
        const updatedUser = await prisma.user.update({
          where: { id },
          data: {
            ...(updates.name && { name: updates.name }),
            ...(updates.status && { status: updates.status }),
          },
        });

        let effectiveRole = updatedUser.role;
        if (updates.role) {
          const roles = await setUserRole(id, user.organizationId, updates.role, {
            // The DECISION from authorizeRoleChange, not a mirror of the body.
            allowOwner: roleChangeAllowOwner,
            assignedBy: currentUser.userId,
          });
          effectiveRole = roles.includes(updates.role) ? updates.role : updatedUser.role;
        }

        requestLog.info({ updates }, 'User updated');

        return reply.send({
          success: true,
          user: {
            id: updatedUser.id,
            email: updatedUser.email,
            name: updatedUser.name,
            role: effectiveRole,
            status: updatedUser.status,
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to update user';
        if (errorMessage === 'cannot_demote_last_owner') {
          requestLog.warn('Refused to demote the last owner');
          return reply.code(409).send({
            error: 'Conflict',
            message:
              'Cannot change the role of the last owner of this organization. Grant owner to another member first.',
          });
        }
        requestLog.error({ error: errorMessage }, 'Failed to update user');
        return reply.code(500).send({
          error: 'Internal Error',
          message: errorMessage,
        });
      }
    }
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
      if (
        !currentUser ||
        typeof currentUser !== 'object' ||
        !('organizationId' in currentUser) ||
        !('userId' in currentUser)
      ) {
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
    }
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
      if (
        !currentUser ||
        typeof currentUser !== 'object' ||
        !('organizationId' in currentUser) ||
        !('userId' in currentUser)
      ) {
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
    }
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
      if (
        !currentUser ||
        typeof currentUser !== 'object' ||
        !('organizationId' in currentUser) ||
        !('userId' in currentUser)
      ) {
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
    }
  );
}
