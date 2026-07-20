// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * L3 Capability Search Service (ADR-022, Sprint 3)
 *
 * Hybrid search over capability ontology and models, fusing:
 *   - Lexical recall (pg_trgm + GIN on synonyms/labels/capability_uris)
 *   - Vector recall (HNSW cosine on `embedding vector(384)`)
 *
 * Fusion via Reciprocal Rank Fusion (RRF) — k=60 default. RRF beats linear
 * combination when scores from different recall paths aren't on comparable
 * scales (BM25-like trgm_similarity vs cosine distance), and avoids the
 * normalisation arguments that linear fusion invites.
 *
 *   RRF_score(d) = Σ_q 1 / (k + rank_q(d))
 *
 * Where `rank_q(d)` is the 1-indexed rank of document `d` in the result list
 * for query path `q`. Documents not present in a path contribute 0 from it.
 *
 * Design choices
 * --------------
 * - The vector path embeds the query text once (single API call) and lets
 *   pgvector do the kNN. That single call costs ~$0.000005 — acceptable for
 *   interactive use.
 * - The lexical path uses pg_trgm `similarity()` not `%` operator threshold,
 *   so we get a continuous score for ranking instead of a boolean filter.
 * - Both paths are bounded by `recallLimit` (default 50) to keep RRF input
 *   sizes predictable. The final result is truncated to `limit` (default 20).
 * - Vector recall is OPTIONAL: if no embedder is configured or the query has
 *   no embedding (network error), we degrade to lexical-only. The system
 *   stays functional, just less recall.
 *
 * Why no BM25/tsvector
 * --------------------
 * pg_trgm captures the typo-tolerance and partial-match needs of capability
 * names ("vision", "image_understanding", "visão") better than tsvector. The
 * synonyms and labels columns already have GIN trgm indices.
 */

import type { Pool } from 'pg';
import {
  type CapabilityEmbedder,
  EMBEDDING_DIM,
  type EmbedResult,
} from '@/capability/embedder/embedder';
import { getCapabilityEmbedder } from '@/capability/embedder/embedder-factory';
import {
  HISTORICAL_UNIVERSE_WHERE,
  LIVE_UNIVERSE_WHERE,
  resolveDefaultUniverse,
  type UniverseMode,
} from '@/capability/inventory-lifecycle-policy';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'capability-search' });

// ─── Query-embedding cache + deadline ─────────────────────────────────────────
// Embedding the search query is a REAL network call to an external API on the
// hot path of every model selection (the semantic rerank) and every capability
// search. Two problems this block solves:
//   1. No caching: the same query text (task summaries repeat heavily in
//      production — "debug this code", "explain X") paid a fresh network
//      round-trip every time.
//   2. No deadline of our own: the only bound was the SDK's 30s timeout, so a
//      degraded embeddings provider stalled SELECTION for up to 30s before the
//      caller's try/catch degraded to lexical-only.
// Successful results are cached by normalized text (LRU, bounded); in-flight
// calls are coalesced; a race-based deadline turns provider degradation into a
// fast lexical-only fallback instead of a pipeline stall. Failures are NOT
// cached — the next request re-tries the provider.
const EMBED_CACHE_MAX = Number(process.env.CAPABILITY_EMBED_CACHE_MAX) || 500;
const EMBED_CACHE_TTL_MS = Number(process.env.CAPABILITY_EMBED_CACHE_TTL_MS) || 15 * 60 * 1000;
const EMBED_DEADLINE_MS = Number(process.env.CAPABILITY_EMBED_TIMEOUT_MS) || 4000;

const embedCache = new Map<string, { result: EmbedResult; expiresAt: number }>();
const embedInflight = new Map<string, Promise<EmbedResult>>();

function embedCacheKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 512);
}

