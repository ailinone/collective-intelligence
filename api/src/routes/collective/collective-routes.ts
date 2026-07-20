// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination — HTTP Routes (F1.6)
 *
 * Read-only org-scoped access to persisted CollectiveRun + CollectiveSignal
 * audit data. The routes are intentionally narrow: only operators
 * inside an organization should be able to read that org's runs, and
 * the design returns the SAME 404 for both "row does not exist" and
 * "row belongs to another org" so an attacker cannot enumerate run
 * ids by probing for the difference.
 *
 * Endpoints:
 *   GET  /v1/collective/runs/:id            — single run + paginated signals
 *   GET  /v1/collective/runs?requestId=...  — list runs by request id
 *
 * Persistence is gated by `CoordinationConfig.persistAuditTrail`. When
 * the flag is `false` (default), these endpoints will simply return
 * 404 because no rows were written. The endpoints exist regardless so
 * deployments that flip the flag have an immediate read path.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '@/middleware/auth-middleware';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import {
  getCollectiveRun,
  listCollectiveRunsByRequestId,
  type CollectiveRunRecord,
  type CollectiveSignalRecord,
} from '@/core/coordination/collective-run-repository';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'collective-routes' });

// ─── Response shaping ───────────────────────────────────────────────────

/**
 * The DB row carries `Date` objects; serialize them as ISO 8601 strings
 * so the JSON response is identical across timezones and survives a
 * round-trip through any standard JSON parser.
 */
function shapeRun(run: CollectiveRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    organizationId: run.organizationId,
    requestId: run.requestId,
    strategy: run.strategy,
    rounds: run.rounds,
    stopReason: run.stopReason,
    convergenceScore: run.convergenceScore,
    decisionFlipRate: run.decisionFlipRate,
    dissent: run.dissent,
    totalCostUsd: run.totalCostUsd,
    totalLatencyMs: run.totalLatencyMs,
    totalTokens: run.totalTokens,
    finalDecisionType: run.finalDecisionType,
    finalConfidence: run.finalConfidence,
    metadata: run.metadata,
    config: run.config,
    createdAt: run.createdAt.toISOString(),
  };
}

function shapeSignal(signal: CollectiveSignalRecord): Record<string, unknown> {
  return {
    id: signal.id,
    runId: signal.runId,
    round: signal.round,
    agentId: signal.agentId,
    modelId: signal.modelId,
    providerId: signal.providerId,
    role: signal.role,
    decision: {
      type: signal.decisionType,
      value: signal.decisionValue,
      confidence: signal.decisionConfidence,
      rationale: signal.decisionRationale,
    },
    sensitivities: signal.sensitivities,
    metrics: {
      latencyMs: signal.latencyMs,
      inputTokens: signal.inputTokens,
      outputTokens: signal.outputTokens,
      costUsd: signal.costUsd,
    },
    createdAt: signal.createdAt.toISOString(),
  };
}

// ─── Auth helpers ───────────────────────────────────────────────────────

/**
 * Read the authenticated organizationId off the request. Returns
 * `null` when the request has no auth context — the calling handler
 * MUST check and reject with 401 before reading data.
 */
function authenticatedOrgId(request: FastifyRequest): string | null {
  const extended = request as ExtendedFastifyRequest;
  if (typeof extended.organizationId === 'string' && extended.organizationId.length > 0) {
    return extended.organizationId;
  }
  return null;
}

// ─── Validation helpers ─────────────────────────────────────────────────

