// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Keys Routes - Clean Architecture
 * Uses CQRS Handlers via DI
 */

import { FastifyInstance } from 'fastify';
import { container } from 'tsyringe';
import { authenticate } from '@/middleware/auth-middleware';
import { requirePermission } from '@/middleware/require-permission-middleware';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { ListApiKeysHandler } from '@/application/handlers/list-api-keys.handler';
import { RotateApiKeyHandler } from '@/application/handlers/rotate-api-key.handler';
import { ListApiKeysQuery } from '@/application/queries/list-api-keys.query';
import { RotateApiKeyCommand } from '@/application/commands/rotate-api-key.command';

export async function apiKeysRoutesClean(server: FastifyInstance): Promise<void> {
  const listApiKeysHandler = container.resolve(ListApiKeysHandler);
  const rotateApiKeyHandler = container.resolve(RotateApiKeyHandler);

  /**
   * GET /v1/api-keys
   * List user's API keys
   */
  server.get(
    '/v1/api-keys',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['API Keys'],
        description: 'List user API keys',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      try {
        // `authenticate` (preHandler) already resolved userId — from a JWT OR
        // an API key. Re-verifying via request.jwtVerify() here duplicated the
        // JWT path AND threw for API-key auth (an API key isn't a JWT), which
        // fell into the generic catch below and returned a wrong 500.
        const userId = (request as ExtendedFastifyRequest).userId;
        if (!userId) {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Invalid token',
          });
        }

        const query = new ListApiKeysQuery(userId);
        const result = await listApiKeysHandler.execute(query);

        if (!result.success) {
          return reply.status(400).send({
            error: result.error,
          });
        }

        return {
          apiKeys: result.apiKeys,
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'List API keys error');
        return reply.status(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );

  /**
   * POST /v1/api-keys/:keyId/rotate
   * Rotate API key
   */
  server.post<{
    Params: {
      keyId: string;
    };
    Body: {
      reason?: string;
    };
  }>(
    '/v1/api-keys/:keyId/rotate',
    {
      // Rotating an API key is a privileged, mutating operation → require the
      // fine-grained `apikeys:manage` permission (composed with `authenticate`).
      preHandler: [authenticate, requirePermission('apikeys:manage')],
      schema: {
        tags: ['API Keys'],
        description: 'Rotate API key',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            keyId: { type: 'string' },
          },
          required: ['keyId'],
        },
        body: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        // Same fix as GET /v1/api-keys above — reuse the auth already resolved
        // by `authenticate`, don't re-verify (and break for API-key callers).
        const userId = (request as ExtendedFastifyRequest).userId;
        if (!userId) {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Invalid token',
          });
        }
        const { keyId } = request.params;
        const { reason } = request.body;

        const command = new RotateApiKeyCommand({
          userId,
          apiKeyId: keyId,
          reason: (typeof reason === 'string' && (reason === 'manual' || reason === 'auto-rotation' || reason === 'security') ? reason : 'manual') as 'manual' | 'auto-rotation' | 'security',
        });
        const result = await rotateApiKeyHandler.execute(command);

        if (!result.success) {
          return reply.status(400).send({
            error: result.error,
          });
        }

        return {
          success: true,
          newKeyId: result.newKeyId,
          gracePeriodEnds: result.gracePeriodEnds,
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Rotate API key error');
        return reply.status(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );
}
