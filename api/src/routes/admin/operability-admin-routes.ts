// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Operability Admin Routes
 *
 * Diagnostic + introspection endpoints for the Phase 1-5 control plane.
 * All routes require admin/owner role.
 *
 * Routes:
 *   GET  /v1/admin/operability/health           — ProviderHealthRegistry snapshot
 *   GET  /v1/admin/operability/discovery        — Last DiscoveryScheduler snapshot
 *   GET  /v1/admin/operability/pool             — OperationalCandidatePool stats + sample
 *   GET  /v1/admin/operability/traces           — Recent CandidateTrace events (filterable)
 *   GET  /v1/admin/operability/semantic-index   — SemanticIndex stats + TEI health
 *   POST /v1/admin/operability/discover-now     — Trigger discovery on demand
 *   POST /v1/admin/operability/rebuild-index    — Trigger embedding pipeline rebuild
 *
 * These endpoints exist to answer concretely:
 *   - Quais providers estão saudáveis?
 *   - Quais modelos entraram no pool?
 *   - Quais ficaram fora e por quê?
 *   - Quantos candidatos têm embedding?
 *   - O scheduler está rodando?
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'operability-admin-routes' });

export async function registerOperabilityAdminRoutes(server: FastifyInstance): Promise<void> {
  const adminPreHandler = [authenticate, requireRole('admin', 'owner')];

  // ─── GET /v1/admin/operability/health ─────────────────────────────────
  server.get(
    '/v1/admin/operability/health',
    { preHandler: adminPreHandler },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as { providerId?: string; state?: string };
      const { getProviderHealthRegistry } = await import('@/core/operability');
      const registry = getProviderHealthRegistry();
      const all = registry.snapshot();

      const filtered = all.filter((r) => {
        if (q.providerId && r.providerId !== q.providerId) return false;
        if (q.state && r.state !== q.state) return false;
        return true;
      });

      return reply.send({
        totalRecords: all.length,
        filtered: filtered.length,
        records: filtered.map((r) => ({
          providerId: r.providerId,
          modelId: r.modelId,
          accountId: r.accountId,
          endpointId: r.endpointId,
          state: r.state,
          reason: r.reason,
          errorClass: r.errorClass,
          lastSuccessAt: r.lastSuccessAt,
          lastFailureAt: r.lastFailureAt,
          lastProbeAt: r.lastProbeAt,
          nextProbeAfter: r.nextProbeAfter,
          ttlMs: r.ttlMs,
          consecutiveFailures: r.consecutiveFailures,
          consecutiveSuccesses: r.consecutiveSuccesses,
          p50LatencyMs: r.p50LatencyMs,
          p95LatencyMs: r.p95LatencyMs,
          p99LatencyMs: r.p99LatencyMs,
        })),
      });
    },
  );

  // ─── GET /v1/admin/operability/discovery ──────────────────────────────
  server.get(
    '/v1/admin/operability/discovery',
    { preHandler: adminPreHandler },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const { getDiscoveryScheduler } = await import('@/core/operability');
      const scheduler = getDiscoveryScheduler();
      const snapshot = scheduler.getLastSnapshot();
      if (!snapshot) {
        return reply.status(404).send({
          error: 'no_snapshot',
          message: 'Discovery has not run yet — try POST /v1/admin/operability/discover-now',
          isRunning: scheduler.isRunning(),
        });
      }
      return reply.send({
        isRunning: scheduler.isRunning(),
        generatedAt: snapshot.generatedAt,
        durationMs: snapshot.durationMs,
        totalConfigured: snapshot.totalConfigured,
        totalAvailable: snapshot.totalAvailable,
        totalUnavailable: snapshot.totalUnavailable,
        results: Array.from(snapshot.results.values()).map((r) => ({
          providerId: r.providerId,
          status: r.status,
          healthState: r.healthState,
          reason: r.reason,
          errorClass: r.errorClass,
          discoveryConfidence: r.discoveryConfidence,
          modelCount: r.models.length,
          includeInOperationalPool: r.includeInOperationalPool,
          probeLatencyMs: r.probeLatencyMs,
        })),
      });
    },
  );

  // ─── GET /v1/admin/operability/pool ───────────────────────────────────
  server.get(
    '/v1/admin/operability/pool',
    { preHandler: adminPreHandler },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as { sample?: string; tier?: string; providerId?: string };
      const { getOperationalCandidatePool } = await import('@/core/operability');
      const pool = getOperationalCandidatePool();
      const all = pool.snapshot();

      const sampleSize = Math.min(Number(q.sample) || 20, 200);

      const byProvider: Record<string, number> = {};
      const byTier: Record<string, number> = {};
      const byFamily: Record<string, number> = {};
      for (const c of all) {
        byProvider[c.providerId] = (byProvider[c.providerId] ?? 0) + 1;
        byTier[c.providerTier] = (byTier[c.providerTier] ?? 0) + 1;
        if (c.modelFamily) byFamily[c.modelFamily] = (byFamily[c.modelFamily] ?? 0) + 1;
      }

      const filtered = all.filter((c) => {
        if (q.tier && c.providerTier !== q.tier) return false;
        if (q.providerId && c.providerId !== q.providerId) return false;
        return true;
      });

      return reply.send({
        builtAtMs: pool.builtAtMs(),
        size: all.length,
        filtered: filtered.length,
        byProvider,
        byTier,
        byFamily,
        sample: filtered.slice(0, sampleSize).map((c) => ({
          providerId: c.providerId,
          modelId: c.modelId,
          modelFamily: c.modelFamily,
          providerTier: c.providerTier,
          contextWindow: c.contextWindow,
          capabilities: c.capabilities,
          source: c.source,
          addedAt: c.addedAt,
        })),
      });
    },
  );

  // ─── GET /v1/admin/operability/traces ─────────────────────────────────
  server.get(
    '/v1/admin/operability/traces',
    { preHandler: adminPreHandler },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as {
        providerId?: string;
        stage?: string;
        included?: string;
        requestId?: string;
        experimentId?: string;
        limit?: string;
      };
      const { queryTraces } = await import('@/core/operability');
      const limit = Math.min(Number(q.limit) || 100, 1000);
      const traces = queryTraces({
        providerId: q.providerId,
        stage: q.stage as never,
        included: q.included === undefined ? undefined : q.included === 'true',
        requestId: q.requestId,
        experimentId: q.experimentId,
        limit,
      });
      return reply.send({ count: traces.length, traces });
    },
  );

  // ─── GET /v1/admin/operability/semantic-index ─────────────────────────
  server.get(
    '/v1/admin/operability/semantic-index',
    { preHandler: adminPreHandler },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const { getSemanticIndex, getEmbeddingPipeline, getTEIClient } = await import('@/core/operability');
      const idx = getSemanticIndex();
      const pipeline = getEmbeddingPipeline();
      const tei = getTEIClient();
      const teiHealthy = await tei.isHealthy().catch(() => false);
      return reply.send({
        indexSize: idx.size(),
        lastRunAt: pipeline.getLastRunAt(),
        lastEntryCount: pipeline.getLastEntryCount(),
        teiHealthy,
        teiUrl: process.env.HCRA_EMBEDDER_URL ?? 'http://tei-embedder:8080',
        semanticRetryEnabled: process.env.OPERABILITY_SEMANTIC_RETRY === 'true',
      });
    },
  );

  // ─── POST /v1/admin/operability/discover-now ──────────────────────────
  server.post(
    '/v1/admin/operability/discover-now',
    { preHandler: adminPreHandler },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const { getDiscoveryScheduler } = await import('@/core/operability');
        const snapshot = await getDiscoveryScheduler().triggerNow();
        if (!snapshot) {
          return reply.status(503).send({
            error: 'discovery_failed',
            message: 'Discovery scheduler not started or returned no snapshot',
          });
        }
        return reply.status(202).send({
          generatedAt: snapshot.generatedAt,
          durationMs: snapshot.durationMs,
          totalConfigured: snapshot.totalConfigured,
          totalAvailable: snapshot.totalAvailable,
          totalUnavailable: snapshot.totalUnavailable,
        });
      } catch (err) {
        log.error({ err: String(err) }, 'discover-now failed');
        return reply.status(500).send({ error: 'internal_error', message: String(err) });
      }
    },
  );

  // ─── POST /v1/admin/operability/rebuild-index ─────────────────────────
  server.post(
    '/v1/admin/operability/rebuild-index',
    { preHandler: adminPreHandler },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const { rebuildEmbeddingIndex } = await import('@/core/operability');
        const count = await rebuildEmbeddingIndex();
        return reply.status(202).send({
          embeddedCount: count,
          message:
            count > 0
              ? 'Embedding index rebuilt successfully'
              : 'Index unchanged — pool empty or TEI unhealthy',
        });
      } catch (err) {
        log.error({ err: String(err) }, 'rebuild-index failed');
        return reply.status(500).send({ error: 'internal_error', message: String(err) });
      }
    },
  );

  log.info('✅ Operability admin routes registered');
}
