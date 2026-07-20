// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * EmbeddingCache — LRU cache for embeddings.
 *
 * Phase 4.1 (2026-05-08): wraps the TEI client so repeated queries
 * don't pay the embedding cost twice. The cache is keyed by the SHA256
 * of the text — different inputs that produce the same hash collide,
 * but the chance is astronomically low and not worth defending against.
 *
 * Default size: 50,000 entries × ~1024 floats × 4 bytes = ~200MB ceiling.
 * That's too much for some deployments — operators can size via
 * EMBEDDING_CACHE_MAX_ENTRIES env var.
 *
 * Hit-rate expectation in production: 30-50% for chat-completion query
 * patterns where users ask similar follow-ups.
 */

import { createHash } from 'node:crypto';
import { logger } from '@/utils/logger';
import { getTEIClient, type TEIClient } from './tei-client';
import { observeHistogram, METRIC_NAMES } from './metrics';

const log = logger.child({ component: 'embedding-cache' });

// ─── Config ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES = (() => {
  const env = process.env.EMBEDDING_CACHE_MAX_ENTRIES;
  if (!env) return 50_000;
  const parsed = parseInt(env, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50_000;
})();

// ─── LRU implementation ───────────────────────────────────────────────────

class EmbeddingCache {
  private readonly cache = new Map<string, Float32Array>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly tei: TEIClient = getTEIClient(),
  ) {}

  /**
   * Returns the embedding for `text`, computing+caching on miss.
   * Uses Map's insertion-order iteration to evict the oldest entry
   * when at capacity (true LRU on access).
   */
  async getOrCompute(text: string): Promise<Float32Array> {
    const key = stableHash(text);
    const cached = this.cache.get(key);
    if (cached) {
      // Touch: re-insert to mark as recent
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.hits++;
      return cached;
    }

    this.misses++;
    const t0 = performance.now();
    let embedding: Float32Array;
    try {
      embedding = await this.tei.embed(text);
    } catch (err) {
      log.warn({ err: String(err), textLen: text.length }, 'Embedding miss + TEI error');
      throw err;
    }
    const elapsed = performance.now() - t0;
    observeHistogram(METRIC_NAMES.PROVIDER_DISCOVERY_DURATION_MS, elapsed, {});

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, embedding);
    return embedding;
  }

  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  size(): number {
    return this.cache.size;
  }

  hitMissCounts(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  clearForTesting(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function stableHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: EmbeddingCache | null = null;

export function getEmbeddingCache(maxEntries?: number, tei?: TEIClient): EmbeddingCache {
  if (!instance) {
    instance = new EmbeddingCache(maxEntries, tei);
  }
  return instance;
}

export function resetEmbeddingCacheForTesting(): void {
  instance = null;
}

export type { EmbeddingCache };
