// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Models Configuration Routes
 * 
 * Endpoints for configuring model settings
 * 
 * Endpoints:
 * - POST /v1/models/configure - Configure model settings (admin/editor only)
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

/**
 * Register models configuration routes
 */
export async function registerModelsConfigRoutes(server: FastifyInstance): Promise<void> {
  /**
   * POST /v1/models/configure
   * Configure model settings (admin/editor only)
   */
  server.post(
    '/v1/models/configure',
    {
      preHandler: [
        authenticate,
        requireRole('admin', 'developer', 'owner'),
        async (request, reply) => {
          // Ensure requireRole has been checked - if reply was sent, stop here
          // This check MUST be first to prevent handler execution if requireRole blocked
          if (reply.sent) {
            return;
          }
          
          // Check API key permissions if using API key auth (after role check)
          // This ensures role-based authorization is checked first
          try {
            const { checkApiKeyPermissions } = await import('@/middleware/api-key-permissions-middleware.js');
            await checkApiKeyPermissions(request, reply);
            // If checkApiKeyPermissions sends a response, it will return early
            // Check if reply was already sent
            if (reply.sent) {
              return;
            }
          } catch (error: unknown) {
            // If middleware doesn't exist or fails, continue (JWT auth is still valid)
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.debug({ error: errorMessage }, 'API key permissions check skipped');
          }
        },
      ],
      schema: {
        tags: ['Models'],
        description: 'Configure model settings (admin/editor only)',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: {
            modelId: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
        response: {
          200: {
            description: 'Model configured successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
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
      // If reply was already sent by a preHandler (e.g., requireRole), stop here
      if (reply.sent) {
        return;
      }
      
      try {
        const extendedRequest = request as ExtendedFastifyRequest;
        
        // Double-check authorization - this should never be reached if requireRole blocked the request
        const user = extendedRequest.user;
        if (!user || typeof user !== 'object') {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: 'Authentication required',
          });
        }
        
        const userRoles: string[] = 
          'roles' in user && Array.isArray(user.roles)
            ? user.roles
            : 'role' in user && typeof user.role === 'string'
              ? [user.role]
              : [];
        
        const allowedRoles = ['admin', 'developer', 'owner'];
        const hasRole = userRoles.some((role) => allowedRoles.includes(role));
        
        if (!hasRole) {
          logger.warn({
            userRoles,
            allowedRoles,
            url: request.url,
            method: request.method,
          }, 'Authorization check failed in handler - this should not happen');
          
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Insufficient permissions',
          });
        }
        
        // Type-safe body extraction
        // Fastify schema validation already ensures body is an object if present
        const body = typeof request.body === 'object' && request.body !== null
          ? request.body
          : {};
        
        // Extract fields with type safety (optional fields)
        const modelId = 'modelId' in body && typeof body.modelId === 'string'
          ? body.modelId
          : undefined;
        const enabled = 'enabled' in body && typeof body.enabled === 'boolean'
          ? body.enabled
          : undefined;
        
        // Validate required fields
        if (!modelId) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'modelId is required',
          });
        }

        // Get organization ID from user context
        const organizationId = 
          'organizationId' in user && typeof user.organizationId === 'string'
            ? user.organizationId
            : 'orgId' in user && typeof user.orgId === 'string'
              ? user.orgId
              : undefined;

        if (!organizationId) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Organization ID not found in user context',
          });
        }

        // Verify model exists in database (dynamic discovery - no hardcoded models)
        const model = await prisma.model.findFirst({
          where: { id: modelId },
        });

        if (!model) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Model ${modelId} not found. Use dynamic model discovery to find available models.`,
          });
        }

        // Update or create model configuration for this organization
        const updateData: {
          enabled?: boolean;
        } = {};

        if (enabled !== undefined) {
          updateData.enabled = enabled;
        }

        // Upsert model configuration
        const modelConfig = await prisma.modelConfig.upsert({
          where: {
            organizationId_modelId: {
              organizationId,
              modelId,
            },
          },
          create: {
            organizationId,
            modelId,
            enabled: enabled !== undefined ? enabled : true,
          },
          update: updateData,
          include: {
            model: {
              select: {
                id: true,
                name: true,
                displayName: true,
                provider: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        });

        logger.info(
          {
            modelId,
            enabled: modelConfig.enabled,
            organizationId,
            modelName: modelConfig.model?.name ?? modelId,
          },
          'Model configuration updated successfully'
        );

        return reply.send({
          success: true,
          message: 'Model configuration updated',
          data: {
            modelId: modelConfig.modelId,
            enabled: modelConfig.enabled,
            model: modelConfig.model
              ? {
                  id: modelConfig.model.id,
                  name: modelConfig.model.name,
                  displayName: modelConfig.model.displayName,
                  provider: modelConfig.model.provider.name,
                }
              : null,
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, 'Failed to configure model');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to configure model',
        });
      }
    },
  );

  logger.info('Models configuration routes registered');
}

