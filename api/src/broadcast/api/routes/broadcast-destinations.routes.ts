// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Broadcast Destinations — tenant-scoped CRUD over /v1/broadcast/destinations.
 *
 * Auth: bearer/api-key via `authenticate` middleware. The authenticated
 * principal's userId/organizationId is the tenant scope — no way to pass
 * `tenantId` in the request body and point it at someone else.
 *
 * Scoping rules:
 *   - Default tenantType is 'organization' (matches the auth context orgId).
 *   - A principal may opt into tenantType=user via `?scope=user`, which uses
 *     their own userId. This lets users manage personal destinations without
 *     needing org admin rights.
 *
 * Responses NEVER include decrypted config. Config is write-only from the API
 * perspective — see destination-manager.ts header for rationale.
 */

import type { FastifyInstance } from 'fastify';

import { authenticate } from '@/middleware/auth-middleware';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { logger } from '@/utils/logger';

import {
  DestinationManager,
  type DestinationDto,
  type TenantScope,
} from '@/broadcast/application/destination-manager';
import { getBroadcastCipher } from '@/broadcast/composition/broadcast-composition-root';
import {
  DESTINATION_TYPES,
  type DestinationType,
} from '@/broadcast/infrastructure/destinations/destination-adapter';

const log = logger.child({ component: 'broadcast-destinations-routes' });

// ─── Route helpers ──────────────────────────────────────────────────────

function resolveScope(
  request: ExtendedFastifyRequest,
  query: { scope?: string } | undefined,
): { ok: true; scope: TenantScope } | { ok: false; error: string } {
  const userId = request.userId;
  const organizationId = request.organizationId;

  const requested = (query?.scope ?? 'organization').toLowerCase();
  if (requested === 'user') {
    if (!userId) return { ok: false, error: 'no userId in auth context' };
    return { ok: true, scope: { tenantType: 'user', tenantId: userId } };
  }
  if (requested === 'organization') {
    if (!organizationId) return { ok: false, error: 'no organizationId in auth context' };
    return { ok: true, scope: { tenantType: 'organization', tenantId: organizationId } };
  }
  return { ok: false, error: `unknown scope: ${requested}` };
}

