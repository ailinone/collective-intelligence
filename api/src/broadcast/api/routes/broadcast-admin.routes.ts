// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Broadcast admin routes — operator-only surfaces.
 *
 * Endpoints:
 *   POST /v1/admin/broadcast/erasure        — GDPR/LGPD right-to-erasure
 *   POST /v1/admin/broadcast/dlq/:id/replay — requeue a DLQ entry
 *   GET  /v1/admin/broadcast/dlq             — list DLQ entries (paginated)
 *
 * Auth: `authenticate` + `requireRole('admin', 'owner')`. Tenant scoping is
 * enforced inside: an org admin can only erase/replay inside their own org.
 * Platform operators (root-level roles) are out of scope for now — add a
 * `requireRole('platform-admin')` check if that role is introduced later.
 */

import type { FastifyInstance } from 'fastify';

import { authenticate, requireRole } from '@/middleware/auth-middleware';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

import {
  BroadcastAdminService,
  type Subject,
} from '@/broadcast/application/broadcast-admin-service';

const log = logger.child({ component: 'broadcast-admin-routes' });

export async function broadcastAdminRoutes(server: FastifyInstance): Promise<void> {
  const service = new BroadcastAdminService();

  // ─── POST /v1/admin/broadcast/erasure ────────────────────────────────
  // Rate limit: erasure is destructive and cascades across multiple tables.
  // A compromised admin token must NOT be able to mass-erase. 10 requests
  // per hour per IP is enough for legitimate GDPR/LGPD operator workflows
  // (ticket volumes in practice are << 10/h) and brick-walls automated abuse.
  server.post(
    '/v1/admin/broadcast/erasure',
    {
      preHandler: [authenticate, requireRole('admin', 'owner')],
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 hour',
        },
      },
      schema: {
        tags: ['Broadcast Admin'],
        description:
          'Right-to-erasure cascade (GDPR Art. 17 / LGPD Art. 18 V). Hard-deletes every broadcast row referencing the subject.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          oneOf: [
            { required: ['userId'], properties: { userId: { type: 'string', format: 'uuid' } } },
            {
              required: ['organizationId'],
              properties: { organizationId: { type: 'string', format: 'uuid' } },
            },
          ],
        },
      },
    },
    async (request, reply) => {
      const principal = request as ExtendedFastifyRequest;
      const body = request.body as { userId?: string; organizationId?: string };

      // Tenant isolation: an org admin cannot erase outside their own org.
      if (body.organizationId && body.organizationId !== principal.organizationId) {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'cannot erase across organizations' });
      }
      if (body.userId) {
        // Verify the target user belongs to the caller's organization.
        const target = await prisma.user.findUnique({
          where: { id: body.userId },
          select: { organizationId: true },
        });
        if (!target || target.organizationId !== principal.organizationId) {
          return reply
            .code(403)
            .send({ error: 'forbidden', message: 'target user not in caller organization' });
        }
      }

      const subject: Subject | null = body.userId
        ? { kind: 'user', userId: body.userId }
        : body.organizationId
        ? { kind: 'organization', organizationId: body.organizationId }
        : null;
      if (!subject) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'userId or organizationId is required' });
      }

      try {
        const tally = await service.eraseSubject(subject);
        log.warn(
          {
            principal: principal.userId,
            principalOrg: principal.organizationId,
            subject,
            tally,
          },
          'broadcast right-to-erasure executed via API',
        );
        return reply.send({ tally });
      } catch (err) {
        log.error({ err, subject }, 'erasure failed');
        return reply
          .code(500)
          .send({ error: 'internal_error', message: 'erasure failed; see logs' });
      }
    },
  );

  // ─── POST /v1/admin/broadcast/dlq/:id/replay ─────────────────────────
  // Rate limit: replay re-emits an envelope into the outbox, fanning out to
  // every destination again. At 60/h per IP, an operator can work through a
  // failure incident in bursts without enabling a stolen-token replay storm
  // against third-party destinations. Tighter than erasure because replay is
  // externally visible (sends outbound requests to destinations).
  server.post<{ Params: { id: string } }>(
    '/v1/admin/broadcast/dlq/:id/replay',
    {
      preHandler: [authenticate, requireRole('admin', 'owner')],
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 hour',
        },
      },
      schema: {
        tags: ['Broadcast Admin'],
        description:
          'Re-queue a DLQ entry by writing a fresh outbox envelope. Optional `forceInclude` bypasses the sampling gate on the replayed delivery.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            forceInclude: {
              type: 'boolean',
              default: false,
              description:
                'Bypass sampling on the replay. Use when sampling rate is low and you need the specific envelope to reach the destination.',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = request as ExtendedFastifyRequest;
      if (!principal.userId) return reply.code(401).send({ error: 'unauthorized' });
      const body = (request.body ?? {}) as { forceInclude?: boolean };

      // Verify the DLQ entry's destination belongs to the caller's org.
      const entry = await prisma.broadcastDlqEntry.findUnique({
        where: { id: request.params.id },
        include: { destination: { select: { tenantType: true, tenantId: true } } },
      });
      if (!entry) return reply.code(404).send({ error: 'not_found' });

      const isOwnOrg =
        entry.destination.tenantType === 'organization' &&
        entry.destination.tenantId === principal.organizationId;
      const isOwnUser =
        entry.destination.tenantType === 'user' &&
        entry.destination.tenantId === principal.userId;
      if (!isOwnOrg && !isOwnUser) {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'dlq entry belongs to another tenant' });
      }

      const outcome = await service.replayDlqEntry({
        dlqEntryId: request.params.id,
        replayedByUserId: principal.userId,
        forceInclude: body.forceInclude === true,
      });
      if (!outcome.requeued) {
        return reply.code(409).send({
          error: 'conflict',
          message: outcome.reason,
        });
      }
      return reply.send(outcome);
    },
  );

  // ─── GET /v1/admin/broadcast/dlq ─────────────────────────────────────
  // Scope filter:
  //   organization (default) — entries for destinations owned by the caller's org
  //   user                   — entries for destinations owned by the caller user
  //   both                   — union (OR) of the above; useful for an admin
  //                            triaging their personal + org destinations in
  //                            a single view. Still tenant-bounded (no access
  //                            to other orgs' entries).
  server.get(
    '/v1/admin/broadcast/dlq',
    {
      preHandler: [authenticate, requireRole('admin', 'owner')],
      schema: {
        tags: ['Broadcast Admin'],
        description:
          'List DLQ entries (paginated) for the caller tenant. Use `scope` to switch between org, user, or both.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            cursor: { type: 'string', format: 'date-time' },
            includeReplayed: { type: 'boolean', default: false },
            scope: {
              type: 'string',
              enum: ['organization', 'user', 'both'],
              default: 'organization',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = request as ExtendedFastifyRequest;
      const {
        limit = 50,
        cursor,
        includeReplayed = false,
        scope = 'organization',
      } = request.query as {
        limit?: number;
        cursor?: string;
        includeReplayed?: boolean;
        scope?: 'organization' | 'user' | 'both';
      };

      // Build the tenant filter. `both` requires an OR over two destination
      // filters — Prisma can't express that inline, so we expand into a
      // top-level OR with the shared constraints duplicated.
      const orgFilter = {
        destination: {
          tenantType: 'organization' as const,
          tenantId: principal.organizationId,
        },
      };
      const userFilter = principal.userId
        ? {
            destination: {
              tenantType: 'user' as const,
              tenantId: principal.userId,
            },
          }
        : null;

      const tenantWhere =
        scope === 'user'
          ? userFilter ?? { id: '__no_user__' } // forces empty when caller has no userId
          : scope === 'both'
            ? { OR: userFilter ? [orgFilter, userFilter] : [orgFilter] }
            : orgFilter;

      const rows = await prisma.broadcastDlqEntry.findMany({
        where: {
          ...tenantWhere,
          ...(includeReplayed ? {} : { replayedAt: null }),
          ...(cursor ? { deadLetteredAt: { lt: new Date(cursor) } } : {}),
        },
        orderBy: { deadLetteredAt: 'desc' },
        take: Math.min(limit, 200),
        select: {
          id: true,
          envelopeId: true,
          destinationId: true,
          errorClass: true,
          errorMessage: true,
          totalAttempts: true,
          firstAttemptedAt: true,
          deadLetteredAt: true,
          replayedAt: true,
          replayedByUserId: true,
          destination: {
            select: { name: true, destinationType: true },
          },
        },
      });

      return reply.send({
        entries: rows.map((r) => ({
          id: r.id,
          envelopeId: r.envelopeId,
          destinationId: r.destinationId,
          destinationName: r.destination.name,
          destinationType: r.destination.destinationType,
          errorClass: r.errorClass,
          errorMessage: r.errorMessage,
          totalAttempts: r.totalAttempts,
          firstAttemptedAt: r.firstAttemptedAt.toISOString(),
          deadLetteredAt: r.deadLetteredAt.toISOString(),
          replayedAt: r.replayedAt?.toISOString() ?? null,
          replayedByUserId: r.replayedByUserId,
        })),
        nextCursor:
          rows.length === limit ? rows[rows.length - 1]!.deadLetteredAt.toISOString() : null,
      });
    },
  );
}
