// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HCRA L3 Search API (ADR-022, Sprint 3)
 *
 * Hybrid retrieval over the capability ontology + materialised model
 * projections. Mounts under /v1/hcra/* to coexist with the existing
 * `/v1/capabilities/*` execution routes during the migration window.
 *
 * Endpoints
 * ---------
 *   GET  /v1/hcra/capabilities          — list/search ontology entries (lex + vec)
 *   GET  /v1/hcra/capabilities/:uri     — single ontology entry with broader/narrower
 *   GET  /v1/hcra/capabilities/expand   — synonym/alias expansion to canonical URIs
 *   GET  /v1/hcra/capabilities/facets   — category counts + provenance distribution
 *   GET  /v1/hcra/models                — find models by capability URI / text query
 *
 * Hybrid recall
 * -------------
 * Lexical: pg_trgm similarity on (preferred_label || description || synonyms).
 * Vector:  cosine distance on embedding (HNSW idx_cap_ont_embedding_hnsw).
 * Fusion:  Reciprocal Rank Fusion with k=60 (Cormack et al.). RRF makes the
 *          fusion robust to score-scale differences and is the standard
 *          choice when scores live in different metric spaces.
 *
 * If embeddings haven't been generated yet, vector recall is silently
 * skipped and lexical results carry the response (graceful degradation).
 *
 * Security
 * --------
 * Product endpoints (`/v1/hcra/capabilities*`, `/v1/hcra/models`) sit behind
 * the same auth middleware as the rest of /v1/* — ontology data is internal
 * but the model facets reveal commercial capability data we don't want
 * unauthenticated.
 *
 * The single exception is `/v1/hcra/health` — an *operational* liveness probe
 * for the search stack. It is intentionally:
 *   - registered BEFORE the plugin-scoped `authenticate` hook so the hook
 *     does not apply to it (Fastify hook semantics: a hook only fires on
 *     routes registered after it within the same encapsulation scope);
 *   - listed in `PUBLIC_ROUTES` (api-key-auth-middleware) so the *global*
 *     auth preHandler also skips it;
 *   - listed in `OPERATIONAL_ROUTE_PATHS` (token-bucket-rate-limit) so a
 *     health probe never spends a customer rate-limit token.
 *
 * If you add another truly operational endpoint here, follow the same three
 * steps. If you add another *product* endpoint, register it AFTER the
 * `authenticate` hook (the natural location below the marker comment).
 */

import type { FastifyInstance } from 'fastify';
import { logger } from '@/utils/logger';
import { authenticate } from '@/middleware/auth-middleware';
import { createRouteRateLimit } from '@/api/middleware/route-rate-limit';
import { prisma } from '@/database/client';
import { tryGetEmbedder } from '@/capability/embeddings/embedder';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';
import {
  getClassifierLastEvaluatedAt,
  hasLifecycleColumn,
  resolveUniverseWhere,
  type UniverseResolution,
} from '@/capability/inventory-lifecycle-policy';

const log = logger.child({ module: 'hcra-search-routes' });

// ────────────────────────────────────────────────────────────────────────────
// Inventory-lifecycle universe cache
// ────────────────────────────────────────────────────────────────────────────
// `hasLifecycleColumn` is an information_schema probe (stable over the
// process lifetime); `getClassifierLastEvaluatedAt` is a MAX() over models
// (cheap but one round-trip per request is wasteful). We cache both with a
// short TTL — classifier cadence is measured in hours, so a 60s cache is
// well inside the staleness tolerance and saves one round-trip per request.

interface UniverseCache {
  readonly columnExists: boolean;
  readonly classifierAt: Date | null;
  readonly refreshedAt: number;
}
const UNIVERSE_CACHE_TTL_MS = 60_000;
let universeCache: UniverseCache | null = null;

async function getUniverseSignals(): Promise<UniverseCache> {
  const now = Date.now();
  if (universeCache && now - universeCache.refreshedAt < UNIVERSE_CACHE_TTL_MS) {
    return universeCache;
  }
  const runner = (sql: string) =>
    prisma.$queryRawUnsafe<{ exists?: boolean; max?: Date | string | null }[]>(sql).then(
      (rows) => ({ rows: rows as { exists: boolean; max: Date | string | null }[] }),
    );
  const columnExists = await hasLifecycleColumn(runner);
  const classifierAt = columnExists ? await getClassifierLastEvaluatedAt(runner) : null;
  universeCache = { columnExists, classifierAt, refreshedAt: now };
  return universeCache;
}