async function embedWithCacheAndDeadline(
  embedder: CapabilityEmbedder,
  text: string,
): Promise<EmbedResult> {
  const key = embedCacheKey(text);

  const cached = embedCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    // LRU touch: re-insert so Map iteration order reflects recency.
    embedCache.delete(key);
    embedCache.set(key, cached);
    return cached.result;
  }

  const inflight = embedInflight.get(key);
  if (inflight) return inflight;

  const cacheResult = (result: EmbedResult): void => {
    embedCache.set(key, { result, expiresAt: Date.now() + EMBED_CACHE_TTL_MS });
    while (embedCache.size > EMBED_CACHE_MAX) {
      const oldest = embedCache.keys().next().value;
      if (oldest === undefined) break;
      embedCache.delete(oldest);
    }
  };

  const attempt = (async () => {
    const raw = embedder.embed(text);
    // A LATE success (after our deadline fired) still populates the cache so the
    // NEXT query for this text is instant instead of re-hitting the provider.
    // The .catch keeps a post-deadline rejection from becoming an unhandled one.
    raw.then(cacheResult).catch(() => {});
    const result = await Promise.race([
      raw,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`embedding deadline exceeded (${EMBED_DEADLINE_MS}ms)`)), EMBED_DEADLINE_MS),
      ),
    ]);
    cacheResult(result);
    return result;
  })().finally(() => {
    embedInflight.delete(key);
  });

  embedInflight.set(key, attempt);
  return attempt;
}

/**
 * Map a UniverseMode to the corresponding SQL WHERE fragment. Callers of
 * `searchModels` pass `universe` as a semantic label; the service translates
 * to SQL here so raw fragments never leak across the module boundary.
 */
