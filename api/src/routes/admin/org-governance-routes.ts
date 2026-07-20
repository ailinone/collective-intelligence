// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Organization Governance Admin Routes
 *
 * Enterprise governance control plane. All routes require admin/owner role AND
 * enforce tenant isolation — an admin may only govern their OWN organization
 * (the `{id}` path param must equal the authenticated org; cross-tenant returns
 * 403). This closes the standard IDOR hole on org-scoped admin endpoints.
 *
 * Routes:
 *   PUT  /v1/admin/organizations/:id/budget       — set monthly budget cap
 *   GET  /v1/admin/organizations/:id/cost-status   — MTD spend vs cap
 *   POST /v1/admin/organizations/:id/policy        — set strategy/model policy
 *   GET  /v1/admin/audit                            — paginated audit query
 *
 * Persistence is migration-free: budget + policy live in
 * `Organization.settings.governance`. Enforcement happens on the chat request
 * path via `evaluateGovernance` (see org-governance-service.ts).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { logger } from '@/utils/logger';
import { recordSecurityEvent } from '@/services/security-audit-service';
import {
  setBudget,
  setPolicy,
  getCostStatus,
  queryAuditEvents,
} from '@/services/org-governance-service';

const log = logger.child({ component: 'org-governance-routes' });

function getAuthIds(req: FastifyRequest): { userId?: string; organizationId?: string } {
  const ext = req as ExtendedFastifyRequest;
  return { userId: ext.userId, organizationId: ext.organizationId };
}

/**
 * Tenant-isolation guard: the path `:id` must match the authenticated org.
 * Returns the org id when authorized, or sends a 403 and returns null.
 */
function authorizeOrgAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  pathOrgId: string
): string | null {
  const { organizationId } = getAuthIds(req);
  if (!organizationId) {
    reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
    return null;
  }
  if (organizationId !== pathOrgId) {
    log.warn(
      { authenticatedOrg: organizationId, requestedOrg: pathOrgId, url: req.url },
      'Cross-tenant governance access denied'
    );
    reply.code(403).send({
      error: 'forbidden',
      message: 'You may only manage governance for your own organization.',
    });
    return null;
  }
  return organizationId;
}

export async function registerOrgGovernanceRoutes(server: FastifyInstance): Promise<void> {
  const adminPreHandler = [authenticate, requireRole('admin', 'owner')];

  // ─── PUT /v1/admin/organizations/:id/budget ──────────────────────────────
  server.put(
    '/v1/admin/organizations/:id/budget',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Governance'],
        summary: 'Set organization monthly budget cap',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['maxMonthlyCostUsd'],
          properties: {
            maxMonthlyCostUsd: { type: 'number', minimum: 0 },
            alertThresholds: {
              type: 'array',
              items: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const pathOrgId = (req.params as { id: string }).id;
      const orgId = authorizeOrgAccess(req, reply, pathOrgId);
      if (!orgId) return;

      const body = (req.body ?? {}) as { maxMonthlyCostUsd?: unknown; alertThresholds?: unknown };
      const maxMonthlyCostUsd = Number(body.maxMonthlyCostUsd);
      if (!Number.isFinite(maxMonthlyCostUsd) || maxMonthlyCostUsd < 0) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: 'maxMonthlyCostUsd must be a non-negative number.',
        });
      }

      const alertThresholds = Array.isArray(body.alertThresholds)
        ? body.alertThresholds.map(Number).filter((n) => Number.isFinite(n))
        : undefined;

      const { userId } = getAuthIds(req);
      const result = await setBudget(orgId, { maxMonthlyCostUsd, alertThresholds, updatedBy: userId });
      if (!result) {
        return reply.code(404).send({ error: 'not_found', message: 'Organization not found.' });
      }

      await recordSecurityEvent({
        eventType: 'governance.budget.updated',
        severity: 'info',
        message: `Organization budget set to $${maxMonthlyCostUsd}/month`,
        userId,
        organizationId: orgId,
        metadata: { maxMonthlyCostUsd, alertThresholds: result.alertThresholds },
      });

      return reply.send({ organizationId: orgId, budget: result });
    }
  );

  // ─── GET /v1/admin/organizations/:id/cost-status ─────────────────────────
  server.get(
    '/v1/admin/organizations/:id/cost-status',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Governance'],
        summary: 'Get organization month-to-date cost vs budget',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const pathOrgId = (req.params as { id: string }).id;
      const orgId = authorizeOrgAccess(req, reply, pathOrgId);
      if (!orgId) return;

      const status = await getCostStatus(orgId);
      if (status === null) {
        return reply.code(404).send({ error: 'not_found', message: 'Organization not found.' });
      }
      return reply.send(status);
    }
  );

  // ─── POST /v1/admin/organizations/:id/policy ─────────────────────────────
  server.post(
    '/v1/admin/organizations/:id/policy',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Governance'],
        summary: 'Set organization access policy (allowed/blocked strategies & models)',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          properties: {
            allowedStrategies: { type: 'array', items: { type: 'string' } },
            allowedModels: { type: 'array', items: { type: 'string' } },
            blockedModels: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const pathOrgId = (req.params as { id: string }).id;
      const orgId = authorizeOrgAccess(req, reply, pathOrgId);
      if (!orgId) return;

      const body = (req.body ?? {}) as {
        allowedStrategies?: unknown;
        allowedModels?: unknown;
        blockedModels?: unknown;
      };

      const toStrArr = (v: unknown): string[] | undefined =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

      const { userId } = getAuthIds(req);
      const result = await setPolicy(orgId, {
        allowedStrategies: toStrArr(body.allowedStrategies),
        allowedModels: toStrArr(body.allowedModels),
        blockedModels: toStrArr(body.blockedModels),
        updatedBy: userId,
      });
      if (!result) {
        return reply.code(404).send({ error: 'not_found', message: 'Organization not found.' });
      }

      await recordSecurityEvent({
        eventType: 'governance.policy.updated',
        severity: 'info',
        message: 'Organization access policy updated',
        userId,
        organizationId: orgId,
        metadata: {
          allowedStrategies: result.allowedStrategies,
          allowedModels: result.allowedModels,
          blockedModels: result.blockedModels,
        },
      });

      return reply.send({ organizationId: orgId, policy: result });
    }
  );

  // ─── GET /v1/admin/audit ─────────────────────────────────────────────────
  server.get(
    '/v1/admin/audit',
    {
      preHandler: adminPreHandler,
      schema: {
        tags: ['Admin', 'Governance'],
        summary: 'Query the organization audit trail (paginated, filtered)',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            eventType: { type: 'string' },
            severity: { type: 'string' },
            since: { type: 'string' },
            until: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { organizationId } = getAuthIds(req);
      if (!organizationId) {
        return reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
      }

      const q = req.query as {
        eventType?: string;
        severity?: string;
        since?: string;
        until?: string;
        limit?: string;
        offset?: string;
      };

      // ALWAYS scoped to the caller's org — no cross-tenant audit visibility.
      const result = await queryAuditEvents({
        organizationId,
        eventType: q.eventType,
        severity: q.severity,
        since: q.since,
        until: q.until,
        limit: q.limit !== undefined ? Number(q.limit) : undefined,
        offset: q.offset !== undefined ? Number(q.offset) : undefined,
      });

      return reply.send(result);
    }
  );

  log.info('✅ Organization governance admin routes registered');
}
