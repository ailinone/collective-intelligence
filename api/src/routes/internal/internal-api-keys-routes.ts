// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Internal API-key management routes — the ci side of the dev/platform BFF
 * contract. The BFF (dev.ailin.one) mints a short-lived id service token and
 * calls these endpoints with `Authorization: Bearer <token>` +
 * `X-Acting-User: <userId>` to manage a console user's Personal Access Tokens
 * (PATs) without exposing ci/ to the browser.
 *
 *   GET    /v1/internal/api-keys        → list the acting user's keys
 *   POST   /v1/internal/api-keys        → create a key (plainKey returned once)
 *   DELETE /v1/internal/api-keys/:id    → revoke a key (ownership-enforced)
 *
 * Auth: route-level `requireServiceAuth(scope)` (see
 * internal-service-auth-middleware.ts). These paths are exempted from the
 * global user-auth + rate-limit hooks; this file is the only thing standing
 * between the network and the key store, so every handler reads the
 * service-auth context and scopes by the acting user.
 *
 * Response shapes mirror exactly what the BFF expects (see
 * dev/platform/app/api/api-keys/route.ts):
 *   list   → { apiKeys: ApiKeySummary[] }
 *   create → { id, name, plainKey, keyPrefix, createdAt, expiresAt, status }
 *   delete → 204 No Content
 */

import { FastifyInstance } from 'fastify';
import { prisma } from '@/database/client';
import {
  requireServiceAuth,
  type ServiceAuthedRequest,
} from '@/api/middleware/internal-service-auth-middleware';
import { createRouteRateLimit } from '@/api/middleware/route-rate-limit';
import { resolveOrProvisionActingUser } from '@/services/internal-acting-user';
import { invalidateApiKeyAuthCache } from '@/api/middleware/api-key-auth-middleware';

const SCOPE_READ = 'apikeys:read:on_behalf';
const SCOPE_WRITE = 'apikeys:write:on_behalf';
const SCOPE_REVOKE = 'apikeys:revoke:on_behalf';

// Hard cap on how far in the future a key may be set to expire. Matches the
// conservative default used elsewhere; the BFF surfaces this 400 verbatim.
const MAX_EXPIRATION_DAYS = 365;
const MAX_EXPIRATION_MS = MAX_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;

interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string | null;
  status: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

function toSummary(row: ApiKeyRow): {
  id: string;
  name: string;
  keyPrefix: string | null;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
} {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    // The ApiKey model has no dedicated revokedAt column; status carries
    // revocation. Expose null so the BFF type stays satisfied.
    revokedAt: null,
  };
}

