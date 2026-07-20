// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DeepSeek Model Fetcher
 *
 * Dynamically fetches models from DeepSeek API.
 */

import OpenAI from 'openai';
import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

/**
 * DeepSeek Model Fetcher
 * Fetches models dynamically from DeepSeek API (uses OpenAI-compatible API)
 */
export class DeepSeekModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'deepseek';
  private client: OpenAI;
  private log = logger.child({ component: 'deepseek-fetcher' });

  constructor(apiKey: string, baseUrl: string = 'https://api.deepseek.com/v1') {
    super();
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout: 30000,
    });
  }

  async getModels(): Promise<ProviderModel[]> {
    // Validate API key is not mock - check the client's apiKey
    const apiKey = (this.client as { apiKey?: string }).apiKey;
    if (!apiKey || apiKey.includes('mock') || apiKey.includes('test-')) {
      this.log.warn(
        { apiKeyPrefix: apiKey?.substring(0, 10) },
        'DeepSeek API key appears to be mock/test key - skipping model discovery'
      );
      return [];
    }

    try {
      // DeepSeek uses OpenAI-compatible API
      const response = await this.client.models.list();

      return response.data.map((model) => this.convertDeepSeekModel(model));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        {
          error: errorMessage,
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        },
        'Failed to fetch models from DeepSeek API'
      );
      // 100% Dynamic Discovery: Return empty array on failure
      // No hardcoded fallback - models must come from API
      return [];
    }
  }

  private convertDeepSeekModel(openAIModel: OpenAI.Models.Model): ProviderModel {
    const capabilities = this.extractCapabilitiesFromDeepSeek(openAIModel);
    const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(openAIModel.id);

    const metadata = {
      endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
      tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
      family: this.extractFamily(openAIModel.id),
      tier: this.extractTier(openAIModel.id),
      source: 'deepseek-api',
    };

    return {
      id: openAIModel.id,
      name: openAIModel.id,
      displayName: this.formatDisplayName(openAIModel.id),
      contextWindow,
      maxOutputTokens,
      capabilities,
      pricing,
      metadata,
    };
  }

  private extractCapabilitiesFromDeepSeek(model: OpenAI.Models.Model): ModelCapability[] {
    const capabilities: ModelCapability[] = ['chat', 'streaming'];
    const modelId = model.id.toLowerCase();

    // Function calling support
    capabilities.push('function_calling');

    // JSON mode support
    capabilities.push('json_mode');

    // DeepSeek models have strong reasoning capabilities
    capabilities.push('reasoning', 'thinking_mode');

    // Coder models are specialized for coding
    if (modelId.includes('coder')) {
      capabilities.push('code_interpreter', 'text_generation');
    }

    // V3 models support vision
    if (modelId.includes('deepseek-v3') || modelId.includes('deepseek-vl')) {
      capabilities.push('vision', 'multimodal');
    }

    return Array.from(new Set(capabilities));
  }

  private extractFamily(modelId: string): string {
    if (modelId.includes('deepseek-chat')) return 'DeepSeek Chat';
    if (modelId.includes('deepseek-coder')) return 'DeepSeek Coder';
    if (modelId.includes('deepseek-v3')) return 'DeepSeek V3';
    if (modelId.includes('deepseek-v2')) return 'DeepSeek V2';
    if (modelId.includes('deepseek-r1')) return 'DeepSeek R1';
    return 'DeepSeek';
  }

  private extractTier(modelId: string): string {
    if (modelId.includes('r1') || modelId.includes('v3')) return 'flagship';
    if (modelId.includes('v2')) return 'premium';
    if (modelId.includes('coder')) return 'fast';
    return 'standard';
  }

  private formatDisplayName(modelId: string): string {
    return modelId
      .split('-')
      .map((word) => {
        if (word === 'deepseek') return 'DeepSeek';
        if (word === 'chat') return 'Chat';
        if (word === 'coder') return 'Coder';
        if (word === 'r1') return 'R1';
        if (word === 'v3') return 'V3';
        if (word === 'v2') return 'V2';
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ');
  }

  private estimateModelSpecs(modelId: string): {
    contextWindow: number;
    maxOutputTokens: number;
    pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
  } {
    const modelIdLower = modelId.toLowerCase();

    // R1 models (latest and most capable)
    if (modelIdLower.includes('deepseek-r1')) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        pricing: { inputCostPer1M: 0.00014, outputCostPer1M: 0.00028, currency: 'USD' },
      };
    }

    // V3 models
    if (modelIdLower.includes('deepseek-v3')) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        pricing: { inputCostPer1M: 0.00014, outputCostPer1M: 0.00028, currency: 'USD' },
      };
    }

    // V2 models
    if (modelIdLower.includes('deepseek-v2')) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        pricing: { inputCostPer1M: 0.00014, outputCostPer1M: 0.00028, currency: 'USD' },
      };
    }

    // Chat models
    if (modelIdLower.includes('deepseek-chat')) {
      return {
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.00014, outputCostPer1M: 0.00028, currency: 'USD' },
      };
    }

    // Coder models
    if (modelIdLower.includes('deepseek-coder')) {
      return {
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.00014, outputCostPer1M: 0.00028, currency: 'USD' },
      };
    }

    // Default specs
    return {
      contextWindow: 32_000,
      maxOutputTokens: 4_096,
      pricing: { inputCostPer1M: 0.00014, outputCostPer1M: 0.00028, currency: 'USD' },
    };
  }
}
