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
import { inferModelCapabilities } from '@/services/model-capability-inference';
import { logger } from '@/utils/logger';

/**
 * What we know about a Bedrock model's specs from `ListFoundationModels`:
 * nothing. The response carries modelId/modelName/providerName/modalities/
 * inferenceTypesSupported and no context window, no max output, no pricing.
 *
 * This used to be filled by an `estimateModelSpecs()` keyword table that
 * invented values (`includes('opus')` ⇒ $15/$75 per 1M and a 200k window),
 * whose own comment records that it had ALREADY mispriced commodity
 * open-weights models by 25-125×. Inventing a number and storing it in
 * `models.input_cost_per_1k` is indistinguishable downstream from a real one,
 * and the cost/selection layers read that column — so an estimate here is a
 * silent correctness bug, not a convenience.
 *
 * Zero is the honest encoding of "the provider did not report this": it is
 * exactly what `bulkUpsertModels` already substitutes for a missing `pricing`
 * block, and the dedicated pricing fetchers are what fill the real values in.
 */
const UNKNOWN_SPECS = Object.freeze({
  contextWindow: 0,
  maxOutputTokens: 0,
  pricing: Object.freeze({ inputCostPer1M: 0, outputCostPer1M: 0, currency: 'USD' }),
});

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

  constructor(config: { accessKeyId: string; secretAccessKey: string; region?: string }) {
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

      type BedrockClientConstructor = new (config: {
        region: string;
        credentials: { accessKeyId: string; secretAccessKey: string };
      }) => BedrockClientType;
      type ListFoundationModelsCommandConstructor = new () => unknown;

      let BedrockClientClass: BedrockClientConstructor | undefined = undefined;
      let ListFoundationModelsCommandClass: ListFoundationModelsCommandConstructor | undefined =
        undefined;

      try {
        const bedrockModule = await import('@aws-sdk/client-bedrock');
        // Type-safe assignment: verify the imported classes match expected types
        if (typeof bedrockModule.BedrockClient === 'function') {
          BedrockClientClass = bedrockModule.BedrockClient as BedrockClientConstructor;
        }
        if (typeof bedrockModule.ListFoundationModelsCommand === 'function') {
          ListFoundationModelsCommandClass =
            bedrockModule.ListFoundationModelsCommand as ListFoundationModelsCommandConstructor;
        }
      } catch (importError) {
        this.log.warn(
          'AWS SDK for Bedrock not installed - install @aws-sdk/client-bedrock for Bedrock support'
        );
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
        .filter(
          (
            model
          ): model is {
            modelId?: string;
            modelName?: string;
            providerName?: string;
            inputModalities?: string[];
            outputModalities?: string[];
            inferenceTypesSupported?: string[];
          } => model !== null && typeof model === 'object'
        )
        .map((model) => this.convertBedrockModel(model));
      this.log.info(
        { count: models.length, region: this.region },
        'Successfully fetched models from AWS Bedrock'
      );
      return models;
    } catch (error: unknown) {
      const { getErrorMessage } = await import('@/utils/type-guards');
      const errorMessage = getErrorMessage(error);
      const errorName =
        error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
          ? error.name
          : undefined;

      // Log auth/permission errors with global cooldown to avoid spam during discovery cycles
      // Use global cooldown so multiple fetcher instances don't spam logs.
      //
      // These were previously logged at `.debug()`, which is silent in
      // production (LOG_LEVEL=info): every discovery cycle recorded
      // `modelsDiscovered: 0` for aws-bedrock-hub with zero trace of *why*,
      // unlike every other hub fetcher (OpenAICompatibleHubModelFetcher),
      // which logs its failures at `.warn()`. The cooldown above already
      // exists to prevent spam, so promoting to `.warn()` restores real
      // operability without reintroducing log volume — and each branch now
      // includes the actual error name/message instead of only a category
      // hint, so an operator doesn't have to guess.
      const now = Date.now();
      if (now - globalAwsBedrockLastAuthErrorTime > AWS_BEDROCK_AUTH_ERROR_COOLDOWN_MS) {
        if (errorName === 'CredentialsProviderError' || errorMessage.includes('credentials')) {
          this.log.warn(
            { errorName, error: errorMessage },
            'AWS Bedrock authentication failed - check credentials'
          );
        } else if (errorName === 'AccessDeniedException') {
          this.log.warn(
            { errorName, error: errorMessage },
            'AWS Bedrock access denied - check IAM permissions'
          );
        } else {
          this.log.warn({ errorName, error: errorMessage }, 'Failed to fetch models from AWS Bedrock');
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
    const capabilities = this.resolveCapabilities(bedrockModel, modelId);

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
      // ListFoundationModels returns NEITHER a context window NOR pricing. See
      // `UNKNOWN_SPECS` — zeros mean "not reported", and the pipeline's own
      // defaults / the pricing fetchers fill them in from real sources.
      ...UNKNOWN_SPECS,
      capabilities,
      metadata,
    };
  }

  /**
   * Capabilities from what the API actually reports, falling back to the id.
   *
   * `ListFoundationModels` returns real `inputModalities` / `outputModalities`
   * arrays per model. Those were previously stashed in metadata and ignored,
   * while capabilities were guessed from substrings of the model id
   * (`includes('claude') && /\d+\.\d+/` ⇒ vision, `includes('command')` ⇒
   * function_calling). Declared modalities are strictly better evidence, and
   * routing them through the shared inference engine keeps the modality rules
   * in one place instead of a Bedrock-specific copy.
   *
   * The id-based extraction is retained ONLY as a fallback for entries whose
   * modality arrays are absent, and for the tool/JSON capabilities that no
   * Bedrock field expresses.
   */
  private resolveCapabilities(
    bedrockModel: { inputModalities?: string[]; outputModalities?: string[] },
    modelId: string
  ): ModelCapability[] {
    const hasDeclaredModalities =
      (bedrockModel.inputModalities?.length ?? 0) > 0 ||
      (bedrockModel.outputModalities?.length ?? 0) > 0;

    if (!hasDeclaredModalities) {
      return this.extractCapabilitiesFromBedrock(modelId);
    }

    return inferModelCapabilities({
      modelId,
      metadata: {
        inputModalities: bedrockModel.inputModalities,
        outputModalities: bedrockModel.outputModalities,
      },
    });
  }

  private async createProviderModel(modelId: string): Promise<ProviderModel> {
    const capabilities = this.extractCapabilitiesFromBedrock(modelId);

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
      ...UNKNOWN_SPECS,
      capabilities,
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
    const hasTextCapability =
      textKeywords.some((keyword) => normalized.includes(keyword)) ||
      normalized.includes('claude') ||
      normalized.includes('llama') ||
      normalized.includes('j2') ||
      normalized.includes('command');
    if (hasTextCapability && !normalized.includes('embed')) {
      capabilities.push('chat', 'text_generation', 'completions', 'streaming');
    }

    // Function calling - modern models typically support it
    const modernKeywords = ['claude', 'llama3', 'j2', 'command'];
    if (modernKeywords.some((keyword) => normalized.includes(keyword))) {
      capabilities.push('function_calling', 'tool_use', 'json_mode');
    }

    // Vision capabilities - check for vision/image keywords or version patterns
    const hasVersion = normalized.match(/\d+\.\d+/);
    if (
      normalized.includes('vision') ||
      normalized.includes('multimodal') ||
      normalized.includes('image') ||
      (hasVersion && normalized.includes('claude'))
    ) {
      capabilities.push('vision', 'multimodal');
    }

    // Image generation - check for image generation keywords
    if (
      (normalized.includes('image') && !normalized.includes('vision')) ||
      normalized.includes('stable-diffusion') ||
      normalized.includes('diffusion')
    ) {
      capabilities.push('image_generation');
    }

    // Embeddings - check for embedding keywords
    if (normalized.includes('embed')) {
      capabilities.push('embeddings');
    }

    // Reasoning capabilities - check for reasoning keywords or higher version numbers
    if (
      normalized.includes('reasoning') ||
      normalized.includes('thinking') ||
      (hasVersion && parseFloat(hasVersion[0]) >= 3.5) ||
      normalized.includes('llama3')
    ) {
      capabilities.push('reasoning', 'thinking_mode');
    }

    // Code capabilities - check for code-related keywords
    if (
      normalized.includes('code') ||
      normalized.includes('codellama') ||
      normalized.includes('claude') ||
      normalized.includes('llama3')
    ) {
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
    const tierKeywords = [
      'text',
      'image',
      'embed',
      'premier',
      'express',
      'lite',
      'ultra',
      'mid',
      'opus',
      'sonnet',
      'haiku',
    ];
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
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
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
    if (
      normalized.includes('premier') ||
      normalized.includes('opus') ||
      normalized.includes('405b') ||
      normalized.match(/\d+[0-9]{2,3}b/)
    ) {
      // Large parameter models (405b, 175b, etc.) are typically flagship
      return 'flagship';
    }

    // Premium tier
    if (
      normalized.includes('sonnet') ||
      normalized.includes('ultra') ||
      normalized.includes('70b') ||
      normalized.includes('65b')
    ) {
      return 'premium';
    }

    // Fast/lightweight tier
    if (
      normalized.includes('lite') ||
      normalized.includes('mid') ||
      normalized.includes('light') ||
      normalized.includes('haiku') ||
      normalized.includes('8b') ||
      normalized.includes('7b')
    ) {
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
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