export async function internalApiKeysRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /v1/internal/api-keys — list the acting user's API keys.
   */
  server.get(
    '/v1/internal/api-keys',
    { preHandler: [requireServiceAuth(SCOPE_READ)] },
    async (request, reply) => {
      const user = await resolveOrProvisionActingUser((request as ServiceAuthedRequest).serviceAuth!);
      if (!user) {
        return reply.code(409).send({
          error: 'acting_user_not_provisioned',
          message:
            'The acting user does not exist in ci yet. The user must authenticate to ci at least once (e.g. load the console dashboard) so their account is provisioned with the correct organization before keys can be managed.',
        });
      }

      const keys = await prisma.apiKey.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          status: true,
          createdAt: true,
          expiresAt: true,
          lastUsedAt: true,
        },
      });

      return reply.send({ apiKeys: keys.map(toSummary) });
    },
  );

  /**
   * POST /v1/internal/api-keys — create a new key for the acting user.
   * Body: { name: string, expiresAt?: string(ISO) | null }.
   * The plaintext key is returned exactly once.
   */
  server.post(
    '/v1/internal/api-keys',
    { preHandler: [requireServiceAuth(SCOPE_WRITE)] },
    async (request, reply) => {
      const user = await resolveOrProvisionActingUser((request as ServiceAuthedRequest).serviceAuth!);
      if (!user) {
        return reply.code(409).send({
          error: 'acting_user_not_provisioned',
          message:
            'The acting user does not exist in ci yet. The user must authenticate to ci at least once (e.g. load the console dashboard) so their account is provisioned with the correct organization before keys can be managed.',
        });
      }

      const body = (request.body ?? {}) as { name?: unknown; expiresAt?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        return reply.code(400).send({
          error: 'bad_request',
          message: 'name is required and must be a non-empty string',
        });
      }
      if (name.length > 200) {
        return reply.code(400).send({
          error: 'bad_request',
          message: 'name must be 200 characters or fewer',
        });
      }

      let expiresAt: Date | null = null;
      if (body.expiresAt !== undefined && body.expiresAt !== null) {
        if (typeof body.expiresAt !== 'string' && typeof body.expiresAt !== 'number') {
          return reply.code(400).send({
            error: 'bad_request',
            message: 'expiresAt must be an ISO date string',
          });
        }
        const parsed = new Date(body.expiresAt);
        if (Number.isNaN(parsed.getTime())) {
          return reply.code(400).send({
            error: 'bad_request',
            message: 'expiresAt is not a valid date',
          });
        }
        const now = Date.now();
        if (parsed.getTime() <= now) {
          return reply.code(400).send({
            error: 'bad_request',
            message: 'expiresAt must be in the future',
          });
        }
        if (parsed.getTime() > now + MAX_EXPIRATION_MS) {
          return reply.code(400).send({
            error: 'bad_request',
            message: `expiresAt must be within ${MAX_EXPIRATION_DAYS} days`,
          });
        }
        expiresAt = parsed;
      }

      const { createApiKey } = await import('@/services/api-key-rotation.js');
      const { apiKey, plainKey } = await createApiKey({
        userId: user.id,
        organizationId: user.organizationId,
        name,
        ...(expiresAt ? { expiresAt } : {}),
      });

      return reply.code(201).send({
        id: apiKey.id,
        name: apiKey.name,
        plainKey,
        keyPrefix: apiKey.keyPrefix,
        createdAt: apiKey.createdAt.toISOString(),
        expiresAt: apiKey.expiresAt ? apiKey.expiresAt.toISOString() : null,
        status: apiKey.status,
      });
    },
  );

  /**
   * DELETE /v1/internal/api-keys/:id — revoke a key the acting user owns.
   * 204 on success (idempotent — already-revoked also returns 204);
   * 404 if the key does not exist or belongs to a different user.
   */
  server.delete<{ Params: { id: string } }>(
    '/v1/internal/api-keys/:id',
    {
      // SECURITY (js/missing-rate-limiting): `/v1/internal/*` is exempted
      // from the global auth + rate-limit hooks (see file header), so this
      // handler's ownership check + DB write must be bounded here.
      // `requireServiceAuth` runs first so `request.serviceAuth.actingUserId`
      // is populated for the rate limiter to scope by. See route-rate-limit.ts.
      preHandler: [
        requireServiceAuth(SCOPE_REVOKE),
        createRouteRateLimit('internal-api-keys-revoke', { capacity: 30, refillRate: 0.5 }),
      ],
    },
    async (request, reply) => {
      const { actingUserId } = (request as ServiceAuthedRequest).serviceAuth!;
      const { id } = request.params;

      const key = await prisma.apiKey.findUnique({ where: { id } });
      // Ownership check doubles as existence-hiding: a key owned by someone
      // else is reported as 404, never 403, so the acting user can't probe
      // for other users' key ids.
      if (!key || key.userId !== actingUserId) {
        return reply.code(404).send({
          error: 'not_found',
          message: 'API key not found',
        });
      }

      if (key.status !== 'revoked') {
        await prisma.apiKey.update({ where: { id }, data: { status: 'revoked' } });
        // Best-effort: shrink the auth-cache staleness window below its TTL bound.
        invalidateApiKeyAuthCache(key.quickHash);
      }

      return reply.code(204).send();
    },
  );
}