async function resolveUniverseForRequest(
  requested: string | undefined,
): Promise<UniverseResolution> {
  const { columnExists, classifierAt } = await getUniverseSignals();
  return resolveUniverseWhere({
    requested,
    lifecycleColumnExists: columnExists,
    classifierLastEvaluatedAt: classifierAt,
  });
}

const URI_PATTERN = /^http:\/\/ailin\.dev\/cap\/v[0-9]+\/[a-z0-9_-]+$/;
const _URI_PREFIX = 'http://ailin.dev/cap/v1/';
const RRF_K = 60;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface OntologySearchRow {
  uri: string;
  preferred_label: string;
  description: string | null;
  synonyms: string[];
  broader: string[];
  narrower: string[];
  category: string;
  status: string;
  lex_score: number;
}

interface OntologySearchVecRow {
  uri: string;
  vec_distance: number;
}

interface OntologyFullRow {
  uri: string;
  schema_version: number;
  preferred_label: string;
  description: string | null;
  synonyms: string[];
  broader: string[];
  narrower: string[];
  category: string;
  status: string;
  embedding_model: string | null;
  embedding_updated_at: Date | null;
}

interface ModelSearchRow {
  uid: string;
  id: string;
  display_name: string;
  provider_id: string;
  capability_uris: string[];
  capability_confidence: Record<string, number>;
  capability_sources: Record<string, string[]>;
  status: string;
  match_score: number;
}

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function clampOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function isUri(s: string): boolean {
  return URI_PATTERN.test(s);
}

function toVectorLiteral(vector: number[]): string {
  const parts = new Array<string>(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    const v = vector[i]!;
    parts[i] = Number.isFinite(v) ? v.toFixed(6) : '0';
  }
  return `[${parts.join(',')}]`;
}

/**
 * Reciprocal Rank Fusion. Each input ranking contributes 1/(k+rank) to the
 * fused score. Robust to score-scale mismatch (lexical similarity 0..1 vs
 * cosine distance 0..2). Used by Elastic, Vespa, Weaviate, etc.
 */
function reciprocalRankFusion(
  rankings: ReadonlyArray<readonly string[]>,
  k = RRF_K,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank += 1) {
      const id = ranking[rank]!;
      const contribution = 1 / (k + rank + 1); // ranks are 1-indexed in the formula
      fused.set(id, (fused.get(id) ?? 0) + contribution);
    }
  }
  return fused;
}

// ─── Ontology search ─────────────────────────────────────────────────────────

async function searchOntologyLexical(
  query: string,
  category: string | undefined,
  limit: number,
): Promise<OntologySearchRow[]> {
  // pg_trgm `similarity` over the joined haystack. Cheap because the table
  // is ~60 rows today and growing slowly.
  const params: unknown[] = [query.toLowerCase(), limit];
  let where = `c.status = 'active' AND (
      similarity(c.preferred_label, $1) > 0.05
      OR EXISTS (
        SELECT 1 FROM unnest(c.synonyms) syn WHERE similarity(syn, $1) > 0.05
      )
      OR ($1 = ANY(c.synonyms))
      OR (c.description IS NOT NULL AND c.description ILIKE '%' || $1 || '%')
  )`;
  if (category) {
    params.push(category);
    where += ` AND c.category = $${params.length}`;
  }

  const sql = `
    SELECT c.uri, c.preferred_label, c.description, c.synonyms, c.broader, c.narrower,
           c.category, c.status,
           GREATEST(
             similarity(c.preferred_label, $1),
             COALESCE((SELECT MAX(similarity(syn, $1)) FROM unnest(c.synonyms) syn), 0)
           ) AS lex_score
    FROM capability_ontology c
    WHERE ${where}
    ORDER BY lex_score DESC
    LIMIT $2
  `;
  return prisma.$queryRawUnsafe<OntologySearchRow[]>(sql, ...params);
}

