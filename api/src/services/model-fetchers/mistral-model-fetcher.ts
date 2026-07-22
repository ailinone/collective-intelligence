// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Mistral Model Fetcher
 *
 * Dynamically fetches models from Mistral API.
 */

import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

/**
 * Mistral Model Fetcher
 * Fetches models dynamically from Mistral API using REST API
 */
export class MistralModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'mistral';
  private log = logger.child({ component: 'mistral-fetcher' });
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string = 'https://api.mistral.ai/v1') {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    
    if (!this.apiKey) {
      this.log.warn('Mistral API key not provided - models will not be discovered');
    }
  }

  async getModels(): Promise<ProviderModel[]> {
    // Validate API key is not mock
    if (!this.apiKey || this.apiKey.includes('mock') || this.apiKey.includes('test-')) {
      this.log.warn(
        { keyPresent: Boolean(this.apiKey) },
        'Mistral API key appears to be mock/test key - skipping model discovery'
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
      this.log.error({ baseUrl: this.baseUrl }, 'Invalid baseUrl for Mistral API');
      return [];
    }

    try {
      // Mistral API REST endpoint for listing models
      const { default: fetch } = await import('node-fetch');
      
      // Construct URL safely
      let requestUrl: string;
      try {
        const url = new URL(`${this.baseUrl}/models`);
        requestUrl = url.toString();
      } catch (urlError) {
        this.log.error(
          { baseUrl: this.baseUrl, error: urlError instanceof Error ? urlError.message : String(urlError) },
          'Failed to construct Mistral API URL - invalid baseUrl or character encoding issue'
        );
        return [];
      }

      const response = await fetch(requestUrl, {
        headers: {
          'Authorization': `Bearer ${sanitizedApiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          this.log.error('Mistral API authentication failed - check API key');
        } else {
          this.log.error({ status: response.status, statusText: response.statusText }, 'Failed to fetch models from Mistral API');
        }
        return [];
      }

      const data = await response.json() as { data: Array<{ id: string; object: string; created: number; owned_by: string }> };
      
      if (!data.data || !Array.isArray(data.data)) {
        this.log.warn('Mistral API returned invalid response format');
        return [];
      }

      const models = data.data.map((model) => this.convertMistralModel(model));
      this.log.info({ count: models.length }, 'Successfully fetched models from Mistral API');
      return models;
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
          'Failed to fetch models from Mistral API - invalid character in URL or headers (ERR_INVALID_CHAR). Check baseUrl and API key encoding.'
        );
      } else {
        this.log.error(
          {
            error: errorMessage,
            errorCode,
            baseUrl: this.baseUrl,
          },
          'Failed to fetch models from Mistral API'
        );
      }
      // 100% Dynamic Discovery: Return empty array on failure
      // No hardcoded fallback - models must come from API
      return [];
    }
  }

  private convertMistralModel(mistralModel: { id: string; object?: string; created?: number; owned_by?: string }): ProviderModel {
    const capabilities = this.extractCapabilitiesFromMistral(mistralModel);
    const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(mistralModel.id);

    const metadata = {
      endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
      tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
      family: this.extractFamily(mistralModel.id),
      tier: this.extractTier(mistralModel.id),
      source: 'mistral-api',
    };

    return {
      id: mistralModel.id,
      name: mistralModel.id,
      displayName: this.formatDisplayName(mistralModel.id),
      contextWindow,
      maxOutputTokens,
      capabilities,
      pricing,
      metadata,
    };
  }

  private extractCapabilitiesFromMistral(model: { id: string; [key: string]: unknown }): ModelCapability[] {
    const capabilities: ModelCapability[] = ['chat', 'streaming'];

    const modelId = model.id.toLowerCase();

    // Function calling (available in most Mistral models)
    capabilities.push('function_calling');

    // JSON mode support
    capabilities.push('json_mode');

    // Large models have enhanced reasoning
    if (modelId.includes('large') || modelId.includes('codestral')) {
      capabilities.push('reasoning', 'code_interpreter');
    }

    // Codestral models are specialized for coding
    if (modelId.includes('codestral')) {
      capabilities.push('code_interpreter', 'text_generation');
    }

    return Array.from(new Set(capabilities));
  }

  private extractFamily(modelId: string): string {
    if (modelId.includes('mistral-large')) return 'Mistral Large';
    if (modelId.includes('mistral-medium')) return 'Mistral Medium';
    if (modelId.includes('mistral-small')) return 'Mistral Small';
    if (modelId.includes('codestral')) return 'Codestral';
    if (modelId.includes('pixtral')) return 'Pixtral';
    return 'Mistral';
  }

  private extractTier(modelId: string): string {
    if (modelId.includes('large')) return 'flagship';
    if (modelId.includes('medium')) return 'premium';
    if (modelId.includes('small')) return 'fast';
    return 'standard';
  }

  private formatDisplayName(modelId: string): string {
    return modelId
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private estimateModelSpecs(modelId: string): {
    contextWindow: number;
    maxOutputTokens: number;
    pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
  } {
    const modelIdLower = modelId.toLowerCase();

    if (modelIdLower.includes('mistral-large')) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        pricing: { inputCostPer1M: 2.0, outputCostPer1M: 6.0, currency: 'USD' },
      };
    }

    if (modelIdLower.includes('mistral-medium')) {
      return {
        contextWindow: 32_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 1.0, outputCostPer1M: 3.0, currency: 'USD' },
      };
    }

    if (modelIdLower.includes('mistral-small')) {
      return {
        contextWindow: 32_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.2, outputCostPer1M: 0.6, currency: 'USD' },
      };
    }

    if (modelIdLower.includes('codestral')) {
      return {
        contextWindow: 32_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.2, outputCostPer1M: 0.6, currency: 'USD' },
      };
    }

    if (modelIdLower.includes('pixtral')) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.2, outputCostPer1M: 0.6, currency: 'USD' },
      };
    }

    // Default specs
    return {
      contextWindow: 32_000,
      maxOutputTokens: 4_096,
      pricing: { inputCostPer1M: 0.3, outputCostPer1M: 0.9, currency: 'USD' },
    };
  }
}
