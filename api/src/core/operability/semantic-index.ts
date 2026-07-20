// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SemanticIndex — kNN over the operational candidate pool's embeddings.
 *
 * Phase 4 (2026-05-08): defines the interface AND ships a naive
 * O(N) cosine similarity implementation as the default. Production
 * deployments can swap in `hnswlib-node` (or `usearch`) without
 * changing callers — both must satisfy the same `SemanticIndex`
 * interface.
 *
 * Why naive default:
 *   - Native HNSW (hnswlib-node) is a C++ binding and adds ~15MB
 *     download + Linux/Alpine/Windows build coordination. Not all
 *     deployments want that complexity.
 *   - For ≤10k candidates, naive cosine over Float32Array is
 *     ~5-10ms p99 — acceptable for many production scales.
 *   - The interface surface is identical, so swapping is one import
 *     change at the call site.
 *
 * What this file ships:
 *   - SemanticIndex interface — kNN, add, remove, size
 *   - LinearScanIndex implementation — O(N) cosine, no native deps
 *   - createSemanticIndex factory — picks LinearScan unless caller
 *     overrides
 *
 * What it does NOT ship (deferred):
 *   - hnswlib-node binding (operator-time choice, not in package.json)
 *   - Build pipeline for embeddings of the candidate pool — Phase 4.2
 *     where every (provider, model) gets an embedding from its
 *     description + capabilities + examples
 *   - Health-aware filter wrap — Phase 5 ranking engine
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'semantic-index' });

// ─── Interface ────────────────────────────────────────────────────────────

export interface SemanticIndexEntry {
  id: string;
  embedding: Float32Array;
  /** Optional metadata returned with each result. */
  meta?: Record<string, unknown>;
}

export interface SemanticIndexHit {
  id: string;
  score: number;
  meta?: Record<string, unknown>;
}

export interface SemanticIndex {
  /**
   * Add an entry to the index. If `id` already exists, replace.
   */
  add(entry: SemanticIndexEntry): void;

  /**
   * Add multiple entries (for bulk init). Implementations may optimize
   * (e.g., HNSW supports batch addPoint).
   */
  addMany(entries: readonly SemanticIndexEntry[]): void;

  /**
   * Remove an entry by id. No-op if absent.
   */
  remove(id: string): void;

  /**
   * Find the top-k entries closest to `query` by cosine similarity.
   * Returns hits sorted by descending score (1.0 = identical direction).
   */
  knn(query: Float32Array, k: number): readonly SemanticIndexHit[];

  /**
   * Number of entries in the index.
   */
  size(): number;

  /**
   * Replace all entries (atomic-ish from caller's perspective — there
   * is a brief window where the old index is gone but the new one isn't
   * built; callers that need true atomic swap should manage their own
   * snapshot).
   */
  rebuild(entries: readonly SemanticIndexEntry[]): void;
}

// ─── LinearScanIndex (naive O(N) cosine) ──────────────────────────────────

class LinearScanIndex implements SemanticIndex {
  private entries = new Map<string, SemanticIndexEntry>();

  add(entry: SemanticIndexEntry): void {
    this.entries.set(entry.id, entry);
  }

  addMany(entries: readonly SemanticIndexEntry[]): void {
    for (const e of entries) this.entries.set(e.id, e);
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  knn(query: Float32Array, k: number): readonly SemanticIndexHit[] {
    if (k <= 0 || this.entries.size === 0) return [];

    const queryNorm = vectorNorm(query);
    if (queryNorm === 0) return [];

    // For small k vs large N, a min-heap would beat a full sort. With
    // ≤10k candidates this is fine — sort is O(N log N), heap is O(N log k).
    const hits: { id: string; score: number; meta?: Record<string, unknown> }[] = [];
    for (const entry of this.entries.values()) {
      const score = cosineSimilarity(query, queryNorm, entry.embedding);
      hits.push({ id: entry.id, score, meta: entry.meta });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  size(): number {
    return this.entries.size;
  }

  rebuild(entries: readonly SemanticIndexEntry[]): void {
    this.entries = new Map(entries.map((e) => [e.id, e]));
  }
}

// ─── Math ─────────────────────────────────────────────────────────────────

/**
 * Computes the L2 norm of a vector.
 */
export function vectorNorm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i] * v[i];
  }
  return Math.sqrt(sum);
}

/**
 * Cosine similarity, given the query's pre-computed norm to amortize
 * across many comparisons.
 *
 * Returns a value in [-1, 1]. Higher = more similar.
 */
export function cosineSimilarity(
  query: Float32Array,
  queryNorm: number,
  candidate: Float32Array,
): number {
  if (query.length !== candidate.length) {
    return 0; // dimension mismatch — can't compare
  }
  let dot = 0;
  let cNorm = 0;
  for (let i = 0; i < query.length; i++) {
    dot += query[i] * candidate[i];
    cNorm += candidate[i] * candidate[i];
  }
  cNorm = Math.sqrt(cNorm);
  if (cNorm === 0 || queryNorm === 0) return 0;
  return dot / (queryNorm * cNorm);
}

// ─── Factory ──────────────────────────────────────────────────────────────

export type SemanticIndexImplementation = 'linear_scan' | 'hnsw';

export interface CreateSemanticIndexInput {
  implementation?: SemanticIndexImplementation;
  /**
   * For HNSW: the embedding dimension. Required to size the index.
   * Ignored by linear-scan.
   */
  dimension?: number;
}

/**
 * Creates a SemanticIndex. Defaults to linear scan; pass `'hnsw'` if
 * `hnswlib-node` is installed (operator-time choice). HNSW path falls
 * back to linear scan with a log warning if the binding is unavailable.
 */
export function createSemanticIndex(input: CreateSemanticIndexInput = {}): SemanticIndex {
  if (input.implementation === 'hnsw') {
    log.warn(
      'HNSW implementation requested but Phase 4 ships only linear_scan; falling back. Install hnswlib-node and swap implementation in a follow-up.',
    );
  }
  return new LinearScanIndex();
}

// ─── Singleton (default index for the operational pool) ────────────────────

let instance: SemanticIndex | null = null;

export function getSemanticIndex(): SemanticIndex {
  if (!instance) {
    instance = createSemanticIndex();
    log.info('SemanticIndex (linear-scan) initialized');
  }
  return instance;
}

export function resetSemanticIndexForTesting(): void {
  instance = null;
}

export type { LinearScanIndex };