async function searchOntologyVector(
  vector: number[],
  category: string | undefined,
  limit: number,
): Promise<OntologySearchVecRow[]> {
  const literal = toVectorLiteral(vector);
  const params: unknown[] = [literal, limit];
  let where = `c.status = 'active' AND c.embedding IS NOT NULL`;
  if (category) {
    params.push(category);
    where += ` AND c.category = $${params.length}`;
  }
  const sql = `
    SELECT c.uri, (c.embedding <=> $1::vector) AS vec_distance
    FROM capability_ontology c
    WHERE ${where}
    ORDER BY c.embedding <=> $1::vector
    LIMIT $2
  `;
  return prisma.$queryRawUnsafe<OntologySearchVecRow[]>(sql, ...params);
}

async function fetchOntologyByUris(uris: string[]): Promise<Map<string, OntologySearchRow>> {
  if (uris.length === 0) return new Map();
  const rows = await prisma.$queryRawUnsafe<OntologySearchRow[]>(
    `SELECT uri, preferred_label, description, synonyms, broader, narrower, category, status,
            0::real AS lex_score
     FROM capability_ontology
     WHERE uri = ANY($1::text[])`,
    uris,
  );
  return new Map(rows.map((r) => [r.uri, r]));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export default async function hcraSearchRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── Operational health probe ──────────────────────────────────────────────
  //
  // Registered BEFORE the `authenticate` hook below. Fastify's plugin-scoped
  // hooks only fire on routes registered *after* them in the same scope, so
  // this endpoint is intentionally outside the auth gate. It is also
  // bypassed by the global preHandler chain (PUBLIC_ROUTES + the
  // OPERATIONAL_ROUTE_PATHS list in token-bucket-rate-limit).
  //
  // Contract (see ADR-022 §Health):
  //   - Always 200 if the route process is running (we do NOT return 503 from
  //     an absent embedder — embedder absence is a *degraded* state, not a
  //     dead one; readiness is the right place for "should I receive product
  //     traffic" checks, this endpoint answers "is the search route module
  //     loaded and able to respond").
  //   - Light, deterministic, idempotent. No DB calls, no network calls, no
  //     anything that could itself fail and turn the health probe into a
  //     failure cascade.
  //   - `return reply.send(...)` (not `reply.send(...); return;`) so Fastify
  //     gets unambiguous "response handled" signaling and never falls through
  //     to FST_ERR_REP_ALREADY_SENT.
  //   - try/catch wrapping a single sync read so an unrelated bug in
  //     `tryGetEmbedder()` would never bring the health probe down.
  fastify.get('/v1/hcra/health', async (_req, reply) => {
    try {
      const embedder = tryGetEmbedder();
      return reply.status(200).send({
        status: 'ok',
        service: 'hcra-search',
        timestamp: new Date().toISOString(),
        embedder: {
          configured: embedder !== null,
          model: embedder?.modelVersion ?? null,
        },
      });
    } catch (err) {
      // Defensive fallback: tryGetEmbedder() is a pure getter, but a future
      // refactor could make it throw. The health endpoint must NEVER 5xx for
      // reasons unrelated to the route itself being dead — return 200 with a
      // minimal shape and surface the underlying error to logs.
      log.warn({ err }, 'hcra-health: embedder probe threw, returning minimal payload');
      return reply.status(200).send({
        status: 'ok',
        service: 'hcra-search',
        timestamp: new Date().toISOString(),
        embedder: { configured: false, model: null },
      });
    }
  });

  // ─── Auth gate for product endpoints (encapsulated scope) ─────────────────
  //
  // CRITICAL Fastify 5 semantics
  // ----------------------------
  // `fastify.addHook('preHandler', ...)` applied at plugin scope hooks the
  // ENTIRE scope, regardless of registration order — it is NOT "future
  // routes only". Verified empirically (Fastify 5.6.2). The only way to
  // exempt the operational health route from auth is to put product routes
  // in a NESTED `fastify.register(...)` call so they live in a child
  // encapsulation context that has its own preHandler chain.
  //
  // Concretely: the health route stays in the OUTER scope (no auth hook
  // visible to it), and every product route below sits inside the INNER
  // `gated` scope where `authenticate` is the first preHandler. Future
  // contributors should think of the inner `register(async (gated) => ...)`
  // block as the literal auth boundary — anything outside it is operational
  // / public, anything inside it requires credentials.
  await fastify.register(async (gated) => {
    gated.addHook('preHandler', authenticate);
    // SECURITY (js/missing-rate-limiting): these handlers run pg_trgm +
    // vector-similarity queries against the ontology/model tables on every
    // call — expensive, authorization-gated reads. Route-scoped (not the
    // global per-identity budget) so it adds a real ceiling here without
    // double-spending the global token bucket. See route-rate-limit.ts.
    gated.addHook('preHandler', createRouteRateLimit('hcra-search', { capacity: 120, refillRate: 2 }));

    // GET /v1/hcra/capabilities?q=...&category=...&limit=...&offset=...&mode=hybrid|lexical|vector
    gated.get('/v1/hcra/capabilities', async (req, reply) => {
    const q = (req.query as Record<string, string | undefined>)?.q?.trim();
    const category = (req.query as Record<string, string | undefined>)?.category?.trim();
    const limit = clampLimit((req.query as Record<string, unknown>)?.limit);
    const offset = clampOffset((req.query as Record<string, unknown>)?.offset);
    const requestedMode = ((req.query as Record<string, string | undefined>)?.mode ?? 'hybrid').toLowerCase();

    if (category && !['modality', 'task', 'safety', 'language', 'tool', 'meta'].includes(category)) {
      return reply.code(400).send({ error: 'invalid_category', allowed: ['modality', 'task', 'safety', 'language', 'tool', 'meta'] });
    }

    if (!q) {
      // No query → simple paginated list, ordered by category then label.
      const params: unknown[] = [limit, offset];
      let where = `status = 'active'`;
      if (category) {
        params.push(category);
        where += ` AND category = $${params.length}`;
      }
      const rows = await prisma.$queryRawUnsafe<OntologySearchRow[]>(
        `SELECT uri, preferred_label, description, synonyms, broader, narrower, category, status,
                0::real AS lex_score
         FROM capability_ontology
         WHERE ${where}
         ORDER BY category, preferred_label
         LIMIT $1 OFFSET $2`,
        ...params,
      );
      return reply.send({
        query: { q: null, category: category ?? null, mode: 'list' },
        results: rows.map((r) => ({
          uri: r.uri,
          preferredLabel: r.preferred_label,
          description: r.description,
          synonyms: r.synonyms,
          broader: r.broader,
          narrower: r.narrower,
          category: r.category,
          status: r.status,
          score: null,
        })),
        pagination: { limit, offset, hasMore: rows.length === limit },
      });
    }

    // Run lexical first (cheap, always available).
    const lexical = await searchOntologyLexical(q, category, Math.max(limit * 2, 50));
    let vector: OntologySearchVecRow[] = [];
    let vectorReady = false;
    let mode: 'hybrid' | 'lexical' | 'vector' = 'lexical';

    if (requestedMode !== 'lexical') {
      const embedder = tryGetEmbedder();
      if (embedder) {
        try {
          const { vectors } = await embedder.embed({ inputs: [q] });
          vector = await searchOntologyVector(vectors[0]!, category, Math.max(limit * 2, 50));
          vectorReady = vector.length > 0;
          mode = vectorReady ? (requestedMode === 'vector' ? 'vector' : 'hybrid') : 'lexical';
        } catch (err) {
          log.warn({ error: err instanceof Error ? err.message : String(err), q }, 'Vector recall failed; falling back to lexical');
        }
      }
    }

    let orderedUris: string[];
    const scoreMap = new Map<string, { lex?: number; vecDist?: number; rrf?: number }>();
    for (const row of lexical) {
      scoreMap.set(row.uri, { lex: row.lex_score });
    }
    for (const row of vector) {
      const cur = scoreMap.get(row.uri) ?? {};
      cur.vecDist = row.vec_distance;
      scoreMap.set(row.uri, cur);
    }

    if (mode === 'hybrid' && vectorReady) {
      const lexRanking = lexical.map((r) => r.uri);
      const vecRanking = vector.map((r) => r.uri);
      const fused = reciprocalRankFusion([lexRanking, vecRanking]);
      for (const [uri, rrf] of fused.entries()) {
        const cur = scoreMap.get(uri) ?? {};
        cur.rrf = rrf;
        scoreMap.set(uri, cur);
      }
      orderedUris = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([uri]) => uri);
    } else if (mode === 'vector') {
      orderedUris = vector.map((r) => r.uri);
    } else {
      orderedUris = lexical.map((r) => r.uri);
    }

    const sliced = orderedUris.slice(offset, offset + limit);
    const detail = await fetchOntologyByUris(sliced);

    return reply.send({
      query: { q, category: category ?? null, mode },
      results: sliced.map((uri) => {
        const d = detail.get(uri);
        const s = scoreMap.get(uri) ?? {};
        return d ? {
          uri: d.uri,
          preferredLabel: d.preferred_label,
          description: d.description,
          synonyms: d.synonyms,
          broader: d.broader,
          narrower: d.narrower,
          category: d.category,
          status: d.status,
          score: { lex: s.lex ?? null, vecDistance: s.vecDist ?? null, rrf: s.rrf ?? null },
        } : null;
      }).filter(Boolean),
      pagination: { limit, offset, hasMore: orderedUris.length > offset + limit },
    });
  });

  // GET /v1/hcra/capabilities/expand?term=visao
  // Returns canonical URIs whose synonyms/labels match the term.
    gated.get('/v1/hcra/capabilities/expand', async (req, reply) => {
    const term = (req.query as Record<string, string | undefined>)?.term?.trim();
    if (!term) return reply.code(400).send({ error: 'missing_term' });

    // First try direct legacy slug → URI mapping. Fast path for callers
    // migrating from the legacy union.
    const direct = LEGACY_CAPABILITY_TO_URI[term.toLowerCase()];

    const rows = await prisma.$queryRawUnsafe<{ uri: string; preferred_label: string; match_kind: string }[]>(
      `SELECT uri, preferred_label,
              CASE
                WHEN preferred_label ILIKE $1 THEN 'preferred_label'
                WHEN $1 = ANY(synonyms) THEN 'synonym_exact'
                WHEN EXISTS (SELECT 1 FROM unnest(synonyms) syn WHERE syn ILIKE $1) THEN 'synonym_ilike'
                ELSE 'trigram'
              END AS match_kind
       FROM capability_ontology
       WHERE status = 'active'
         AND (preferred_label ILIKE $1
              OR $1 = ANY(synonyms)
              OR EXISTS (SELECT 1 FROM unnest(synonyms) syn WHERE syn ILIKE $1)
              OR similarity(preferred_label, $2) > 0.3
              OR EXISTS (SELECT 1 FROM unnest(synonyms) syn WHERE similarity(syn, $2) > 0.3))
       ORDER BY (CASE WHEN preferred_label ILIKE $1 THEN 0 WHEN $1 = ANY(synonyms) THEN 1 ELSE 2 END),
                preferred_label
       LIMIT 20`,
      term,                                  // exact ILIKE
      term.toLowerCase(),                    // similarity comparison value
    );

    return reply.send({
      term,
      directMatch: direct ? { uri: direct, source: 'legacy_enum' } : null,
      candidates: rows.map((r) => ({ uri: r.uri, preferredLabel: r.preferred_label, matchKind: r.match_kind })),
    });
  });

  // GET /v1/hcra/capabilities/facets — quick aggregates for dashboards
  //
  // Universe-aware: the `models` aggregates honour `?universe=live|historical`
  // (default comes from HCRA_DEFAULT_UNIVERSE env). The `capability_ontology`
  // aggregates keep their own `status='active'` filter — that's ADR-022
  // ontology lifecycle, not ADR-023 inventory freshness.
    gated.get('/v1/hcra/capabilities/facets', async (req, reply) => {
    const requested = (req.query as Record<string, string | undefined>)?.universe;
    const universe = await resolveUniverseForRequest(requested);

    const [byCategory, sourceDist, modelCoverage, embeddingCoverage] = await Promise.all([
      prisma.$queryRawUnsafe<{ category: string; count: bigint }[]>(
        `SELECT category, COUNT(*)::bigint AS count
         FROM capability_ontology WHERE status = 'active' GROUP BY category ORDER BY category`,
      ),
      prisma.$queryRawUnsafe<{ source: string; count: bigint }[]>(
        `SELECT source, COUNT(*)::bigint AS count
         FROM model_capability_assertions
         WHERE superseded_at IS NULL GROUP BY source ORDER BY source`,
      ),
      prisma.$queryRawUnsafe<{ models_with_uris: bigint; models_total: bigint }[]>(
        `SELECT
           COUNT(*) FILTER (WHERE array_length(capability_uris, 1) > 0)::bigint AS models_with_uris,
           COUNT(*)::bigint AS models_total
         FROM models WHERE ${universe.sql}`,
      ),
      prisma.$queryRawUnsafe<{ ontology_total: bigint; ontology_emb: bigint; models_total: bigint; models_emb: bigint }[]>(
        `SELECT
           (SELECT COUNT(*)::bigint FROM capability_ontology WHERE status = 'active') AS ontology_total,
           (SELECT COUNT(*)::bigint FROM capability_ontology WHERE status = 'active' AND embedding IS NOT NULL) AS ontology_emb,
           (SELECT COUNT(*)::bigint FROM models WHERE ${universe.sql}) AS models_total,
           (SELECT COUNT(*)::bigint FROM models WHERE ${universe.sql} AND embedding IS NOT NULL) AS models_emb`,
      ),
    ]);

    if (universe.warning) {
      log.warn({ warning: universe.warning, requested }, 'HCRA universe fell back to historical');
    }

    const cov = embeddingCoverage[0]!;
    return reply.send({
      universe: universe.mode,
      ...(universe.warning ? { warning: universe.warning } : {}),
      ontologyByCategory: byCategory.map((r) => ({ category: r.category, count: Number(r.count) })),
      assertionsBySource: sourceDist.map((r) => ({ source: r.source, count: Number(r.count) })),
      modelCoverage: {
        modelsWithCapabilityUris: Number(modelCoverage[0]!.models_with_uris),
        modelsTotal: Number(modelCoverage[0]!.models_total),
      },
      embeddingCoverage: {
        ontology: { total: Number(cov.ontology_total), embedded: Number(cov.ontology_emb) },
        models: { total: Number(cov.models_total),   embedded: Number(cov.models_emb) },
      },
    });
  });

  // GET /v1/hcra/capabilities/:uri  — explicit lookup with broader/narrower
    gated.get<{ Params: { uri: string } }>('/v1/hcra/capabilities/*', async (req, reply) => {
    // Fastify wildcard captures everything after the prefix as `*`.
    const path = (req.params as Record<string, string>)['*'];
    const uri = decodeURIComponent(path ?? '');
    if (!isUri(uri)) {
      return reply.code(400).send({ error: 'invalid_uri', expectedPattern: URI_PATTERN.source });
    }
    const rows = await prisma.$queryRawUnsafe<OntologyFullRow[]>(
      `SELECT uri, schema_version, preferred_label, description, synonyms,
              broader, narrower, category, status,
              embedding_model, embedding_updated_at
       FROM capability_ontology WHERE uri = $1`,
      uri,
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found', uri });
    const r = rows[0]!;
    return reply.send({
      uri: r.uri,
      schemaVersion: r.schema_version,
      preferredLabel: r.preferred_label,
      description: r.description,
      synonyms: r.synonyms,
      broader: r.broader,
      narrower: r.narrower,
      category: r.category,
      status: r.status,
      embedding: {
        model: r.embedding_model,
        updatedAt: r.embedding_updated_at,
      },
    });
  });

  // GET /v1/hcra/models?capabilityUri=...&q=...&minConfidence=0.5&source=provider-declared&provider=openai&limit=20&universe=live|historical
    gated.get('/v1/hcra/models', async (req, reply) => {
    const q       = (req.query as Record<string, string | undefined>)?.q?.trim();
    const capUri  = (req.query as Record<string, string | undefined>)?.capabilityUri?.trim();
    const provider = (req.query as Record<string, string | undefined>)?.provider?.trim();
    const sourceFilter = (req.query as Record<string, string | undefined>)?.source?.trim();
    const requestedUniverse = (req.query as Record<string, string | undefined>)?.universe;
    const minConf = Number((req.query as Record<string, string | undefined>)?.minConfidence ?? 0);
    const limit   = clampLimit((req.query as Record<string, unknown>)?.limit);
    const offset  = clampOffset((req.query as Record<string, unknown>)?.offset);

    if (capUri && !isUri(capUri)) {
      return reply.code(400).send({ error: 'invalid_capability_uri' });
    }
    if (sourceFilter && !['provider-declared', 'helicone-oracle', 'modality-derived', 'parameter-derived', 'name-regex', 'llm-extracted', 'operator-override'].includes(sourceFilter)) {
      return reply.code(400).send({ error: 'invalid_source' });
    }

    const universe = await resolveUniverseForRequest(requestedUniverse);
    if (universe.warning) {
      log.warn({ warning: universe.warning, requested: requestedUniverse }, 'HCRA model search universe fell back');
    }

    const params: unknown[] = [];
    // Universe fragment ("status = 'active' [AND lifecycle_status = 'active']")
    // uses unqualified column names. Since `models m` is the only table in
    // this FROM clause, Postgres resolves them against `m` unambiguously.
    const where: string[] = [universe.sql];

    if (capUri) {
      params.push(capUri);
      const capUriParam = params.length;
      where.push(`$${capUriParam} = ANY(m.capability_uris)`);
      if (minConf > 0) {
        params.push(minConf);
        where.push(`COALESCE((m.capability_confidence->>$${capUriParam})::float, 0) >= $${params.length}`);
      }
      if (sourceFilter) {
        params.push(sourceFilter);
        where.push(`m.capability_sources @> jsonb_build_object($${capUriParam}::text, jsonb_build_array($${params.length}::text))`);
      }
    }
    if (provider) {
      params.push(provider);
      where.push(`m.provider_id = $${params.length}`);
    }

    let orderClause = `m.id`;
    let scoreCol = `0::real AS match_score`;

    if (q) {
      // Prefer vector recall on models if embeddings exist; else trgm on id/name.
      const embedder = tryGetEmbedder();
      if (embedder) {
        try {
          const { vectors } = await embedder.embed({ inputs: [q] });
          params.push(toVectorLiteral(vectors[0]!));
          scoreCol = `(m.embedding <=> $${params.length}::vector) AS match_score`;
          orderClause = `m.embedding <=> $${params.length}::vector`;
          where.push(`m.embedding IS NOT NULL`);
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Vector model search failed; falling back to trigram');
          params.push(q.toLowerCase());
          scoreCol = `GREATEST(similarity(m.id, $${params.length}), similarity(m.display_name, $${params.length})) AS match_score`;
          orderClause = `match_score DESC`;
          where.push(`(similarity(m.id, $${params.length}) > 0.1 OR similarity(m.display_name, $${params.length}) > 0.1)`);
        }
      } else {
        params.push(q.toLowerCase());
        scoreCol = `GREATEST(similarity(m.id, $${params.length}), similarity(m.display_name, $${params.length})) AS match_score`;
        orderClause = `match_score DESC`;
        where.push(`(similarity(m.id, $${params.length}) > 0.1 OR similarity(m.display_name, $${params.length}) > 0.1)`);
      }
    }

    params.push(limit);
    const limitParam = params.length;
    params.push(offset);
    const offsetParam = params.length;

    const sql = `
      SELECT m.uid, m.id, m.display_name, m.provider_id,
             m.capability_uris, m.capability_confidence, m.capability_sources, m.status,
             ${scoreCol}
      FROM models m
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderClause}
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;
    const rows = await prisma.$queryRawUnsafe<ModelSearchRow[]>(sql, ...params);

    return reply.send({
      query: { q: q ?? null, capabilityUri: capUri ?? null, provider: provider ?? null, source: sourceFilter ?? null, minConfidence: minConf || null },
      universe: universe.mode,
      ...(universe.warning ? { warning: universe.warning } : {}),
      results: rows.map((r) => ({
        uid: r.uid,
        id: r.id,
        displayName: r.display_name,
        provider: r.provider_id,
        capabilityUris: r.capability_uris,
        capabilityConfidence: r.capability_confidence,
        capabilitySources: r.capability_sources,
        score: r.match_score,
        ...(capUri ? {
          targetCapability: {
            uri: capUri,
            confidence: r.capability_confidence?.[capUri] ?? null,
            sources: r.capability_sources?.[capUri] ?? [],
          },
        } : {}),
      })),
      pagination: { limit, offset, hasMore: rows.length === limit },
    });
    });
  }); // end of `await fastify.register(async (gated) => { ... })` — auth boundary

  // NOTE: `/v1/hcra/health` lives at the TOP of this plugin (in the OUTER
  // scope). Do NOT re-register it here, and do NOT move it inside the inner
  // `gated` scope above — it would inherit the auth hook and start 401-ing
  // operational probes again.
}
