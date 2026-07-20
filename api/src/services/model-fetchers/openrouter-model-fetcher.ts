// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OpenRouter Model Fetcher
 *
 * Dynamically fetches models from OpenRouter API.
 * This is already working well - we're just wrapping it in the fetcher interface.
 */

import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
  };
  top_provider?: {
    max_completion_tokens?: number;
  };
  supported_parameters?: string[];
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
    web_search?: string;
    internal_reasoning?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

/**
 * OpenRouter Model Fetcher
 * Fetches models dynamically from OpenRouter API
 */
export class OpenRouterModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'openrouter';
  private apiKey: string;
  private baseUrl: string;
  private log = logger.child({ component: 'openrouter-fetcher' });

  constructor(apiKey: string, baseUrl: string = 'https://openrouter.ai/api/v1') {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async getModels(): Promise<ProviderModel[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as OpenRouterModelsResponse;

      return data.data.map((model) => this.convertOpenRouterModel(model));
    } catch (error) {
      this.log.error({ error }, 'Failed to fetch models from OpenRouter API');
      // Return empty array - fallback will be used
      return [];
    }
  }

  private convertOpenRouterModel(orModel: OpenRouterModel): ProviderModel {
    const capabilities = this.extractCapabilitiesFromOpenRouter(orModel);
    const pricing = this.extractPricingFromOpenRouter(orModel);
    const supportedParams = orModel.supported_parameters || [];
    // Derive uses_max_completion_tokens from supported_parameters or capabilities
    const usesMaxCompletionTokens =
      supportedParams.includes('max_completion_tokens') ||
      capabilities.some((c: string) => c === 'reasoning' || c === 'thinking_mode' || c === 'deep_research');

    const metadata: Record<string, unknown> = {
      architecture: orModel.architecture,
      supported_parameters: supportedParams,
      description: orModel.description,
      originalProvider: this.extractProviderFromId(orModel.id),
      endpoint: this.determineEndpoint({
        capabilities,
        metadata: { architecture: orModel.architecture },
      } as ProviderModel),
      tools: this.extractTools({
        capabilities,
        metadata: { architecture: orModel.architecture },
      } as ProviderModel),
      // Signal to adapters which max tokens parameter to use
      ...(usesMaxCompletionTokens ? { uses_max_completion_tokens: true } : {}),
    };

    return {
      id: orModel.id,
      name: orModel.id,
      displayName: orModel.name,
      contextWindow: orModel.context_length,
      maxOutputTokens: orModel.top_provider?.max_completion_tokens || 4096,
      capabilities,
      pricing,
      metadata,
    };
  }

  private extractCapabilitiesFromOpenRouter(model: OpenRouterModel): ModelCapability[] {
    return this.extractCapabilities(
      {
        architecture: model.architecture,
        supported_parameters: model.supported_parameters || [],
        description: model.description,
      },
      model.id
    );
  }

  private extractProviderFromId(modelId: string): string | undefined {
    const index = modelId.indexOf('/');
    if (index <= 0) return undefined;
    return modelId.slice(0, index).toLowerCase();
  }

  private extractPricingFromOpenRouter(model: OpenRouterModel): ProviderModel['pricing'] {
    return {
      inputCostPer1M: parseFloat(model.pricing.prompt) * 1000000,
      outputCostPer1M: parseFloat(model.pricing.completion) * 1000000,
      currency: 'USD',
    };
  }
}