function universeWhere(mode: UniverseMode): string {
  return mode === 'live' ? LIVE_UNIVERSE_WHERE : HISTORICAL_UNIVERSE_WHERE;
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface OntologySearchHit {
  uri: string;
  preferredLabel: string;
  category: string;
  synonyms: string[];
  description: string | null;
  score: number;          // RRF combined score
  matchedBy: ReadonlyArray<'lexical' | 'vector'>;
}

export interface ModelSearchHit {
  uid: string;
  modelId: string;
  providerId: string;
  displayName: string;
  capabilityUris: string[];
  capabilityConfidence: Record<string, number>;
  capabilitySources: Record<string, string[]>;
  score: number;
  matchedBy: ReadonlyArray<'lexical' | 'vector' | 'capability_filter'>;
}

export interface OntologySearchOptions {
  query: string;
  limit?: number;
  category?: 'modality' | 'task' | 'tool' | 'safety' | 'language' | 'meta';
  recallLimit?: number;
  rrfK?: number;
  /** Skip the vector path (e.g. if embedder is unavailable). */
  lexicalOnly?: boolean;
}

export interface ModelSearchOptions {
  /** Free-text query (model name, family, capabilities). Optional. */
  query?: string;
  /** URI list — only models that contain ALL of these capabilities. */
  requireCapabilities?: readonly string[];
  /** URI list — models that contain ANY one of these (boost, not filter). */
  prefersCapabilities?: readonly string[];
  /** Drop hits whose fused confidence on requireCapabilities < threshold. */
  minConfidence?: number;
  /** Only models whose evidence comes from these sources. */
  sources?: ReadonlyArray<
    'provider-declared' | 'helicone-oracle' | 'modality-derived' |
    'parameter-derived' | 'name-regex' | 'llm-extracted' | 'operator-override'
  >;
  /** Filter by provider ids. */
  providerIds?: readonly string[];
  limit?: number;
  recallLimit?: number;
  rrfK?: number;
  lexicalOnly?: boolean;
  /**
   * Inventory-freshness universe (ADR-023). `'live'` returns only models the
   * classifier has observed within `STALE_HOURS`; `'historical'` returns all
   * catalog-active rows including ghosts. When omitted, the env-configured
   * default applies (`HCRA_DEFAULT_UNIVERSE`, falling back to `'historical'`
   * for backwards compatibility).
   */
  universe?: UniverseMode;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class CapabilitySearchService {
  constructor(
    private readonly pool: Pool,
    private readonly embedder: CapabilityEmbedder = getCapabilityEmbedder(),
  ) {}

  // ─────────────────────────────────────────── Ontology

  async searchOntology(opts: OntologySearchOptions): Promise<OntologySearchHit[]> {
    const limit = opts.limit ?? 20;
    const recallLimit = opts.recallLimit ?? 50;
    const rrfK = opts.rrfK ?? 60;

    const q = opts.query.trim();
    if (q.length === 0) return [];

    const lexicalRows = await this.lexicalOntologyRecall(q, recallLimit, opts.category);
    let vectorRows: OntologyVectorRow[] = [];
    let queryEmbedding: EmbedResult | null = null;

    if (!opts.lexicalOnly) {
      try {
        queryEmbedding = await embedWithCacheAndDeadline(this.embedder, q);
        vectorRows = await this.vectorOntologyRecall(queryEmbedding.vector, recallLimit, opts.category);
      } catch (err) {
        log.warn({ err, query: q }, 'Vector recall failed — degrading to lexical-only');
      }
    }

    return rrfFuseOntology(lexicalRows, vectorRows, rrfK, limit);
  }

  private async lexicalOntologyRecall(
    query: string,
    limit: number,
    category?: string,
  ): Promise<OntologyLexicalRow[]> {
    const params: unknown[] = [query, limit];
    let categoryClause = '';
    if (category) {
      params.push(category);
      categoryClause = `AND category = $${params.length}`;
    }
    const { rows } = await this.pool.query<OntologyLexicalRow>(
      `WITH scored AS (
         SELECT
           uri,
           preferred_label,
           category,
           synonyms,
           description,
           GREATEST(
             similarity(preferred_label, $1),
             COALESCE((SELECT MAX(similarity(s, $1)) FROM unnest(synonyms) s), 0),
             COALESCE(similarity(description, $1), 0) * 0.5
           ) AS sim
         FROM capability_ontology
         WHERE status != 'deprecated' ${categoryClause}
       )
       SELECT * FROM scored
       WHERE sim > 0.10
       ORDER BY sim DESC
       LIMIT $2;`,
      params,
    );
    return rows;
  }

  private async vectorOntologyRecall(
    queryVec: number[],
    limit: number,
    category?: string,
  ): Promise<OntologyVectorRow[]> {
    if (queryVec.length !== EMBEDDING_DIM) {
      throw new Error(`Query embedding has dim ${queryVec.length}, expected ${EMBEDDING_DIM}`);
    }
    const params: unknown[] = [vectorLiteral(queryVec), limit];
    let categoryClause = '';
    if (category) {
      params.push(category);
      categoryClause = `AND category = $${params.length}`;
    }
    const { rows } = await this.pool.query<OntologyVectorRow>(
      `SELECT
         uri,
         preferred_label,
         category,
         synonyms,
         description,
         (1 - (embedding <=> $1::vector)) AS cos_sim
       FROM capability_ontology
       WHERE status != 'deprecated'
         AND embedding IS NOT NULL ${categoryClause}
       ORDER BY embedding <=> $1::vector
       LIMIT $2;`,
      params,
    );
    return rows;
  }

  // ─────────────────────────────────────────── Models

  async searchModels(opts: ModelSearchOptions): Promise<ModelSearchHit[]> {
    const limit = opts.limit ?? 20;
    const recallLimit = opts.recallLimit ?? 100;
    const rrfK = opts.rrfK ?? 60;
    const minConfidence = opts.minConfidence ?? 0;

    const requireCaps = opts.requireCapabilities ?? [];
    const prefersCaps = opts.prefersCapabilities ?? [];

    // Inventory-freshness universe (ADR-023). Route-level handlers should
    // resolve this via `resolveUniverseWhere()` (with classifier-freshness
    // signals) and pass the result in; direct callers fall through to the
    // env-configured default.
    const universe = opts.universe ?? resolveDefaultUniverse();
    const universeSql = universeWhere(universe);

    const filter = buildModelFilter({
      requireCaps,
      providerIds: opts.providerIds,
      sources: opts.sources,
    });

    // Lexical recall (Postgres) and the embedding call (external API, ~50-200ms
    // typical, up to several seconds under provider degradation) are INDEPENDENT
    // — the embedding doesn't need the lexical rows or vice versa. Running them
    // sequentially serialized the DB scan behind the network round-trip for no
    // reason; Promise.all overlaps them so the wall-clock cost is max(), not sum().
    const lexicalPromise = opts.query
      ? this.lexicalModelRecall(opts.query, recallLimit, filter, universeSql)
      : Promise.resolve<ModelLexicalRow[]>([]);

    const embedPromise =
      opts.query && !opts.lexicalOnly
        ? embedWithCacheAndDeadline(this.embedder, opts.query).catch((err: unknown) => {
            log.warn({ err, query: opts.query }, 'Embedding failed — degrading to lexical-only');
            return null;
          })
        : Promise.resolve(null);

    const [lexicalRows, queryEmbedding] = await Promise.all([lexicalPromise, embedPromise]);

    let vectorRows: ModelVectorRow[] = [];
    if (queryEmbedding) {
      try {
        vectorRows = await this.vectorModelRecall(queryEmbedding.vector, recallLimit, filter, universeSql);
      } catch (err) {
        log.warn({ err, query: opts.query }, 'Vector recall failed — degrading to lexical-only');
      }
    }

    let capabilityRows: ModelLexicalRow[] = [];
    if (!opts.query && requireCaps.length > 0) {
      capabilityRows = await this.capabilityOnlyRecall(recallLimit, filter, universeSql);
    }

    const fused = rrfFuseModels(lexicalRows, vectorRows, capabilityRows, rrfK, limit * 2);

    return fused
      .filter((hit) => {
        if (minConfidence === 0 || requireCaps.length === 0) return true;
        return requireCaps.every(
          (uri) => (hit.capabilityConfidence[uri] ?? 0) >= minConfidence,
        );
      })
      .map((hit) => applyPreferenceBoost(hit, prefersCaps))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private async lexicalModelRecall(
    query: string,
    limit: number,
    filter: ModelFilterClause,
    universeSql: string,
  ): Promise<ModelLexicalRow[]> {
    const params: unknown[] = [query, limit, ...filter.params];
    const { rows } = await this.pool.query<ModelLexicalRow>(
      `SELECT
         m.uid,
         m.id AS model_id,
         m.provider_id,
         COALESCE(m.display_name, m.name) AS display_name,
         m.capability_uris,
         m.capability_confidence,
         m.capability_sources,
         GREATEST(
           similarity(m.name, $1),
           similarity(COALESCE(m.display_name, ''), $1),
           COALESCE(similarity(m.metadata->>'family', $1), 0),
           COALESCE(similarity(m.metadata->>'description', $1), 0) * 0.5
         ) AS sim
       FROM models m
       WHERE ${universeSql}
         ${filter.sql}
       ORDER BY sim DESC
       LIMIT $2;`,
      params,
    );
    return rows.filter((r) => r.sim > 0.05);
  }

  private async vectorModelRecall(
    queryVec: number[],
    limit: number,
    filter: ModelFilterClause,
    universeSql: string,
  ): Promise<ModelVectorRow[]> {
    const params: unknown[] = [vectorLiteral(queryVec), limit, ...filter.params];
    const { rows } = await this.pool.query<ModelVectorRow>(
      `SELECT
         m.uid,
         m.id AS model_id,
         m.provider_id,
         COALESCE(m.display_name, m.name) AS display_name,
         m.capability_uris,
         m.capability_confidence,
         m.capability_sources,
         (1 - (m.embedding <=> $1::vector)) AS cos_sim
       FROM models m
       WHERE ${universeSql}
         AND m.embedding IS NOT NULL
         ${filter.sql}
       ORDER BY m.embedding <=> $1::vector
       LIMIT $2;`,
      params,
    );
    return rows;
  }

  private async capabilityOnlyRecall(
    limit: number,
    filter: ModelFilterClause,
    universeSql: string,
  ): Promise<ModelLexicalRow[]> {
    const params: unknown[] = [limit, ...filter.params];
    const { rows } = await this.pool.query<ModelLexicalRow>(
      `SELECT
         m.uid,
         m.id AS model_id,
         m.provider_id,
         COALESCE(m.display_name, m.name) AS display_name,
         m.capability_uris,
         m.capability_confidence,
         m.capability_sources,
         1.0 AS sim
       FROM models m
       WHERE ${universeSql}
         ${filter.sql}
       ORDER BY array_length(m.capability_uris, 1) DESC NULLS LAST, m.uid
       LIMIT $1;`,
      params,
    );
    return rows;
  }
}

// ─── Filter builder ──────────────────────────────────────────────────────────

interface ModelFilterClause {
  sql: string;
  params: unknown[];
}

function buildModelFilter(input: {
  requireCaps: readonly string[];
  providerIds?: readonly string[];
  sources?: readonly string[];
}): ModelFilterClause {
  const fragments: string[] = [];
  const params: unknown[] = [];
  let pIdx = 3; // $1=query/vec, $2=limit, $3+ filters

  if (input.requireCaps.length > 0) {
    fragments.push(`AND m.capability_uris @> $${pIdx}::text[]`);
    params.push(input.requireCaps);
    pIdx += 1;
  }

  if (input.providerIds && input.providerIds.length > 0) {
    fragments.push(`AND m.provider_id = ANY($${pIdx}::text[])`);
    params.push(input.providerIds);
    pIdx += 1;
  }

  if (input.sources && input.sources.length > 0) {
    // capability_sources is jsonb {uri: [source,...]}. Match if ANY required
    // capability has its source in the requested set.
    fragments.push(`AND EXISTS (
      SELECT 1
      FROM jsonb_each(m.capability_sources) AS kv(uri, srcs)
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(kv.srcs) AS src
        WHERE src = ANY($${pIdx}::text[])
      )
    )`);
    params.push(input.sources);
    pIdx += 1;
  }

  return { sql: fragments.join(' '), params };
}

// ─── RRF fusion ───────────────────────────────────────────────────────────────

interface OntologyLexicalRow {
  uri: string;
  preferred_label: string;
  category: string;
  synonyms: string[];
  description: string | null;
  sim: number;
}

interface OntologyVectorRow {
  uri: string;
  preferred_label: string;
  category: string;
  synonyms: string[];
  description: string | null;
  cos_sim: number;
}

interface ModelLexicalRow {
  uid: string;
  model_id: string;
  provider_id: string;
  display_name: string;
  capability_uris: string[];
  capability_confidence: Record<string, number>;
  capability_sources: Record<string, string[]>;
  sim: number;
}

interface ModelVectorRow {
  uid: string;
  model_id: string;
  provider_id: string;
  display_name: string;
  capability_uris: string[];
  capability_confidence: Record<string, number>;
  capability_sources: Record<string, string[]>;
  cos_sim: number;
}

function rrfFuseOntology(
  lexical: OntologyLexicalRow[],
  vector: OntologyVectorRow[],
  k: number,
  limit: number,
): OntologySearchHit[] {
  const accum = new Map<string, OntologySearchHit>();

  lexical.forEach((row, idx) => {
    const score = 1 / (k + idx + 1);
    accum.set(row.uri, {
      uri: row.uri,
      preferredLabel: row.preferred_label,
      category: row.category,
      synonyms: row.synonyms ?? [],
      description: row.description,
      score,
      matchedBy: ['lexical'],
    });
  });

  vector.forEach((row, idx) => {
    const score = 1 / (k + idx + 1);
    const existing = accum.get(row.uri);
    if (existing) {
      existing.score += score;
      existing.matchedBy = unionMatchedBy(existing.matchedBy, 'vector');
    } else {
      accum.set(row.uri, {
        uri: row.uri,
        preferredLabel: row.preferred_label,
        category: row.category,
        synonyms: row.synonyms ?? [],
        description: row.description,
        score,
        matchedBy: ['vector'],
      });
    }
  });

  return Array.from(accum.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function rrfFuseModels(
  lexical: ModelLexicalRow[],
  vector: ModelVectorRow[],
  capability: ModelLexicalRow[],
  k: number,
  limit: number,
): ModelSearchHit[] {
  const accum = new Map<string, ModelSearchHit>();

  const ingest = (
    row: ModelLexicalRow | ModelVectorRow,
    idx: number,
    matchedBy: 'lexical' | 'vector' | 'capability_filter',
  ): void => {
    const score = 1 / (k + idx + 1);
    const existing = accum.get(row.uid);
    if (existing) {
      existing.score += score;
      existing.matchedBy = unionMatchedBy(existing.matchedBy, matchedBy);
    } else {
      accum.set(row.uid, {
        uid: row.uid,
        modelId: row.model_id,
        providerId: row.provider_id,
        displayName: row.display_name,
        capabilityUris: row.capability_uris ?? [],
        capabilityConfidence: row.capability_confidence ?? {},
        capabilitySources: row.capability_sources ?? {},
        score,
        matchedBy: [matchedBy],
      });
    }
  };

  lexical.forEach((row, idx) => ingest(row, idx, 'lexical'));
  vector.forEach((row, idx) => ingest(row, idx, 'vector'));
  capability.forEach((row, idx) => ingest(row, idx, 'capability_filter'));

  return Array.from(accum.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function applyPreferenceBoost(hit: ModelSearchHit, prefers: readonly string[]): ModelSearchHit {
  if (prefers.length === 0) return hit;
  let boost = 0;
  for (const uri of prefers) {
    const conf = hit.capabilityConfidence[uri];
    if (typeof conf === 'number') boost += conf * 0.1;
  }
  return { ...hit, score: hit.score + boost };
}

function unionMatchedBy<T extends string>(
  existing: ReadonlyArray<T>,
  next: T,
): ReadonlyArray<T> {
  if (existing.includes(next)) return existing;
  return [...existing, next];
}

function vectorLiteral(vec: readonly number[]): string {
  return `[${vec.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
}
