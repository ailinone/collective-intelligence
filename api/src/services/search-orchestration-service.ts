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
    const { query, model, searchDepth, maxResults, includeImages, includeAnswer, includeRawContent, includeDomains, excludeDomains, topic, userContext, requestId } = options;

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
        
        log.info({ requestId, model: selectedModel.name, provider: selectedModel.provider }, 'Using model with web_search capability');

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
          log.warn({ requestId, model: selectedModel.name }, 'Model has web_search capability but adapter does not implement webSearch method, falling back to Tavily');
          
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

        const rawData = modelResult.raw as {
          answer?: string;
          results?: Array<{ title: string; url: string; content: string; rawContent?: string; score: number; publishedDate?: string }>;
          images?: string[]
        } | undefined;

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
        throw new Error('No search providers available (Tavily or models with web_search capability)');
      }
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Search orchestration failed';
      log.error({ requestId, error, durationMs }, 'Search orchestration failed');
      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }

  /**
   * Extract content from URLs
   * Uses Tavily or model-based extraction
   */
  async extractContent(options: ExtractOptions): Promise<ExtractResult> {
    const startTime = Date.now();
    const { urls, includeImages, requestId } = options;

    log.info({ requestId, urlCount: urls.length }, 'Content extraction orchestration started');

    try {
      // Try to use models with content extraction capabilities first
      // Otherwise fall back to Tavily (most reliable)
      const extractionModels = await this.modelRepo.searchModels({
        capabilities: ['web_scraping' as ModelCapability, 'content_extraction' as ModelCapability],
        status: 'active',
      });
      
      let tavilyResult;
      
      if (extractionModels.length > 0 && urls.length <= 3) {
        // For small batches, try model-based extraction using chat completion
        // This uses models with web_search capability to extract content
        try {
          const selectedModel = extractionModels[0];
          log.info({ requestId, model: selectedModel.name, provider: selectedModel.provider }, 'Attempting model-based extraction');
          
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

          // Extract content from each URL using chat completion
          const extractionResults: Array<{ url: string; content: string; images?: string[] }> = [];
          const failedResults: Array<{ url: string; error: string }> = [];

          for (const url of urls) {
            try {
              // Use chat completion to extract content from URL
              const extractionPrompt = `Extract and summarize the main content from this URL: ${url}. 
Provide a clear, comprehensive summary of the key information, main points, and important details. 
If the content includes images, describe them briefly. 
Format your response as plain text, focusing on factual information.`;

              const chatResponse = await adapter.chatCompletion({
                model: selectedModel.id,
                messages: [
                  {
                    role: 'user',
                    content: extractionPrompt,
                  },
                ],
                temperature: 0.3,
                max_tokens: 2000,
              });

              // Extract content from chat response with proper type guards
              const messageContent = chatResponse.choices[0]?.message?.content;
              let content = '';
              
              if (typeof messageContent === 'string') {
                content = messageContent;
              } else if (Array.isArray(messageContent)) {
                // Handle array content (MessageContent[])
                content = messageContent
                  .map((item) => {
                    if (typeof item === 'string') {
                      return item;
                    }
                    if (item && typeof item === 'object' && 'type' in item) {
                      // Type guard for TextContent
                      if (item.type === 'text' && 'text' in item && typeof item.text === 'string') {
                        return item.text;
                      }
                      // Type guard for ImageContent (skip images in extraction)
                      if (item.type === 'image_url') {
                        return ''; // Images are not extracted as text
                      }
                    }
                    return '';
                  })
                  .filter((text) => text.length > 0)
                  .join(' ');
              }

              extractionResults.push({
                url,
                content: content || '',
                images: includeImages ? [] : undefined, // Model extraction doesn't return images directly
              });
            } catch (urlError: unknown) {
              const errorMessage = urlError instanceof Error ? urlError.message : String(urlError);
              log.warn({ requestId, url, error: errorMessage }, 'Failed to extract content from URL using model');
              failedResults.push({
                url,
                error: errorMessage,
              });
            }
          }

          // If we got at least one successful extraction, return results
          if (extractionResults.length > 0) {
            const durationMs = Date.now() - startTime;
            return {
              results: extractionResults,
              failedResults,
              responseTime: durationMs,
              providerUsed: selectedModel.provider,
              durationMs,
            };
          } else {
            // All extractions failed, fall back to Tavily
            throw new Error('All model-based extractions failed');
          }
        } catch (modelError: unknown) {
          const errorMessage = modelError instanceof Error ? modelError.message : String(modelError);
          log.warn({ requestId, error: errorMessage }, 'Model extraction failed, falling back to Tavily');
          tavilyResult = await this.tavilyService.extract({
            urls,
            includeImages,
          });
        }
      } else {
        // Use Tavily for larger batches or when no models available
        tavilyResult = await this.tavilyService.extract({
          urls,
          includeImages,
        });
      }

      const durationMs = Date.now() - startTime;

      if (!tavilyResult.success) {
        throw new Error('Content extraction failed');
      }

      return {
        results: tavilyResult.results.map(r => ({
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
      log.error({ requestId, error: errorMessage, durationMs }, 'Content extraction orchestration failed');
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
      const models = await this.modelRepo.searchModels({ providers: [], capabilities: [] });
      const model = models.find(m => m.name === explicitModel);
      
      if (model && this.hasWebSearchCapability(model)) {
        const resolution = providerRegistry.resolveAdapterForModel(model);
        if (resolution.adapter) {
          return { type: 'model', model };
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
      log.warn({ explicitModel }, 'Explicit model does not support web_search, falling back to Tavily');
    }

    // Auto-select: prefer Tavily for deep search, models for basic search
    if (searchDepth === 'advanced') {
      // Tavily is better for deep research
      return { type: 'tavily' };
    }

    // Check if we have models with web_search capability
    const webSearchModels = await this.modelRepo.searchModels({
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
    return model.capabilities.includes('web_search' as ModelCapability) ||
           model.capabilities.includes('deep_research' as ModelCapability);
  }
}

