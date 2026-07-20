// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Alibaba/Qwen Model Fetcher
 *
 * Dynamically fetches models from Alibaba/Qwen API.
 */

import OpenAI from 'openai';
import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

/**
 * Alibaba Model Fetcher
 * Fetches models dynamically from Alibaba/Qwen API (uses OpenAI-compatible API)
 */
export class AlibabaModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'alibaba';
  private client: OpenAI | null = null;
  private log = logger.child({ component: 'alibaba-fetcher' });
  private apiKey: string;
  private accessKeyId?: string;
  private accessKeySecret?: string;
  private baseUrl: string;

  constructor(
    apiKey: string,
    baseUrl: string = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', // Singapore region (default)
    accessKeyId?: string,
    accessKeySecret?: string
  ) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;

    // Initialize client with API key (primary method)
    if (apiKey) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout: 30000,
    });
    }
  }

  async getModels(): Promise<ProviderModel[]> {
    // Try API key first (primary method for DashScope)
    if (this.client) {
      try {
        return await this.fetchWithApiKey();
      } catch (error: unknown) {
        // Safely extract status without type assertions
        let has401Status = false;
        if (error && typeof error === 'object' && error !== null) {
          const statusDescriptor = Object.getOwnPropertyDescriptor(error, 'status');
          if (statusDescriptor && statusDescriptor.value === 401) {
            has401Status = true;
          } else {
            const responseDescriptor = Object.getOwnPropertyDescriptor(error, 'response');
            if (responseDescriptor && responseDescriptor.value && typeof responseDescriptor.value === 'object') {
              const responseStatusDescriptor = Object.getOwnPropertyDescriptor(responseDescriptor.value, 'status');
              if (responseStatusDescriptor && responseStatusDescriptor.value === 401) {
                has401Status = true;
              }
            }
          }
        }
        // If API key fails with 401, try AccessKey ID/Secret as fallback
        if (has401Status && this.accessKeyId && this.accessKeySecret) {
          const errorMessage = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
          this.log.warn(
            {
              error: errorMessage,
              fallback: 'Attempting AccessKey ID/Secret authentication',
            },
            'API key authentication failed, trying AccessKey ID/Secret'
          );
          try {
            return await this.fetchWithAccessKey();
          } catch (accessKeyError: unknown) {
            const accessKeyErrorMessage = accessKeyError && typeof accessKeyError === 'object' && 'message' in accessKeyError ? String(accessKeyError.message) : String(accessKeyError);
            this.log.error(
              {
                apiKeyError: errorMessage,
                accessKeyError: accessKeyErrorMessage,
              },
              'Both API key and AccessKey authentication failed'
            );
            throw error; // Throw original error
          }
        }
        throw error;
      }
    } else if (this.accessKeyId && this.accessKeySecret) {
      // If no API key, try AccessKey ID/Secret directly
      return await this.fetchWithAccessKey();
    } else {
      this.log.warn('Alibaba API client not initialized and no AccessKey provided - returning empty model list');
      return [];
    }
  }

  /**
   * Fetch models using API key (primary method for DashScope)
   */
  private async fetchWithApiKey(): Promise<ProviderModel[]> {
    if (!this.client) {
      throw new Error('API client not initialized');
    }

    // Alibaba DashScope uses OpenAI-compatible API
    // Endpoint: https://dashscope.aliyuncs.com/compatible-mode/v1
    // Extract API key safely (OpenAI client may have apiKey property)
    const apiKey = 'apiKey' in this.client && typeof this.client.apiKey === 'string' 
      ? this.client.apiKey 
      : undefined;
    
    this.log.debug(
      {
        endpoint: this.client.baseURL,
        apiKeyPrefix: apiKey ? apiKey.substring(0, 15) + '...' : 'not available',
      },
      'Attempting to fetch models from Alibaba DashScope using API key'
    );

    const response = await this.client.models.list();

    if (!response.data || !Array.isArray(response.data)) {
      this.log.warn(
        {
          responseType: typeof response.data,
          hasData: !!response.data,
          isArray: Array.isArray(response.data),
        },
        'Alibaba API returned invalid response format'
      );
      return [];
    }

    const models = response.data.map((model) => this.convertAlibabaModel(model));
    this.log.info({ count: models.length }, 'Successfully fetched models from Alibaba API using API key');
    return models;
  }

  /**
   * Fetch models using AccessKey ID/Secret (alternative method)
   * Note: DashScope Model Studio primarily uses API keys, but AccessKey can be used
   * for other Alibaba Cloud services. This is a fallback attempt.
   */
  private async fetchWithAccessKey(): Promise<ProviderModel[]> {
    if (!this.accessKeyId || !this.accessKeySecret) {
      throw new Error('AccessKey ID and Secret are required for this authentication method');
    }

    this.log.debug(
      {
        endpoint: this.baseUrl,
        accessKeyIdPrefix: this.accessKeyId.substring(0, 10) + '...',
      },
      'Attempting to fetch models from Alibaba using AccessKey ID/Secret'
    );

    try {
      // For DashScope, we still need to use the OpenAI-compatible endpoint
      // AccessKey ID/Secret might need to be converted to a token first
      // For now, we'll try using AccessKey ID as the API key (some services support this)
      const tempClient = new OpenAI({
        apiKey: this.accessKeyId, // Try AccessKey ID as API key
        baseURL: this.baseUrl,
        timeout: 30000,
      });

      const response = await tempClient.models.list();

      if (!response.data || !Array.isArray(response.data)) {
        this.log.warn('Alibaba API returned invalid response format with AccessKey');
        return [];
      }

      const models = response.data.map((model) => this.convertAlibabaModel(model));
      this.log.info({ count: models.length }, 'Successfully fetched models from Alibaba API using AccessKey');
      return models;
    } catch (error: unknown) {
      // AccessKey authentication also failed
      const errorObj = error && typeof error === 'object' && error !== null ? error : {};
      const errorDetails: {
        status?: unknown;
        statusText?: unknown;
        message?: unknown;
        code?: unknown;
        error?: unknown;
        requestId?: unknown;
      } = {};
      
      if ('status' in errorObj) {
        errorDetails.status = errorObj.status;
      }
      if ('response' in errorObj && errorObj.response && typeof errorObj.response === 'object' && 'status' in errorObj.response) {
        errorDetails.status = errorObj.response.status;
      }
      if ('statusText' in errorObj) {
        errorDetails.statusText = errorObj.statusText;
      }
      if ('response' in errorObj && errorObj.response && typeof errorObj.response === 'object' && 'statusText' in errorObj.response) {
        errorDetails.statusText = errorObj.response.statusText;
      }
      if ('message' in errorObj) {
        errorDetails.message = errorObj.message;
      }
      if ('code' in errorObj) {
        errorDetails.code = errorObj.code;
      }
      if ('error' in errorObj) {
        errorDetails.error = errorObj.error;
      }
      if ('request_id' in errorObj) {
        errorDetails.requestId = errorObj.request_id;
      }
      if ('requestId' in errorObj) {
        errorDetails.requestId = errorObj.requestId;
      }

      this.log.error(
        {
          ...errorDetails,
          hint: 'DashScope Model Studio may require API keys (sk-...) format. AccessKey ID/Secret may be for other Alibaba Cloud services.',
        },
        'Failed to fetch models using AccessKey ID/Secret'
      );
      throw error;
    }
  }

  private convertAlibabaModel(openAIModel: OpenAI.Models.Model): ProviderModel {
    const capabilities = this.extractCapabilitiesFromAlibaba(openAIModel);
    const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(openAIModel.id);

    const metadata = {
      endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
      tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
      family: this.extractFamily(openAIModel.id),
      tier: this.extractTier(openAIModel.id),
      source: 'alibaba-api',
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

  private extractCapabilitiesFromAlibaba(model: OpenAI.Models.Model): ModelCapability[] {
    const capabilities: ModelCapability[] = ['chat', 'streaming'];
    const modelId = model.id.toLowerCase();

    // Qwen models support function calling
    capabilities.push('function_calling');

    // JSON mode support
    capabilities.push('json_mode');

    // Qwen models have strong reasoning capabilities
    capabilities.push('reasoning', 'thinking_mode');

    // VL models support vision
    if (modelId.includes('vl') || modelId.includes('vision')) {
      capabilities.push('vision', 'multimodal');
    }

    // Coder models are specialized for coding
    if (modelId.includes('coder') || modelId.includes('code')) {
      capabilities.push('code_interpreter', 'text_generation');
    }

    // Max models are flagship
    if (modelId.includes('max')) {
      capabilities.push('deep_research', 'research');
    }

    return Array.from(new Set(capabilities));
  }

  private extractFamily(modelId: string): string {
    if (modelId.includes('qwen-max')) return 'Qwen Max';
    if (modelId.includes('qwen-turbo')) return 'Qwen Turbo';
    if (modelId.includes('qwen-plus')) return 'Qwen Plus';
    if (modelId.includes('qwen-vl')) return 'Qwen VL';
    if (modelId.includes('qwen-coder')) return 'Qwen Coder';
    if (modelId.includes('qwen-2.5')) return 'Qwen 2.5';
    if (modelId.includes('qwen-2')) return 'Qwen 2';
    if (modelId.includes('qwen-1')) return 'Qwen 1';
    return 'Qwen';
  }

  private extractTier(modelId: string): string {
    if (modelId.includes('max')) return 'flagship';
    if (modelId.includes('plus') || modelId.includes('turbo')) return 'premium';
    if (modelId.includes('coder') || modelId.includes('2.5')) return 'standard';
    if (modelId.includes('1.5') || modelId.includes('7b')) return 'fast';
    return 'standard';
  }

  private formatDisplayName(modelId: string): string {
    return modelId
      .split('-')
      .map((word) => {
        if (word === 'qwen') return 'Qwen';
        if (word === 'vl') return 'VL';
        if (word === 'max') return 'Max';
        if (word === 'plus') return '+';
        if (word === 'turbo') return 'Turbo';
        if (word === 'coder') return 'Coder';
        if (word === 'v2') return 'V2';
        if (word === 'v1') return 'V1';
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ');
  }

  private estimateModelSpecs(modelId: string): {
    contextWindow: number;
    maxOutputTokens: number;
    pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
  } {
    const id = modelId.toLowerCase();

    // Pricing values below are USD per 1M tokens, written directly in the
    // field's unit — no ×1000/×1000000 scaling arithmetic. A ×1_000_000 mixup
    // in this function once inflated the whole Alibaba catalog 1000× and
    // poisoned the experiment budget governor.
    // Estimates pinned to the Model Studio international price list
    // (https://www.alibabacloud.com/help/en/model-studio/model-pricing).
    // DashScope's /models endpoint returns no pricing, so family-level
    // estimates are the best available; matchers must tolerate both hyphenated
    // ids (qwen-max) and the hyphenless open-weights ids DashScope actually
    // returns (qwen2.5-7b-instruct, qwen3-4b, ...).

    // Vision-language models (qwen-vl-max/plus, qwen2.5-vl-*, qvq-*)
    if (/(^|-)vl(-|$)/.test(id) || id.startsWith('qvq')) {
      return {
        contextWindow: 32_768,
        maxOutputTokens: 2_048,
        pricing: id.includes('max')
          ? { inputCostPer1M: 0.8, outputCostPer1M: 3.2, currency: 'USD' } // qwen-vl-max
          : { inputCostPer1M: 0.21, outputCostPer1M: 0.63, currency: 'USD' }, // qwen-vl-plus / open VL
      };
    }

    // Coder family (qwen3-coder-plus/flash, qwen2.5-coder-*, qwen-coder-*)
    if (id.includes('coder')) {
      return {
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
        pricing: id.includes('plus')
          ? { inputCostPer1M: 1.0, outputCostPer1M: 5.0, currency: 'USD' } // qwen3-coder-plus
          : { inputCostPer1M: 0.3, outputCostPer1M: 1.5, currency: 'USD' }, // qwen3-coder-flash / open coder
      };
    }

    // Flagship (qwen-max, qwen3-max, qwen2.5-max)
    if (/qwen[\d.]*-max/.test(id)) {
      return {
        contextWindow: 32_768,
        maxOutputTokens: 8_192,
        pricing: { inputCostPer1M: 1.6, outputCostPer1M: 6.4, currency: 'USD' },
      };
    }

    // Qwen Plus (qwen-plus, qwen3-*-plus)
    if (id.includes('plus')) {
      return {
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
        pricing: { inputCostPer1M: 0.4, outputCostPer1M: 1.2, currency: 'USD' },
      };
    }

    // Qwen Turbo
    if (id.includes('turbo')) {
      return {
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
        pricing: { inputCostPer1M: 0.05, outputCostPer1M: 0.2, currency: 'USD' },
      };
    }

    // Qwen Flash (qwen-flash, qwen3-tts-flash, ...)
    if (id.includes('flash')) {
      return {
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
        pricing: { inputCostPer1M: 0.05, outputCostPer1M: 0.4, currency: 'USD' },
      };
    }

    // Open-weights models with an explicit parameter size
    // (qwen2.5-7b-instruct, qwen3-4b, qwen3-30b-a3b, qwen2-72b-instruct, ...).
    // Model Studio reference points: qwen3-8b $0.18/$0.7, qwen3-32b $0.16/$0.64.
    if (/(^|-)\d+(\.\d+)?b(-|$)/.test(id)) {
      return {
        contextWindow: 32_768,
        maxOutputTokens: 8_192,
        pricing: { inputCostPer1M: 0.2, outputCostPer1M: 0.8, currency: 'USD' },
      };
    }

    // Default specs — conservative small-model estimate
    return {
      contextWindow: 8_192,
      maxOutputTokens: 2_048,
      pricing: { inputCostPer1M: 0.25, outputCostPer1M: 0.5, currency: 'USD' },
    };
  }
}
