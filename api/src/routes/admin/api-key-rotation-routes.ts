// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Key Rotation Admin Routes (v5.0)
 *
 * Admin-only endpoints for managing API key rotation
 *
 * Endpoints:
 * - POST /v1/admin/api-keys/rotate/:keyId - Manually rotate a key
 * - GET /v1/admin/api-keys/rotation-status - Get rotation status for all keys
 * - POST /v1/admin/api-keys/auto-rotate/enable - Enable auto-rotation
 * - GET /v1/admin/api-keys/rotation-logs - Get audit trail
 */

import type { FastifyInstance } from 'fastify';
import { ApiKeyRotationService } from '@/services/api-key-rotation';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { authenticate, requireRole, isPlatformAdminRequest } from '@/middleware/auth-middleware';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { rejectAnonymousGuestKeyPreHandler } from '@/services/anonymous-quota-gate';
import { rejectChatFreeTierKeyPreHandler } from '@/services/free-tier-quota-gate';
import { requirePermission } from '@/middleware/require-permission-middleware';

// ============================================
// Types
// ============================================

interface RotateKeyParams {
  keyId: string;
}

interface RotateKeyBody {
  gracePeriodDays?: number;
  reason?: string;
}

interface EnableAutoRotationBody {
  keyId: string;
  rotationIntervalDays?: number;
  gracePeriodDays?: number;
}

interface RotationLogsQuery {
  apiKeyId?: string;
  limit?: number;
  offset?: number;
}

// ============================================
// Routes
// ============================================

