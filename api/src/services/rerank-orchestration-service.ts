// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Rerank Orchestration Service (LOTE AP, 2026-09-05)
 *
 * Cross-encoder DOCUMENT reranking — the retrieval second stage. Given a
 * query and N candidate documents, a reranker model rescores every
 * (query, document) pair jointly and returns them ordered by relevance.
 *
 * ### Why this file exists
 *
 * The catalog has carried `supports.rerank: true` on 17 providers and real
 * reranker model rows (`voyage/rerank-2.5`, `bge-reranker-v2-m3`,
 * `qwen3-rerank`, …) since long before anything could execute one.
 * (`relace-code-reranker` was a similar-looking pinned id that turned out to
 * be unverified — dropped 2026-09-09, LOTE AT — see providers.catalog.ts's
 * `relace` entry.) Two adapters implemented a rerank call each, in two mutually
 * incompatible vendor shapes, reachable only by narrowing to the concrete
 * class — so no route, no orchestrator and no caller ever used them. The
 * capability `reranking` therefore dispatched to generic chat orchestration,
 * which is not reranking at all: an LLM asked to "score these documents"
 * is a slower, pricier, unordered approximation of a cross-encoder.
 *
 * ### Do not confuse with the router's "semantic rerank"
 *
 * `core/selection/dynamic-model-selector.ts` has an `applySemanticRerank`
 * that reorders candidate *models* via RRF. Same word, unrelated subsystem.
 * This service reorders *documents*.
 *
 * NO HARDCODED MODELS — the candidate pool comes from the catalog by
 * capability, exactly like images/audio/video.
 */

import { logger } from '@/utils/logger';
import { ModelRepository } from '@/services/model-repository';
import {
  normalizeStrategy,
  resolveFallbackDeadlineMs,
  diversifyProviders,
  type ModalityStrategy,
} from '@/services/modality/modality-execution-helpers';
import { runModalityFallback } from '@/services/modality/modality-fallback-driver';
import { getProviderRegistry } from '@/providers/provider-registry';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { Model, ModelCapability, OrchestrationContext } from '@/types';
import type { RerankResponse, RerankResultItem } from '@/types/model-client';
import { isAdapterMethodImplemented } from '@/providers/provider-operability';
import { narrowAs } from '@/utils/type-guards';
import type { CandidateAttempt } from '@/core/orchestration/execute-with-fallback';
import { ValidationError } from '@/utils/custom-errors';

const log = logger.child({ service: 'rerank-orchestration' });

/**
 * Upper bound on documents per request. Cross-encoders are O(N) forward
 * passes, so an unbounded list is both a cost and a latency footgun; every
 * vendor caps this anyway (Voyage 1000, Cohere 1000). Rejecting locally
 * produces a clear 400 instead of a vendor-specific 4xx surfaced as a
 * provider failure.
 */
export const MAX_RERANK_DOCUMENTS = 1000;

/** Per-document character cap — protects the provider request body. */
export const MAX_RERANK_DOCUMENT_CHARS = 100_000;

export interface RerankOptions {
  query: string;
  documents: string[];
  /** undefined / 'auto' = dynamic selection across the whole catalog. */
  model?: string;
  topN?: number;
  returnDocuments?: boolean;
  strategy?: string;
  allowFallback?: boolean;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface RerankOrchestrationResult {
  results: RerankResultItem[];
  totalTokens?: number;
  modelUsed: string;
  provider: string;
  durationMs: number;
  strategyUsed: ModalityStrategy;
  fallbackUsed: boolean;
  attempts?: CandidateAttempt[];
}

/**
 * The adapter response, augmented with an OpenAI-shaped `usage` block.
 *
 * `computeModalityCost` prices a modality execution from
 * `usage.prompt_tokens` + the catalog's `inputCostPer1k`. Reranker billing IS
 * input-token based, and the providers report the figure as
 * `usage.total_tokens` — so projecting it onto `prompt_tokens` makes rerank
 * cost REAL in the unified counter instead of the `missing` that every other
 * per-unit modality is stuck with. No number is invented: when the provider
 * reports nothing, nothing is projected and the cost stays `missing`.
 */
type PricedRerankResponse = RerankResponse & {
  usage?: { prompt_tokens: number; completion_tokens: number };
};

export class RerankOrchestrationService {
  private modelRepo: ModelRepository;
  private getRegistry: () => ProviderRegistry;

