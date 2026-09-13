// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Search Orchestration Service
 * Orchestrates web search and grounding across multiple providers
 *
 * Features:
 * - Dynamic provider selection (Tavily, Perplexity, Google Search Grounding, etc.)
 * - Models with web_search capability automatically included
 * - Automatic failover between providers
 * - Content extraction for RAG
 * - Google Maps integration (when available)
 *
 * NO HARDCODED PROVIDERS - All selection is dynamic via capabilities
 */

import { logger } from '@/utils/logger';
import { ModelRepository } from '@/services/model-repository';
import { computeModalityCost } from '@/services/modality-cost';
import { getProviderRegistry } from '@/providers/provider-registry';
import type { ProviderRegistry } from '@/providers/provider-registry';
import { TavilySearchService } from '@/services/tavily-search-service';
import type { Model, ModelCapability, OrchestrationContext } from '@/types';
import { isAdapterMethodOverridden } from '@/providers/provider-operability';

const log = logger.child({ service: 'search-orchestration' });

// ============================================
// Types
// ============================================

export interface SearchOptions {
  query: string;
  model?: string; // undefined = auto-select
  searchDepth: 'basic' | 'advanced';
  maxResults: number;
  includeImages: boolean;
  includeAnswer: boolean;
  includeRawContent: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  topic: 'general' | 'news' | 'finance';
  userContext: OrchestrationContext;
  requestId: string;
}

export interface SearchResult {
  answer?: string;
  results: Array<{
    title: string;
    url: string;
    content: string;
    rawContent?: string;
    score: number;
    publishedDate?: string;
  }>;
  images?: string[];
  responseTime: number;
  providerUsed: string;
  modelUsed?: string;
  durationMs: number;
}

export interface ExtractOptions {
  urls: string[];
  includeImages: boolean;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface ExtractResult {
  results: Array<{
    url: string;
    content: string;
    images?: string[];
  }>;
  failedResults: Array<{
    url: string;
    error: string;
  }>;
  responseTime: number;
  providerUsed: string;
  durationMs: number;
}

// ============================================
// Search Orchestration Service
// ============================================

export class SearchOrchestrationService {
  private modelRepo: ModelRepository;
  private getRegistry: () => ProviderRegistry;
  private tavilyService: TavilySearchService;

  constructor() {
    this.modelRepo = new ModelRepository();
    this.getRegistry = getProviderRegistry;
    this.tavilyService = new TavilySearchService();
  }

  private createCapabilityNotOperationalError(params: {
    capability: string;
    model: Model;
    nonOperationalReasons: string[];
  }): Error & { statusCode: number; code: string; details: Record<string, unknown> } {
    const reasonList =
      params.nonOperationalReasons.length > 0
        ? params.nonOperationalReasons
        : ['no_registered_execution_provider'];
    const err = new Error(
      `Model ${params.model.name} is not operational for capability ${params.capability}: ${reasonList.join(', ')}`
    ) as Error & { statusCode: number; code: string; details: Record<string, unknown> };
    err.statusCode = 422;
    err.code = 'capability_not_operational';
    err.details = {
      capability: params.capability,
      model: params.model.name,
      provider: params.model.provider,
      reasons: reasonList,
    };
    return err;
  }

