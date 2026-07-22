// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Azure OpenAI Model Fetcher
 * Fetches models from Azure OpenAI Service
 */

import {
  BaseProviderModelFetcher,
  type ProviderModel,
  type ModelCapability,
} from './provider-model-fetcher.js';
import { logger } from '@/utils/logger';

interface AzureOpenAIModelFetcherConfig {
  apiKey?: string;
  endpoint?: string;
  apiVersion?: string;
  defaultDeployment?: string;
}

export class AzureOpenAIModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'azure-openai';
  private readonly apiKey?: string;
  private readonly endpoint?: string;
  private readonly apiVersion: string;
  private readonly defaultDeployment?: string;
  private readonly log = logger.child({ component: 'azure-openai-fetcher' });
  private models: ProviderModel[] = [];

  constructor(config?: AzureOpenAIModelFetcherConfig) {
    super();
    this.apiKey = config?.apiKey ?? process.env.AZURE_OPENAI_API_KEY;
    this.endpoint = config?.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
    this.apiVersion = config?.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? '2023-12-01-preview';
    this.defaultDeployment = config?.defaultDeployment ?? process.env.AZURE_OPENAI_DEPLOYMENT;
  }

  async getModels(): Promise<ProviderModel[]> {
    this.models = await this.fetchModels();
    return this.models;
  }

  private async fetchModels(): Promise<ProviderModel[]> {
    // Validate endpoint is not mock
    if (!this.endpoint || this.endpoint.includes('mock')) {
      this.log.warn(
        { endpoint: this.endpoint },
        'Azure OpenAI endpoint appears to be mock - skipping model discovery'
      );
      return [];
    }

    // Validate API key is not mock
    if (!this.apiKey || this.apiKey.includes('mock') || this.apiKey.includes('test-')) {
      this.log.warn(
        { keyPresent: Boolean(this.apiKey) },
        'Azure OpenAI API key appears to be mock/test key - skipping model discovery'
      );
      return [];
    }

    try {
      const models = await this.fetchModelsViaSDK();

      if (models.length > 0) {
        this.log.info({ models: models.length }, 'Azure OpenAI discovery succeeded');
        return models;
      }

      this.log.warn('Azure OpenAI SDK returned zero models - returning empty list (100% dynamic discovery)');
      return [];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Check if it's a DNS error (mock URL)
      if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        this.log.warn(
          { endpoint: this.endpoint, error: errorMessage },
          'Azure OpenAI endpoint appears to be invalid or unreachable - skipping model discovery'
        );
      } else {
        this.log.warn(
          { error: errorMessage },
          'Failed to fetch Azure OpenAI models via SDK - returning empty list (100% dynamic discovery)'
        );
      }
      // 100% Dynamic Discovery: Return empty array on failure
      // No hardcoded fallback - models must come from API
      return [];
    }
  }

  /**
   * Try to fetch models using Azure OpenAI SDK
   */
  private async fetchModelsViaSDK(): Promise<ProviderModel[]> {
    if (!this.endpoint || !this.apiKey) {
      throw new Error('Azure OpenAI credentials not configured');
    }

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: `${this.endpoint}/openai/deployments`,
      defaultQuery: { 'api-version': this.apiVersion },
      defaultHeaders: { 'api-key': this.apiKey },
    });

    // Try to list models (Azure reuses OpenAI surface)
    const models = await client.models.list();

    const providerModels: ProviderModel[] = [];
    for (const model of models.data) {
      // Convert OpenAI Model type to our expected format
      // Model from OpenAI SDK has id, model, object properties
      // Create a new object to avoid type conversion issues
      const modelData: { id?: string; model?: string; object?: string; [key: string]: unknown } = {};
      
      if (model && typeof model === 'object') {
        // Type guard: verify model has expected structure
        // Create a safe copy without direct type assertion
        const modelObj: Record<string, unknown> = {};
        // Iterate over model properties safely
        // Use Object.entries to safely iterate without type assertion
        const entries = Object.entries(model);
        for (const [key, value] of entries) {
          if (value !== undefined) {
            modelObj[key] = value;
          }
        }
        
        if ('id' in modelObj && modelObj.id !== null && modelObj.id !== undefined) {
          modelData.id = String(modelObj.id);
        }
        if ('model' in modelObj && modelObj.model !== null && modelObj.model !== undefined) {
          modelData.model = String(modelObj.model);
        }
        if ('object' in modelObj && modelObj.object !== null && modelObj.object !== undefined) {
          modelData.object = String(modelObj.object);
        }
        // Copy other properties if they exist
        for (const key in modelObj) {
          if (key !== 'id' && key !== 'model' && key !== 'object' && Object.prototype.hasOwnProperty.call(modelObj, key)) {
            modelData[key] = modelObj[key];
          }
        }
      }
      
      const providerModel = this.convertAzureModel(modelData);
      if (providerModel) {
        providerModels.push(providerModel);
      }
    }

    // If Azure API doesn't return deployments we still attempt to return fallback list
    if (providerModels.length === 0 && this.defaultDeployment) {
      providerModels.push(...this.buildModelsFromDeployments([this.defaultDeployment]));
    }

    return providerModels;
  }

  /**
   * Convert Azure OpenAI model to our ProviderModel format
   */
  private convertAzureModel(model: { id?: string; model?: string; object?: string; [key: string]: unknown }): ProviderModel | null {
    try {
      const modelId = model.id || model.model || model.object || this.defaultDeployment;
      if (!modelId) {
        return null;
      }

      const capabilities = this.extractCapabilitiesFromAzureModel(modelId);
      const { contextWindow, maxOutputTokens, pricing } = this.estimateAzureModelSpecs(modelId);

      return {
        id: modelId,
        name: modelId,
        displayName: this.formatDisplayName(modelId),
        contextWindow,
        maxOutputTokens,
        capabilities,
        pricing,
        metadata: {
          provider: 'azure_openai',
          source: 'azure-openai-api',
          ownedBy: model.owned_by || 'microsoft',
          apiVersion: this.apiVersion,
          endpoint: this.endpoint,
          deployment: modelId,
        },
      };
    } catch (error) {
      this.log.warn({ modelId: model?.id, error }, 'Failed to convert Azure model');
      return null;
    }
  }

  private buildModelsFromDeployments(deployments: string[]): ProviderModel[] {
    return deployments.map((deployment) => {
      const capabilities = this.extractCapabilitiesFromAzureModel(deployment);
      const { contextWindow, maxOutputTokens, pricing } = this.estimateAzureModelSpecs(deployment);
      return {
        id: deployment,
        name: deployment,
        displayName: this.formatDisplayName(deployment),
        contextWindow,
        maxOutputTokens,
        capabilities,
        pricing,
        metadata: {
          provider: 'azure_openai',
          source: 'azure-deployment',
          deployment,
          endpoint: this.endpoint,
        },
      } satisfies ProviderModel;
    });
  }

  private formatDisplayName(modelId: string): string {
    return modelId
      .split(/[-_]/)
      .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Extract capabilities from Azure model ID
   */
  private extractCapabilitiesFromAzureModel(modelId: string): ModelCapability[] {
    const capabilities: ModelCapability[] = ['text_generation'];
    const name = modelId.toLowerCase();

    if (name.includes('gpt') || name.includes('claude')) {
      capabilities.push('chat');
    }

    // Use generic keywords, not specific model names
    if (name.includes('vision') || name.includes('multimodal') || name.includes('o')) {
      capabilities.push('vision', 'multimodal');
    }

    // Function calling - infer from generic patterns (modern models typically support it)
    const isModernModel = name.includes('gpt') || name.includes('claude') || name.includes('gemini');
    if (isModernModel && !name.includes('tts') && !name.includes('whisper') && !name.includes('embedding')) {
      capabilities.push('function_calling', 'tool_use');
    }

    capabilities.push('streaming');

    return Array.from(new Set(capabilities));
  }

  /**
   * Estimate Azure OpenAI model specifications
   */
  private estimateAzureModelSpecs(modelId: string): {
    contextWindow: number;
    maxOutputTokens: number;
    pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
  } {
    const name = modelId.toLowerCase();

    let contextWindow = 4096;
    let maxOutputTokens = 1024;
    let inputCost = 0.0015;
    let outputCost = 0.002;

    // Use generic tier/keyword patterns, not specific model names
    const isPremium = name.includes('pro') || name.includes('turbo') || name.includes('max');
    const isFast = name.includes('mini') || name.includes('nano') || name.includes('lite') || name.includes('flash');
    
    if (isPremium && !isFast) {
      // Premium models - larger context, higher cost
      contextWindow = 128000;
      maxOutputTokens = 4096;
      inputCost = 10.0;
      outputCost = 30.0;
    } else if (isFast) {
      // Fast models - smaller context, lower cost
      contextWindow = 16384;
      maxOutputTokens = 4096;
      inputCost = 0.5;
      outputCost = 1.5;
    } else {
      // Standard models - conservative defaults
      contextWindow = 128000;
      maxOutputTokens = 4096;
      inputCost = 5.0;
      outputCost = 15.0;
    }

    return {
      contextWindow,
      maxOutputTokens,
      pricing: {
        inputCostPer1M: inputCost,
        outputCostPer1M: outputCost,
        currency: 'USD',
      },
    };
  }

  /**
   * Fallback models when API is not available
   * Returns empty array - models should be discovered dynamically
   */

  async validateModel(modelId: string): Promise<boolean> {
    return this.models.some((model) => model.id === modelId);
  }
}