export async function registerApiKeyRotationRoutes(server: FastifyInstance): Promise<void> {
  // ==========================================
  // POST /v1/admin/api-keys/rotate/:keyId
  // Manually rotate an API key
  // ==========================================

  server.post<{
    Params: RotateKeyParams;
    Body: RotateKeyBody;
  }>(
    '/v1/admin/api-keys/rotate/:keyId',
    {
      preHandler: [
        authenticate,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
        // SECURITY (platform-admin-vs-tenant-admin, 2026-09-08): a tenant
        // admin/owner may legitimately manage its OWN organization's keys
        // (self-service credential rotation is real product functionality,
        // not a bug) — the real gap was the handler never checking the
        // TARGET key belongs to the caller's org. Fixed here via an explicit
        // ownership check (isPlatformAdminRequest bypass for genuine
        // platform operators), not by removing tenant self-service.
        requireRole('admin', 'owner'),
        requirePermission('apikeys:manage'),
      ],
      schema: {
        tags: ['Admin - API Keys'],
        summary: 'Manually rotate an API key',
        description:
          'Triggers immediate key rotation with grace period. Both old and new keys will be valid during grace period.',
        params: {
          type: 'object',
          required: ['keyId'],
          properties: {
            keyId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            gracePeriodDays: {
              type: 'number',
              minimum: 1,
              maximum: 30,
              default: 7,
              description: 'Days before old key expires',
            },
            reason: {
              type: 'string',
              description: 'Reason for rotation (e.g., security incident, routine)',
            },
          },
        },
        response: {
          200: {
            description: 'Key rotated successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: {
                type: 'object',
                properties: {
                  newKey: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      keyPrefix: { type: 'string' },
                      plainKey: { type: 'string', description: 'Only shown once!' },
                    },
                  },
                  oldKey: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      keyPrefix: { type: 'string' },
                      expiresAt: { type: 'string', format: 'date-time' },
                    },
                  },
                  gracePeriodDays: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { keyId } = request.params;
        const { gracePeriodDays, reason } = request.body;

        // Extract userId from authenticated user
        const extendedRequest = request as ExtendedFastifyRequest;
        const user = extendedRequest.user;
        const performedBy =
          user && typeof user === 'object' && 'userId' in user && typeof user.userId === 'string'
            ? user.userId
            : undefined;

        // SECURITY: a tenant admin may only rotate a key that belongs to
        // their OWN organization; a genuine platform admin may target any.
        // 404 (not 403) so the response doesn't confirm another org's key exists.
        if (!isPlatformAdminRequest(request)) {
          const target = await prisma.apiKey.findUnique({
            where: { id: keyId },
            select: { organizationId: true },
          });
          if (!target || target.organizationId !== extendedRequest.organizationId) {
            return reply.status(404).send({
              success: false,
              error: 'API_KEY_NOT_FOUND',
              message: 'API key not found',
            });
          }
        }

        const result = await ApiKeyRotationService.rotateApiKey({
          keyId,
          gracePeriodDays,
          reason,
          performedBy,
        });

        logger.info(
          {
            apiKeyId: keyId,
            performedBy,
            gracePeriodDays: gracePeriodDays || 7,
          },
          'API key rotated via admin endpoint'
        );

        return reply.status(200).send({
          success: true,
          message: 'API key rotated successfully',
          data: {
            newKey: {
              id: result.newKey.id,
              keyPrefix: result.newKey.keyPrefix,
              plainKey: result.plainKey, // IMPORTANT: Only shown once!
            },
            oldKey: {
              id: result.oldKey.id,
              keyPrefix: result.oldKey.keyPrefix,
              expiresAt: result.oldKey.expiresAt,
            },
            gracePeriodDays: result.oldKey.gracePeriodDays,
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'API key rotation failed';
        logger.error({ error: errorMessage, params: request.params }, 'Failed to rotate API key');
        return reply.status(400).send({
          success: false,
          error: 'API_KEY_ROTATION_FAILED',
          message: errorMessage,
        });
      }
    }
  );

  // ==========================================
  // GET /v1/admin/api-keys/rotation-status
  // Get rotation status for all keys
  // ==========================================

  server.get(
    '/v1/admin/api-keys/rotation-status',
    {
      preHandler: [
        authenticate,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
        // SECURITY (platform-admin-vs-tenant-admin, 2026-09-08): a tenant
        // admin/owner may legitimately manage its OWN organization's keys
        // (self-service credential rotation is real product functionality,
        // not a bug) — the real gap was the handler never checking the
        // TARGET key belongs to the caller's org. Fixed here via an explicit
        // ownership check (isPlatformAdminRequest bypass for genuine
        // platform operators), not by removing tenant self-service.
        requireRole('admin', 'owner'),
        requirePermission('apikeys:manage'),
      ],
      schema: {
        tags: ['Admin - API Keys'],
        summary: 'Get rotation status for all API keys',
        description: 'Returns list of all API keys with their rotation status',
        querystring: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['active', 'rotating', 'revoked', 'expired'],
              description: 'Filter by status',
            },
            organizationId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            description: 'Rotation status retrieved',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  keys: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        keyPrefix: { type: 'string' },
                        status: { type: 'string' },
                        userId: { type: 'string' },
                        organizationId: { type: 'string' },
                        autoRotate: { type: 'boolean' },
                        rotationIntervalDays: { type: 'number' },
                        gracePeriodDays: { type: 'number' },
                        createdAt: { type: 'string' },
                        rotatedAt: { type: 'string' },
                        expiresAt: { type: 'string' },
                        rotationCount: { type: 'number' },
                        requestCount: { type: 'number' },
                        lastUsedAt: { type: 'string' },
                      },
                    },
                  },
                  total: { type: 'number' },
                },
              },
            },
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const query = request.query as { status?: string; organizationId?: string };
        const { status, organizationId } = query;
        const extendedRequest = request as ExtendedFastifyRequest;

        const where: {
          status?: string;
          organizationId?: string;
        } = {};
        if (status && typeof status === 'string') where.status = status;

        // SECURITY: a tenant admin only ever sees their OWN organization's
        // keys — the caller-supplied `organizationId` filter is honored only
        // for a genuine platform admin (who may narrow to any org, or omit
        // it to see all). Without this, any tenant admin could enumerate
        // every organization's API-key inventory by supplying (or omitting)
        // this query param.
        if (isPlatformAdminRequest(request)) {
          if (organizationId && typeof organizationId === 'string')
            where.organizationId = organizationId;
        } else {
          where.organizationId = extendedRequest.organizationId;
        }

        const keys = await prisma.apiKey.findMany({
          where,
          select: {
            id: true,
            name: true,
            keyPrefix: true,
            status: true,
            userId: true,
            organizationId: true,
            autoRotate: true,
            rotationIntervalDays: true,
            gracePeriodDays: true,
            createdAt: true,
            rotatedAt: true,
            expiresAt: true,
            rotationCount: true,
            requestCount: true,
            lastUsedAt: true,
            user: {
              select: {
                email: true,
                name: true,
              },
            },
            organization: {
              select: {
                name: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        });

        return reply.status(200).send({
          success: true,
          data: {
            keys,
            total: keys.length,
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, 'Failed to get rotation status');
        return reply.code(500).send({
          success: false,
          error: 'ROTATION_STATUS_FAILED',
          message: 'Failed to retrieve rotation status',
        });
      }
    }
  );

  // ==========================================
  // POST /v1/admin/api-keys/auto-rotate/enable
  // Enable auto-rotation for a key
  // ==========================================

  server.post<{
    Body: EnableAutoRotationBody;
  }>(
    '/v1/admin/api-keys/auto-rotate/enable',
    {
      preHandler: [
        authenticate,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
        // SECURITY (platform-admin-vs-tenant-admin, 2026-09-08): a tenant
        // admin/owner may legitimately manage its OWN organization's keys
        // (self-service credential rotation is real product functionality,
        // not a bug) — the real gap was the handler never checking the
        // TARGET key belongs to the caller's org. Fixed here via an explicit
        // ownership check (isPlatformAdminRequest bypass for genuine
        // platform operators), not by removing tenant self-service.
        requireRole('admin', 'owner'),
        requirePermission('apikeys:manage'),
      ],
      schema: {
        tags: ['Admin - API Keys'],
        summary: 'Enable auto-rotation for an API key',
        description: 'Configures automatic rotation schedule for a key',
        body: {
          type: 'object',
          required: ['keyId'],
          properties: {
            keyId: { type: 'string', format: 'uuid' },
            rotationIntervalDays: {
              type: 'number',
              minimum: 30,
              maximum: 365,
              default: 90,
              description: 'Auto-rotation frequency in days',
            },
            gracePeriodDays: {
              type: 'number',
              minimum: 1,
              maximum: 30,
              default: 7,
              description: 'Grace period after rotation',
            },
          },
        },
        response: {
          200: {
            description: 'Auto-rotation enabled',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: {
                type: 'object',
                properties: {
                  apiKeyId: { type: 'string' },
                  autoRotate: { type: 'boolean' },
                  rotationIntervalDays: { type: 'number' },
                  gracePeriodDays: { type: 'number' },
                  nextRotationDate: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { keyId, rotationIntervalDays = 90, gracePeriodDays = 7 } = request.body;
        const extendedRequest = request as ExtendedFastifyRequest;

        // SECURITY: same ownership rule as POST /rotate/:keyId above — a
        // tenant admin may only reconfigure a key belonging to their own org.
        if (!isPlatformAdminRequest(request)) {
          const target = await prisma.apiKey.findUnique({
            where: { id: keyId },
            select: { organizationId: true },
          });
          if (!target || target.organizationId !== extendedRequest.organizationId) {
            return reply.status(404).send({
              success: false,
              error: 'API_KEY_NOT_FOUND',
              message: 'API key not found',
            });
          }
        }

        const apiKey = await prisma.apiKey.update({
          where: { id: keyId },
          data: {
            autoRotate: true,
            rotationIntervalDays,
            gracePeriodDays,
          },
        });

        // Calculate next rotation date
        const lastRotation = apiKey.rotatedAt ?? apiKey.createdAt;
        const nextRotationDate = new Date(lastRotation);
        nextRotationDate.setDate(nextRotationDate.getDate() + rotationIntervalDays);

        logger.info(
          {
            apiKeyId: keyId,
            rotationIntervalDays,
            gracePeriodDays,
          },
          'Auto-rotation enabled for API key'
        );

        return reply.status(200).send({
          success: true,
          message: 'Auto-rotation enabled successfully',
          data: {
            apiKeyId: apiKey.id,
            autoRotate: apiKey.autoRotate,
            rotationIntervalDays: apiKey.rotationIntervalDays,
            gracePeriodDays: apiKey.gracePeriodDays,
            nextRotationDate,
          },
        });
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to enable auto-rotation';
        logger.error({ error: errorMessage, body: request.body }, 'Failed to enable auto-rotation');
        return reply.status(400).send({
          success: false,
          error: 'AUTO_ROTATION_ENABLE_FAILED',
          message: errorMessage,
        });
      }
    }
  );

  /**
   * GET /v1/admin/api-keys/rotation-logs
   * Get audit trail of API key rotations
   */
  server.get(
    '/v1/admin/api-keys/rotation-logs',
    {
      preHandler: [
        authenticate,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
        // SECURITY (platform-admin-vs-tenant-admin, 2026-09-08): a tenant
        // admin/owner may legitimately manage its OWN organization's keys
        // (self-service credential rotation is real product functionality,
        // not a bug) — the real gap was the handler never checking the
        // TARGET key belongs to the caller's org. Fixed here via an explicit
        // ownership check (isPlatformAdminRequest bypass for genuine
        // platform operators), not by removing tenant self-service.
        requireRole('admin', 'owner'),
        requirePermission('apikeys:manage'),
      ],
      schema: {
        tags: ['Admin', 'API Keys'],
        description: 'Get audit trail of API key rotations',
        querystring: {
          type: 'object',
          properties: {
            apiKeyId: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: 100, default: 50 },
            offset: { type: 'number', minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            description: 'Rotation logs',
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const query = request.query as RotationLogsQuery;
        const { apiKeyId, limit = 50, offset = 0 } = query;
        const extendedRequest = request as ExtendedFastifyRequest;

        const where: {
          apiKeyId?: string;
          apiKey?: { organizationId: string };
        } = {};
        if (apiKeyId && typeof apiKeyId === 'string') where.apiKeyId = apiKeyId;

        // SECURITY: rotation logs reference a key, not an org directly — a
        // tenant admin is scoped to logs for keys belonging to their OWN
        // organization (via the apiKey relation) unless they are a genuine
        // platform admin. Without this, any tenant admin could read other
        // tenants' API-key names/prefixes and rotation history.
        if (!isPlatformAdminRequest(request)) {
          where.apiKey = { organizationId: extendedRequest.organizationId as string };
        }

        const [logs, total] = await Promise.all([
          prisma.apiKeyRotationLog.findMany({
            where,
            include: {
              apiKey: {
                select: {
                  id: true,
                  name: true,
                  keyPrefix: true,
                },
              },
            },
            take: limit,
            skip: offset,
            orderBy: {
              performedAt: 'desc',
            },
          }),
          prisma.apiKeyRotationLog.count({ where }),
        ]);

        return reply.status(200).send({
          success: true,
          data: {
            logs,
            total,
            limit,
            offset,
          },
        });
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to retrieve rotation logs';
        logger.error({ error: errorMessage }, 'Failed to get rotation logs');
        return reply.code(500).send({
          success: false,
          error: 'ROTATION_LOGS_FAILED',
          message: errorMessage,
        });
      }
    }
  );

  logger.info('API Key Rotation admin routes registered');
}
