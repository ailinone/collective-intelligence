// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { FastifyInstance } from 'fastify';
import { authenticate } from '@/middleware/auth-middleware';
import { requirePermission } from '@/middleware/require-permission-middleware';
import {
  requireTenantContext,
  getTenantContext,
} from '@/api/middleware/tenant-isolation-middleware';
import {
  checkQuota,
  listQuotas,
  recordQuotaUsage,
  resetQuota,
  upsertQuota,
  getQuotaUsage,
} from '@/services/quota-service';
import { recordSecurityEvent } from '@/services/security-audit-service';
import type { QuotaCheckRequest, QuotaCheckResult, QuotaConfig, QuotaUsage } from '@/types';

interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export async function registerEnterpriseQuotaRoutes(server: FastifyInstance): Promise<void> {
  server.get<{ Reply: { quotas: QuotaConfig[] } | ApiErrorResponse }>(
    '/v1/enterprise/quotas',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'List usage quotas for the organization',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      const quotas = await listQuotas(organizationId);
      return reply.send({ quotas });
    }
  );

  server.post<{ Body: QuotaConfig; Reply: ApiErrorResponse | void }>(
    '/v1/enterprise/quotas',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Configure usage quotas',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['limits'],
          properties: {
            organizationId: { type: 'string' },
            limits: {
              type: 'object',
              required: ['period'],
              properties: {
                period: { type: 'string', enum: ['minute', 'hour', 'day', 'month'] },
                maxRequests: { type: 'integer', minimum: 0 },
                maxTokens: { type: 'integer', minimum: 0 },
                maxCost: { type: 'number', minimum: 0 },
                maxFiles: { type: 'integer', minimum: 0 },
                maxFileSize: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
      // Configuring org quotas is a privileged override operation.
      preHandler: [authenticate, requireTenantContext(), requirePermission('quotas:override')],
    },
    async (request, reply) => {
      const tenantContext = getTenantContext(request);
      const organizationId = tenantContext.organizationId;
      if (request.body.organizationId && request.body.organizationId !== organizationId) {
        await recordSecurityEvent({
          eventType: 'organization_mismatch',
          severity: 'critical',
          message: 'Attempted to configure quotas for a different organization.',
          organizationId,
          userId: tenantContext.userId,
          metadata: {
            attemptedOrganizationId: request.body.organizationId,
            route: request.url,
          },
        });
        return reply.status(403).send({
          error: {
            code: 'organization_mismatch',
            message: 'Organization in payload does not match authenticated tenant.',
          },
        });
      }

      await upsertQuota(organizationId, {
        ...request.body,
        organizationId,
      });

      return reply.status(204).send();
    }
  );

  server.post<{ Body: QuotaCheckRequest; Reply: QuotaCheckResult | ApiErrorResponse }>(
    '/v1/enterprise/quotas/check',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Check if an operation fits within quota limits',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['minute', 'hour', 'day', 'month'] },
            operation: {
              type: 'object',
              properties: {
                requests: { type: 'integer', minimum: 0 },
                tokens: { type: 'integer', minimum: 0 },
                cost: { type: 'number', minimum: 0 },
                files: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      const result = await checkQuota(organizationId, request.body);
      return reply.send(result);
    }
  );

  server.post<{ Body: QuotaCheckRequest; Reply: ApiErrorResponse | void }>(
    '/v1/enterprise/quotas/usage',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Record quota usage for an operation',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['minute', 'hour', 'day', 'month'] },
            operation: {
              type: 'object',
              properties: {
                requests: { type: 'integer', minimum: 0 },
                tokens: { type: 'integer', minimum: 0 },
                cost: { type: 'number', minimum: 0 },
                files: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      await recordQuotaUsage(organizationId, request.body);
      return reply.status(204).send();
    }
  );

  server.post<{
    Body: { period?: 'minute' | 'hour' | 'day' | 'month' };
    Reply: ApiErrorResponse | void;
  }>(
    '/v1/enterprise/quotas/reset',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Reset quota usage for the current period',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['minute', 'hour', 'day', 'month'] },
          },
        },
      },
      // Resetting quota usage is a privileged override operation.
      preHandler: [authenticate, requireTenantContext(), requirePermission('quotas:override')],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      await resetQuota(organizationId, request.body.period);
      return reply.status(204).send();
    }
  );

  server.get<{
    Querystring: { period?: 'minute' | 'hour' | 'day' | 'month' };
    Reply: { usage: QuotaUsage | null } | ApiErrorResponse;
  }>(
    '/v1/enterprise/quotas/current',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Get current quota usage for the active period',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['minute', 'hour', 'day', 'month'] },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      const usage = await getQuotaUsage(organizationId, request.query.period);
      return reply.send({ usage });
    }
  );
}