  constructor() {
    this.modelRepo = new ModelRepository();
    this.getRegistry = getProviderRegistry;
  }

  /**
   * Rerank `documents` against `query`.
   *
   * Capability: `reranking`. Adapter method: `rerank`.
   */
  async rerank(options: RerankOptions): Promise<RerankOrchestrationResult> {
    const startTime = Date.now();
    const {
      query,
      documents,
      model,
      topN,
      returnDocuments = false,
      strategy,
      allowFallback = true,
      userContext,
      requestId,
    } = options;

    this.validateInput(query, documents);
    const strategyUsed = normalizeStrategy(strategy);

    log.info(
      {
        requestId,
        model,
        queryLength: query.length,
        documentCount: documents.length,
        topN,
        strategy: strategyUsed,
        allowFallback,
      },
      'Rerank orchestration started'
    );

    const catalogRows = await this.resolveRerankCatalog(model);
    const ranked = this.sortModelsByStrategy(catalogRows, strategyUsed, userContext);
    const preRanked = diversifyProviders(ranked);

    const supportsMethod = (adapter: ProviderAdapter): boolean =>
      isAdapterMethodImplemented(adapter, 'rerank');

    const result = await runModalityFallback<PricedRerankResponse>({
      capability: ['reranking' as ModelCapability],
      capabilityLabel: 'reranking',
      explicit: model && model !== 'auto' ? model : null,
      catalog: preRanked,
      deadlineMs: resolveFallbackDeadlineMs(strategyUsed, allowFallback),
      registry: this.getRegistry(),
      supportsCapability: supportsMethod,
      log,
      requestId,
      startTime,
      execute: async (selectedModel, adapter) => {
        const response = await narrowAs<{ rerank: ProviderAdapter['rerank'] }>(adapter).rerank(
          selectedModel,
          {
            query,
            documents,
            ...(typeof topN === 'number' ? { topN } : {}),
            returnDocuments,
          }
        );

        return {
          ...response,
          ...(typeof response.totalTokens === 'number'
            ? { usage: { prompt_tokens: response.totalTokens, completion_tokens: 0 } }
            : {}),
        };
      },
    });

    // `topN` is enforced locally as well as passed to the provider: not every
    // vendor honours it (some ignore it, some cap it), and a caller that asked
    // for 5 must never receive 50.
    const trimmed =
      typeof topN === 'number' && topN > 0
        ? result.response.results.slice(0, topN)
        : result.response.results;

    return {
      results: trimmed,
      ...(typeof result.response.totalTokens === 'number'
        ? { totalTokens: result.response.totalTokens }
        : {}),
      modelUsed: result.selectedModel.name,
      provider: result.selectedModel.provider,
      durationMs: result.durationMs,
      strategyUsed,
      fallbackUsed: result.fallbackUsed,
      attempts: result.attempts,
    };
  }

  // ============================================
  // Input validation
  // ============================================

