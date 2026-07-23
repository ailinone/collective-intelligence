// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * xAI Model Fetcher
 *
 * Dynamically fetches models from xAI API.
 */

import OpenAI from 'openai';
import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

/**
 * xAI Model Fetcher
 * Fetches models dynamically from xAI API (uses OpenAI-compatible API)
 */
export class XAIModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'xai';
  private client: OpenAI;
  private log = logger.child({ component: 'xai-fetcher' });

  constructor(apiKey: string, baseUrl: string = 'https://api.x.ai/v1') {
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
        { keyPresent: Boolean(apiKey) },
        'xAI API key appears to be mock/test key - skipping model discovery'
      );
      return [];
    }

    try {
      // xAI uses OpenAI-compatible API
      const response = await this.client.models.list();

      // Distinguish empty response from fetch error (see openai-model-fetcher for
      // rationale). Surfacing zero-data-with-200-OK as a warn is essential for
      // diagnosing cases where credits exist but no models populate in DB.
      if (!response.data || response.data.length === 0) {
        this.log.warn(
          'xAI models.list() returned empty data array — key valid but no models readable'
        );
        return [];
      }

      return response.data.map((model) => this.convertXAIModel(model));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        {
          error: errorMessage,
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        },
        'Failed to fetch models from xAI API'
      );
      // 100% Dynamic Discovery: Return empty array on failure
      // No hardcoded fallback - models must come from API
      return [];
    }
  }

  private convertXAIModel(openAIModel: OpenAI.Models.Model): ProviderModel {
    const capabilities = this.extractCapabilitiesFromXAI(openAIModel);
    const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(openAIModel.id);

    const metadata = {
      endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
      tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
      family: this.extractFamily(openAIModel.id),
      tier: this.extractTier(openAIModel.id),
      source: 'xai-api',
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

  private extractCapabilitiesFromXAI(model: OpenAI.Models.Model): ModelCapability[] {
    const modelId = model.id.toLowerCase();

    // xAI's /v1/models now lists non-chat model classes alongside Grok chat
    // models with no modality field to tell them apart: "Grok Imagine"
    // image/video generation (grok-imagine-image, grok-imagine-video*) and
    // agentic computer-use/build models (grok-build-*, *-computer-use-*).
    // Tagging every listed model 'chat' unconditionally (as before) let
    // these into chat-only candidate pools (e.g. CostCascadeStrategy),
    // where their non-per-token real cost also produced bogus near-zero
    // cost_usd once run through token-based pricing estimates.
    const isImageModel = modelId.includes('imagine') && modelId.includes('image');
    const isVideoModel = modelId.includes('imagine') && modelId.includes('video');
    const isComputerUseModel = modelId.includes('computer-use');
    const isBuildAgentModel = modelId.includes('grok-build');
    const isNonChatModel = isImageModel || isVideoModel || isComputerUseModel || isBuildAgentModel;

    const capabilities: ModelCapability[] = [];
    if (isImageModel) capabilities.push('image_generation');
    if (isVideoModel) capabilities.push('video_generation');
    if (isComputerUseModel) capabilities.push('computer_use');

    if (!isNonChatModel) {
      capabilities.push('chat', 'streaming');

      // All Grok chat models support function calling
      capabilities.push('function_calling');

      // JSON mode support
      capabilities.push('json_mode');

      // Grok models have enhanced reasoning
      if (modelId.includes('grok')) {
        capabilities.push('reasoning', 'thinking_mode');
      }

      // Vision capabilities (Grok-2 and later)
      if (modelId.includes('grok-2') || modelId.includes('grok-vision')) {
        capabilities.push('vision', 'multimodal');
      }
    }

    return Array.from(new Set(capabilities));
  }

  private extractFamily(modelId: string): string {
    if (modelId.includes('grok-2')) return 'Grok 2';
    if (modelId.includes('grok-1')) return 'Grok 1';
    if (modelId.includes('grok-vision')) return 'Grok Vision';
    return 'Grok';
  }

  private extractTier(modelId: string): string {
    if (modelId.includes('max') || modelId.includes('pro')) return 'premium';
    if (modelId.includes('mini') || modelId.includes('fast')) return 'fast';
    return 'flagship';
  }

  private formatDisplayName(modelId: string): string {
    return modelId
      .split('-')
      .map((word) => {
        if (word === 'grok') return 'Grok';
        if (word === 'vision') return 'Vision';
        if (word === 'max') return 'Max';
        if (word === 'mini') return 'Mini';
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

    // Grok-2 models
    if (modelIdLower.includes('grok-2')) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        pricing: { inputCostPer1M: 0.003, outputCostPer1M: 0.012, currency: 'USD' },
      };
    }

    // Grok-1 models
    if (modelIdLower.includes('grok-1')) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        pricing: { inputCostPer1M: 0.005, outputCostPer1M: 0.015, currency: 'USD' },
      };
    }

    // Vision models
    if (modelIdLower.includes('vision')) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.008, outputCostPer1M: 0.024, currency: 'USD' },
      };
    }

    // Default Grok specs
    return {
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      pricing: { inputCostPer1M: 0.003, outputCostPer1M: 0.009, currency: 'USD' },
    };
  }
}
