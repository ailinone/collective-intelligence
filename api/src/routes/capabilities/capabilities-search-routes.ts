// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * L3 Capability Search Routes (ADR-022, Sprint 3)
 *
 * Public HTTP surface for the hybrid lexical+vector RRF search service.
 *
 * Endpoints
 * ---------
 *   GET /v1/capabilities/ontology/search
 *     Find canonical capability URIs by free-text query (label, synonyms,
 *     description). Used by ops, debugging UIs, and downstream services
 *     resolving user-supplied capability strings.
 *
 *   GET /v1/capabilities/models/search
 *     Find models by free-text query and/or hard capability filters. The
 *     workhorse endpoint for selection/routing/orchestration to discover
 *     candidates without scanning the full catalog.
 *
 * Why GET (not POST):
 * - These are pure reads, side-effect-free, cacheable, observable in access
 *   logs without body capture, and trivially callable via curl. The tradeoff
 *   is URL length — at ~4KB-tolerant gateways, a 200-capability filter list
 *   would overflow. Until that materialises, GET is correct.
 *
 * Auth & isolation:
 * - Require authentication (these expose the model catalog with confidence
 *   scores — not a public surface).
 * - No per-tenant isolation: the catalog is shared across tenants. If we
 *   ever bring per-tenant model overlays, this route grows a `?tenant=...`
 *   filter, not a middleware injection.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { getCapabilitySearchService } from '@/capability/search/capability-search-singleton';
import { logger } from '@/utils/logger';

const log = logger.child({ module: 'capabilities-search-routes' });

const ALLOWED_CATEGORIES = new Set([
  'modality',
  'task',
  'tool',
  'safety',
  'language',
  'meta',
]);

const ALLOWED_SOURCES = new Set([
  'provider-declared',
  'helicone-oracle',
  'modality-derived',
  'parameter-derived',
  'name-regex',
  'llm-extracted',
  'operator-override',
]);

interface OntologySearchQuery {
  q?: string;
  category?: string;
  limit?: string;
  recall_limit?: string;
  rrf_k?: string;
  lexical_only?: string;
}

interface ModelSearchQuery {
  q?: string;
  require_capabilities?: string;
  prefers_capabilities?: string;
  min_confidence?: string;
  sources?: string;
  provider_ids?: string;
  limit?: string;
  recall_limit?: string;
  rrf_k?: string;
  lexical_only?: string;
}