function dtoToResponse(d: DestinationDto): Record<string, unknown> {
  return {
    id: d.id,
    tenantType: d.tenantType,
    tenantId: d.tenantId,
    destinationType: d.destinationType,
    name: d.name,
    enabled: d.enabled,
    samplingRate: d.samplingRate,
    privacyMode: d.privacyMode,
    privacyCustomFields: d.privacyCustomFields,
    apiKeyFilter: d.apiKeyFilter,
    releaseStatus: d.releaseStatus,
    kekResource: d.kekResource,
    lastUsedAt: d.lastUsedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

// ─── Route plugin ───────────────────────────────────────────────────────

export async function broadcastDestinationsRoutes(server: FastifyInstance): Promise<void> {
  const manager = new DestinationManager({ cipher: getBroadcastCipher() });

  // ─── POST /v1/broadcast/destinations ──────────────────────────────────
  server.post(
    '/v1/broadcast/destinations',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Broadcast'],
        description: 'Create a broadcast destination (tenant-scoped).',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: { scope: { type: 'string', enum: ['organization', 'user'] } },
        },
        body: {
          type: 'object',
          required: ['destinationType', 'name', 'config'],
          properties: {
            destinationType: { type: 'string', enum: [...DESTINATION_TYPES] },
            name: { type: 'string', minLength: 1, maxLength: 128 },
            enabled: { type: 'boolean' },
            samplingRate: { type: 'number', minimum: 0, maximum: 1 },
            privacyMode: { type: 'boolean' },
            privacyCustomFields: { type: 'array', items: { type: 'string' } },
            apiKeyFilter: { type: 'array', items: { type: 'string', format: 'uuid' } },
            releaseStatus: { type: 'string', enum: ['alpha', 'beta', 'stable', 'deprecated'] },
            config: { type: 'object' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const scope = resolveScope(request as ExtendedFastifyRequest, request.query as { scope?: string });
      if (!scope.ok) return reply.code(400).send({ error: 'bad_request', message: scope.error });

      const body = request.body as {
        destinationType: DestinationType;
        name: string;
        enabled?: boolean;
        samplingRate?: number;
        privacyMode?: boolean;
        privacyCustomFields?: string[];
        apiKeyFilter?: string[];
        releaseStatus?: 'alpha' | 'beta' | 'stable' | 'deprecated';
        config: Record<string, unknown>;
      };

      const result = await manager.create({
        ...scope.scope,
        destinationType: body.destinationType,
        name: body.name,
        enabled: body.enabled,
        samplingRate: body.samplingRate,
        privacyMode: body.privacyMode,
        privacyCustomFields: body.privacyCustomFields,
        apiKeyFilter: body.apiKeyFilter,
        releaseStatus: body.releaseStatus,
        config: body.config,
      });

      if (!result.ok) {
        return reply.code(mapErrorStatus(result.error.code)).send({
          error: result.error.code,
          message: 'message' in result.error ? result.error.message : undefined,
        });
      }
      return reply.code(201).send({ destination: dtoToResponse(result.destination) });
    },
  );

  // ─── GET /v1/broadcast/destinations ───────────────────────────────────
  server.get(
    '/v1/broadcast/destinations',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Broadcast'],
        description: 'List broadcast destinations for the authenticated tenant.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: { scope: { type: 'string', enum: ['organization', 'user'] } },
        },
      },
    },
    async (request, reply) => {
      const scope = resolveScope(request as ExtendedFastifyRequest, request.query as { scope?: string });
      if (!scope.ok) return reply.code(400).send({ error: 'bad_request', message: scope.error });
      const destinations = await manager.list(scope.scope);
      return reply.send({ destinations: destinations.map(dtoToResponse) });
    },
  );

  // ─── GET /v1/broadcast/destinations/:id ───────────────────────────────
  server.get<{ Params: { id: string } }>(
    '/v1/broadcast/destinations/:id',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Broadcast'],
        description: 'Get a broadcast destination by id.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const scope = resolveScope(request as ExtendedFastifyRequest, request.query as { scope?: string });
      if (!scope.ok) return reply.code(400).send({ error: 'bad_request', message: scope.error });
      const result = await manager.getById(scope.scope, request.params.id);
      if (!result.ok) {
        return reply.code(mapErrorStatus(result.error.code)).send({ error: result.error.code });
      }
      return reply.send({ destination: dtoToResponse(result.destination) });
    },
  );

  // ─── PATCH /v1/broadcast/destinations/:id ─────────────────────────────
  server.patch<{ Params: { id: string } }>(
    '/v1/broadcast/destinations/:id',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Broadcast'],
        description: 'Update a broadcast destination. If `config` is set, the DEK is rotated.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 128 },
            enabled: { type: 'boolean' },
            samplingRate: { type: 'number', minimum: 0, maximum: 1 },
            privacyMode: { type: 'boolean' },
            privacyCustomFields: { type: 'array', items: { type: 'string' } },
            apiKeyFilter: { type: 'array', items: { type: 'string', format: 'uuid' } },
            releaseStatus: { type: 'string', enum: ['alpha', 'beta', 'stable', 'deprecated'] },
            config: { type: 'object' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const scope = resolveScope(request as ExtendedFastifyRequest, request.query as { scope?: string });
      if (!scope.ok) return reply.code(400).send({ error: 'bad_request', message: scope.error });
      const result = await manager.update(
        scope.scope,
        request.params.id,
        request.body as Record<string, unknown>,
      );
      if (!result.ok) {
        return reply.code(mapErrorStatus(result.error.code)).send({
          error: result.error.code,
          message: 'message' in result.error ? result.error.message : undefined,
        });
      }
      return reply.send({ destination: dtoToResponse(result.destination) });
    },
  );

  // ─── DELETE /v1/broadcast/destinations/:id ────────────────────────────
  server.delete<{ Params: { id: string } }>(
    '/v1/broadcast/destinations/:id',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Broadcast'],
        description: 'Soft-delete a broadcast destination (sets deleted_at).',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const scope = resolveScope(request as ExtendedFastifyRequest, request.query as { scope?: string });
      if (!scope.ok) return reply.code(400).send({ error: 'bad_request', message: scope.error });
      const result = await manager.delete(scope.scope, request.params.id);
      if (!result.ok) {
        return reply.code(mapErrorStatus(result.error.code)).send({ error: result.error.code });
      }
      log.info(
        { destinationId: request.params.id, ...scope.scope },
        'broadcast destination deleted via API',
      );
      return reply.code(204).send();
    },
  );
}

function mapErrorStatus(code: string): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'invalid_config':
    case 'invalid_input':
      return 400;
    default:
      return 500;
  }
}
