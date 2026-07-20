// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * User Routes - Clean Architecture
 * Uses CQRS Handlers via DI
 *
 * Migration from old service-based routes to Clean Architecture:
 * - GET /profile → GetUserHandler
 * - PUT /profile → UpdateUserHandler
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { container } from 'tsyringe';
import { GetUserHandler } from '@/application/handlers/get-user.handler';
import { UpdateUserHandler } from '@/application/handlers/update-user.handler';
import { GetUserQuery } from '@/application/queries/get-user.query';
import { UpdateUserCommand } from '@/application/commands/update-user.command';
import { initializeDIContainer } from '@/di/container';
import { authenticate } from '@/middleware/auth-middleware';

export async function userRoutes(server: FastifyInstance): Promise<void> {
  initializeDIContainer();

  // Get handlers from DI container
  const getUserHandler = container.resolve(GetUserHandler);
  const updateUserHandler = container.resolve(UpdateUserHandler);

  /**
   * GET /v1/user/profile
   * Get user profile (CQRS Query)
   */
  server.get(
    '/v1/user/profile',
    {
      onRequest: [authenticate],
      schema: {
        tags: ['User'],
        description: 'Get user profile',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  role: { type: 'string' },
                  status: { type: 'string' },
                  organizationId: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
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
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' },
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
        const currentUser = extendedRequest.user;

        if (!currentUser || typeof currentUser !== 'object' || !('userId' in currentUser) || typeof currentUser.userId !== 'string') {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: 'Authentication required',
          });
        }

        const requesterId = currentUser.userId;

        const query = new GetUserQuery({
          userId: requesterId,
          requestedBy: requesterId,
        });
        const result = await getUserHandler.execute(query);

        if (!result.success) {
          return reply.code(404).send({
            error: result.error || 'User not found',
          });
        }

        return {
          user: result.user,
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Internal server error';
        const errorStack = error instanceof Error ? error.stack : undefined;
        server.log.error(
          { error: errorMessage, stack: errorStack },
          'Error fetching user profile'
        );
        return reply.code(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    },
  );

  /**
   * PUT /v1/user/profile
   * Update user profile
   */
  server.put<
    {
      Body: {
        name?: string;
        email?: string;
      };
    },
    FastifyRequest
  >(
    '/v1/user/profile',
    {
      onRequest: [authenticate],
      schema: {
        tags: ['User'],
        description: 'Update user profile',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
          },
        },
        response: {
          200: {
            description: 'Profile updated',
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
        const currentUser = extendedRequest.user;

        if (!currentUser || typeof currentUser !== 'object' || !('userId' in currentUser) || typeof currentUser.userId !== 'string') {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: 'Authentication required',
          });
        }

        const { name, email } = request.body;

        // If no fields were provided, treat as a no-op update (idempotent)
        // This is safer for clients that send empty PATCH-like payloads.
        if (!name && !email) {
          return {
            success: true,
            message: 'No changes provided',
          };
        }

        const command = new UpdateUserCommand(currentUser.userId, { name, email });
        const result = await updateUserHandler.execute(command);

        if (!result.success) {
          return reply.code(400).send({
            error: result.error || 'Failed to update profile',
          });
        }

        return {
          success: true,
          message: 'Profile updated successfully',
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Internal server error';
        server.log.error({ error: errorMessage }, 'Error updating user profile');
        return reply.code(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    },
  );
}

export const registerUserRoutes = userRoutes;
