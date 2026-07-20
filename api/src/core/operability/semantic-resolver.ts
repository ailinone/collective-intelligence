// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * resolveSemanticCandidates — the unified hot-path API for selecting
 * candidates by semantic similarity, filtered by health + capability.
 *
 * Phase 4 (2026-05-08): wires together
 *   - EmbeddingCache (TEI local)
 *   - SemanticIndex (linear scan default; HNSW pluggable)
 *   - OperationalCandidatePool (health filter)
 *
 * Returns RankedCandidate[] — operational-eligible candidates sorted
 * by semantic similarity to the query. Phase 5 ranking engine will
 * compose this score with capability / latency / cost / diversity
 * signals; this function exposes the semantic component as a
 * standalone signal.
 *
 * Design choices:
 *   - Health filter is applied AFTER semantic kNN (kNN requests k=N
 *     larger than needed so post-filter still returns enough). This
 *     keeps the index pure (similarity only) and makes health-state
 *     changes immediately effective without rebuilding the index.
 *   - Embeddings of candidates are not built here. Phase 4.2 owns
 *     the embedding pipeline; this resolver assumes the index has
 *     been populated externally.
 *   - When the index is empty (no embeddings populated), the
 *     resolver falls back to OperationalCandidatePool.query() —
 *     graceful degradation rather than empty result.
 */

import { logger } from '@/utils/logger';
import { getEmbeddingCache } from './embedding-cache';
import { getSemanticIndex } from './semantic-index';
import {
  getOperationalCandidatePool,
  type OperationalCandidate,
  type CandidateFilter,
} from './operational-candidate-pool';
import {
  METRIC_NAMES,
  incrementCounter,
  observeHistogram,
  setGauge,
} from './metrics';

const log = logger.child({ component: 'semantic-resolver' });

// ─── Types ────────────────────────────────────────────────────────────────

export interface RankedCandidate {
  candidate: OperationalCandidate;
  /** Cosine similarity in [-1, 1]. Undefined if index was empty. */
  semanticScore?: number;
}

export interface ResolveSemanticCandidatesInput {
  /** The user query / context whose semantic match drives ranking. */
  query: string;
  /** Final number of candidates to return. */
  k: number;
  /**
   * Initial candidate width before health/capability filters are applied.
   * Defaults to k * 5 — pulls a bigger semantic neighborhood so the
   * post-filter still has enough.
   */
  candidateWidth?: number;
  /** Filter passed to OperationalCandidatePool.query. */
  filter?: CandidateFilter;
}

// ─── Resolver ─────────────────────────────────────────────────────────────

export async function resolveSemanticCandidates(
  input: ResolveSemanticCandidatesInput,
): Promise<readonly RankedCandidate[]> {
  const t0 = performance.now();
  const { query, k } = input;
  const candidateWidth = Math.max(input.candidateWidth ?? k * 5, k);
  const pool = getOperationalCandidatePool();
  const index = getSemanticIndex();

  // Fast path: no embeddings yet → fall back to pool query (returns
  // operational candidates with no semantic ranking).
  if (index.size() === 0) {
    const fallback = pool.query(input.filter);
    observeHistogram(METRIC_NAMES.CANDIDATE_RESOLUTION_LATENCY_MS, performance.now() - t0, {
      outcome: 'index_empty_fallback',
    });
    return fallback.slice(0, k).map((candidate) => ({ candidate }));
  }

  // 1. Embed query (cache hit-rate ~30-50% in production)
  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await getEmbeddingCache().getOrCompute(query);
    setGauge(METRIC_NAMES.EMBEDDING_CACHE_HIT_RATE, getEmbeddingCache().hitRate());
  } catch (err) {
    log.warn(
      { err: String(err) },
      'Embedding failed — falling back to pool query without semantic ranking',
    );
    observeHistogram(METRIC_NAMES.CANDIDATE_RESOLUTION_LATENCY_MS, performance.now() - t0, {
      outcome: 'embedding_failed_fallback',
    });
    const fallback = pool.query(input.filter);
    return fallback.slice(0, k).map((candidate) => ({ candidate }));
  }

  // 2. Semantic kNN over the index
  const hits = index.knn(queryEmbedding, candidateWidth);

  // 3. Health/capability filter (via pool's query-style predicates)
  const operationalIds = new Set(
    pool.query(input.filter).map((c) => `${c.providerId}::${c.modelId}`),
  );

  const ranked: RankedCandidate[] = [];
  for (const hit of hits) {
    if (!operationalIds.has(hit.id)) continue;
    const [providerId, modelId] = hit.id.split('::');
    const candidate = pool.get(providerId, modelId);
    if (!candidate) continue;
    ranked.push({ candidate, semanticScore: hit.score });
    if (ranked.length >= k) break;
  }

  observeHistogram(METRIC_NAMES.CANDIDATE_RESOLUTION_LATENCY_MS, performance.now() - t0, {
    outcome: 'semantic_ranked',
  });

  // If semantic kNN returned nothing usable (e.g. pool was filtered to
  // zero), fall back to pool query so the caller still gets candidates
  if (ranked.length === 0) {
    incrementCounter(METRIC_NAMES.SEMANTIC_RETRY_FALLBACK_TOTAL, { reason: 'no_semantic_match' });
    return pool
      .query(input.filter)
      .slice(0, k)
      .map((candidate) => ({ candidate }));
  }

  return ranked;
}
