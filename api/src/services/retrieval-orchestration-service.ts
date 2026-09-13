// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Retrieval Orchestration Service (LOTE AP, 2026-09-05)
 *
 * The `retrieval` capability, executed for real.
 *
 * ### What this is NOT
 *
 * It is not a new retrieval stack. The repository already ships a complete,
 * production vector-search substrate and this service is a thin, honest
 * composition of it:
 *
 *   - `vector_store_chunks` — pgvector(384) + HNSW cosine index
 *     (`prisma/schema.prisma`), org-scoped, populated at ingest.
 *   - `VectorStoreIngestService.search()` — the kNN itself.
 *   - `CapabilityEmbedder` — the query embedding (TEI sidecar / OpenAI).
 *   - `RerankOrchestrationService` — the cross-encoder second stage
 *     (also new in LOTE AP).
 *
 * Before this, the `retrieval` capability dispatched to generic chat
 * orchestration: an LLM was asked to answer a retrieval request with no
 * corpus attached, which cannot retrieve anything. The pieces above were all
 * reachable ONLY through `POST /v1/vector_stores/:id/search` and the chat
 * `rag_config` field — never through the capability surface.
 *
 * ### Two-stage retrieval
 *
 * Stage 1 (recall) is the ANN search: cheap, high-recall, embedding-only, and
 * blind to token-level interaction between query and document. Stage 2
 * (precision) is the cross-encoder rerank, which scores each pair jointly.
 * Asking stage 1 for more candidates than the caller wants and letting stage 2
 * choose among them is what makes the second stage worth its latency — so
 * `rerank: true` over-fetches rather than reranking an already-truncated list.
 *
 * Reranking is FAIL-SOFT: a reranker outage degrades to pure vector order and
 * is reported in `rerank.reason`, never turned into a failed retrieval.
 */

import { logger } from '@/utils/logger';
import {
  VectorStoreIngestService,
  type SearchChunkHit,
} from '@/services/vector-store-ingest-service';
import {
  getRerankOrchestrationService,
  type RerankOrchestrationService,
} from '@/services/rerank-orchestration-service';
import type { OrchestrationContext } from '@/types';
import { ValidationError } from '@/utils/custom-errors';
import { incrementCounter, observeHistogram, METRIC_NAMES } from '@/core/operability/metrics';

const log = logger.child({ service: 'retrieval-orchestration' });

/** Default per-store kNN depth. Mirrors the chat RAG path's `RAG_DEFAULT_TOP_K`. */
export const RETRIEVAL_DEFAULT_TOP_K = 5;
/** Default cap on returned chunks. Mirrors `RAG_DEFAULT_MAX_CHUNKS`. */
export const RETRIEVAL_DEFAULT_MAX_CHUNKS = 8;
/** Hard ceiling on both, bounding retrieval cost and latency. */
export const RETRIEVAL_MAX_LIMIT = 50;
/** Max stores addressable in one request — each one is a separate kNN. */
export const RETRIEVAL_MAX_STORES = 20;
/**
 * Recall multiplier applied to the per-store depth when a rerank stage is
 * requested. 4x is the standard first-stage/second-stage ratio: enough extra
 * recall for the cross-encoder to actually change the ordering, small enough
 * that the reranker's O(N) forward passes stay bounded.
 */
export const RETRIEVAL_RERANK_OVERFETCH = 4;

export interface RetrievalOptions {
  query: string;
  vectorStoreIds: string[];
  /** Per-store kNN depth (before rerank over-fetch). */
  topK?: number;
  /** Final cap on returned chunks. */
  maxChunks?: number;
  /** Drop chunks whose stage-1 cosine similarity is below this. */
  scoreThreshold?: number;
  /** Restrict the search to specific file ids inside the stores. */
  fileIds?: string[];
  /** Run the cross-encoder second stage. Default false (vector order only). */
  rerank?: boolean;
  /** Pin a reranker model; omit for dynamic selection. */
  rerankModel?: string;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface RetrievalChunk {
  vectorStoreId: string;
  fileId: string;
  chunkIndex: number;
  content: string;
  /** Stage-1 cosine similarity in [0,1]. Always present. */
  vectorScore: number;
  /** Stage-2 cross-encoder relevance. Present only when rerank ran. */
  rerankScore?: number;
  /** The score the final ordering used — `rerankScore` when present. */
  score: number;
  metadata: Record<string, unknown>;
}

export interface RetrievalRerankInfo {
  requested: boolean;
  applied: boolean;
  model?: string;
  provider?: string;
  /** Why a requested rerank did not apply. Absent when it did. */
  reason?: string;
}

export interface RetrievalResult {
  chunks: RetrievalChunk[];
  storeIds: string[];
  /** Chunks returned by stage 1 before threshold/rerank/cap. */
  retrievedCount: number;
  /** Stores that errored and were skipped (retrieval is per-store fail-soft). */
  failedStoreIds: string[];
  rerank: RetrievalRerankInfo;
  durationMs: number;
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), RETRIEVAL_MAX_LIMIT);
}

