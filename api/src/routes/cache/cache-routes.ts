// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cache Routes
 * Exposes distributed cache operations for CLI consumers.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { authenticate } from '@/middleware/auth-middleware';
import {
  requireTenantContext,
  getTenantContext,
  type TenantContext,
} from '@/api/middleware/tenant-isolation-middleware';
import { getDistributedCacheService, type CacheStats } from '@/cache/distributed-cache-service';
import { getCacheRuntimeState, isCacheEnabled } from '@/cache/cache-runtime-state';
import { recordSecurityEvent } from '@/services/security-audit-service';
import { logger } from '@/utils/logger';

interface CacheValueQuery {
  key: string;
  namespace?: string;
}

interface CacheValueBody extends CacheValueQuery {
  value: unknown;
  ttlSeconds?: number;
}

/**
 * Helper: pull `.namespace` out of an unknown value (string body, Buffer body,
 * or already-parsed object). Single source of truth — replaces 3 duplicated
 * inline narrows that all triggered unsafe-* on `parsed.namespace`.
 */
function extractNamespace(input: unknown): string | undefined {
  if (typeof input === 'string') {
    try {
      return extractNamespace(JSON.parse(input));
    } catch {
      return undefined;
    }
  }
  if (Buffer.isBuffer(input)) {
    try {
      return extractNamespace(JSON.parse(input.toString('utf-8')));
    } catch {
      return undefined;
    }
  }
  if (typeof input === 'object' && input !== null) {
    const obj = input as { namespace?: unknown };
    if (typeof obj.namespace === 'string') return obj.namespace;
  }
  return undefined;
}

interface CacheDeleteBody {
  key: string;
  namespace?: string;
}

interface CacheNamespaceBody {
  namespace?: string;
}

interface CacheDisabledResponse {
  status: 503;
  payload: {
    error: 'cache_disabled';
    message: string;
    reason: string;
    details?: Record<string, unknown>;
  };
}

