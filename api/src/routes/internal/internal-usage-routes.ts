// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Internal usage-summary route — powers the dev portal's usage dashboard.
 *
 * GET /v1/internal/usage — returns the acting user's ORGANISATION usage
 * (requests / tokens / cost) over a date range, bucketed by day and by model.
 *
 * Auth: route-level `requireServiceAuth` (the id-minted service token +
 * X-Acting-User), same model as /v1/internal/api-keys. Sourced from the
 * `RequestLog` table (typed cost/token/model columns, org+createdAt indexed) —
 * the same source as the public /v1/usage/stats endpoint.
 *
 * Scope note: reuses `apikeys:read:on_behalf` (the BFF already holds it). A
 * dedicated `usage:read:on_behalf` scope is a cleaner follow-up (needs the id
 * dev-server client allowlist + BFF to request it).
 *
 * Attribution note: usage is ORG-scoped — per-API-key attribution does not
 * exist yet (RequestLog has no apiKeyId column); adding it is a separate
 * schema + write-path change.
 */

import { FastifyInstance } from 'fastify';
import { prisma } from '@/database/client';
import {
  requireServiceAuth,
  type ServiceAuthedRequest,
} from '@/api/middleware/internal-service-auth-middleware';
import { resolveOrProvisionActingUser } from '@/services/internal-acting-user';

const SCOPE_READ = 'apikeys:read:on_behalf';
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 92;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toNum(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value) || 0;
}

/** Round to micro-USD to avoid float drift in summed costs. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export async function internalUsageRoutes(server: FastifyInstance): Promise<void> {
  server.get(
    '/v1/internal/usage',
    { preHandler: [requireServiceAuth(SCOPE_READ)] },
    async (request, reply) => {
      const user = await resolveOrProvisionActingUser((request as ServiceAuthedRequest).serviceAuth!);
      if (!user) {
        return reply.code(409).send({
          error: 'acting_user_not_provisioned',
          message:
            'The acting user does not exist in ci yet. The user must authenticate to ci at least once so their account is provisioned before usage can be read.',
        });
      }

      const q = request.query as { start?: string; end?: string };
      const now = Date.now();
      const end = q.end ? new Date(q.end) : new Date(now);
      let start = q.start ? new Date(q.start) : new Date(now - DEFAULT_RANGE_DAYS * MS_PER_DAY);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return reply.code(400).send({ error: 'bad_request', message: 'start/end must be valid ISO dates' });
      }
      if (start.getTime() > end.getTime()) {
        return reply.code(400).send({ error: 'bad_request', message: 'start must be <= end' });
      }
      // Clamp the window so an unbounded range can't scan the whole table.
      if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * MS_PER_DAY) {
        start = new Date(end.getTime() - MAX_RANGE_DAYS * MS_PER_DAY);
      }

      const logs = await prisma.requestLog.findMany({
        where: {
          organizationId: user.organizationId,
          createdAt: { gte: start, lte: end },
        },
        select: {
          modelId: true,
          durationMs: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          costUsd: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      const totals = {
        requests: logs.length,
        inputTokens: logs.reduce((s, l) => s + (l.inputTokens ?? 0), 0),
        outputTokens: logs.reduce((s, l) => s + (l.outputTokens ?? 0), 0),
        totalTokens: logs.reduce((s, l) => s + (l.totalTokens ?? 0), 0),
        costUsd: round6(logs.reduce((s, l) => s + toNum(l.costUsd), 0)),
        errorRate: logs.length ? logs.filter((l) => l.status !== 'success').length / logs.length : 0,
        avgDurationMs: logs.length
          ? Math.round(logs.reduce((s, l) => s + (l.durationMs ?? 0), 0) / logs.length)
          : 0,
      };

      const dayMap = new Map<string, { requests: number; totalTokens: number; costUsd: number }>();
      const modelMap = new Map<string, { requests: number; totalTokens: number; costUsd: number }>();
      for (const l of logs) {
        const day = l.createdAt.toISOString().slice(0, 10);
        const d = dayMap.get(day) ?? { requests: 0, totalTokens: 0, costUsd: 0 };
        d.requests += 1;
        d.totalTokens += l.totalTokens ?? 0;
        d.costUsd += toNum(l.costUsd);
        dayMap.set(day, d);

        if (l.modelId) {
          const m = modelMap.get(l.modelId) ?? { requests: 0, totalTokens: 0, costUsd: 0 };
          m.requests += 1;
          m.totalTokens += l.totalTokens ?? 0;
          m.costUsd += toNum(l.costUsd);
          modelMap.set(l.modelId, m);
        }
      }

      const byDay = Array.from(dayMap.entries())
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([date, v]) => ({ date, requests: v.requests, totalTokens: v.totalTokens, costUsd: round6(v.costUsd) }));

      const byModel = Array.from(modelMap.entries())
        .map(([model, v]) => ({ model, requests: v.requests, totalTokens: v.totalTokens, costUsd: round6(v.costUsd) }))
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 20);

      return reply.send({
        range: { start: start.toISOString(), end: end.toISOString() },
        totals,
        byDay,
        byModel,
      });
    },
  );
}
