// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cohere Model Fetcher
 *
 * 100% Dynamic Model Discovery - No hardcoded models
 * Uses Cohere API /v1/models endpoint for real-time model discovery
 * Reference: https://docs.cohere.com/reference/list-models
 */

import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

/**
 * Cohere Model Fetcher
 * 100% Dynamic - Fetches models from Cohere API /v1/models endpoint
 */
export class CohereModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'cohere';
  private log = logger.child({ component: 'cohere-fetcher' });
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string = 'https://api.cohere.com') {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    if (!this.apiKey) {
      this.log.warn('Cohere API key not provided - returning empty model list');
    }
  }

  async getModels(): Promise<ProviderModel[]> {
    // Validate API key is not mock
    if (!this.apiKey || this.apiKey.includes('mock') || this.apiKey.includes('test-')) {
      this.log.warn(
        { keyPresent: Boolean(this.apiKey) },
        'Cohere API key appears to be mock/test key - skipping model discovery'
      );
      return [];
    }

    // Sanitize API key - remove invalid characters that can't be in HTTP headers
    const sanitizedApiKey = this.apiKey.trim().replace(/[\r\n\t]/g, '');
    if (sanitizedApiKey !== this.apiKey) {
      this.log.warn('API key contained invalid characters and was sanitized');
    }

    // Validate baseUrl
    if (!this.baseUrl || !this.baseUrl.startsWith('http')) {
      this.log.error({ baseUrl: this.baseUrl }, 'Invalid baseUrl for Cohere API');
      return [];
    }

    try {
      // 100% Dynamic Discovery - Fetch from Cohere API /v1/models
      // Reference: https://docs.cohere.com/reference/list-models
      const { default: fetch } = await import('node-fetch');
      const allModels: ProviderModel[] = [];
      let pageToken: string | null = null;
      let hasMore = true;

      while (hasMore) {
        let url: URL;
        try {
          url = new URL(`${this.baseUrl}/v1/models`);
          if (pageToken) {
            url.searchParams.set('page_token', pageToken);
          }
          url.searchParams.set('page_size', '100'); // Max page size
        } catch (urlError) {
          this.log.error(
            { baseUrl: this.baseUrl, error: urlError instanceof Error ? urlError.message : String(urlError) },
            'Failed to construct Cohere API URL - invalid baseUrl or character encoding issue'
          );
          return [];
        }

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${sanitizedApiKey}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          this.log.error(
            {
              status: response.status,
              statusText: response.statusText,
              error: errorText.substring(0, 500),
            },
            'Failed to fetch models from Cohere API'
          );
          return [];
        }

        const data = (await response.json()) as {
          models?: Array<{
            name: string;
            is_deprecated?: boolean;
            endpoints?: string[];
            finetuned?: boolean;
            context_length?: number;
            default_endpoints?: string[];
            features?: string[];
          }>;
          next_page_token?: string | null;
        };

        if (!data.models || !Array.isArray(data.models)) {
          this.log.warn('Cohere API returned invalid response format');
          break;
        }

        // Convert Cohere models to ProviderModel format
        for (const cohereModel of data.models) {
          // Skip deprecated models
          if (cohereModel.is_deprecated) {
            continue;
          }

        try {
            const model = this.convertCohereModel(cohereModel);
            if (model) {
              allModels.push(model);
            }
        } catch (error) {
            this.log.warn({ model: cohereModel.name, error }, 'Failed to convert Cohere model');
          }
        }

        // Check for next page
        pageToken = data.next_page_token || null;
        hasMore = Boolean(pageToken);
      }

      this.log.info({ count: allModels.length }, 'Successfully fetched models from Cohere API');
      return allModels;
    } catch (error) {
      const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Handle ERR_INVALID_CHAR specifically
      if (errorCode === 'ERR_INVALID_CHAR') {
        this.log.error(
          {
            baseUrl: this.baseUrl,
            keyPresent: Boolean(this.apiKey),
            error: errorMessage,
          },
          'Failed to fetch models from Cohere API - invalid character in URL or headers (ERR_INVALID_CHAR). Check baseUrl and API key encoding.'
        );
      } else {
        this.log.error(
          {
            error: errorMessage,
            errorCode,
            baseUrl: this.baseUrl,
          },
          'Failed to fetch models from Cohere API'
        );
      }
      // 100% Dynamic Discovery: Return empty array on failure
      // No hardcoded fallback - models must come from API
      return [];
    }
  }

  /**
   * Convert Cohere API model to ProviderModel format
   */
  private convertCohereModel(cohereModel: {
    name: string;
    endpoints?: string[];
    context_length?: number;
    features?: string[];
    default_endpoints?: string[];
  }): ProviderModel | null {
    try {
      const modelId = cohereModel.name;
      const capabilities = this.extractCapabilitiesFromCohere(modelId, cohereModel);
      const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(
        modelId,
        cohereModel.context_length
      );

    const metadata = {
      endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
      tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
      family: this.extractFamily(modelId),
      tier: this.extractTier(modelId),
      source: 'cohere-api',
        endpoints: cohereModel.endpoints || [],
        defaultEndpoints: cohereModel.default_endpoints || [],
        features: cohereModel.features || [],
    };

    return {
      id: modelId,
      name: modelId,
      displayName: this.formatDisplayName(modelId),
      contextWindow,
      maxOutputTokens,
      capabilities,
      pricing,
      metadata,
    };
    } catch (error) {
      this.log.warn({ model: cohereModel.name, error }, 'Failed to convert Cohere model');
      return null;
    }
  }

  private extractCapabilitiesFromCohere(
    modelId: string,
    cohereModel?: { endpoints?: string[]; features?: string[] }
  ): ModelCapability[] {
    const capabilities: ModelCapability[] = [];
    const modelIdLower = modelId.toLowerCase();

    // Use API data if available (highest priority — provider-declared
    // capabilities outrank any name-pattern inference).
    if (cohereModel?.endpoints) {
      if (cohereModel.endpoints.includes('chat')) {
        capabilities.push('chat', 'streaming');
      }
      if (cohereModel.endpoints.includes('embed')) {
        capabilities.push('embeddings');
        return capabilities; // Embeddings-only model — return early.
      }
      // Cohere's `rerank` endpoint is a first-class surface
      // (https://docs.cohere.com/reference/rerank). Emit explicit
      // `reranking` + `retrieval` tags so capability-search routes
      // rerank queries here. Added 2026-04-28 (root-cause fix —
      // previously silently dropped with a "not a ModelCapability"
      // comment, which left rerank-2/2.5/cohere-rerank-* invisible
      // to downstream routers).
      if (cohereModel.endpoints.includes('rerank')) {
        capabilities.push('reranking', 'retrieval');
        return capabilities; // Rerank-only model — no chat/embed surface.
      }
    }

    // Infer from model ID (fallback)
    // Command models are chat models
    if (modelIdLower.includes('command')) {
      capabilities.push('chat', 'streaming', 'function_calling', 'json_mode', 'reasoning');
    }

    // Base models are generation models
    if (modelIdLower.includes('base')) {
      capabilities.push('text_generation', 'streaming');
    }

    // Embed models are for embeddings
    if (modelIdLower.includes('embed')) {
      capabilities.push('embeddings');
      return capabilities; // Embeddings only
    }

    // Command-R models have enhanced capabilities
    if (modelIdLower.includes('command-r')) {
      capabilities.push('web_search', 'thinking_mode');
    }

    // Use features from API if available
    if (cohereModel?.features) {
      if (cohereModel.features.includes('function-calling')) {
        capabilities.push('function_calling');
      }
      if (cohereModel.features.includes('json-mode')) {
        capabilities.push('json_mode');
      }
    }

    return Array.from(new Set(capabilities));
  }

  private extractFamily(modelId: string): string {
    if (modelId.includes('command-r-plus')) return 'Command R+';
    if (modelId.includes('command-r')) return 'Command R';
    if (modelId.includes('command-light')) return 'Command Light';
    if (modelId.includes('command')) return 'Command';
    if (modelId.includes('base-light')) return 'Base Light';
    if (modelId.includes('base')) return 'Base';
    if (modelId.includes('embed')) return 'Embed';
    return 'Cohere';
  }

  private extractTier(modelId: string): string {
    if (modelId.includes('command-r-plus')) return 'flagship';
    if (modelId.includes('command-r')) return 'premium';
    if (modelId.includes('command')) return 'standard';
    if (modelId.includes('light')) return 'fast';
    return 'standard';
  }

  private formatDisplayName(modelId: string): string {
    return modelId
      .split('-')
      .map((word) => {
        if (word === 'command') return 'Command';
        if (word === 'embed') return 'Embed';
        if (word === 'english') return 'English';
        if (word === 'multilingual') return 'Multilingual';
        if (word === 'light') return 'Light';
        if (word === 'plus') return '+';
        if (word === 'r') return 'R';
        if (word === 'v3') return 'V3';
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ');
  }

  private estimateModelSpecs(
    modelId: string,
    apiContextLength?: number
  ): {
    contextWindow: number;
    maxOutputTokens: number;
    pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
  } {
    // Use API context_length if available (highest priority)
    if (apiContextLength) {
      return {
        contextWindow: apiContextLength,
        maxOutputTokens: Math.min(apiContextLength / 4, 4096),
        pricing: this.estimatePricing(modelId),
      };
    }
    const modelIdLower = modelId.toLowerCase();

    // Command-R Plus (flagship)
    if (modelIdLower.includes('command-r-plus')) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 3.0, outputCostPer1M: 9.0, currency: 'USD' },
      };
    }

    // Command-R (premium)
    if (modelIdLower.includes('command-r') && !modelIdLower.includes('plus')) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.5, outputCostPer1M: 1.5, currency: 'USD' },
      };
    }

    // Command Light
    if (modelIdLower.includes('command-light')) {
      return {
        contextWindow: 8_192,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.15, outputCostPer1M: 0.6, currency: 'USD' },
      };
    }

    // Command (standard)
    if (modelIdLower.includes('command') && !modelIdLower.includes('light')) {
      return {
        contextWindow: 8_192,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.25, outputCostPer1M: 1.0, currency: 'USD' },
      };
    }

    // Base models
    if (modelIdLower.includes('base')) {
      return {
        contextWindow: 4_096,
        maxOutputTokens: 2_048,
        pricing: { inputCostPer1M: 0.5, outputCostPer1M: 1.0, currency: 'USD' },
      };
    }

    // Embed models
    if (modelIdLower.includes('embed')) {
      return {
        contextWindow: 512,
        maxOutputTokens: 1,
        pricing: { inputCostPer1M: 0.025, outputCostPer1M: 0, currency: 'USD' },
      };
    }

    // Default specs
    return {
      contextWindow: 8_192,
      maxOutputTokens: 4_096,
      pricing: { inputCostPer1M: 0.3, outputCostPer1M: 1.0, currency: 'USD' },
    };
  }

  private estimatePricing(modelId: string): {
    inputCostPer1M: number;
    outputCostPer1M: number;
    currency: string;
  } {
    const modelIdLower = modelId.toLowerCase();

    // Command-R Plus (flagship)
    if (modelIdLower.includes('command-r-plus')) {
      return { inputCostPer1M: 3.0, outputCostPer1M: 9.0, currency: 'USD' };
    }

    // Command-R (premium)
    if (modelIdLower.includes('command-r') && !modelIdLower.includes('plus')) {
      return { inputCostPer1M: 0.5, outputCostPer1M: 1.5, currency: 'USD' };
    }

    // Command Light
    if (modelIdLower.includes('command-light')) {
      return { inputCostPer1M: 0.15, outputCostPer1M: 0.6, currency: 'USD' };
    }

    // Command (standard)
    if (modelIdLower.includes('command') && !modelIdLower.includes('light')) {
      return { inputCostPer1M: 0.25, outputCostPer1M: 1.0, currency: 'USD' };
    }

    // Base models
    if (modelIdLower.includes('base')) {
      return { inputCostPer1M: 0.5, outputCostPer1M: 1.0, currency: 'USD' };
    }

    // Embed models
    if (modelIdLower.includes('embed')) {
      return { inputCostPer1M: 0.025, outputCostPer1M: 0, currency: 'USD' };
    }

    // Default pricing
    return { inputCostPer1M: 0.3, outputCostPer1M: 1.0, currency: 'USD' };
  }
}