  /**
   * Perform web search
   * Dynamically selects best search provider (Tavily or models with web_search capability)
   */
  async performSearch(options: SearchOptions): Promise<SearchResult> {
    const startTime = Date.now();
    const {
      query,
      model,
      searchDepth,
      maxResults,
      includeImages,
      includeAnswer,
      includeRawContent,
      includeDomains,
      excludeDomains,
      topic,
      userContext,
      requestId,
    } = options;

    log.info({ requestId, query, model, searchDepth, maxResults }, 'Search orchestration started');

    try {
      // Step 1: Decide between Tavily or model with web_search capability
      const searchStrategy = await this.selectSearchStrategy(model, searchDepth, userContext);

      if (searchStrategy.type === 'tavily') {
        // Use Tavily API directly
        log.info({ requestId, provider: 'tavily' }, 'Using Tavily for search');

        const tavilyResult = await this.tavilyService.search({
          query,
          searchDepth: searchDepth === 'advanced' ? 'advanced' : 'basic',
          includeImages,
          includeAnswer,
          includeRawContent,
          maxResults,
          includeDomains,
          excludeDomains,
          topic,
        });

        const durationMs = Date.now() - startTime;

        if (!tavilyResult.success) {
          throw new Error(tavilyResult.error || 'Search failed');
        }

        return {
          answer: tavilyResult.answer,
          results: tavilyResult.results,
          images: tavilyResult.images,
          responseTime: tavilyResult.responseTime,
          providerUsed: 'tavily',
          durationMs,
        };
      } else if (searchStrategy.type === 'model') {
        // Use model with web_search capability
        const selectedModel = searchStrategy.model!;

        log.info(
          { requestId, model: selectedModel.name, provider: selectedModel.provider },
          'Using model with web_search capability'
        );

        const providerRegistry = this.getRegistry();
        const resolution = providerRegistry.resolveAdapterForModel(selectedModel);
        const adapter = resolution.adapter;
        if (!adapter) {
          throw this.createCapabilityNotOperationalError({
            capability: 'web_search',
            model: selectedModel,
            nonOperationalReasons: resolution.operability.nonOperationalReasons,
          });
        }

        // Execute search via model
        if (!isAdapterMethodOverridden(adapter, 'webSearch')) {
          // Fallback to Tavily if model doesn't implement webSearch method yet
          log.warn(
            { requestId, model: selectedModel.name },
            'Model has web_search capability but adapter does not implement webSearch method, falling back to Tavily'
          );

          return this.performSearch({
            ...options,
            model: undefined, // Force Tavily
          });
        }

        let modelResult: { text: string; raw: unknown };
        try {
          modelResult = await adapter.webSearch(selectedModel, {
            query,
            maxResults,
            options: {
              depth: searchDepth,
              includeImages,
              includeAnswer,
            },
          });
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log.warn(
            {
              requestId,
              model: selectedModel.name,
              provider: selectedModel.provider,
              error: errorMessage,
            },
            'Model webSearch execution failed, falling back to Tavily'
          );
          return this.performSearch({
            ...options,
            model: undefined,
          });
        }

        const durationMs = Date.now() - startTime;

        // COST #6: feed model-based search cost into the unified accounting.
        const cost = computeModalityCost({
          response: modelResult,
          model: selectedModel,
          provider: (selectedModel.provider || '').toLowerCase(),
        });
        log.info(
          {
            requestId,
            model: selectedModel.name,
            provider: selectedModel.provider,
            durationMs,
            costUsd: cost.normalizedCostUsd,
            costSource: cost.costSource,
          },
          'Model-based web search completed'
        );

        const rawData = modelResult.raw as
          | {
              answer?: string;
              results?: Array<{
                title: string;
                url: string;
                content: string;
                rawContent?: string;
                score: number;
                publishedDate?: string;
              }>;
              images?: string[];
            }
          | undefined;

        return {
          answer: rawData?.answer,
          results: (rawData?.results || []) as SearchResult['results'],
          images: rawData?.images,
          responseTime: durationMs,
          providerUsed: selectedModel.provider,
          modelUsed: selectedModel.name,
          durationMs,
        };
      } else {
        throw new Error(
          'No search providers available (Tavily or models with web_search capability)'
        );
      }
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Search orchestration failed';
      log.error({ requestId, error, durationMs }, 'Search orchestration failed');
      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }

  /**
   * Extract content from URLs via Tavily.
   *
   * This previously had a "model-based extraction" branch gated on models
   * carrying `web_scraping`/`content_extraction` capabilities. Neither
   * capability was ever a member of `ModelCapability` (the filter cast the
   * strings `as ModelCapability` to bypass the type system), and no
   * assignment path anywhere in the codebase ever produced them: the
   * `searchModelsComplete` capabilities filter requires a JSONB superset
   * match, which is unsatisfiable for a capability no model can ever hold.
   * `extractionModels` was therefore always `[]` and the branch was dead
   * code from the day it was introduced (verified via git history: it
   * shipped in the initial repository import with no incremental design
   * history, and the branch's own error path referenced the unrelated
   * `web_search` capability, evidence it was never exercised or reviewed
   * against real behavior). Removed rather than repaired, since it always
   * fell straight through to Tavily (removing it changes no observed
   * behavior), and asking a chat model to "summarize the content at this
   * URL" without giving it a real live-browsing capability was never a
   * sound design (that need is already served by the `web_search`-gated
   * strategy in `selectSearchStrategy`/`hasWebSearchCapability` above).
   */
  async extractContent(options: ExtractOptions): Promise<ExtractResult> {
    const startTime = Date.now();
    const { urls, includeImages, requestId } = options;

    log.info({ requestId, urlCount: urls.length }, 'Content extraction orchestration started');

    try {
      const tavilyResult = await this.tavilyService.extract({
        urls,
        includeImages,
      });

      const durationMs = Date.now() - startTime;

      if (!tavilyResult.success) {
        throw new Error('Content extraction failed');
      }

      return {
        results: tavilyResult.results.map((r) => ({
          url: r.url,
          content: r.content,
          images: r.images,
        })),
        failedResults: tavilyResult.failedResults,
        responseTime: tavilyResult.responseTime,
        providerUsed: 'tavily',
        durationMs,
      };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(
        { requestId, error: errorMessage, durationMs },
        'Content extraction orchestration failed'
      );
      throw error;
    }
  }

  // ============================================
  // Private Methods - Dynamic Provider Selection
  // ============================================

  /**
   * Select best search strategy (Tavily or model with web_search)
   * NO HARDCODED - Dynamic based on capabilities
   */
  private async selectSearchStrategy(
    explicitModel: string | undefined,
    searchDepth: string,
    _userContext: OrchestrationContext
  ): Promise<{ type: 'tavily' | 'model'; model?: Model }> {
    const providerRegistry = this.getRegistry();

    // If explicit model specified, try to use it
    if (explicitModel) {
      // Direct id/name resolution across the WHOLE catalog. This used to be
      // `searchModels({}).find(m => m.name === explicitModel)`, i.e. a scan of
      // the 100 most recently discovered rows: any older model named here was
      // reported as "does not support web_search" and silently downgraded to
      // Tavily, even when it did. `findModelsByIdOrName` resolves in SQL and
      // returns every provider row for the id (same id ships under N
      // providers), so an operable deployment can still be found when the
      // first one has no adapter.
      const rows = await this.modelRepo.findModelsByIdOrName(explicitModel);
      const capableRows = rows.filter((m) => this.hasWebSearchCapability(m));
      const model = capableRows[0] ?? rows[0];

      for (const candidate of capableRows) {
        const resolution = providerRegistry.resolveAdapterForModel(candidate);
        if (resolution.adapter) {
          return { type: 'model', model: candidate };
        }
      }

      if (model && this.hasWebSearchCapability(model)) {
        log.warn(
          {
            explicitModel,
            reasons: providerRegistry.getModelOperability(model).nonOperationalReasons,
          },
          'Explicit model has web_search capability but is not operational'
        );
      }

      // If explicit model doesn't support web_search, fallback to Tavily
      log.warn(
        { explicitModel },
        'Explicit model does not support web_search, falling back to Tavily'
      );
    }

    // Auto-select: prefer Tavily for deep search, models for basic search
    if (searchDepth === 'advanced') {
      // Tavily is better for deep research
      return { type: 'tavily' };
    }

    // Check if we have models with web_search capability
    // searchModelsComplete: `searchModels` caps at `limit || 100` ordered by
    // `created_at DESC`, so this pool was the newest-onboarded providers only.
    const webSearchModels = await this.modelRepo.searchModelsComplete({
      capabilities: ['web_search' as ModelCapability],
      status: 'active',
    });

    const operationalWebSearchModels = webSearchModels.filter((candidate) => {
      const resolution = providerRegistry.resolveAdapterForModel(candidate);
      return !!resolution.adapter && isAdapterMethodOverridden(resolution.adapter, 'webSearch');
    });

    if (operationalWebSearchModels.length > 0) {
      // Prefer models like Perplexity for basic search
      return { type: 'model', model: operationalWebSearchModels[0] };
    }

    // Fallback to Tavily
    return { type: 'tavily' };
  }

  /**
   * Check if model has web search capability
   */
  private hasWebSearchCapability(model: Model): boolean {
    return (
      model.capabilities.includes('web_search' as ModelCapability) ||
      model.capabilities.includes('deep_research' as ModelCapability)
    );
  }
}