export class RetrievalOrchestrationService {
  private readonly ingestService: VectorStoreIngestService;
  private readonly getRerankService: () => RerankOrchestrationService;

  constructor(
    ingestService?: VectorStoreIngestService,
    getRerankService: () => RerankOrchestrationService = getRerankOrchestrationService
  ) {
    this.ingestService = ingestService ?? new VectorStoreIngestService();
    this.getRerankService = getRerankService;
  }

  async retrieve(options: RetrievalOptions): Promise<RetrievalResult> {
    const startTime = Date.now();
    const {
      query,
      vectorStoreIds,
      scoreThreshold,
      fileIds,
      rerank = false,
      rerankModel,
      userContext,
      requestId,
    } = options;

    this.validateInput(query, vectorStoreIds);

    const organizationId = userContext.organizationId;
    if (!organizationId) {
      throw new ValidationError('retrieval requires an organization-scoped request context');
    }

    const maxChunks = clampLimit(options.maxChunks, RETRIEVAL_DEFAULT_MAX_CHUNKS);
    const baseTopK = clampLimit(options.topK, RETRIEVAL_DEFAULT_TOP_K);
    // Over-fetch ONLY when a second stage will actually re-order the result;
    // without it the extra rows are pure cost.
    const effectiveTopK = rerank
      ? Math.min(baseTopK * RETRIEVAL_RERANK_OVERFETCH, RETRIEVAL_MAX_LIMIT)
      : baseTopK;

    log.info(
      {
        requestId,
        stores: vectorStoreIds.length,
        queryLength: query.length,
        topK: baseTopK,
        effectiveTopK,
        maxChunks,
        rerank,
      },
      'Retrieval orchestration started'
    );

    // Search every store in parallel, org-scoped. `VectorStoreIngestService`
    // additionally filters by organization_id in SQL (defence in depth), so a
    // store id from another tenant returns zero rows rather than data.
    const perStore = await Promise.allSettled(
      vectorStoreIds.map(async (vectorStoreId) => {
        const hits = await this.ingestService.search({
          vectorStoreId,
          organizationId,
          query,
          topK: effectiveTopK,
          ...(fileIds && fileIds.length > 0 ? { fileIds } : {}),
        });
        return hits.map((hit) => ({ ...hit, vectorStoreId }));
      })
    );

    const aggregated: Array<SearchChunkHit & { vectorStoreId: string }> = [];
    const failedStoreIds: string[] = [];
    for (const [index, outcome] of perStore.entries()) {
      const storeId = vectorStoreIds[index] ?? '<unknown>';
      if (outcome.status === 'fulfilled') {
        aggregated.push(...outcome.value);
      } else {
        failedStoreIds.push(storeId);
        log.warn(
          { requestId, vectorStoreId: storeId, error: String(outcome.reason) },
          'Retrieval vector-store search failed (skipping this store)'
        );
      }
    }

    const thresholded = aggregated.filter((hit) =>
      scoreThreshold === undefined ? true : hit.score >= scoreThreshold
    );

    const rerankInfo: RetrievalRerankInfo = { requested: rerank, applied: false };
    let ordered: RetrievalChunk[];

    if (rerank && thresholded.length > 0) {
      const reranked = await this.applyRerank({
        query,
        hits: thresholded,
        topN: maxChunks,
        model: rerankModel,
        userContext,
        requestId,
      });
      ordered = reranked.chunks;
      rerankInfo.applied = reranked.applied;
      if (reranked.model) rerankInfo.model = reranked.model;
      if (reranked.provider) rerankInfo.provider = reranked.provider;
      if (reranked.reason) rerankInfo.reason = reranked.reason;
    } else {
      if (rerank) rerankInfo.reason = 'no_candidates';
      ordered = thresholded
        .map((hit) => this.toChunk(hit, hit.score))
        .sort((a, b) => b.score - a.score);
    }

    const chunks = ordered.slice(0, maxChunks);
    const durationMs = Date.now() - startTime;

    this.recordMetrics({
      outcome: chunks.length > 0 ? 'hit' : 'empty',
      rerankApplied: rerankInfo.applied,
      durationMs,
    });

    log.info(
      {
        requestId,
        retrieved: aggregated.length,
        afterThreshold: thresholded.length,
        returned: chunks.length,
        failedStores: failedStoreIds.length,
        rerankApplied: rerankInfo.applied,
        durationMs,
      },
      'Retrieval orchestration completed'
    );

    return {
      chunks,
      storeIds: vectorStoreIds,
      retrievedCount: aggregated.length,
      failedStoreIds,
      rerank: rerankInfo,
      durationMs,
    };
  }