  private validateInput(query: string, documents: string[]): void {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new ValidationError('query is required and must be a non-empty string');
    }
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new ValidationError('documents is required and must be a non-empty array of strings');
    }
    if (documents.length > MAX_RERANK_DOCUMENTS) {
      throw new ValidationError(
        `documents exceeds the maximum of ${MAX_RERANK_DOCUMENTS} (received ${documents.length})`
      );
    }
    for (const [index, document] of documents.entries()) {
      if (typeof document !== 'string') {
        throw new ValidationError(`documents[${index}] must be a string`);
      }
      if (document.length > MAX_RERANK_DOCUMENT_CHARS) {
        throw new ValidationError(
          `documents[${index}] exceeds the maximum of ${MAX_RERANK_DOCUMENT_CHARS} characters`
        );
      }
    }
  }

  // ============================================
  // Candidate pool
  // ============================================

  /**
   * Build the reranker candidate pool.
   *
   * Uses `searchModelsComplete`, never `searchModels`: the latter silently
   * caps at 100 rows ordered by `created_at DESC`, which for a catalog of
   * ~76k rows means "the 100 most recently discovered models" — the failure
   * mode that made image and video generation unusable (LOTE AN). Reranker
   * rows are a small minority of the catalog, so they would be the FIRST
   * thing pushed out of such a window.
   *
   * `reranking` is the only capability queried. Reranker rows also carry
   * `retrieval`, but so would a future non-reranker retrieval model, and
   * pooling on `retrieval` would hand the rerank driver models that cannot
   * rerank.
   */
  private async resolveRerankCatalog(explicit: string | undefined): Promise<Model[]> {
    if (explicit && explicit !== 'auto') {
      // Every provider row carrying this id, so fallback can cross providers
      // of the same model.
      const rows = await this.modelRepo.findModelsByIdOrName(explicit);
      return rows.filter((m) => (m.capabilities ?? []).includes('reranking' as ModelCapability));
    }

    return this.modelRepo.searchModelsComplete({
      capabilities: ['reranking' as ModelCapability],
      status: 'active',
    });
  }

  // ============================================
  // Ranking
  // ============================================

  private getModelAverageCostPer1k(model: Model): number {
    const input = Number.isFinite(model.inputCostPer1k) ? model.inputCostPer1k : 0;
    const output = Number.isFinite(model.outputCostPer1k) ? model.outputCostPer1k : input;
    return (Math.max(0, input) + Math.max(0, output)) / 2;
  }

  private getModelQuality(model: Model): number {
    const quality = model.performance?.quality;
    return typeof quality === 'number' && Number.isFinite(quality) ? quality : 0.5;
  }

  private getModelLatencyMs(model: Model): number {
    const latency = model.performance?.latencyMs;
    return typeof latency === 'number' && Number.isFinite(latency) ? latency : 2000;
  }

  private sortModelsByStrategy(
    models: Model[],
    strategy: ModalityStrategy,
    userContext: OrchestrationContext
  ): Model[] {
    const sorted = [...models];
    sorted.sort((a, b) => {
      const costA = this.getModelAverageCostPer1k(a);
      const costB = this.getModelAverageCostPer1k(b);
      const qualityA = this.getModelQuality(a);
      const qualityB = this.getModelQuality(b);
      const latencyA = this.getModelLatencyMs(a);
      const latencyB = this.getModelLatencyMs(b);

      if (strategy === 'cost') {
        if (costA !== costB) return costA - costB;
        return qualityB - qualityA;
      }

      if (strategy === 'speed') {
        if (latencyA !== latencyB) return latencyA - latencyB;
        return costA - costB;
      }

      if (strategy === 'quality' || strategy === 'quality_multipass' || strategy === 'debate') {
        if (qualityA !== qualityB) return qualityB - qualityA;
        if (latencyA !== latencyB) return latencyA - latencyB;
        return costA - costB;
      }

      const qualityWeight =
        userContext.qualityTarget && userContext.qualityTarget > 0.7 ? 0.6 : 0.45;
      const costWeight = userContext.maxCost !== undefined ? 0.45 : 0.3;
      const latencyWeight = 1 - qualityWeight - costWeight;
      const scoreA =
        qualityA * qualityWeight -
        Math.log10(Math.max(1, costA + 1)) * costWeight -
        Math.log10(Math.max(1, latencyA)) * latencyWeight;
      const scoreB =
        qualityB * qualityWeight -
        Math.log10(Math.max(1, costB + 1)) * costWeight -
        Math.log10(Math.max(1, latencyB)) * latencyWeight;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return costA - costB;
    });
    return sorted;
  }
}

let sharedRerankService: RerankOrchestrationService | null = null;

/**
 * Process-wide singleton. The service is stateless apart from its
 * `ModelRepository`, and both the `/v1/rerank` route and the retrieval path
 * need one — sharing avoids a second repository per call site.
 */
export function getRerankOrchestrationService(): RerankOrchestrationService {
  if (!sharedRerankService) {
    sharedRerankService = new RerankOrchestrationService();
  }
  return sharedRerankService;
}

/** Test seam — resets the singleton between suites. */
export function resetRerankOrchestrationServiceForTesting(): void {
  sharedRerankService = null;
}