function parseList(raw: string | undefined): string[] {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseInt32(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function parseFloatBounded(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

function badRequest(reply: FastifyReply, message: string, details?: Record<string, unknown>) {
  return reply.code(400).send({
    error: {
      code: 'invalid_request',
      type: 'capability_search_error',
      message,
      details,
    },
  });
}

export async function registerCapabilitySearchRoutes(server: FastifyInstance): Promise<void> {
  // Module-level singleton — shared with any other surface that needs
  // RRF capability search (e.g. dynamic-model-selector when an operator
  // enables RRF-based candidate generation). See
  // `src/capability/search/capability-search-singleton.ts`.
  const getService = getCapabilitySearchService;

  server.get<{ Querystring: OntologySearchQuery }>(
    '/v1/capabilities/ontology/search',
    {
      schema: {
        tags: ['Capabilities'],
        description:
          'Hybrid lexical + vector search over the capability ontology. Returns RRF-fused hits with provenance of which path matched.',
      },
      preHandler: [authenticateRequest],
    },
    async (request: FastifyRequest<{ Querystring: OntologySearchQuery }>, reply) => {
      const q = (request.query.q ?? '').trim();
      if (q.length === 0) {
        return badRequest(reply, "Query parameter 'q' is required and must be non-empty.");
      }
      if (q.length > 256) {
        return badRequest(reply, "Query parameter 'q' exceeds 256-character limit.");
      }

      const category = request.query.category?.trim();
      if (category && !ALLOWED_CATEGORIES.has(category)) {
        return badRequest(reply, `Invalid category '${category}'.`, {
          allowed: [...ALLOWED_CATEGORIES],
        });
      }

      const start = Date.now();
      try {
        const hits = await getService().searchOntology({
          query: q,
          category: category as 'modality' | 'task' | 'tool' | 'safety' | 'language' | 'meta' | undefined,
          limit: parseInt32(request.query.limit, 20, 100),
          recallLimit: parseInt32(request.query.recall_limit, 50, 200),
          rrfK: parseInt32(request.query.rrf_k, 60, 200),
          lexicalOnly: parseBool(request.query.lexical_only, false),
        });

        const durationMs = Date.now() - start;
        log.info(
          { q, category, count: hits.length, durationMs, requestId: request.id },
          'Ontology search completed',
        );

        return reply.send({
          object: 'list',
          query: q,
          count: hits.length,
          data: hits,
          _ailin: {
            duration_ms: durationMs,
            request_id: request.id,
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message, q, requestId: request.id }, 'Ontology search failed');
        return reply.code(500).send({
          error: {
            code: 'capability_search_failed',
            type: 'capability_search_error',
            message: 'Ontology search failed',
            details: { reason: message },
          },
        });
      }
    },
  );

  server.get<{ Querystring: ModelSearchQuery }>(
    '/v1/capabilities/models/search',
    {
      schema: {
        tags: ['Capabilities'],
        description:
          'Hybrid lexical + vector + capability-filter search over the model catalog. Use require_capabilities for hard filters and prefers_capabilities for soft boost.',
      },
      preHandler: [authenticateRequest],
    },
    async (request: FastifyRequest<{ Querystring: ModelSearchQuery }>, reply) => {
      const q = request.query.q?.trim();
      const requireCaps = parseList(request.query.require_capabilities);
      const prefersCaps = parseList(request.query.prefers_capabilities);
      const sources = parseList(request.query.sources);
      const providerIds = parseList(request.query.provider_ids);

      if (!q && requireCaps.length === 0 && providerIds.length === 0) {
        return badRequest(
          reply,
          "At least one of 'q', 'require_capabilities', or 'provider_ids' is required.",
        );
      }

      if (q && q.length > 256) {
        return badRequest(reply, "Query parameter 'q' exceeds 256-character limit.");
      }

      const invalidSources = sources.filter((s) => !ALLOWED_SOURCES.has(s));
      if (invalidSources.length > 0) {
        return badRequest(reply, 'One or more source values are not recognised.', {
          invalid: invalidSources,
          allowed: [...ALLOWED_SOURCES],
        });
      }

      const start = Date.now();
      try {
        const hits = await getService().searchModels({
          query: q,
          requireCapabilities: requireCaps,
          prefersCapabilities: prefersCaps,
          minConfidence: parseFloatBounded(request.query.min_confidence, 0, 0, 1),
          sources: sources as Array<
            'provider-declared' | 'helicone-oracle' | 'modality-derived' |
            'parameter-derived' | 'name-regex' | 'llm-extracted' | 'operator-override'
          >,
          providerIds,
          limit: parseInt32(request.query.limit, 20, 100),
          recallLimit: parseInt32(request.query.recall_limit, 100, 500),
          rrfK: parseInt32(request.query.rrf_k, 60, 200),
          lexicalOnly: parseBool(request.query.lexical_only, false),
        });

        const durationMs = Date.now() - start;
        log.info(
          {
            q,
            requireCaps: requireCaps.length,
            providers: providerIds.length,
            count: hits.length,
            durationMs,
            requestId: request.id,
          },
          'Model search completed',
        );

        return reply.send({
          object: 'list',
          query: q ?? null,
          filters: {
            require_capabilities: requireCaps,
            prefers_capabilities: prefersCaps,
            sources,
            provider_ids: providerIds,
            min_confidence: parseFloatBounded(request.query.min_confidence, 0, 0, 1),
          },
          count: hits.length,
          data: hits,
          _ailin: {
            duration_ms: durationMs,
            request_id: request.id,
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message, q, requestId: request.id }, 'Model search failed');
        return reply.code(500).send({
          error: {
            code: 'capability_search_failed',
            type: 'capability_search_error',
            message: 'Model search failed',
            details: { reason: message },
          },
        });
      }
    },
  );

  log.info('Capability search routes registered (ontology + models)');
}
