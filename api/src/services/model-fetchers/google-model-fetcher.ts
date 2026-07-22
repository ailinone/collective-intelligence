// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Google/Gemini Model Fetcher
 *
 * Dynamically fetches models from Google AI API.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

/**
 * Google Model Fetcher
 * Fetches models dynamically from Google AI API
 */
export class GoogleModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'google';
  private client: GoogleGenerativeAI;
  private log = logger.child({ component: 'google-fetcher' });

  constructor(apiKey: string) {
    super();
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async getModels(): Promise<ProviderModel[]> {
    try {
      // Google AI Studio API endpoint for listing models
      // 100% Dynamic - No hardcoded models
      const { default: fetch } = await import('node-fetch');
      interface GoogleClient {
        apiKey?: string;
      }
      const apiKey = (this.client as GoogleClient).apiKey;
      
      // Validate API key is not mock
      if (!apiKey || apiKey.includes('mock') || apiKey.includes('test-')) {
        this.log.warn(
          { keyPresent: Boolean(apiKey) },
          'Google API key appears to be mock/test key - skipping model discovery'
        );
        return [];
      }

      // Google AI Studio uses generativelanguage.googleapis.com API
      let endpoint: string;
      try {
        const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
        url.searchParams.set('key', apiKey);
        endpoint = url.toString();
      } catch (urlError) {
        this.log.error(
          { error: urlError instanceof Error ? urlError.message : String(urlError) },
          'Failed to construct Google AI Studio API URL'
        );
        return [];
      }
      
      this.log.debug({ endpoint: 'https://generativelanguage.googleapis.com/v1beta/models' }, 'Fetching models from Google AI Studio API');

      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        const payload = {
          status: response.status,
          statusText: response.statusText,
          error: errorText.substring(0, 500),
        };
        const expectedStatus = new Set([400, 401, 403, 404, 429]);
        if (expectedStatus.has(response.status)) {
          this.log.warn(
            payload,
            'Google AI Studio model discovery unavailable (non-critical)'
          );
        } else {
          this.log.error(
            payload,
            'Failed to fetch models from Google AI Studio API'
          );
        }
        return [];
      }

      const data = await response.json() as {
        models?: Array<{
          name: string;
          displayName?: string;
          description?: string;
          supportedGenerationMethods?: string[];
        }>;
      };
      
      if (!data.models || !Array.isArray(data.models)) {
        this.log.warn('Google AI Studio API returned invalid response format');
        return [];
      }

      const models: ProviderModel[] = [];

      for (const modelData of data.models) {
        try {
          // Extract model ID from name (format: models/gemini-1.5-pro)
          const modelId = modelData.name?.replace('models/', '') || '';
          
          if (!modelId) {
            continue;
          }

          const capabilities = this.extractCapabilitiesFromGoogle(modelId, modelData);
          const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(modelId);

          const metadata = {
            endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
            tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
            family: this.extractFamily(modelId),
            tier: this.extractTier(modelId),
            source: 'google-ai-api',
            displayName: modelData?.displayName,
            description: modelData?.description,
            supportedGenerationMethods: modelData?.supportedGenerationMethods ?? [],
            supportsGenerateContent: this.supportsGenerateContent(
              modelData?.supportedGenerationMethods
            ),
          };

          const model: ProviderModel = {
            id: modelId,
            name: modelId,
            displayName: modelData?.displayName || this.formatDisplayName(modelId),
            contextWindow,
            maxOutputTokens,
            capabilities,
            pricing,
            metadata,
          };
          
          models.push(model);
        } catch (error) {
          this.log.warn({ modelData, error }, 'Failed to create model info');
          // Continue with next model
        }
      }

      this.log.info({ count: models.length }, 'Successfully fetched models from Google AI Studio API');
      return models;
    } catch (error) {
      this.log.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Google model discovery failed (non-critical)'
      );
      // 100% Dynamic Discovery: Return empty array on failure
      // No hardcoded fallback - models must come from API
      return [];
    }
  }

  private async createProviderModel(modelId: string, modelData?: { displayName?: string; description?: string; supportedGenerationMethods?: string[] }): Promise<ProviderModel> {
    // Use modelData if provided (from API), otherwise extract from model ID
    const capabilities = this.extractCapabilitiesFromGoogle(modelId, modelData);
    const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(modelId);

    const metadata = {
      endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
      tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
      family: this.extractFamily(modelId),
      tier: this.extractTier(modelId),
      source: 'google-ai-api',
      description: modelData?.description,
    };

    return {
      id: modelId,
      name: modelId,
      displayName: modelData?.displayName || this.formatDisplayName(modelId),
      contextWindow,
      maxOutputTokens,
      capabilities,
      pricing,
      metadata,
    };
  }

  private extractCapabilitiesFromGoogle(
    modelId: string,
    modelData?: { supportedGenerationMethods?: string[] }
  ): ModelCapability[] {
    const capabilities: ModelCapability[] = [];
    const normalizedModelId = modelId.toLowerCase();
    const isComputerUseModel = normalizedModelId.includes('computer-use');
    const isLikelyEmbeddingModel =
      normalizedModelId.includes('embedding') || normalizedModelId.includes('embed');
    const isLikelyAudioModel =
      normalizedModelId.includes('tts') ||
      normalizedModelId.includes('speech') ||
      normalizedModelId.includes('audio') ||
      normalizedModelId.includes('transcrib') ||
      normalizedModelId.includes('voice');
    const isLikelyImageModel =
      normalizedModelId.includes('imagen') || normalizedModelId.includes('image');
    const isLikelyVideoModel =
      normalizedModelId.includes('veo') || normalizedModelId.includes('video');
    const isLikelyNonChatModel =
      isLikelyEmbeddingModel || isLikelyAudioModel || isLikelyImageModel || isLikelyVideoModel;
    const methods = (modelData?.supportedGenerationMethods ?? []).map((method) =>
      method.toLowerCase()
    );
    const hasMethodMetadata = methods.length > 0;
    const supportsGenerateContent = this.supportsGenerateContent(modelData?.supportedGenerationMethods);
    const supportsEmbeddings =
      this.supportsEmbeddings(modelData?.supportedGenerationMethods) || isLikelyEmbeddingModel;

    // Use provider-declared methods as source of truth when available.
    if (supportsGenerateContent && !isLikelyNonChatModel) {
      capabilities.push('chat', 'text_generation', 'streaming');
    }

    if (supportsEmbeddings) {
      capabilities.push('embedding', 'embeddings');
    }

    if (isLikelyAudioModel) {
      capabilities.push('audio', 'text_to_speech', 'tts');
    }

    if (isLikelyImageModel) {
      capabilities.push('image_generation');
    }

    if (isLikelyVideoModel) {
      capabilities.push('video_generation');
    }

    // Fallback heuristic only when the provider does not return method metadata.
    if (!hasMethodMetadata && !isComputerUseModel && !isLikelyNonChatModel) {
      capabilities.push('chat', 'text_generation', 'streaming');
    }

    // Computer-use preview models are not guaranteed to support generateContent.
    if (isComputerUseModel) {
      capabilities.push('computer_use');
    }

    const canInferGenerativeCapabilities =
      supportsGenerateContent || (!hasMethodMetadata && !isLikelyNonChatModel);

    // Infer advanced generative capabilities only for models that can generate text.
    if (canInferGenerativeCapabilities) {
      if (
        modelId.includes('vision') ||
        modelId.includes('multimodal') ||
        modelId.includes('pro') ||
        modelId.match(/\d+\.\d+/)
      ) {
        capabilities.push('vision', 'multimodal');
      }

      if (
        modelId.includes('pro') ||
        modelId.includes('premium') ||
        modelId.match(/\d+\.\d+/) ||
        modelId.match(/^\d+\.\d+/)
      ) {
        capabilities.push('function_calling', 'json_mode');
      }
    }

    if (isComputerUseModel && supportsGenerateContent !== true) {
      return capabilities.filter(
        (capability) =>
          capability !== 'chat' &&
          capability !== 'text_generation' &&
          capability !== 'streaming'
      );
    }

    return Array.from(new Set(capabilities));
  }

  private supportsGenerateContent(supportedMethods?: string[]): boolean {
    if (!supportedMethods || supportedMethods.length === 0) {
      return false;
    }

    const methods = supportedMethods.map((method) => method.toLowerCase());
    return methods.includes('generatecontent') || methods.includes('streamgeneratecontent');
  }

  private supportsEmbeddings(supportedMethods?: string[]): boolean {
    if (!supportedMethods || supportedMethods.length === 0) {
      return false;
    }

    const methods = supportedMethods.map((method) => method.toLowerCase());
    return methods.some(
      (method) => method === 'embedcontent' || method === 'batchembedcontents'
    );
  }

  /**
   * Extract model family using generic pattern extraction, not hardcoded names
   */
  private extractFamily(modelId: string): string {
    const normalized = modelId.toLowerCase();
    
    // Extract base family name (first meaningful segment before version/qualifier)
    // This works for any model name pattern
    const match = normalized.match(/^([a-z]+(?:-\d+)?(?:\.\d+)?)/);
    if (match && match[1]) {
      const prefix = match[1];
      // Format to title case
      return prefix
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }
    
    // Fallback: extract first segment
    const segments = normalized.split('-');
    if (segments.length > 0 && segments[0]) {
      return segments[0].charAt(0).toUpperCase() + segments[0].slice(1);
    }
    
    return 'Unknown';
  }

  private extractTier(modelId: string): string {
    if (modelId.includes('pro')) return 'premium';
    if (modelId.includes('flash')) return 'fast';
    return 'standard';
  }

  private formatDisplayName(modelId: string): string {
    return modelId
      .split('-')
      .map((word) => {
        if (word === 'pro') return 'Pro';
        if (word === 'flash') return 'Flash';
        if (word === 'vision') return 'Vision';
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ');
  }

  private estimateModelSpecs(modelId: string): {
    contextWindow: number;
    maxOutputTokens: number;
    pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
  } {
    // Gemini 1.5 models have massive context
    if (modelId.includes('gemini-1.5')) {
      if (modelId.includes('pro')) {
        return {
          contextWindow: 1_000_000,
          maxOutputTokens: 8_192,
          pricing: { inputCostPer1M: 0.00125, outputCostPer1M: 0.005, currency: 'USD' },
        };
      }
      if (modelId.includes('flash')) {
        return {
          contextWindow: 1_000_000,
          maxOutputTokens: 8_192,
          pricing: { inputCostPer1M: 0.000075, outputCostPer1M: 0.0003, currency: 'USD' },
        };
      }
    }

    // Gemini Pro
    if (modelId.includes('gemini-pro')) {
      return {
        contextWindow: 32_768,
        maxOutputTokens: 2_048,
        pricing: { inputCostPer1M: 0.0005, outputCostPer1M: 0.0015, currency: 'USD' },
      };
    }

    // PaLM models
    if (modelId.includes('bison')) {
      return {
        contextWindow: 8_192,
        maxOutputTokens: 1_024,
        pricing: { inputCostPer1M: 0.0005, outputCostPer1M: 0.001, currency: 'USD' },
      };
    }

    // Default specs
    return {
      contextWindow: 32_768,
      maxOutputTokens: 2_048,
      pricing: { inputCostPer1M: 0.00025, outputCostPer1M: 0.0005, currency: 'USD' },
    };
  }
}
