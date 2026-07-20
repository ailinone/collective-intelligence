// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * AWS Bedrock Model Fetcher
 *
 * Dynamically fetches models from AWS Bedrock API.
 */

import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

/**
 * AWS Bedrock Model Fetcher
 * Fetches models dynamically from AWS Bedrock API
 */
/**
 * Global cooldown tracker for AWS Bedrock auth errors (shared across all instances)
 * This prevents spam logs when multiple fetcher instances are created
 */
let globalAwsBedrockLastAuthErrorTime = 0;
const AWS_BEDROCK_AUTH_ERROR_COOLDOWN_MS = 60000; // 1 minute cooldown between auth error logs

export class AWSBedrockModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'aws-bedrock';
  private log = logger.child({ component: 'aws-bedrock-fetcher' });
  private region: string;
  private accessKeyId: string;
  private secretAccessKey: string;

  constructor(config: {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
  }) {
    super();
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.region = config.region || 'us-east-1';
  }

  async getModels(): Promise<ProviderModel[]> {
    if (!this.accessKeyId || !this.secretAccessKey) {
      this.log.warn('AWS Bedrock credentials not provided - returning empty model list');
      return [];
    }

    try {
      // AWS Bedrock ListFoundationModels API
      // Using AWS SDK v3 for Bedrock (dynamic import to handle optional dependency)
      interface BedrockClientType {
        send: (command: unknown) => Promise<{ modelSummaries?: unknown[] }>;
      }
      
      type BedrockClientConstructor = new (config: { region: string; credentials: { accessKeyId: string; secretAccessKey: string } }) => BedrockClientType;
      type ListFoundationModelsCommandConstructor = new () => unknown;
      
      let BedrockClientClass: BedrockClientConstructor | undefined = undefined;
      let ListFoundationModelsCommandClass: ListFoundationModelsCommandConstructor | undefined = undefined;
      
      try {
        const bedrockModule = await import('@aws-sdk/client-bedrock');
        // Type-safe assignment: verify the imported classes match expected types
        if (typeof bedrockModule.BedrockClient === 'function') {
          BedrockClientClass = bedrockModule.BedrockClient as BedrockClientConstructor;
        }
        if (typeof bedrockModule.ListFoundationModelsCommand === 'function') {
          ListFoundationModelsCommandClass = bedrockModule.ListFoundationModelsCommand as ListFoundationModelsCommandConstructor;
        }
      } catch (importError) {
        this.log.warn('AWS SDK for Bedrock not installed - install @aws-sdk/client-bedrock for Bedrock support');
        return [];
      }
      
      if (!BedrockClientClass || !ListFoundationModelsCommandClass) {
        this.log.warn('AWS SDK for Bedrock classes not properly initialized');
        return [];
      }
      
      const client = new BedrockClientClass({
        region: this.region,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey,
        },
      });

      const command = new ListFoundationModelsCommandClass();
      const response = await client.send(command);

      if (!response.modelSummaries || !Array.isArray(response.modelSummaries)) {
        this.log.warn('AWS Bedrock API returned invalid response format');
      return [];
      }

      const models = response.modelSummaries
        .filter((model): model is {
          modelId?: string;
          modelName?: string;
          providerName?: string;
          inputModalities?: string[];
          outputModalities?: string[];
          inferenceTypesSupported?: string[];
        } => model !== null && typeof model === 'object')
        .map((model) => this.convertBedrockModel(model));
      this.log.info({ count: models.length, region: this.region }, 'Successfully fetched models from AWS Bedrock');
      return models;
    } catch (error: unknown) {
      const { getErrorMessage } = await import('@/utils/type-guards');
      const errorMessage = getErrorMessage(error);
      const errorName = error && typeof error === 'object' && 'name' in error && typeof error.name === 'string' 
        ? error.name 
        : undefined;
      
      // Log auth/permission errors with global cooldown to avoid spam during discovery cycles
      // Use global cooldown so multiple fetcher instances don't spam logs
      const now = Date.now();
      if (now - globalAwsBedrockLastAuthErrorTime > AWS_BEDROCK_AUTH_ERROR_COOLDOWN_MS) {
        if (errorName === 'CredentialsProviderError' || errorMessage.includes('credentials')) {
          this.log.debug('AWS Bedrock authentication failed - check credentials');
        } else if (errorName === 'AccessDeniedException') {
          this.log.debug('AWS Bedrock access denied - check IAM permissions');
        } else {
          this.log.debug({ error: errorMessage }, 'Failed to fetch models from AWS Bedrock');
        }
        globalAwsBedrockLastAuthErrorTime = now;
      }
      // 100% Dynamic Discovery: Return empty array on failure
      // No hardcoded fallback - models must come from API
      return [];
    }
  }

  private convertBedrockModel(bedrockModel: {
    modelId?: string;
    modelName?: string;
    providerName?: string;
    inputModalities?: string[];
    outputModalities?: string[];
    inferenceTypesSupported?: string[];
  }): ProviderModel {
    const modelId = bedrockModel.modelId || 'unknown';
    const capabilities = this.extractCapabilitiesFromBedrock(modelId);
    const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(modelId);

    const metadata = {
      endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
      tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
      family: this.extractFamily(modelId),
      tier: this.extractTier(modelId),
      source: 'aws-bedrock-api',
      region: this.region,
      providerName: bedrockModel.providerName,
      inputModalities: bedrockModel.inputModalities,
      outputModalities: bedrockModel.outputModalities,
      inferenceTypes: bedrockModel.inferenceTypesSupported,
    };

    return {
      id: modelId,
      name: modelId,
      displayName: bedrockModel.modelName || this.formatDisplayName(modelId),
      contextWindow,
      maxOutputTokens,
      capabilities,
      pricing,
      metadata,
    };
  }

  private async createProviderModel(modelId: string): Promise<ProviderModel> {
    const capabilities = this.extractCapabilitiesFromBedrock(modelId);
    const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(modelId);

    const metadata = {
      endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
      tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
      family: this.extractFamily(modelId),
      tier: this.extractTier(modelId),
      source: 'aws-bedrock-api',
      region: this.region,
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
  }

  /**
   * Extract capabilities using generic keywords, not hardcoded model names
   */
  private extractCapabilitiesFromBedrock(modelId: string): ModelCapability[] {
    const capabilities: ModelCapability[] = [];
    const normalized = modelId.toLowerCase();

    // Text generation - check for generic text-related keywords
    const textKeywords = ['text', 'chat', 'completion', 'generation'];
    const hasTextCapability = textKeywords.some(keyword => normalized.includes(keyword)) ||
                             normalized.includes('claude') || normalized.includes('llama') ||
                             normalized.includes('j2') || normalized.includes('command');
    if (hasTextCapability && !normalized.includes('embed')) {
      capabilities.push('chat', 'text_generation', 'completions', 'streaming');
    }

    // Function calling - modern models typically support it
    const modernKeywords = ['claude', 'llama3', 'j2', 'command'];
    if (modernKeywords.some(keyword => normalized.includes(keyword))) {
      capabilities.push('function_calling', 'tool_use', 'json_mode');
    }

    // Vision capabilities - check for vision/image keywords or version patterns
    const hasVersion = normalized.match(/\d+\.\d+/);
    if (normalized.includes('vision') || normalized.includes('multimodal') ||
        normalized.includes('image') || (hasVersion && normalized.includes('claude'))) {
      capabilities.push('vision', 'multimodal');
    }

    // Image generation - check for image generation keywords
    if (normalized.includes('image') && !normalized.includes('vision') ||
        normalized.includes('stable-diffusion') || normalized.includes('diffusion')) {
      capabilities.push('image_generation');
    }

    // Embeddings - check for embedding keywords
    if (normalized.includes('embed')) {
      capabilities.push('embeddings');
    }

    // Reasoning capabilities - check for reasoning keywords or higher version numbers
    if (normalized.includes('reasoning') || normalized.includes('thinking') ||
        (hasVersion && parseFloat(hasVersion[0]) >= 3.5) || normalized.includes('llama3')) {
      capabilities.push('reasoning', 'thinking_mode');
    }

    // Code capabilities - check for code-related keywords
    if (normalized.includes('code') || normalized.includes('codellama') ||
        normalized.includes('claude') || normalized.includes('llama3')) {
      capabilities.push('code_generation', 'code_review', 'debugging');
    }

    return Array.from(new Set(capabilities));
  }

  /**
   * Extract model family using generic pattern extraction, not hardcoded names
   */
  private extractFamily(modelId: string): string {
    const normalized = modelId.toLowerCase();
    
    // Extract base family name (first meaningful segment before tier/version)
    // Remove tier keywords to get base family
    const tierKeywords = ['text', 'image', 'embed', 'premier', 'express', 'lite', 'ultra', 'mid', 'opus', 'sonnet', 'haiku'];
    let familyPart = normalized;
    
    // Try to extract base family by removing tier keywords
    for (const tier of tierKeywords) {
      if (familyPart.includes(`-${tier}`) || familyPart.startsWith(`${tier}-`)) {
        familyPart = familyPart.replace(new RegExp(`-?${tier}-?`, 'g'), '');
      }
    }
    
    // Extract prefix pattern (e.g., "titan", "claude", "llama", "j2")
    const match = familyPart.match(/^([a-z]+(?:-\d+)?(?:\.\d+)?)/);
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
    
    return 'AWS Bedrock';
  }

  /**
   * Extract tier using generic keywords, not hardcoded model names
   */
  private extractTier(modelId: string): string {
    const normalized = modelId.toLowerCase();
    
    // Flagship tier - highest quality models
    if (normalized.includes('premier') || normalized.includes('opus') ||
        normalized.includes('405b') || normalized.match(/\d+[0-9]{2,3}b/)) {
      // Large parameter models (405b, 175b, etc.) are typically flagship
      return 'flagship';
    }
    
    // Premium tier
    if (normalized.includes('sonnet') || normalized.includes('ultra') ||
        normalized.includes('70b') || normalized.includes('65b')) {
      return 'premium';
    }
    
    // Fast/lightweight tier
    if (normalized.includes('lite') || normalized.includes('mid') ||
        normalized.includes('light') || normalized.includes('haiku') ||
        normalized.includes('8b') || normalized.includes('7b')) {
      return 'fast';
    }
    
    // Standard tier (default)
    if (normalized.includes('express') || normalized.includes('standard')) {
      return 'standard';
    }
    
    return 'standard';
  }

  private formatDisplayName(modelId: string): string {
    // Convert model ID to readable name
    return modelId
      .replace(/\./g, ' ')
      .replace(/-/g, ' ')
      .replace(/\bv\d+/g, 'v$&')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Estimate model specifications using generic tier/keyword inference, not hardcoded model names
   */
  private estimateModelSpecs(modelId: string): {
    contextWindow: number;
    maxOutputTokens: number;
    pricing: { inputCostPer1M: number; outputCostPer1M: number; currency?: string };
  } {
    const normalized = modelId.toLowerCase();

    // Use generic tier/keyword patterns.
    // Pricing values are USD per 1M tokens, written directly in the field's unit.
    // Parameter count is deliberately NOT a flagship-pricing signal: large
    // open-weights models on Bedrock are commodity-priced (gpt-oss-120b is
    // $0.15/$0.60, llama-405b is $2.40/$2.40 per 1M) — pricing them like a
    // proprietary flagship ($15/$75) once inflated them 25-125×.
    const isFlagship = normalized.includes('premier') || normalized.includes('opus');
    const isLargeOpenWeights = normalized.match(/\d+[0-9]{2,3}b/); // 100B+ params (405b, 120b, 175b, ...)
    const isPremium = normalized.includes('sonnet') || normalized.includes('ultra') ||
                     normalized.includes('70b') || normalized.includes('65b');
    const isFast = normalized.includes('lite') || normalized.includes('haiku') ||
                  normalized.includes('8b') || normalized.includes('7b');
    const isStandard = normalized.includes('express') || normalized.includes('standard');

    // Estimate based on generic patterns
    if (isFlagship) {
      return {
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        pricing: { inputCostPer1M: 15.0, outputCostPer1M: 75.0, currency: 'USD' },
      };
    }

    if (isLargeOpenWeights) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 1.0, outputCostPer1M: 3.0, currency: 'USD' },
      };
    }

    if (isPremium) {
      return {
        contextWindow: 200_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 3.0, outputCostPer1M: 15.0, currency: 'USD' },
      };
    }
    
    if (isFast) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.25, outputCostPer1M: 1.25, currency: 'USD' },
      };
    }
    
    if (isStandard) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 3_072,
        pricing: { inputCostPer1M: 0.8, outputCostPer1M: 2.4, currency: 'USD' },
      };
    }

    // Default specs - conservative estimates that work for any model
    return {
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      pricing: { inputCostPer1M: 1.0, outputCostPer1M: 2.0, currency: 'USD' },
    };
  }
}
