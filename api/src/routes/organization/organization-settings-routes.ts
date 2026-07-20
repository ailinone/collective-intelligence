// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Organization Settings Routes
 * 
 * Endpoints for managing organization settings
 * 
 * Endpoints:
 * - PATCH /v1/organization/settings - Update organization settings (admin only)
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { requirePermission } from '@/middleware/require-permission-middleware';
import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

/**
 * Register organization settings routes
 */
export async function registerOrganizationSettingsRoutes(server: FastifyInstance): Promise<void> {
  /**
   * PATCH /v1/organization/settings
   * Update organization settings (admin only)
   */
  server.patch(
    '/v1/organization/settings',
    {
      preHandler: [authenticate, requireRole('admin', 'owner'), requirePermission('org:update')],
      schema: {
        tags: ['Organization'],
        description: 'Update organization settings (admin only)',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            settings: { type: 'object' },
          },
        },
        response: {
          200: {
            description: 'Organization settings updated successfully',
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
        
        if (!user || typeof user !== 'object') {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: 'Authentication required',
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

        // Type-safe body extraction
        const body = typeof request.body === 'object' && request.body !== null
          ? request.body
          : {};
        
        const name = 'name' in body && typeof body.name === 'string'
          ? body.name
          : undefined;
        const settings = 'settings' in body && typeof body.settings === 'object' && body.settings !== null
          ? body.settings as Record<string, unknown>
          : undefined;

        // Validate at least one field to update
        if (!name && !settings) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'At least one field (name or settings) must be provided',
          });
        }

        // Verify organization exists
        const existingOrg = await prisma.organization.findUnique({
          where: { id: organizationId },
          select: { id: true, name: true, settings: true },
        });

        if (!existingOrg) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Organization not found',
          });
        }

        // Prepare update data
        const updateData: {
          name?: string;
          settings?: Prisma.InputJsonValue;
        } = {};

        if (name !== undefined) {
          updateData.name = name;
        }

        if (settings !== undefined) {
          // Merge with existing settings (preserve existing, update provided)
          const existingSettings = existingOrg.settings && typeof existingOrg.settings === 'object' && existingOrg.settings !== null
            ? existingOrg.settings as Record<string, unknown>
            : {};
          
          const mergedSettings = {
            ...existingSettings,
            ...settings,
          };
          
          // Convert to Prisma.InputJsonValue type-safe
          updateData.settings = mergedSettings as Prisma.InputJsonValue;
        }

        // Update organization
        const updatedOrg = await prisma.organization.update({
          where: { id: organizationId },
          data: updateData,
          select: {
            id: true,
            name: true,
            settings: true,
            tier: true,
            status: true,
            updatedAt: true,
          },
        });

        logger.info(
          {
            organizationId,
            updatedFields: Object.keys(updateData),
            userId: 'userId' in user && typeof user.userId === 'string' ? user.userId : undefined,
          },
          'Organization settings updated successfully'
        );

        return reply.send({
          success: true,
          message: 'Organization settings updated',
          data: {
            organization: {
              id: updatedOrg.id,
              name: updatedOrg.name,
              tier: updatedOrg.tier,
              status: updatedOrg.status,
              settings: updatedOrg.settings,
              updatedAt: updatedOrg.updatedAt,
            },
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, 'Failed to update organization settings');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to update organization settings',
        });
      }
    },
  );

  logger.info('Organization settings routes registered');
}