  // ============================================
  // Stage 2 — cross-encoder rerank (fail-soft)
  // ============================================

  private async applyRerank(params: {
    query: string;
    hits: Array<SearchChunkHit & { vectorStoreId: string }>;
    topN: number;
    model?: string;
    userContext: OrchestrationContext;
    requestId: string;
  }): Promise<{
    chunks: RetrievalChunk[];
    applied: boolean;
    model?: string;
    provider?: string;
    reason?: string;
  }> {
    const { query, hits, topN, model, userContext, requestId } = params;

    const vectorOrder = () =>
      hits.map((hit) => this.toChunk(hit, hit.score)).sort((a, b) => b.score - a.score);

    try {
      const result = await this.getRerankService().rerank({
        query,
        documents: hits.map((hit) => hit.content),
        ...(model ? { model } : {}),
        topN,
        returnDocuments: false,
        userContext,
        requestId,
      });

      const chunks: RetrievalChunk[] = [];
      for (const item of result.results) {
        const hit = hits[item.index];
        // A provider returning an out-of-range index is a contract violation,
        // not a reason to fail the retrieval — drop that entry and keep going.
        if (!hit) {
          log.warn(
            { requestId, index: item.index, documentCount: hits.length, provider: result.provider },
            'Reranker returned an out-of-range document index — dropping entry'
          );
          continue;
        }
        const chunk = this.toChunk(hit, item.relevanceScore);
        chunk.rerankScore = item.relevanceScore;
        chunks.push(chunk);
      }

      if (chunks.length === 0) {
        return {
          chunks: vectorOrder(),
          applied: false,
          reason: 'reranker_returned_no_usable_results',
        };
      }

      return {
        chunks,
        applied: true,
        model: result.modelUsed,
        provider: result.provider,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // Fail-soft by design: retrieval still has a correct (if less precise)
      // answer from stage 1, and a reranker outage must not take it down.
      log.warn(
        { requestId, error: message },
        'Cross-encoder rerank failed — falling back to vector order'
      );
      return {
        chunks: vectorOrder(),
        applied: false,
        reason: `rerank_unavailable: ${message}`,
      };
    }
  }

  // ============================================
  // Helpers
  // ============================================

  private toChunk(hit: SearchChunkHit & { vectorStoreId: string }, score: number): RetrievalChunk {
    return {
      vectorStoreId: hit.vectorStoreId,
      fileId: hit.fileId,
      chunkIndex: hit.chunkIndex,
      content: hit.content,
      vectorScore: hit.score,
      score,
      metadata:
        hit.metadata && typeof hit.metadata === 'object' && !Array.isArray(hit.metadata)
          ? (hit.metadata as Record<string, unknown>)
          : {},
    };
  }

  private validateInput(query: string, vectorStoreIds: string[]): void {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new ValidationError('query is required and must be a non-empty string');
    }
    if (!Array.isArray(vectorStoreIds) || vectorStoreIds.length === 0) {
      throw new ValidationError(
        'vector_store_ids is required and must list at least one vector store. ' +
          'Retrieval searches an indexed corpus — create a vector store and ingest ' +
          'files via POST /v1/vector_stores before retrieving.'
      );
    }
    if (vectorStoreIds.length > RETRIEVAL_MAX_STORES) {
      throw new ValidationError(
        `vector_store_ids exceeds the maximum of ${RETRIEVAL_MAX_STORES} stores per request`
      );
    }
    for (const [index, id] of vectorStoreIds.entries()) {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new ValidationError(`vector_store_ids[${index}] must be a non-empty string`);
      }
    }
  }

  /**
   * Emit retrieval observability on the shared operability registry, so the
   * capability is watchable next to discovery/embedding/probe series rather
   * than only in logs. Never throws — the metrics helpers already swallow,
   * but a retrieval must not fail on instrumentation.
   */
  private recordMetrics(params: {
    outcome: 'hit' | 'empty';
    rerankApplied: boolean;
    durationMs: number;
  }): void {
    try {
      incrementCounter(METRIC_NAMES.RETRIEVAL_REQUEST_TOTAL, {
        outcome: params.outcome,
        reranked: params.rerankApplied ? 'true' : 'false',
      });
      observeHistogram(METRIC_NAMES.RETRIEVAL_LATENCY_MS, params.durationMs, {
        reranked: params.rerankApplied ? 'true' : 'false',
      });
    } catch {
      // Instrumentation is best-effort.
    }
  }
}

let sharedRetrievalService: RetrievalOrchestrationService | null = null;

export function getRetrievalOrchestrationService(): RetrievalOrchestrationService {
  if (!sharedRetrievalService) {
    sharedRetrievalService = new RetrievalOrchestrationService();
  }
  return sharedRetrievalService;
}

/** Test seam — resets the singleton between suites. */
export function resetRetrievalOrchestrationServiceForTesting(): void {
  sharedRetrievalService = null;
}
