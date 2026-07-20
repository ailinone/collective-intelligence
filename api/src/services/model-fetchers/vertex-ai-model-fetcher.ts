// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Vertex AI Model Fetcher
 * Fetches models from Google Cloud Vertex AI
 */

import {
  BaseProviderModelFetcher,
  type ProviderModel,
  type ModelCapability,
} from './provider-model-fetcher.js';
import { spawn } from 'node:child_process';
import { logger } from '@/utils/logger';
import { inferModelCapabilities } from '@/services/model-capability-inference';

/**
 * Gap 3 closure (2026-04-30): when the per-name extractor yields an empty
 * list (families like `aqa` that don't match any of the keyword substrings
 * the extractor checks), fall back to the central inference pipeline so the
 * `capability_uris[]` projection isn't empty downstream. Mirrors the pattern
 * the OpenAI-compatible hub path already uses in central-model-discovery-service.
 */
function applyInferenceFallback(
  modelId: string,
  metadata: Record<string, unknown>,
  extractorOutput: ModelCapability[],
): ModelCapability[] {
  return extractorOutput.length > 0
    ? extractorOutput
    : inferModelCapabilities({ modelId, metadata });
}

interface VertexAIModelFetcherConfig {
  apiKey?: string;
  projectId?: string;
  location?: string;
}

