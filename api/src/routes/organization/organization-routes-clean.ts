// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Organization Routes - Clean Architecture
 * Uses CQRS Handlers via DI
 */

import type { FastifyInstance } from 'fastify';
import { container } from 'tsyringe';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { requirePermission } from '@/middleware/require-permission-middleware';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { ListOrganizationsHandler } from '@/application/handlers/list-organizations.handler';
import { GetOrganizationHandler } from '@/application/handlers/get-organization.handler';
import { UpdateOrganizationHandler } from '@/application/handlers/update-organization.handler';
import { ListOrganizationMembersHandler } from '@/application/handlers/list-organization-members.handler';
import { RemoveOrganizationMemberHandler } from '@/application/handlers/remove-organization-member.handler';
import { ListOrganizationsQuery } from '@/application/queries/list-organizations.query';
import { GetOrganizationQuery } from '@/application/queries/get-organization.query';
import { UpdateOrganizationCommand } from '@/application/commands/update-organization.command';
import { ListOrganizationMembersQuery } from '@/application/queries/list-organization-members.query';
import { RemoveOrganizationMemberCommand } from '@/application/commands/remove-organization-member.command';
import { initializeDIContainer } from '@/di/container';

export async function organizationRoutesClean(server: FastifyInstance): Promise<void> {
  initializeDIContainer();

  const listOrganizationsHandler = container.resolve(ListOrganizationsHandler);
  const getOrganizationHandler = container.resolve(GetOrganizationHandler);
  const updateOrganizationHandler = container.resolve(UpdateOrganizationHandler);
  const listOrganizationMembersHandler = container.resolve(ListOrganizationMembersHandler);
  const removeOrganizationMemberHandler = container.resolve(RemoveOrganizationMemberHandler);

  /**
   * GET /v1/organizations
   * List organizations
   */
  server.get<{
    Querystring: {
      limit?: number;
      offset?: number;
      tier?: string;
    };
  }>(
    '/v1/organizations',
    {
      onRequest: [authenticate],
      schema: {
        tags: ['Organizations'],
        description: 'List organizations',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            // A missing `default` meant an omitted `limit` became `take: undefined`
            // in Prisma — i.e. no limit, returning every organization on the
            // platform plus a per-row _count subquery. Default to a sane page size;
            // callers who already send `limit` are unaffected.
            limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
            offset: { type: 'number', minimum: 0, default: 0 },
            tier: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { limit, offset, tier } = request.query;

        const query = new ListOrganizationsQuery(limit, offset, tier);
        const result = await listOrganizationsHandler.execute(query);

        if (!result.success) {
          return reply.status(400).send({
            error: result.error,
          });
        }

        return {
          organizations: result.organizations,
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'List organizations error');
        return reply.status(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );

  /**
   * GET /v1/organizations/:id
   * Retrieve organization details
   */
  server.get<{
    Params: { id: string };
  }>(
    '/v1/organizations/:id',
    {
      onRequest: [authenticate],
      schema: {
        tags: ['Organizations'],
        description: 'Get organization details',
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
            type: 'object',
            properties: {
              organization: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  tier: { type: 'string' },
                  status: { type: 'string' },
                  memberCount: { type: 'number' },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const extendedRequest = request as ExtendedFastifyRequest;
        const currentUser = extendedRequest.user;
        if (!currentUser || typeof currentUser !== 'object' || !('userId' in currentUser) || !('organizationId' in currentUser)) {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'User not authenticated',
          });
        }

        const query = new GetOrganizationQuery(id, currentUser.userId, currentUser.organizationId);

        const result = await getOrganizationHandler.execute(query);

        if (!result.success) {
          if (result.errorCode === 'forbidden') {
            return reply.status(403).send({ error: result.error });
          }
          if (result.errorCode === 'not_found') {
            return reply.status(404).send({ error: result.error });
          }
          return reply.status(500).send({ error: result.error || 'Internal server error' });
        }

        return { organization: result.organization };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Get organization error');
        return reply.status(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );

  /**
   * PUT /v1/organizations/:id
   * Update organization
   */
  server.put<{
    Params: { id: string };
    Body: {
      name?: string;
      tier?: string;
    };
  }>(
    '/v1/organizations/:id',
    {
      onRequest: [authenticate],
      // Tighten the coarse role gate with the fine-grained `org:update` permission.
      preHandler: [requireRole('admin', 'owner'), requirePermission('org:update')],
      schema: {
        tags: ['Organizations'],
        description: 'Update organization',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            tier: { type: 'string', enum: ['free', 'starter', 'pro', 'enterprise'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              organization: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  tier: { type: 'string' },
                  status: { type: 'string' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const { name, tier } = request.body || {};
        const extendedRequest = request as ExtendedFastifyRequest;
        const currentUser = extendedRequest.user;
        if (!currentUser || typeof currentUser !== 'object' || !('userId' in currentUser) || !('organizationId' in currentUser)) {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'User not authenticated',
          });
        }

        const command = new UpdateOrganizationCommand(
          id,
          currentUser.userId,
          currentUser.organizationId,
          name,
          tier
        );

        const result = await updateOrganizationHandler.execute(command);

        if (!result.success) {
          if (result.errorCode === 'forbidden') {
            return reply.status(403).send({ error: result.error });
          }
          if (result.errorCode === 'not_found') {
            return reply.status(404).send({ error: result.error });
          }
          if (result.errorCode === 'invalid_payload') {
            return reply.status(400).send({ error: result.error });
          }
          return reply.status(500).send({ error: result.error || 'Internal server error' });
        }

        return {
          success: true,
          organization: result.organization,
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Update organization error');
        return reply.status(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );

  /**
   * GET /v1/organizations/:id/members
   * List organization members
   */
  server.get<{
    Params: { id: string };
  }>(
    '/v1/organizations/:id/members',
    {
      onRequest: [authenticate],
      schema: {
        tags: ['Organizations'],
        description: 'List organization members',
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
            type: 'object',
            properties: {
              members: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    name: { type: 'string' },
                    role: { type: 'string' },
                    status: { type: 'string' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const extendedRequest = request as ExtendedFastifyRequest;
        const currentUser = extendedRequest.user;
        if (!currentUser || typeof currentUser !== 'object' || !('userId' in currentUser) || !('organizationId' in currentUser)) {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'User not authenticated',
          });
        }

        const query = new ListOrganizationMembersQuery(
          id,
          currentUser.userId,
          currentUser.organizationId
        );

        const result = await listOrganizationMembersHandler.execute(query);

        if (!result.success) {
          if (result.errorCode === 'forbidden') {
            return reply.status(403).send({ error: result.error });
          }
          return reply.status(500).send({ error: result.error || 'Internal server error' });
        }

        return {
          members: result.members,
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'List organization members error');
        return reply.status(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );

  /**
   * DELETE /v1/organizations/:id/members/:userId
   * Remove organization member
   */
  server.delete<{
    Params: { id: string; userId: string };
  }>(
    '/v1/organizations/:id/members/:userId',
    {
      onRequest: [authenticate],
      // Removing a member is a membership/role-management operation.
      preHandler: [requireRole('admin', 'owner'), requirePermission('users:role_assign')],
      schema: {
        tags: ['Organizations'],
        description: 'Remove member from organization',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id', 'userId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { id, userId } = request.params;
        const extendedRequest = request as ExtendedFastifyRequest;
        const currentUser = extendedRequest.user;
        if (!currentUser || typeof currentUser !== 'object' || !('userId' in currentUser) || !('organizationId' in currentUser)) {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'User not authenticated',
          });
        }

        const command = new RemoveOrganizationMemberCommand(
          id,
          userId,
          currentUser.userId,
          currentUser.organizationId
        );

        const result = await removeOrganizationMemberHandler.execute(command);

        if (!result.success) {
          if (result.errorCode === 'forbidden') {
            return reply.status(403).send({ error: result.error });
          }
          if (result.errorCode === 'not_found') {
            return reply.status(404).send({ error: result.error });
          }
          if (result.errorCode === 'invalid_payload') {
            return reply.status(400).send({ error: result.error });
          }
          return reply.status(500).send({ error: result.error || 'Internal server error' });
        }

        return {
          success: true,
          message: result.message,
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Remove organization member error');
        return reply.status(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );
}
