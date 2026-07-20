// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Embedding pipeline — populates SemanticIndex with embeddings of
 * the OperationalCandidatePool.
 *
 * Phase 4.2 (2026-05-08): builds a textual representation per
 * candidate (provider + model + capabilities + family + tier) and
 * sends it through TEI in batches, then loads the resulting embeddings
 * into the SemanticIndex.
 *
 * Design choices:
 *   - Batched TEI calls (default batchSize=32): one /embed call per
 *     batch to amortize HTTP overhead. TEI handles batched inference
 *     more efficiently than N sequential calls.
 *   - Idempotent: re-running over the same candidate set produces the
 *     same embedding (textual representation is deterministic). Index
 *     is rebuilt — no stale entries.
 *   - On-demand AND periodic: triggered by the DiscoveryScheduler after
 *     each pool rebuild, plus exposed `rebuildIndexNow()` for tests
 *     and admin endpoints.
 *   - Failure isolation: if one batch fails, others continue. The
 *     index is updated with partial results. Logged per-batch.
 *
 * Textual representation rationale:
 *   The embedding describes the model's CAPABILITIES + ROLE, not its
 *   identity. Two providers serving the same model (e.g., openai +
 *   aihubmix both serving gpt-4o-mini) get nearly-identical embeddings
 *   — which is correct: semantically they're equivalent, and the
 *   ranking engine (Phase 5) breaks ties on tier/health/cost.
 */

import { logger } from '@/utils/logger';
import {
  getOperationalCandidatePool,
  type OperationalCandidate,
} from './operational-candidate-pool';
import { getEmbeddingCache } from './embedding-cache';
import { getTEIClient, type TEIClient } from './tei-client';
import { getSemanticIndex, type SemanticIndex, type SemanticIndexEntry } from './semantic-index';
import {
  METRIC_NAMES,
  incrementCounter,
  observeHistogram,
  setGauge,
} from './metrics';

const log = logger.child({ component: 'embedding-pipeline' });

// ─── Config ────────────────────────────────────────────────────────────────

export interface EmbeddingPipelineConfig {
  /** Batch size for TEI embedBatch calls. Default 32. */
  batchSize?: number;
  /** Use embedding cache for identical texts (cross-candidate dedup). Default true. */
  useCache?: boolean;
  /** TEI client override (testing). */
  tei?: TEIClient;
}

const DEFAULT_BATCH_SIZE = 32;

// ─── Textual representation ──────────────────────────────────────────────

/**
 * Builds the canonical text that gets embedded for a candidate.
 *
 * Rationale per field:
 *   - providerTier: indicates "where" — native vs aggregator vs local
 *     — useful for matching queries that imply premium/cost/quality
 *   - modelFamily: anchors the family (gpt vs claude vs llama)
 *   - capabilities: signals function-calling, json-mode, vision, etc.
 *   - contextWindow: tells the embedding "this model handles long
 *     context" so a query about long documents matches naturally
 *
 * Output format is structured to avoid the embedding model treating
 * it as natural language — labels + values give a clearer signal.
 */
function buildCandidateText(c: OperationalCandidate): string {
  const parts: string[] = [];
  parts.push(`provider:${c.providerId}`);
  parts.push(`model:${c.modelId}`);
  if (c.modelFamily) parts.push(`family:${c.modelFamily}`);
  parts.push(`tier:${c.providerTier}`);
  if (c.contextWindow) parts.push(`context:${c.contextWindow}`);
  if (c.capabilities && c.capabilities.length > 0) {
    parts.push(`capabilities:${c.capabilities.slice().sort().join(',')}`);
  }
  return parts.join(' ');
}

// ─── Pipeline ────────────────────────────────────────────────────────────

class EmbeddingPipeline {
  private lastRunAt: number = 0;
  private lastEntryCount: number = 0;
  private inProgress = false;