export class VertexAIModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'vertex-ai';
  private readonly apiKey?: string;
  private readonly projectId?: string;
  private readonly location?: string;
  private readonly log = logger.child({ component: 'vertex-ai-fetcher' });
  private models: ProviderModel[] = [];

  constructor(config?: VertexAIModelFetcherConfig) {
    super();
    this.apiKey = config?.apiKey ?? process.env.VERTEX_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
    this.projectId = config?.projectId ?? process.env.VERTEX_AI_PROJECT_ID;
    this.location = config?.location ?? process.env.VERTEX_AI_LOCATION ?? 'us-central1';
  }

  async getModels(): Promise<ProviderModel[]> {
    this.models = await this.fetchModels();
    return this.models;
  }

  private async fetchModels(): Promise<ProviderModel[]> {
    try {
      const modelsFromApi = await this.fetchModelsFromGoogleAPI();
      if (modelsFromApi.length > 0) {
        this.log.info({ models: modelsFromApi.length }, 'Vertex AI discovery succeeded');
        return modelsFromApi;
      }

      this.log.warn('Vertex AI API returned zero models - returning empty list (100% dynamic discovery)');
      return [];
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorObj = error && typeof error === 'object' && error !== null ? error : {};
      const errorDetails: { message: string; code?: unknown; status?: unknown } = {
        message: errorMessage,
      };
      if ('code' in errorObj) errorDetails.code = errorObj.code;
      if ('status' in errorObj) errorDetails.status = errorObj.status;
      this.log.warn(
        {
          error: errorDetails,
          projectId: this.projectId,
          location: this.location,
          hasApiKey: !!this.apiKey,
        },
        'Vertex AI discovery failed (invalid credentials or API error) - returning empty list'
      );
      // 100% Dynamic Discovery: Return empty array on failure
      // No hardcoded fallback - models must come from API
      return [];
    }
  }

  private async fetchModelsFromGoogleAPI(): Promise<ProviderModel[]> {
    const { default: fetch } = await import('node-fetch');
    let endpoint: URL;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (this.apiKey) {
      // Express mode - use API key
      endpoint = new URL('https://generativelanguage.googleapis.com/v1beta/models');
      endpoint.searchParams.set('key', this.apiKey);
    } else if (this.projectId) {
      // Standard mode - use gcloud auth application-default
      try {
        const accessToken = await this.executeGcloudCommand([
          'auth',
          'application-default',
          'print-access-token',
        ]);
        // Vertex AI Model Garden foundation models are listed via publishers endpoint
        // First try to get publishers (Google, Anthropic, etc.) which contain foundation models
        const modelLocation = 'us-central1'; // Model Garden publishers are typically in us-central1
        endpoint = new URL(
          `https://aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${modelLocation}/publishers`
        );
        headers.Authorization = `Bearer ${accessToken}`;
      } catch (error: unknown) {
        const { getErrorMessage, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        const errorMessage = getErrorMessage(error);
        const errorCode = extractErrorCodeFromObject(error);
        
        // Safely extract stderr from error object
        let stderr: unknown;
        if (typeof error === 'object' && error !== null && 'stderr' in error) {
          stderr = error.stderr;
        }
        
        const errorDetails = {
          message: errorMessage,
          code: errorCode,
          stderr,
        };
        this.log.warn(
          {
            error: errorDetails,
            projectId: this.projectId,
            location: this.location,
            hint: 'Run "gcloud auth application-default login" to configure authentication',
          },
          'Failed to get gcloud access token, falling back to Google AI API (may return limited models)'
        );
        // Fallback to Google AI API (may not return Vertex AI models)
        endpoint = new URL('https://generativelanguage.googleapis.com/v1beta/models');
      }
    } else {
      throw new Error('Vertex AI requires either API key or projectId with gcloud auth');
    }

    const response = await fetch(endpoint.toString(), {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Vertex AI models request failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const payload = (await response.json()) as { 
      models?: Array<Record<string, unknown>>;
      publishers?: Array<{ name: string; displayName?: string }>;
    };
    
    // If we got publishers (Model Garden), fetch models from each publisher
    if (payload.publishers && Array.isArray(payload.publishers)) {
      const allModels: ProviderModel[] = [];
      
      for (const publisher of payload.publishers) {
        try {
          // Fetch models from this publisher
          const publisherName = publisher.name.replace('publishers/', '');
          const publisherModelsEndpoint = new URL(
            `https://aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location || 'us-central1'}/publishers/${publisherName}/models`
          );
          
          const publisherResponse = await fetch(publisherModelsEndpoint.toString(), {
            method: 'GET',
            headers: {
              Authorization: headers.Authorization!,
              'Content-Type': 'application/json',
            },
          });
          
          if (publisherResponse.ok) {
            const publisherData = await publisherResponse.json() as { models?: Array<Record<string, unknown>> };
            if (publisherData.models && Array.isArray(publisherData.models)) {
              const converted = publisherData.models
                .map((model) => this.convertVertexAIModel(model, publisherName))
                .filter((m): m is ProviderModel => Boolean(m));
              allModels.push(...converted);
            }
          }
        } catch (error) {
          this.log.warn({ publisher, error }, 'Failed to fetch models from publisher');
        }
      }
      
      if (allModels.length > 0) {
        this.log.info({ models: allModels.length, publishers: payload.publishers.length }, 'Successfully fetched foundation models from Vertex AI Model Garden');
        return allModels;
      }
    }
    
    // Fallback: if no publishers, try direct models endpoint (Google AI Studio)
    const models = payload.models ?? [];

    return models
      .map((model) => this.convertGoogleAIModel(model))
      .filter((converted): converted is ProviderModel => Boolean(converted));
  }

  /**
   * Execute gcloud command to get access token
   */
  private async executeGcloudCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use PowerShell to execute gcloud on Windows to avoid spawn issues.
      // `spawn` imported at module scope (top of file) — no more `require()`,
      // which means the returned ChildProcess has its real types and the
      // `.stdout.on('data', ...)` chain is no longer typed `any`.
      const gcloud = spawn(
        process.platform === 'win32' ? 'powershell' : 'gcloud',
        process.platform === 'win32' ? ['-Command', `& { gcloud ${args.join(' ')} }`] : args,
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, GOOGLE_CLOUD_PROJECT: this.projectId },
        }
      );

      let stdout = '';
      let stderr = '';

      gcloud.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      gcloud.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      gcloud.on('close', (code: number | null) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`gcloud command failed: ${stderr}`));
        }
      });

      gcloud.on('error', (error: Error) => {
        reject(new Error(`Failed to execute gcloud: ${error.message}`));
      });
    });
  }

  /**
   * Convert Vertex AI Model Garden model to our ProviderModel format
   */
  private convertVertexAIModel(
    model: {
      name?: string;
      modelId?: string;
      displayName?: string;
      description?: string;
      [key: string]: unknown;
    },
    publisherName: string
  ): ProviderModel | null {
    try {
      // Safely extract model name - use type guards instead of assertions
      let modelName: string | undefined;
      if (typeof model.name === 'string') {
        modelName = model.name;
      } else if (typeof model.modelId === 'string') {
        modelName = model.modelId;
      }
      if (!modelName) {
        return null;
      }

      // Extract model ID (format: publishers/google/models/gemini-1.5-pro or just gemini-1.5-pro)
      const modelId = modelName.includes('/') 
        ? modelName.split('/').pop() || modelName
        : modelName;
      
      const baseName = modelId.replace('models/', '');
      const supportedMethods = this.extractSupportedMethods(model);
      const extractorOutput = this.extractCapabilitiesFromModelName(baseName, supportedMethods);
      const capabilities = applyInferenceFallback(
        baseName,
        { supportedMethods, description: model.description, displayName: model.displayName },
        extractorOutput,
      );
      const { contextWindow, maxOutputTokens, pricing } = this.estimateVertexModelSpecs(baseName);

      return {
        id: baseName,
        name: baseName,
        displayName: model.displayName || this.formatDisplayName(baseName),
        contextWindow,
        maxOutputTokens,
        capabilities,
        pricing,
        metadata: {
          provider: 'vertex-ai',
          publisher: publisherName,
          source: 'vertex-ai-model-garden',
          description: model.description || model.displayName || '',
          version: this.extractVersion(baseName),
          supportedGenerationMethods: supportedMethods,
          multimodal: capabilities.includes('vision') || capabilities.includes('multimodal'),
          apiEndpoint: 'aiplatform.googleapis.com',
          projectId: this.projectId,
          location: this.location,
        },
      };
    } catch (error) {
      this.log.warn({ model, error }, 'Failed to convert Vertex AI Model Garden model');
      return null;
    }
  }

  /**
   * Convert Google AI Studio model to our ProviderModel format
   */
  private convertGoogleAIModel(
    model: {
      name?: string;
      displayName?: string;
      description?: string;
      [key: string]: unknown;
    }
  ): ProviderModel | null {
    try {
      const modelName = typeof model.name === 'string' ? model.name : '';
      if (!modelName) {
        return null;
      }

      const baseName = modelName.replace('models/', '');
      const supportedMethods = this.extractSupportedMethods(model);
      const extractorOutput = this.extractCapabilitiesFromModelName(baseName, supportedMethods);
      const capabilities = applyInferenceFallback(
        baseName,
        { supportedMethods, description: model.description, displayName: model.displayName },
        extractorOutput,
      );
      const { contextWindow, maxOutputTokens, pricing } = this.estimateVertexModelSpecs(baseName);

      return {
        id: baseName,
        name: baseName,
        displayName: this.formatDisplayName(baseName),
        contextWindow,
        maxOutputTokens,
        capabilities,
        pricing,
        metadata: {
          provider: 'vertex_ai',
          source: 'google-ai-api',
          description: model.description || '',
          version: this.extractVersion(baseName),
          supportedGenerationMethods: supportedMethods,
          multimodal: capabilities.includes('vision') || capabilities.includes('multimodal'),
          apiEndpoint: 'generativelanguage.googleapis.com',
          projectId: this.projectId,
          location: this.location,
        },
      };
    } catch (error) {
      this.log.warn({ model, error }, 'Failed to convert Google AI model');
      return null;
    }
  }

  private formatDisplayName(modelId: string): string {
    return modelId
      .split(/[-_]/)
      .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Extract provider methods when available.
   */
  private extractSupportedMethods(model: Record<string, unknown>): string[] {
    const candidates = [
      model.supportedGenerationMethods,
      model.supportedMethods,
      model.methods,
    ];

    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) {
        continue;
      }

      const normalized = candidate
        .filter((method): method is string => typeof method === 'string')
        .map((method) => method.trim())
        .filter((method) => method.length > 0);

      if (normalized.length > 0) {
        return normalized;
      }
    }

    return [];
  }

  /**
   * Extract capabilities from model name + provider-declared methods.
   * Method metadata is preferred over heuristics when available.
   */
  private extractCapabilitiesFromModelName(
    modelName: string,
    supportedMethods: string[] = []
  ): ModelCapability[] {
    const capabilities = new Set<ModelCapability>();
    const name = modelName.toLowerCase();
    const methods = supportedMethods.map((method) => method.toLowerCase());
    const hasMethodMetadata = methods.length > 0;

    const isLikelyEmbeddingModel = name.includes('embedding') || name.includes('embed');
    const isLikelyAudioModel =
      name.includes('tts') ||
      name.includes('speech') ||
      name.includes('audio') ||
      name.includes('transcrib') ||
      name.includes('voice');
    const isLikelyImageModel = name.includes('imagen') || name.includes('image');
    const isLikelyVideoModel = name.includes('veo') || name.includes('video');
    const isLikelyNonChatModel =
      isLikelyEmbeddingModel || isLikelyAudioModel || isLikelyImageModel || isLikelyVideoModel;

    const supportsGenerateContent =
      methods.includes('generatecontent') || methods.includes('streamgeneratecontent');
    const supportsEmbeddings = methods.some(
      (method) => method === 'embedcontent' || method === 'batchembedcontents'
    );

    if (supportsEmbeddings || isLikelyEmbeddingModel) {
      capabilities.add('embedding');
      capabilities.add('embeddings');
    }

    if (isLikelyAudioModel) {
      capabilities.add('audio');
      capabilities.add('text_to_speech');
      capabilities.add('tts');
    }

    if (isLikelyImageModel) {
      capabilities.add('image_generation');
    }

    if (isLikelyVideoModel) {
      capabilities.add('video_generation');
    }

    const canInferGenerativeByName =
      !hasMethodMetadata &&
      !isLikelyNonChatModel &&
      (name.includes('gemini') ||
        name.includes('claude') ||
        name.includes('gpt') ||
        name.includes('chat') ||
        name.includes('instruct'));

    if ((supportsGenerateContent && !isLikelyNonChatModel) || canInferGenerativeByName) {
      capabilities.add('text_generation');
      capabilities.add('chat');
      capabilities.add('streaming');
    }

    const hasGenerativeCapability =
      capabilities.has('chat') || capabilities.has('text_generation');

    if (
      hasGenerativeCapability &&
      (name.includes('vision') ||
        name.includes('pro-vision') ||
        name.includes('multimodal') ||
        name.includes('1.5') ||
        name.includes('2.0'))
    ) {
      capabilities.add('vision');
      capabilities.add('multimodal');
    }

    if (
      hasGenerativeCapability &&
      (name.includes('pro') || name.includes('1.5') || name.includes('2.0'))
    ) {
      capabilities.add('function_calling');
      capabilities.add('tool_use');
    }

    if (hasGenerativeCapability && (name.includes('code') || name.includes('coder'))) {
      capabilities.add('code_generation');
    }

    return Array.from(capabilities);
  }

  /**
   * Estimate Vertex AI model specifications
   */
  private estimateVertexModelSpecs(modelName: string): {
    contextWindow: number;
    maxOutputTokens: number;
    pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
  } {
    const name = modelName.toLowerCase();

    let contextWindow = 32768;
    let maxOutputTokens = 2048;
    let inputCost = 0.00125;
    let outputCost = 0.005;

    if (name.includes('gemini-1.5')) {
      contextWindow = name.includes('flash') ? 1048576 : 2097152;
      maxOutputTokens = 8192;
      inputCost = name.includes('flash') ? 0.075 : 3.5;
      outputCost = name.includes('flash') ? 0.3 : 10.5;
    } else if (name.includes('gemini-2.0')) {
      contextWindow = 4194304;
      maxOutputTokens = 16384;
      inputCost = 5.0;
      outputCost = 15.0;
    } else if (name.includes('claude')) {
      contextWindow = 200000;
      maxOutputTokens = 4096;
      inputCost = 3.0;
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
   * Extract version from model name
   */
  private extractVersion(modelName: string): string {
    const versionMatch = modelName.match(/(\d+\.\d+)/);
    return versionMatch ? versionMatch[1] : 'latest';
  }

  /**
   * Fallback models when API is not available
   * Returns empty array - models should be discovered dynamically
   */

  async validateModel(modelId: string): Promise<boolean> {
    return this.models.some((model) => model.id === modelId);
  }
}