/**
 * UUID v4 regex. The runId column is stored as `UUID` in Postgres so
 * the format is fixed; cheap pre-flight validation prevents the DB
 * from receiving malformed input that would otherwise cause a 500.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

// ─── Route registration ─────────────────────────────────────────────────

export async function registerCollectiveRoutes(server: FastifyInstance): Promise<void> {
  // ─── GET /v1/collective/runs/:id ──────────────────────────────────────
  server.get(
    '/v1/collective/runs/:id',
    { preHandler: [authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const organizationId = authenticatedOrgId(req);
      if (!organizationId) {
        return reply.status(401).send({ error: 'authentication required' });
      }

      const params = req.params as { id?: unknown };
      if (!isUuid(params.id)) {
        return reply.status(400).send({ error: 'invalid run id format' });
      }

      try {
        const fetched = await getCollectiveRun(params.id, organizationId);
        if (!fetched) {
          return reply.status(404).send({ error: 'run not found' });
        }

        return reply.status(200).send({
          run: shapeRun(fetched.run),
          signals: fetched.signals.map(shapeSignal),
          signalCount: fetched.signals.length,
        });
      } catch (err) {
        log.error(
          {
            runId: params.id,
            organizationId,
            error: err instanceof Error ? err.message : String(err),
          },
          'GET /v1/collective/runs/:id failed',
        );
        return reply.status(500).send({ error: 'internal error' });
      }
    },
  );

  // ─── GET /v1/collective/runs/:id/trace (F2.10) ────────────────────────
  // Returns the full CollectiveTrace spans persisted under the run's
  // metadata. Available only when `config.persistAuditTrail = true`
  // was set at run time; otherwise the spans key is absent and the
  // endpoint returns 404. Same enumeration-resistant shape as the
  // single-run route — wrong-org and not-found are indistinguishable.
  server.get(
    '/v1/collective/runs/:id/trace',
    { preHandler: [authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const organizationId = authenticatedOrgId(req);
      if (!organizationId) {
        return reply.status(401).send({ error: 'authentication required' });
      }

      const params = req.params as { id?: unknown };
      if (!isUuid(params.id)) {
        return reply.status(400).send({ error: 'invalid run id format' });
      }

      try {
        const fetched = await getCollectiveRun(params.id, organizationId);
        if (!fetched) {
          return reply.status(404).send({ error: 'run not found' });
        }

        const meta = fetched.run.metadata;
        const spans =
          meta && typeof meta === 'object' && !Array.isArray(meta)
            ? (meta as Record<string, unknown>).collectiveTraceSpans
            : undefined;

        if (!Array.isArray(spans)) {
          // The run exists but had `persistAuditTrail=false` so the
          // trace was never persisted. Return 404 to match the
          // standard "no record" semantics — the trace summary is
          // still reachable via the parent run endpoint.
          return reply.status(404).send({ error: 'trace not persisted for this run' });
        }

        return reply.status(200).send({
          runId: fetched.run.id,
          strategy: fetched.run.strategy,
          spanCount: spans.length,
          spans,
        });
      } catch (err) {
        log.error(
          {
            runId: params.id,
            organizationId,
            error: err instanceof Error ? err.message : String(err),
          },
          'GET /v1/collective/runs/:id/trace failed',
        );
        return reply.status(500).send({ error: 'internal error' });
      }
    },
  );

  // ─── GET /v1/collective/runs?requestId=... ────────────────────────────
  server.get(
    '/v1/collective/runs',
    { preHandler: [authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const organizationId = authenticatedOrgId(req);
      if (!organizationId) {
        return reply.status(401).send({ error: 'authentication required' });
      }

      const query = req.query as { requestId?: unknown; limit?: unknown };

      if (typeof query.requestId !== 'string' || query.requestId.length === 0) {
        return reply.status(400).send({ error: 'requestId query parameter is required' });
      }

      let limit = 10;
      if (typeof query.limit === 'string') {
        const parsed = Number.parseInt(query.limit, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.min(100, parsed);
        }
      } else if (typeof query.limit === 'number' && Number.isFinite(query.limit)) {
        limit = Math.min(100, Math.max(1, Math.floor(query.limit)));
      }

      try {
        const runs = await listCollectiveRunsByRequestId(query.requestId, organizationId, limit);
        return reply.status(200).send({
          runs: runs.map(shapeRun),
          count: runs.length,
        });
      } catch (err) {
        log.error(
          {
            requestId: query.requestId,
            organizationId,
            error: err instanceof Error ? err.message : String(err),
          },
          'GET /v1/collective/runs failed',
        );
        return reply.status(500).send({ error: 'internal error' });
      }
    },
  );
}