  /**
   * Rebuilds the SemanticIndex from the current OperationalCandidatePool.
   * Returns the number of entries written to the index.
   */
  async rebuildIndexNow(config: EmbeddingPipelineConfig = {}): Promise<number> {
    if (this.inProgress) {
      log.warn('Pipeline already running — skipping concurrent rebuild');
      incrementCounter(METRIC_NAMES.EMBEDDING_PIPELINE_FAILED_TOTAL, { reason: 'concurrent_call' });
      return this.lastEntryCount;
    }
    this.inProgress = true;
    const t0 = Date.now();

    try {
      const tei = config.tei ?? getTEIClient();

      // Verify TEI is reachable before doing the work
      const healthy = await tei.isHealthy();
      setGauge(METRIC_NAMES.TEI_HEALTH_STATE, healthy ? 1 : 0);
      if (!healthy) {
        log.warn('TEI unreachable — skipping index rebuild (resolver will fall back to pool query)');
        incrementCounter(METRIC_NAMES.EMBEDDING_PIPELINE_FAILED_TOTAL, { reason: 'tei_unhealthy' });
        return this.lastEntryCount;
      }

      const candidates = getOperationalCandidatePool().snapshot();
      if (candidates.length === 0) {
        log.info('Pool empty — clearing index');
        getSemanticIndex().rebuild([]);
        this.lastEntryCount = 0;
        setGauge(METRIC_NAMES.SEMANTIC_INDEX_SIZE, 0);
        incrementCounter(METRIC_NAMES.EMBEDDING_PIPELINE_RUN_TOTAL, { result: 'pool_empty' });
        return 0;
      }

      const entries = await this.embedAll(candidates, config);

      const idx = getSemanticIndex();
      idx.rebuild(entries);

      this.lastRunAt = Date.now();
      this.lastEntryCount = entries.length;

      const durationMs = Date.now() - t0;
      observeHistogram(METRIC_NAMES.EMBEDDING_PIPELINE_DURATION_MS, durationMs);
      incrementCounter(METRIC_NAMES.EMBEDDING_PIPELINE_MODELS_EMBEDDED_TOTAL, {}, { by: entries.length });
      setGauge(METRIC_NAMES.SEMANTIC_INDEX_SIZE, entries.length);
      setGauge(METRIC_NAMES.SEMANTIC_INDEX_LAST_REBUILD_AT, Math.floor(this.lastRunAt / 1000));
      incrementCounter(METRIC_NAMES.EMBEDDING_PIPELINE_RUN_TOTAL, { result: 'success' });

      log.info(
        {
          candidates: candidates.length,
          embedded: entries.length,
          durationMs,
        },
        'Embedding pipeline run complete',
      );

      return entries.length;
    } catch (err) {
      incrementCounter(METRIC_NAMES.EMBEDDING_PIPELINE_FAILED_TOTAL, { reason: 'unhandled_error' });
      throw err;
    } finally {
      this.inProgress = false;
    }
  }

  getLastRunAt(): number {
    return this.lastRunAt;
  }

  getLastEntryCount(): number {
    return this.lastEntryCount;
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async embedAll(
    candidates: readonly OperationalCandidate[],
    config: EmbeddingPipelineConfig,
  ): Promise<SemanticIndexEntry[]> {
    const tei = config.tei ?? getTEIClient();
    const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    const entries: SemanticIndexEntry[] = [];

    // Note on cache: a fresh index rebuild has effectively no repeated
    // texts (each candidate's text representation is unique), so the
    // EmbeddingCache provides no win here. We always go through
    // embedBatch — TEI's batching is more efficient than N cached
    // lookups + N batchSize-1 calls. Cache stays for hot-path query
    // embeds (resolveSemanticCandidates).
    void config.useCache;
    void getEmbeddingCache;

    // Batch candidates into groups of `batchSize`
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const texts = batch.map(buildCandidateText);

      try {
        const embeddings: Float32Array[] = await tei.embedBatch(texts);

        for (let j = 0; j < batch.length; j++) {
          const candidate = batch[j];
          const embedding = embeddings[j];
          if (!embedding) continue;
          entries.push({
            id: `${candidate.providerId}::${candidate.modelId}`,
            embedding,
            meta: {
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              providerTier: candidate.providerTier,
              modelFamily: candidate.modelFamily,
            },
          });
        }
      } catch (err) {
        log.warn(
          { err: String(err), batchStart: i, batchSize: batch.length },
          'Embedding batch failed — continuing with remaining batches',
        );
      }
    }

    return entries;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: EmbeddingPipeline | null = null;

export function getEmbeddingPipeline(): EmbeddingPipeline {
  if (!instance) {
    instance = new EmbeddingPipeline();
  }
  return instance;
}

export function resetEmbeddingPipelineForTesting(): void {
  instance = null;
}

export type { EmbeddingPipeline };

/**
 * Convenience: trigger an index rebuild immediately. Used by the
 * DiscoveryScheduler hook and by admin endpoints.
 */
export async function rebuildEmbeddingIndex(config?: EmbeddingPipelineConfig): Promise<number> {
  return getEmbeddingPipeline().rebuildIndexNow(config);
}

/**
 * Exposed for tests and as a building block when callers want to embed
 * a single candidate (e.g., when a new provider is added mid-stream
 * via DiscoveryService.addCandidatesByProvider).
 */
export async function embedSingleCandidate(
  candidate: OperationalCandidate,
  tei: SemanticIndex extends infer _ ? TEIClient : TEIClient = getTEIClient(),
): Promise<SemanticIndexEntry> {
  const text = buildCandidateText(candidate);
  const embedding = await tei.embed(text);
  return {
    id: `${candidate.providerId}::${candidate.modelId}`,
    embedding,
    meta: {
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      providerTier: candidate.providerTier,
      modelFamily: candidate.modelFamily,
    },
  };
}

export { buildCandidateText };
