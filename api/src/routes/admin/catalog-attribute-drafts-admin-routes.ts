// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Catalog attribute-drafts admin routes — Tier 3 review surface (LOTE AZ, 2026-09-23).
 *
 * GET  /v1/admin/catalog/attribute-drafts           — list llm_draft rows for review
 * POST /v1/admin/catalog/attribute-drafts/:id/promote — manually promote one to source: 'human'
 *
 * SECURITY (platform-admin-vs-tenant-admin): capability-attribute drafts are
 * a shared, cross-tenant catalog resource (they describe provider/model
 * capabilities, not anything scoped to an organization), so these routes are
 * gated with requirePlatformAdmin() — same pattern as operability-admin-routes.ts —
 * rather than the per-org requireRole('admin','owner'), which any tenant's
 * own self-promoted admin would satisfy.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate, requirePlatformAdmin } from '@/middleware/auth-middleware';
import { rejectAnonymousGuestKeyPreHandler } from '@/services/anonymous-quota-gate';
import { rejectChatFreeTierKeyPreHandler } from '@/services/free-tier-quota-gate';
import { listAttributeDrafts, promoteDraft } from '@/services/catalog/capability-attribute-draft-service';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'catalog-attribute-drafts-admin-routes' });

export async function registerCatalogAttributeDraftsAdminRoutes(
  server: FastifyInstance
): Promise<void> {
  const adminPreHandler = [
    authenticate,
    rejectAnonymousGuestKeyPreHandler,
    rejectChatFreeTierKeyPreHandler,
    requirePlatformAdmin(),
  ];

  server.get(
    '/v1/admin/catalog/attribute-drafts',
    { preHandler: adminPreHandler },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const drafts = await listAttributeDrafts();
      return reply.send({ drafts });
    }
  );

  server.post(
    '/v1/admin/catalog/attribute-drafts/:id/promote',
    { preHandler: adminPreHandler },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      try {
        await promoteDraft(id);
        return reply.send({ success: true, id });
      } catch (error: unknown) {
        log.error({ id, error: String(error) }, 'Failed to promote catalog attribute draft');
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Promotion failed' });
      }
    }
  );

  log.info('Catalog attribute-drafts admin routes registered');
}
