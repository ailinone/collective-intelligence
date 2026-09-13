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
  private client: OpenAI | null;
  private apiKey: string;
  private log = logger.child({ component: 'deepseek-fetcher' });

  constructor(apiKey: string, baseUrl: string = 'https://api.deepseek.com/v1') {
    super();
    this.apiKey = apiKey;
    // Guard against constructing the raw `openai` SDK client (reused here as
    // a thin OpenAI-COMPATIBLE HTTP client — DeepSeek's own API is OpenAI-
    // shaped, this fetcher does not talk to OpenAI) with an empty/mock key.
    // The SDK's own constructor throws a synchronous, OpenAI-branded
    // "Missing credentials... OPENAI_API_KEY or OPENAI_ADMIN_KEY..." error
    // when apiKey is falsy, which bypassed getModels()'s own graceful
    // missing-key handling below entirely and was genuinely confusing in
    // production (2026-09-08 incident: a DeepSeek discovery failure logged
    // an OpenAI-branded credential error). Constructing lazily means a
    // missing/mock key surfaces through this fetcher's own DeepSeek-branded
    // log line instead.
    this.client = DeepSeekModelFetcher.isUsableApiKey(apiKey)
      ? new OpenAI({
          apiKey,
          baseURL: baseUrl,
          timeout: 30000,
        })
      : null;
  }

  private static isUsableApiKey(key: string | undefined): key is string {
    return Boolean(key) && !key!.includes('mock') && !key!.includes('test-');
  }

  async getModels(): Promise<ProviderModel[]> {
    if (!this.client) {
      this.log.warn(
        { keyPresent: Boolean(this.apiKey) },
        'DeepSeek API key appears to be missing/mock/test key - skipping model discovery'
      );
      return [];
    }

    const client = this.client;

    try {
      // DeepSeek uses OpenAI-compatible API
      const response = await client.models.list();

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

    // Coder models are specialized for coding. NOTE: `code_generation` (this
    // model writes/understands code well), NOT `code_interpreter` (a REAL,
    // provider-declared server-side sandbox/execution tool — DeepSeek
    // declares no such parameter; see alibaba-model-fetcher.ts's identical
    // fix for the full incident writeup, 2026-09).
    if (modelId.includes('coder')) {
      capabilities.push('code_generation', 'text_generation');
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
