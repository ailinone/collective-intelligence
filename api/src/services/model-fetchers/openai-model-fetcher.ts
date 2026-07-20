// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OpenAI Model Fetcher
 *
 * Dynamically fetches models from OpenAI API.
 * Note: OpenAI API doesn't have a public endpoint to list all models,
 * so we'll use the models.list() endpoint which returns available models.
 */

import OpenAI from 'openai';
import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

/**
 * OpenAI Model Fetcher
 * Fetches models dynamically from OpenAI API
 */
export class OpenAIModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'openai';
  private client: OpenAI;
  private log = logger.child({ component: 'openai-fetcher' });

  constructor(apiKey: string, baseUrl?: string, organization?: string) {
    super();
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      organization,
      timeout: 30000,
    });
  }

  async getModels(): Promise<ProviderModel[]> {
    // Validate API key is not mock - check the client's apiKey
    const apiKey = (this.client as { apiKey?: string }).apiKey;
    if (!apiKey || apiKey.includes('mock') || apiKey.includes('test-')) {
      this.log.warn(
        { apiKeyPrefix: apiKey?.substring(0, 10) },
        'OpenAI API key appears to be mock/test key - skipping model discovery'
      );
      return [];
    }

    try {
      // OpenAI API endpoint to list models
      const response = await this.client.models.list();

      // Distinguish empty response from fetch error: the try/catch below swallows
      // thrown errors, so a 200 OK with zero data (key valid but lacks read
      // scope, or org has no models assigned) would be indistinguishable from
      // a silent failure without this warn.
      if (!response.data || response.data.length === 0) {
        this.log.warn(
          { apiKeyPrefix: apiKey?.substring(0, 10) },
          'OpenAI models.list() returned empty data array — key valid but no models readable'
        );
        return [];
      }

      return response.data.map((model) => this.convertOpenAIModel(model));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        {
          error: errorMessage,
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        },
        'Failed to fetch models from OpenAI API'
      );
      // Return empty array - fallback will be used
      return [];
    }
  }

  private convertOpenAIModel(openAIModel: OpenAI.Models.Model): ProviderModel {
    // Extract capabilities from model ID and metadata
    const capabilities = this.extractCapabilitiesFromOpenAI(openAIModel);

    // Determine endpoint based on capabilities
    // Derive uses_max_completion_tokens from capabilities
    // Models with reasoning/thinking_mode require max_completion_tokens instead of max_tokens
    const usesMaxCompletionTokens = capabilities.some(
      (c: string) => c === 'reasoning' || c === 'thinking_mode' || c === 'deep_research'
    );

    const metadata: Record<string, unknown> = {
      endpoint: this.determineEndpoint({
        capabilities,
        metadata: {},
      } as ProviderModel),
      tools: this.extractTools({
        capabilities,
        metadata: {},
      } as ProviderModel),
      // OpenAI doesn't provide detailed metadata in models.list()
      // We'll infer from model ID patterns
      family: this.extractFamily(openAIModel.id),
      tier: this.extractTier(openAIModel.id),
      // Signal to adapters which max tokens parameter to use
      ...(usesMaxCompletionTokens ? { uses_max_completion_tokens: true } : {}),
    };

    // Note: OpenAI models.list() doesn't provide pricing or context window
    // These will need to be fetched from a pricing API or use defaults
    // For now, we'll use reasonable defaults based on model family
    const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(openAIModel.id);

    return {
      id: openAIModel.id,
      name: openAIModel.id,
      displayName: openAIModel.id,
      contextWindow,
      maxOutputTokens,
      capabilities,
      pricing,
      metadata,
    };
  }

  /**
   * Extract capabilities from OpenAI model using dynamic inference based on generic keywords
   * NO HARDCODED MODEL NAMES - Uses capability keywords that work for any model
   */
  private extractCapabilitiesFromOpenAI(model: OpenAI.Models.Model): ModelCapability[] {
    const capabilities: ModelCapability[] = [];
    const modelId = model.id.toLowerCase();
    const isEmbeddingModel = modelId.includes('embedding');
    const isImageModel = modelId.includes('image') || modelId.includes('dall');
    const isAudioModel =
      modelId.includes('tts') ||
      modelId.includes('speech') ||
      modelId.includes('whisper') ||
      modelId.includes('transcribe') ||
      modelId.includes('audio');
    const isOpenAIReasoningFamily = /^o\d/.test(modelId);
    const isLegacyCompletionModel =
      ['babbage', 'davinci', 'curie', 'ada', 'instruct'].some((hint) =>
        modelId.includes(hint)
      ) || /-(001|002)$/.test(modelId);
    const likelyChatModel =
      modelId.includes('gpt') || modelId.includes('chatgpt') || isOpenAIReasoningFamily;

    // Use generic capability keywords, not model-specific names
    // This approach works for any model, existing or new

    // Vision/multimodal capabilities - check for vision-related keywords
    if (modelId.includes('vision') || modelId.includes('multimodal') || modelId.includes('4o')) {
      capabilities.push('vision', 'multimodal');
    }

    // Chat capabilities - conservative inference to avoid exposing completions-only models as chat.
    const exclusiveNonChatKeywords = ['tts', 'whisper', 'embedding', 'image'];
    const isExclusiveNonChat =
      exclusiveNonChatKeywords.some((keyword) => modelId.includes(keyword)) ||
      isEmbeddingModel ||
      isImageModel ||
      isLegacyCompletionModel;
    if (likelyChatModel && !isExclusiveNonChat) {
      capabilities.push('chat');
      // Streaming support should be tied to chat-capable models.
      capabilities.push('streaming');
    }

    // Function calling - inferred from generic patterns, not specific model names
    // Modern models typically support function calling
    const supportsModernChatFeatures = likelyChatModel && !isExclusiveNonChat;
    if (supportsModernChatFeatures) {
      capabilities.push('function_calling');
    }

    // JSON mode - available in modern chat models
    if (supportsModernChatFeatures) {
      capabilities.push('json_mode');
    }

    // Reasoning/thinking - check for reasoning-related keywords (generic)
    if (modelId.includes('reasoning') || modelId.includes('thinking') || 
        modelId.includes('deep-research') || isOpenAIReasoningFamily) {
      // Match 'o' followed by number at start (o1, o2, o3, o4, etc.) - generic pattern
      capabilities.push('reasoning', 'thinking_mode');
    }

    // Audio capabilities - use generic audio keywords
    if (isAudioModel) {
      capabilities.push('audio', 'text_to_speech', 'speech_to_text');
    }

    // Realtime capabilities - use generic keyword
    if (modelId.includes('realtime')) {
      capabilities.push('realtime', 'realtime_audio');
    }

    // Image generation - use generic image keywords
    if (isImageModel) {
      capabilities.push('image_generation');
    }

    // Embeddings - use generic keyword
    if (isEmbeddingModel) {
      capabilities.push('embedding', 'embeddings');
    }

    if (isLegacyCompletionModel) {
      capabilities.push('completions', 'text_generation');
    }

    // Code-related capabilities - check for code keywords
    if (modelId.includes('code') || modelId.includes('codex')) {
      capabilities.push('code_generation', 'code_completion');
    }

    return Array.from(new Set(capabilities));
  }

  /**
   * Extract model family using generic patterns, not hardcoded model names
   */
  private extractFamily(modelId: string): string {
    const normalized = modelId.toLowerCase();
    
    // Use generic patterns that work for any model family
    // Extract prefix pattern (e.g., "gpt", "o", "dall", "whisper", "tts")
    const match = normalized.match(/^([a-z]+(?:-\d+)?(?:\.\d+)?)/);
    if (match && match[1]) {
      const prefix = match[1];
      // Format prefix to title case for display
      return prefix
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }
    
    // Fallback: try to extract first meaningful segment
    const segments = normalized.split('-');
    if (segments.length > 0 && segments[0]) {
      return segments[0].charAt(0).toUpperCase() + segments[0].slice(1);
    }
    
    return 'Unknown';
  }

  private extractTier(modelId: string): string {
    if (modelId.includes('pro') || modelId.includes('turbo')) return 'premium';
    if (modelId.includes('mini') || modelId.includes('nano')) return 'fast';
    return 'flagship';
  }

  /**
   * Estimate model specifications using generic tier/keyword inference, not hardcoded model names
   * Uses conservative defaults that work for any model
   */
  private estimateModelSpecs(modelId: string): {
    contextWindow: number;
    maxOutputTokens: number;
    pricing: ProviderModel['pricing'];
  } {
    const id = modelId.toLowerCase();

    // Use generic tier/keyword patterns instead of specific model names
    // This works for any model, existing or new

    // Premium/pro models - typically have larger context windows
    const isPremium = id.includes('pro') || id.includes('turbo') || id.includes('max');
    
    // Fast/lightweight models - typically smaller context windows
    const isFast = id.includes('mini') || id.includes('nano') || id.includes('lite') || id.includes('flash');
    
    // Reasoning models - detected via generic patterns
    const isReasoning = id.includes('reasoning') || id.includes('thinking') || 
                       id.includes('deep-research') || id.match(/^o\d/);
    
    // Audio/image models - typically have different specs
    const isAudio = id.includes('tts') || id.includes('whisper') || id.includes('audio');
    const isImage = id.includes('image') || id.includes('dall');
    const isEmbedding = id.includes('embedding');

    // Estimate based on generic patterns
    if (isPremium && !isFast) {
      // Premium models - larger context, higher cost
      return {
        contextWindow: 200000,
        maxOutputTokens: 16384,
        pricing: { inputCostPer1M: 15.0, outputCostPer1M: 60.0, currency: 'USD' },
      };
    }
    
    if (isReasoning) {
      // Reasoning models - large context, medium cost
      return {
        contextWindow: 200000,
        maxOutputTokens: 16384,
        pricing: { inputCostPer1M: 15.0, outputCostPer1M: 60.0, currency: 'USD' },
      };
    }
    
    if (isFast) {
      // Fast models - smaller context, lower cost
      return {
        contextWindow: 16384,
        maxOutputTokens: 4096,
        pricing: { inputCostPer1M: 0.5, outputCostPer1M: 1.5, currency: 'USD' },
      };
    }
    
    if (isAudio || isImage || isEmbedding) {
      // Specialized models - conservative defaults
      return {
        contextWindow: 8192,
        maxOutputTokens: 2048,
        pricing: { inputCostPer1M: 1.0, outputCostPer1M: 2.0, currency: 'USD' },
      };
    }

    // Default for standard models - conservative estimates that work for any model
    return {
      contextWindow: 128000,
      maxOutputTokens: 16384,
      pricing: { inputCostPer1M: 5.0, outputCostPer1M: 15.0, currency: 'USD' },
    };
  }
}