export async function registerCacheRoutes(server: FastifyInstance): Promise<void> {
  const cacheService = getDistributedCacheService();

  // Helper function to send cache disabled error response
  // Uses type-safe approach without type assertions
  // Accepts any FastifyReply type to work with different route handlers
  const sendCacheDisabledError = (
    reply: FastifyReply,
    payload: { error: string; message: string; reason: string }
  ): void => {
    // Create a type-safe payload object that matches the 503 schema
    const errorPayload: { error: string; message: string; reason: string } = {
      error: payload.error,
      message: payload.message,
      reason: payload.reason,
    };
    reply.code(503).send(errorPayload);
  };

  const ensureCacheEnabled = async (
    tenantContext: TenantContext
  ): Promise<CacheDisabledResponse | null> => {
    if (!isCacheEnabled({ organizationId: tenantContext.organizationId })) {
      const state = getCacheRuntimeState();
      const reason = state.reason ?? 'Cache runtime disabled';
      const detailPayload = state.details
        ? { details: state.details as Record<string, unknown> }
        : {};
      logger.warn(
        {
          component: 'cache-routes',
          organizationId: tenantContext.organizationId,
          reason,
          ...detailPayload,
        },
        'Distributed cache runtime disabled for tenant request'
      );
      await recordSecurityEvent({
        eventType: 'cache_runtime_disabled',
        severity: 'warning',
        message: 'Distributed cache runtime denied tenant operation.',
        organizationId: tenantContext.organizationId,
        userId: tenantContext.userId,
        metadata: {
          route: 'cache',
          reason,
          ...detailPayload,
        },
      });
      const response: CacheDisabledResponse = {
        status: 503,
        payload: {
          error: 'cache_disabled',
          message: 'Distributed cache runtime is disabled',
          reason,
          ...detailPayload,
        },
      } as const;
      return response;
    }
    return null;
  };

  server.get<{
    Querystring: CacheValueQuery;
    Reply: { hit: boolean; value?: unknown };
  }>(
    '/v1/cache/value',
    {
      onRequest: [authenticate, requireTenantContext()],
      schema: {
        tags: ['Cache'],
        description: 'Retrieve a cached value by key and optional namespace',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          required: ['key'],
          properties: {
            key: { type: 'string', minLength: 1 },
            namespace: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              hit: { type: 'boolean' },
              value: {},
            },
          },
          400: {
            type: 'object',
            properties: {
              hit: { type: 'boolean' },
            },
          },
          503: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const tenantContext = getTenantContext(request);
      const disabled = await ensureCacheEnabled(tenantContext);
      if (disabled) {
        sendCacheDisabledError(reply, disabled.payload);
        return;
      }

      const { key, namespace } = request.query;
      try {
        const result = await cacheService.getValue({
          key,
          namespace,
          organizationId: tenantContext.organizationId,
        });

        if (!result.hit) {
          logger.debug(
            {
              component: 'cache-routes',
              organizationId: tenantContext.organizationId,
              key,
              namespace,
            },
            'Cache miss'
          );
          return reply.send({ hit: false });
        }

        logger.debug(
          {
            component: 'cache-routes',
            organizationId: tenantContext.organizationId,
            key,
            namespace,
          },
          'Cache hit'
        );
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          {
            component: 'cache-routes',
            organizationId: tenantContext.organizationId,
            key,
            namespace,
            error: errorMessage,
          },
          'Error retrieving cache value'
        );
        return reply.code(400).send({
          hit: false,
          value: undefined,
        });
      }
    }
  );

  server.post<{
    Body: CacheValueBody;
  }>(
    '/v1/cache/value',
    {
      onRequest: [authenticate, requireTenantContext()],
      schema: {
        tags: ['Cache'],
        description: 'Store a value in the distributed cache',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['key', 'value'],
          properties: {
            key: { type: 'string', minLength: 1 },
            namespace: { type: 'string', minLength: 1 },
            value: {},
            ttlSeconds: { type: 'number', minimum: 0 },
          },
          additionalProperties: false,
        },
        response: {
          204: { type: 'null' },
        },
      },
    },
    async (request, reply) => {
      const tenantContext = getTenantContext(request);
      const disabled = await ensureCacheEnabled(tenantContext);
      if (disabled) {
        sendCacheDisabledError(reply, disabled.payload);
        return;
      }

      const { key, namespace, value, ttlSeconds } = request.body;

      await cacheService.setValue({
        key,
        namespace,
        value,
        ttlSeconds,
        organizationId: tenantContext.organizationId,
      });

      logger.info(
        {
          component: 'cache-routes',
          organizationId: tenantContext.organizationId,
          key,
          namespace,
          ttlSeconds,
        },
        'Cache value stored'
      );
      return reply.status(204).send();
    }
  );

  server.delete<{
    Body: CacheDeleteBody;
    Reply: { deleted: boolean };
  }>(
    '/v1/cache/value',
    {
      onRequest: [authenticate, requireTenantContext()],
      schema: {
        tags: ['Cache'],
        description: 'Delete a cached value by key',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['key'],
          properties: {
            key: { type: 'string', minLength: 1 },
            namespace: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              deleted: { type: 'boolean' },
            },
          },
          503: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const tenantContext = getTenantContext(request);
      const disabled = await ensureCacheEnabled(tenantContext);
      if (disabled) {
        sendCacheDisabledError(reply, disabled.payload);
        return;
      }

      const { key, namespace } = request.body;
      const deleted = await cacheService.deleteValue({
        key,
        namespace,
        organizationId: tenantContext.organizationId,
      });
      logger.info(
        {
          component: 'cache-routes',
          organizationId: tenantContext.organizationId,
          key,
          namespace,
          deleted,
        },
        'Cache delete executed'
      );
      return reply.send({ deleted });
    }
  );

  server.post<{
    Body: CacheNamespaceBody;
    Reply: { cleared: number };
  }>(
    '/v1/cache/clear',
    {
      onRequest: [authenticate, requireTenantContext()],
      schema: {
        tags: ['Cache'],
        description: 'Clear all entries from a cache namespace',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: {
            namespace: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              cleared: { type: 'number' },
            },
          },
          503: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const tenantContext = getTenantContext(request);
      const disabled = await ensureCacheEnabled(tenantContext);
      if (disabled) {
        sendCacheDisabledError(reply, disabled.payload);
        return;
      }

      const namespace = extractNamespace(request.body);
      const cleared = await cacheService.clearNamespace({
        namespace,
        organizationId: tenantContext.organizationId,
      });
      logger.warn(
        {
          component: 'cache-routes',
          organizationId: tenantContext.organizationId,
          namespace: namespace ?? '(entire-tenant)',
          cleared,
        },
        'Cache namespace cleared'
      );
      await recordSecurityEvent({
        eventType: 'cache_namespace_cleared',
        severity: namespace ? 'info' : 'warning',
        message: namespace
          ? `Cache namespace "${namespace}" cleared for tenant.`
          : 'Entire tenant cache cleared.',
        organizationId: tenantContext.organizationId,
        userId: tenantContext.userId,
        metadata: {
          namespace: namespace ?? '(entire-tenant)',
          cleared,
        },
      });
      return reply.send({ cleared });
    }
  );

  server.get<{
    Querystring: CacheNamespaceBody;
    Reply: CacheStats;
  }>(
    '/v1/cache/stats',
    {
      onRequest: [authenticate, requireTenantContext()],
      schema: {
        tags: ['Cache'],
        description: 'Retrieve cache statistics for a namespace',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            namespace: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              items: { type: 'number' },
              hits: { type: 'number' },
              misses: { type: 'number' },
            },
          },
          503: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const tenantContext = getTenantContext(request);
      const disabled = await ensureCacheEnabled(tenantContext);
      if (disabled) {
        sendCacheDisabledError(reply, disabled.payload);
        return;
      }

      const namespace = extractNamespace(request.query);
      const stats = await cacheService.getStats({
        namespace,
        organizationId: tenantContext.organizationId,
      });
      logger.debug(
        {
          component: 'cache-routes',
          organizationId: tenantContext.organizationId,
          namespace,
          stats,
        },
        'Cache stats requested'
      );
      return reply.send(stats);
    }
  );
}
