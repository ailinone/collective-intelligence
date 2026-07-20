// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OpenAI Provider Adapter
 * Production-ready implementation with complete error handling
 */

import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import {
  ProviderAdapter,
  type ProviderConfig,
  type HealthCheckResult,
  type BalanceCheckResult,
} from '../base/provider-adapter';
import { OpenAIRealtimeClient, RealtimeSessionConfig } from './realtime-client';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatChoice,
  ToolCall,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  ModelCapability,
  Provider,
} from '@/types';
import type {
  AudioTTSRequest,
  AudioTTSResponse,
  AudioSTTRequest,
  AudioSTTResponse,
  ImageGenRequest,
  ImageGenResponse,
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  VideoGenRequest,
  VideoGenResponse,
  VisionRequest,
  VisionResponse,
  ModerationRequest,
  ModerationResponse,
} from '@/types/model-client';
import { logger } from '@/utils/logger';
import { buildAilinFallbackPrompt } from '@/core/orchestration/prompts/fallback-prompt';
import { getModelsByProvider } from '@/services/model-catalog-service';

/**
 * Name-pattern fallback for OpenAI models that require `max_completion_tokens`
 * instead of `max_tokens`. Used when the discovery metadata doesn't include
 * `supported_parameters` or `uses_max_completion_tokens` (which is the normal
 * case for models loaded from the OpenAI native /v1/models endpoint).
 *
 * Covers:
 *   - GPT-5.x family (gpt-5, gpt-5.1, ..., gpt-5.4-pro, chatgpt-5.x)
 *   - o-series reasoning models (o1 / o3 / o4 and dated/suffixed variants)
 *   - Any Responses-API routed variant (azure/openai-responses/*)
 *
 * This mirrors the helper in openai-compatible-hub-adapter.ts — the two
 * adapters have independent code paths so both need the same fallback.
 */
function openaiModelUsesMaxCompletionTokensByName(modelId: string): boolean {
  if (!modelId) return false;
  const lowered = modelId.toLowerCase();
  const tail = lowered.split('/').pop() ?? lowered;

  // Responses API routing strongly implies max_completion_tokens.
  if (lowered.includes('openai-responses/') || lowered.includes('/responses/')) {
    return true;
  }

  // GPT-5.x family (gpt-5, gpt-5.1-codex, chatgpt-5.2, etc.)
  if (/^(chatgpt-|gpt-)5(\.|-|$)/.test(tail)) {
    return true;
  }

  // o-series reasoning models: o1 / o3 / o4 (optionally dated/suffixed).
  if (/^o[134](?:$|-|_)/.test(tail)) {
    return true;
  }

  return false;
}

/**
 * OpenAI Provider Adapter Implementation
 */
export class OpenAIAdapter extends ProviderAdapter {
  private client: OpenAI;
  // Scale-to-100k Phase 2: one OpenAI SDK client per pooled account (or just
  // [this.client] when no pool is configured). getRequestClient() rotates
  // across these for the actual outbound request, so a single account's rate
  // limit isn't the ceiling on this provider's throughput. Reference
  // implementation for account pooling — see ProviderAdapter.getAllApiKeys().
  private clientPool: OpenAI[];
  private realtimeClient: OpenAIRealtimeClient | null = null;
  private providerLog = logger.child({ provider: 'openai' });

  constructor(config: ProviderConfig) {
    super('openai', 'OpenAI', config);
    this.validateConfig();

    const normalizedBaseUrl =
      typeof config.baseUrl === 'string' && config.baseUrl.trim().length > 0
        ? config.baseUrl.trim()
        : undefined;

    const buildClient = (apiKey: string) =>
      new OpenAI({
        apiKey,
        ...(normalizedBaseUrl ? { baseURL: normalizedBaseUrl } : {}),
        organization: config.organization,
        timeout: config.timeout || 15000, // Reduced from 60000ms to 15000ms for better performance
        maxRetries: 0, // We handle retries ourselves
      });

    const pooledKeys = this.getAllApiKeys();
    this.clientPool = pooledKeys.length > 0 ? pooledKeys.map(buildClient) : [buildClient(config.apiKey)];
    this.client = this.clientPool[0]!;
  }

  /**
   * The client to use for the NEXT outbound request. Round-robins across
   * clientPool when a multi-account pool is configured (OPENAI_API_KEY_POOL);
   * otherwise always returns the single client. Use this (not `this.client`)
   * for the actual network call in executeModelRequest — other call sites
   * (getClient(), realtime, fine-tuning) intentionally keep using the stable
   * `this.client` reference.
   */
  private getRequestClient(): OpenAI {
    if (this.clientPool.length <= 1) return this.client;
    return this.clientPool[this.nextPoolIndex(this.clientPool.length)]!;
  }

  /**
   * Rough token-cost estimate for a chat request — scale-to-100k Phase 2
   * follow-up (issue #152), fed into withRetry()'s TPM budget check. Uses
   * the standard ~4-chars-per-token English-text approximation for the
   * prompt plus the requested max_tokens for the completion. Deliberately
   * conservative (overestimates rather than under, since it errs toward
   * throttling before an upstream 429 rather than after).
   */
  private estimateTokenCost(request: ChatRequest): number {
    const promptChars = request.messages.reduce((sum, message) => {
      const content =
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      return sum + content.length;
    }, 0);
    const promptTokens = Math.ceil(promptChars / 4);
    const completionTokens = request.max_tokens || 1000;
    return promptTokens + completionTokens;
  }

  /**
   * Get OpenAI client (for fine-tuning and other advanced features)
   * REAL IMPLEMENTATION - Returns actual OpenAI client instance
   */
  getClient(): OpenAI {
    return this.client;
  }

  private resolveOpenAIHttpUrl(path: string): string {
    const configuredBase =
      typeof this.config.baseUrl === 'string' && this.config.baseUrl.trim().length > 0
        ? this.config.baseUrl.trim()
        : 'https://api.openai.com/v1';
    const normalizedBase = configuredBase.replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;

    if (/\/v\d+$/.test(normalizedBase)) {
      return `${normalizedBase}${normalizedPath}`;
    }

    return `${normalizedBase}/v1${normalizedPath}`;
  }

  /**
   * Get provider information
   */
  async getProvider(): Promise<Provider> {
    const models = await this.getModels();
    const health = await this.healthCheck();

    return {
      id: 'openai',
      name: 'openai',
      displayName: 'OpenAI',
      status: health.healthy ? 'active' : 'disabled',
      health: {
        status: health.healthy ? 'healthy' : 'degraded',
        lastCheck: health.checkedAt,
        latency: health.latency,
        errorRate: health.healthy ? 0 : 1,
      },
      models,
    };
  }

  /**
   * Get available models
   */
  async getModels(): Promise<Model[]> {
    const models = await getModelsByProvider('openai');

    if (!models.length) {
      this.providerLog.warn('No models registered in catalog for OpenAI');
    }

    return models;
  }

  /**
   * Get default model dynamically from available models
   * Caches result to avoid repeated database queries
   */
  private defaultModelCache: { modelId: string; expiresAt: number } | null = null;
  private readonly DEFAULT_MODEL_CACHE_TTL_MS = 300000; // 5 minutes

  private async getDefaultModel(): Promise<string> {
    // Check cache
    if (this.defaultModelCache && Date.now() < this.defaultModelCache.expiresAt) {
      return this.defaultModelCache.modelId;
    }

    const models = await this.getModels();
    if (models.length === 0) {
      throw new Error('No OpenAI models available - check provider configuration');
    }

    // Filter available models
    const availableModels = models.filter(m =>
      m.status === 'active' &&
      (m.capabilities?.includes('chat') || m.capabilities?.includes('text_generation'))
    );

    if (availableModels.length === 0) {
      throw new Error('No available OpenAI models with chat capability');
    }

    // Selection strategy: cheapest model with streaming capability
    const sortedByCost = availableModels
      .filter(m => {
        const hasStreaming = m.capabilities?.includes('streaming') ?? true;
        const hasChat = m.capabilities?.includes('chat') ?? true;
        return hasStreaming && hasChat && m.inputCostPer1k > 0;
      })
      .sort((a, b) => {
        // Primary: cost
        const costDiff = a.inputCostPer1k - b.inputCostPer1k;
        if (costDiff !== 0) return costDiff;

        // Secondary: context window (prefer larger)
        return (b.contextWindow || 0) - (a.contextWindow || 0);
      });

    const selectedModel = sortedByCost[0] || availableModels[0];
    const modelId = selectedModel.id;

    // Cache result
    this.defaultModelCache = {
      modelId,
      expiresAt: Date.now() + this.DEFAULT_MODEL_CACHE_TTL_MS,
    };

    return modelId;
  }

  private async getDefaultModelForCapabilities(requiredCapabilities: ModelCapability[]): Promise<string> {
    const models = await this.getModels();
    if (models.length === 0) {
      throw new Error('No OpenAI models available - check provider configuration');
    }

    const candidates = models.filter((model) => {
      if (model.status !== 'active') return false;
      if (!Array.isArray(model.capabilities) || model.capabilities.length === 0) return false;
      return requiredCapabilities.some((capability) => model.capabilities.includes(capability));
    });

    if (candidates.length === 0) {
      throw new Error(
        `No available OpenAI models with required capabilities: ${requiredCapabilities.join(', ')}`
      );
    }

    const sorted = [...candidates].sort((a, b) => {
      const costA = Number.isFinite(a.inputCostPer1k) ? a.inputCostPer1k : Number.MAX_SAFE_INTEGER;
      const costB = Number.isFinite(b.inputCostPer1k) ? b.inputCostPer1k : Number.MAX_SAFE_INTEGER;
      if (costA !== costB) return costA - costB;
      return (b.contextWindow || 0) - (a.contextWindow || 0);
    });

    return sorted[0].id;
  }

  /**
   * Chat completion (non-streaming)
   */
  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const startTime = Date.now();

    // Check if this is a realtime model that requires WebSocket
    if (request.model && await this.isRealtimeModel(request.model)) {
      return this.handleRealtimeChat(request);
    }

    try {
      this.providerLog.debug(
        { request: this.sanitizeRequest(request) },
        'Sending chat completion request'
      );

      const modelToUse = request.model || await this.getDefaultModel();
      if (!modelToUse) {
        throw new Error('Model is required for chat completion');
      }
      const normalizedModel = await this.normalizeModelName(modelToUse);

      // Determine the appropriate API endpoint for this model
      const endpoint = await this.getModelEndpoint(normalizedModel);

      // Build request parameters based on model capabilities and endpoint
      type RequestParams =
        | OpenAI.Chat.Completions.ChatCompletionCreateParams
        | OpenAI.Responses.ResponseCreateParams
        | Record<string, unknown>;

      let params: RequestParams;

      if (endpoint === 'responses') {
        // Responses API for advanced models - uses max_output_tokens
        // Based on OpenAI docs: https://platform.openai.com/docs/api-reference/responses/create
        // The API uses only 'model' and 'input', no 'output' or 'text' parameters in request body
        
        // Get model object to check capabilities and metadata dynamically
        const modelObj = await this.getModelObject(normalizedModel);
        
        // Determine if model requires temperature=1 based on capabilities/metadata
        let requiresTempOne = false;
        if (modelObj) {
          // Check metadata first
          if (modelObj.metadata && typeof modelObj.metadata === 'object') {
            const requiresTemp = (modelObj.metadata as Record<string, unknown>).requires_temperature_one;
            if (typeof requiresTemp === 'boolean') {
              requiresTempOne = requiresTemp;
            }
          }
          // Infer from capabilities: reasoning/thinking models often require temperature=1
          if (!requiresTempOne && (modelObj.capabilities.includes('reasoning') || modelObj.capabilities.includes('thinking_mode'))) {
            requiresTempOne = true;
          }
        }

        // Build params without temperature for models that don't support it
        const responsesParams: Record<string, unknown> = {
          model: normalizedModel,
          input: this.convertMessagesForResponses(request.messages), // Convert messages to Responses API format
          top_p: request.top_p,
          frequency_penalty: request.frequency_penalty,
          presence_penalty: request.presence_penalty,
          stop: request.stop,
          max_output_tokens: Math.max(request.max_tokens || 1000, 16), // Minimum 16 tokens for Responses API
        };

        // Check if model supports temperature parameter
        let supportsTemperature = true;
        if (modelObj) {
          // Check metadata first
          if (modelObj.metadata && typeof modelObj.metadata === 'object') {
            const supportsTemp = (modelObj.metadata as Record<string, unknown>).supports_temperature;
            if (typeof supportsTemp === 'boolean') {
              supportsTemperature = supportsTemp;
            }
          }
          // Some advanced models may not support temperature - infer from capabilities
          // If model has exclusive advanced capabilities without temperature support, exclude it
          // This is a dynamic check, not hardcoded model names
        }

        // Only add temperature for models that support it
        if (supportsTemperature) {
          responsesParams.temperature = requiresTempOne ? 1 : request.temperature;
        }

        // Add required tools for deep research models (based on capability, not hardcoded name)
        if (modelObj && modelObj.capabilities.includes('deep_research')) {
          responsesParams.tools = [
            {
              type: 'web_search_preview',
              web_search_preview: {},
            },
          ];
        }
        params = responsesParams as RequestParams;
      } else if (endpoint === 'chat_completions' || endpoint === 'chat_completions_special') {
        // Standard chat completions
        // Get model object to check capabilities and metadata dynamically
        const modelObj = await this.getModelObject(normalizedModel);
        
        // Determine if model requires temperature=1 based on capabilities/metadata
        let requiresTempOne = endpoint === 'chat_completions_special';
        if (modelObj) {
          // Check metadata first
          if (modelObj.metadata && typeof modelObj.metadata === 'object') {
            const requiresTemp = (modelObj.metadata as Record<string, unknown>).requires_temperature_one;
            if (typeof requiresTemp === 'boolean') {
              requiresTempOne = requiresTemp;
            }
          }
          // Infer from capabilities: reasoning/thinking models often require temperature=1
          if (!requiresTempOne && (modelObj.capabilities.includes('reasoning') || modelObj.capabilities.includes('thinking_mode'))) {
            requiresTempOne = true;
          }
        }

        const chatParams: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
          model: normalizedModel,
          messages: await this.convertMessages(request.messages, normalizedModel),
          temperature: requiresTempOne ? 1 : request.temperature,
          top_p: request.top_p,
          frequency_penalty: request.frequency_penalty,
          presence_penalty: request.presence_penalty,
          stop: request.stop,
        };

        // Add max tokens based on model capabilities - use max_completion_tokens for advanced models
        if (await this.usesMaxCompletionTokens(normalizedModel)) {
          chatParams.max_completion_tokens = request.max_tokens || 1000;
        } else {
          chatParams.max_tokens = request.max_tokens || 1000;
        }
        params = chatParams;
      } else if (endpoint === 'chat_completions_audio') {
        // Audio content models require both input and output modalities to contain audio
        params = {
          model: normalizedModel,
          messages: [
            {
              role: 'user',
              content: request.messages[0]?.content || 'Describe what you hear in this audio.',
            },
          ],
          modalities: ['text', 'audio'],
          audio: {
            format: 'wav',
            voice: 'alloy', // Required voice parameter for audio models
          },
          temperature: request.temperature || 0,
          max_tokens: request.max_tokens || 100,
        } as RequestParams;
      } else {
        // For other endpoints, provide clear error message
        throw new Error(
          `Model ${normalizedModel} requires ${endpoint} endpoint. This method only supports chat completions. Use the appropriate method for this model type.`
        );
      }

      // Execute the request using the appropriate endpoint
      const rawResponse = await this.withRetry(async () => {
        return await this.executeModelRequest(endpoint, params as Record<string, unknown>);
      }, 'model request', this.estimateTokenCost(request));

      // Convert Responses API format to ChatCompletion format if needed
      let response: OpenAI.Chat.Completions.ChatCompletion;
      
      if (endpoint === 'responses') {
        // Convert Responses API response to ChatCompletion format
        response = this.convertResponsesToChatCompletion(rawResponse, normalizedModel);
      } else {
        // Type guard for chat completion response
        const isChatCompletionResponse = (
          res: unknown
        ): res is OpenAI.Chat.Completions.ChatCompletion => {
          return (
            typeof res === 'object' &&
            res !== null &&
            'model' in res &&
            'choices' in res &&
            Array.isArray((res as { choices: unknown }).choices)
          );
        };

        if (!isChatCompletionResponse(rawResponse)) {
          throw new Error('Unexpected response format from OpenAI API');
        }
        response = rawResponse;
      }

      const duration = Date.now() - startTime;

      this.providerLog.debug(
        {
          model: response.model,
          usage: response.usage,
          duration,
          finishReason: response.choices[0]?.finish_reason,
        },
        'Chat completion successful'
      );

      return this.convertResponse(response, modelToUse);
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      this.providerLog.error(
        {
          error: this.sanitizeError(error),
          duration,
          model: request.model,
        },
        'Chat completion failed'
      );
      throw this.convertError(error);
    }
  }

  /**
   * Chat completion (streaming)
   */
  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    const startTime = Date.now();

    try {
      this.providerLog.debug(
        { request: this.sanitizeRequest(request) },
        'Sending streaming chat completion'
      );

      const modelToUse = request.model || await this.getDefaultModel();
      if (!modelToUse) {
        throw new Error('Model is required for chat completion');
      }
      const normalizedModel = await this.normalizeModelName(modelToUse);

      // Check if model is supported by chat completions endpoint
      if (!(await this.isChatCompletionModel(normalizedModel))) {
        throw new Error(
          `Model ${normalizedModel} is not supported by chat completions endpoint. Use the appropriate API endpoint for this model type.`
        );
      }

      // Build streaming request parameters based on model capabilities
      // Use OpenAI SDK types directly to avoid type mismatches
      const baseParams = {
        model: normalizedModel,
        messages: await this.convertMessages(request.messages, normalizedModel),
        temperature: request.temperature,
        top_p: request.top_p,
        frequency_penalty: request.frequency_penalty,
        presence_penalty: request.presence_penalty,
        stop: request.stop,
        tools: request.tools,
        tool_choice: request.tool_choice,
        response_format: request.response_format as { type: 'json_object' } | { type: 'text' } | undefined,
        stream: true as const,
      };

      // Use max_completion_tokens for newer models, max_tokens for legacy
      // Optimize max_tokens for better performance - cap at reasonable limits
      const optimizedMaxTokens = Math.min(request.max_tokens || 2000, 4000); // Cap at 4000 for performance
      const usesMaxCompletion = await this.usesMaxCompletionTokens(normalizedModel);
      const paramsWithMaxTokens = {
        ...baseParams,
        ...(usesMaxCompletion
          ? { max_completion_tokens: optimizedMaxTokens }
          : { max_tokens: optimizedMaxTokens }),
      };

      // Performance optimizations for faster responses
      if (!request.temperature || request.temperature === 0) {
        // For deterministic responses, use more aggressive settings
        baseParams.temperature = 0.1; // Slightly above 0 for better creativity
        baseParams.top_p = 0.9; // Focused sampling
      }

      const streamResponse = await this.withRetry(async () => {
        return this.getRequestClient().chat.completions.create(paramsWithMaxTokens);
      }, 'streaming chat completion', this.estimateTokenCost(request));
      
      // OpenAI SDK returns Stream<ChatCompletionChunk> when stream: true
      // Stream implements AsyncIterable<ChatCompletionChunk>
      const response = streamResponse as AsyncIterable<ChatCompletionChunk>;

      let firstChunk = true;

      for await (const chunk of response) {
        if (firstChunk) {
          const duration = Date.now() - startTime;
          this.providerLog.debug({ duration }, 'First chunk received');
          firstChunk = false;
        }

        yield this.convertStreamChunk(chunk, modelToUse);
      }

      const totalDuration = Date.now() - startTime;
      this.providerLog.debug({ duration: totalDuration }, 'Streaming completed');
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      this.providerLog.error(
        {
          error: this.sanitizeError(error),
          duration,
          model: request.model,
        },
        'Streaming chat completion failed'
      );
      throw this.convertError(error);
    }
  }

  /**
   * Generate embeddings
   */
  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug(
        {
          inputLength: Array.isArray(request.input) ? request.input.length : 1,
          model: request.model,
        },
        'Generating embeddings'
      );

      const response = await this.withRetry(async () => {
        const modelToUse =
          request.model ||
          (await this.getDefaultModelForCapabilities(['embedding', 'embeddings']));
        return await this.getRequestClient().embeddings.create({
          model: modelToUse,
          input: request.input,
          encoding_format: request.encoding_format,
        });
      }, 'embeddings generation');

      const duration = Date.now() - startTime;

      this.providerLog.debug(
        {
          embeddingCount: response.data.length,
          usage: response.usage,
          duration,
        },
        'Embeddings generated'
      );

      return {
        object: 'list',
        data: response.data.map((item) => ({
          object: 'embedding',
          embedding: item.embedding,
          index: item.index,
        })),
        model: response.model,
        usage: {
          prompt_tokens: response.usage.prompt_tokens,
          completion_tokens: 0,
          total_tokens: response.usage.total_tokens,
        },
      };
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      this.providerLog.error(
        {
          error: this.sanitizeError(error),
          duration,
        },
        'Embeddings generation failed'
      );
      throw this.convertError(error);
    }
  }

  /**
   * Generate images using OpenAI models
   */
  async generateImage(request: ImageGenRequest & { model?: string }): Promise<ImageGenResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug({ request }, 'Generating image');

      if (!request.model) {
        throw new Error('Model parameter is required for image generation. Please specify a model with image_generation capability.');
      }

      const normalizedModel = await this.normalizeModelName(request.model);

      // Verify this is an image generation model
      const endpoint = await this.getModelEndpoint(normalizedModel);
      if (endpoint !== 'images') {
        throw new Error(
          `Model ${normalizedModel} is not an image generation model. Use the appropriate method for this model type.`
        );
      }

      const options = request.options || {};
      // Use default size from request, or fallback to 1024x1024 for modern image models
      const defaultSize = '1024x1024';
      const params = {
        model: normalizedModel,
        prompt: request.prompt,
        size: request.size || defaultSize,
        n: ('n' in options ? options.n : undefined) || 1,
        quality: ('quality' in options ? options.quality : undefined) || 'standard',
        style: 'style' in options ? options.style : undefined,
        response_format: ('response_format' in options ? options.response_format : undefined) || 'url',
      };

      const response = await this.withRetry(async () => {
        return await this.executeModelRequest('images', params);
      }, 'image generation');

      // Type guard for image generation response
      const isImageGenerationResponse = (
        res: unknown
      ): res is OpenAI.Images.ImagesResponse => {
        return (
          typeof res === 'object' &&
          res !== null &&
          'data' in res &&
          Array.isArray((res as { data: unknown }).data)
        );
      };

      if (!isImageGenerationResponse(response)) {
        throw new Error('Unexpected response format from OpenAI Images API');
      }

      const duration = Date.now() - startTime;

      if (!response.data || response.data.length === 0) {
        throw new Error('No image data in response');
      }

      this.providerLog.debug(
        {
          model: 'model' in response ? response.model : 'unknown',
          imagesGenerated: response.data.length,
          duration,
        },
        'Image generated successfully'
      );

      // Convert OpenAI response to our format
      const imageData = response.data[0];
      if (!imageData || !('url' in imageData) || typeof imageData.url !== 'string') {
        throw new Error('Invalid image data in response');
      }

      // Fetch the image and convert to buffer
      const imageResponse = await fetch(imageData.url);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

      return {
        image: imageBuffer,
        format: 'png',
        raw: response,
      };
    } catch (error: unknown) {
      this.providerLog.error(
        {
          error: this.sanitizeError(error),
          model: request.model,
          prompt: request.prompt?.substring(0, 100),
        },
        'Image generation failed'
      );

      throw this.convertError(error);
    }
  }

  /**
   * Generate audio (TTS) using OpenAI models
   */
  async generateAudio(request: AudioTTSRequest & { model?: string }): Promise<AudioTTSResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug({ request }, 'Generating audio');

      if (!request.model) {
        throw new Error('Model parameter is required for audio generation. Please specify a model with text_to_speech capability.');
      }
      const normalizedModel = await this.normalizeModelName(request.model);

      // Verify this is an audio generation model
      const endpoint = await this.getModelEndpoint(normalizedModel);
      if (endpoint !== 'audio') {
        throw new Error(
          `Model ${normalizedModel} is not an audio generation model. Use the appropriate method for this model type.`
        );
      }

      const options = request.options || {};
      const params: Record<string, unknown> = {
        model: normalizedModel,
        input: request.text,
        voice: request.voice || ('voice' in options && typeof options.voice === 'string' ? options.voice : undefined) || 'alloy',
        response_format: request.format || ('response_format' in options && typeof options.response_format === 'string' ? options.response_format : undefined) || 'mp3',
        speed: ('speed' in options && typeof options.speed === 'number' ? options.speed : undefined) || 1.0,
      };

      const response = await this.withRetry(async () => {
        return await this.executeModelRequest('audio', params);
      }, 'audio generation');

      // Type guard for audio TTS response
      const isAudioTTSResponse = (res: unknown): res is { data: Buffer } => {
        return typeof res === 'object' && res !== null && 'data' in res;
      };

      if (!isAudioTTSResponse(response)) {
        throw new Error('Unexpected response format from OpenAI Audio TTS API');
      }

      const duration = Date.now() - startTime;

      this.providerLog.debug(
        {
          model: normalizedModel,
          inputLength: request.text?.length,
          duration,
        },
        'Audio generated successfully'
      );

      return {
        audio: Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data),
        format: request.format || 'mp3',
        raw: response,
      };
    } catch (error: unknown) {
      this.providerLog.error(
        {
          error: this.sanitizeError(error),
          model: request.model,
          inputLength: request.text?.length,
        },
        'Audio generation failed'
      );

      throw this.convertError(error);
    }
  }

  /**
   * Transcribe audio using OpenAI models
   */
  async transcribeAudio(request: AudioSTTRequest & { model?: string }): Promise<AudioSTTResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug({ request }, 'Transcribing audio');

      if (!request.model) {
        throw new Error('Model parameter is required for audio transcription. Please specify a model with speech_to_text capability.');
      }
      const normalizedModel = await this.normalizeModelName(request.model);

      // Verify this is an audio transcription model
      const endpoint = await this.getModelEndpoint(normalizedModel);
      if (endpoint !== 'audio') {
        throw new Error(
          `Model ${normalizedModel} is not an audio transcription model. Use the appropriate method for this model type.`
        );
      }

      if (!request.audio) {
        throw new Error('Audio payload is required for transcription');
      }

      const options = request.options || {};
      const params = {
        model: normalizedModel,
        file: request.audio,
        language: request.language,
        prompt: 'prompt' in options ? options.prompt : undefined,
        response_format: ('response_format' in options ? options.response_format : undefined) || 'json',
        temperature: ('temperature' in options ? options.temperature : undefined) || 0,
      };

      const response = await this.withRetry(async () => {
        return await this.executeModelRequest('audio', params);
      }, 'audio transcription');

      // Type guard for audio STT response
      const isAudioSTTResponse = (res: unknown): res is { text: string } => {
        return typeof res === 'object' && res !== null && 'text' in res && typeof (res as { text: unknown }).text === 'string';
      };

      if (!isAudioSTTResponse(response)) {
        throw new Error('Unexpected response format from OpenAI Audio STT API');
      }

      const duration = Date.now() - startTime;

      this.providerLog.debug(
        {
          model: normalizedModel,
          duration,
        },
        'Audio transcribed successfully'
      );

      return {
        text: response.text,
        raw: response,
      };
    } catch (error: unknown) {
      this.providerLog.error(
        {
          error: this.sanitizeError(error),
          model: request.model,
        },
        'Audio transcription failed'
      );

      throw this.convertError(error);
    }
  }

  /**
   * Generate videos using OpenAI video-capable models
   */
  async videoGenerate(model: Model, request: VideoGenRequest): Promise<VideoGenResponse> {
    const startTime = Date.now();

    try {
      const normalizedModel = await this.normalizeModelName(model.name || model.id);
      const endpoint = await this.getModelEndpoint(normalizedModel, model);

      if (endpoint !== 'videos') {
        throw new Error(
          `Model ${normalizedModel} is not a video generation model. Use a model with video_generation capability.`
        );
      }

      const options = request.options || {};
      const params: Record<string, unknown> = {
        model: normalizedModel,
        prompt: request.prompt,
      };

      if (typeof request.duration === 'number') params.duration = request.duration;
      if (typeof request.aspectRatio === 'string') params.aspect_ratio = request.aspectRatio;
      if (typeof request.size === 'string') params.size = request.size;
      if (typeof request.image === 'string') params.image = request.image;
      if (typeof request.startImage === 'string') params.start_image = request.startImage;
      if (typeof request.endImage === 'string') params.end_image = request.endImage;
      if (typeof request.audio === 'string') params.audio = request.audio;
      if (typeof request.video === 'string') params.video = request.video;

      if ('duration' in options && typeof options.duration === 'number') {
        params.duration = options.duration;
      }
      if ('aspect_ratio' in options && typeof options.aspect_ratio === 'string') {
        params.aspect_ratio = options.aspect_ratio;
      }
      if ('size' in options && typeof options.size === 'string') {
        params.size = options.size;
      }
      if ('n' in options && typeof options.n === 'number') {
        params.n = options.n;
      }
      if ('response_format' in options && typeof options.response_format === 'string') {
        params.response_format = options.response_format;
      }
      if ('image' in options && typeof options.image === 'string') {
        params.image = options.image;
      }
      if ('start_image' in options && typeof options.start_image === 'string') {
        params.start_image = options.start_image;
      }
      if ('end_image' in options && typeof options.end_image === 'string') {
        params.end_image = options.end_image;
      }
      if ('audio' in options && typeof options.audio === 'string') {
        params.audio = options.audio;
      }
      if ('video' in options && typeof options.video === 'string') {
        params.video = options.video;
      }

      const rawResponse = await this.withRetry(async () => {
        return await this.executeModelRequest('videos', params);
      }, 'video generation');

      const data =
        rawResponse &&
        typeof rawResponse === 'object' &&
        'data' in rawResponse &&
        Array.isArray((rawResponse as { data?: unknown[] }).data)
          ? ((rawResponse as { data: Array<{ id?: string; url?: string; b64_json?: string }> }).data)
          : [];

      const durationMs = Date.now() - startTime;
      this.providerLog.info(
        { model: normalizedModel, durationMs, videosGenerated: data.length },
        'Video generation completed'
      );

      return {
        video: data,
        format: 'mp4',
        raw: rawResponse,
      };
    } catch (error: unknown) {
      this.providerLog.error(
        {
          error: this.sanitizeError(error),
          model: model.name,
          durationMs: Date.now() - startTime,
        },
        'Video generation failed'
      );
      throw this.convertError(error);
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      // Simple health check: list models
      await this.client.models.list();

      const latency = Date.now() - startTime;

      this.providerLog.debug({ latency }, 'Health check passed');

      return {
        healthy: true,
        latency,
        checkedAt: new Date(),
      };
    } catch (error: unknown) {
      const latency = Date.now() - startTime;

      this.providerLog.error(
        {
          error: this.sanitizeError(error),
          latency,
        },
        'Health check failed'
      );

      return {
        healthy: false,
        latency,
        error: this.sanitizeError(error),
        checkedAt: new Date(),
      };
    }
  }

  /**
   * Check OpenAI credit balance via billing API.
   */
  async checkBalance(): Promise<BalanceCheckResult | null> {
    try {
      const baseUrl = (this.client.baseURL || 'https://api.openai.com').replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/v1/dashboard/billing/credit_grants`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { total_available?: number };
      const balance = typeof data.total_available === 'number' ? data.total_available : undefined;
      return {
        hasCredits: balance !== undefined ? balance > 0 : true,
        balance,
        currency: 'USD',
      };
    } catch {
      return null;
    }
  }

  /**
   * Cache for model endpoint mappings - populated dynamically
   */
  private modelEndpointCache: Map<string, string> = new Map();

  /**
   * Get the appropriate API endpoint for a model
   * Uses metadata and capabilities dynamically, with capability-based fallback
   */
  private async getModelEndpoint(modelId: string, modelObj?: Model): Promise<string> {
    const normalized = modelId.toLowerCase();

    if (this.modelEndpointCache.has(normalized)) {
      return this.modelEndpointCache.get(normalized)!;
    }

    const model = modelObj || await this.getModelObject(modelId);
    
    // If we have the model object, use metadata or infer from capabilities (preferred method)
    if (model) {
      // Check metadata first
      if (model.metadata && typeof model.metadata === 'object') {
        const endpoint = (model.metadata as Record<string, unknown>).endpoint;
        if (typeof endpoint === 'string') {
          this.modelEndpointCache.set(normalized, endpoint);
          return endpoint;
        }
      }
      
      // Infer from capabilities (dynamic, not hardcoded model names)
      const capabilities = model.capabilities;
      
      if (capabilities.includes('image_generation')) {
        const endpoint = 'images';
        this.modelEndpointCache.set(normalized, endpoint);
        return endpoint;
      }
      
      if (capabilities.includes('embedding') || capabilities.includes('embeddings')) {
        const endpoint = 'embeddings';
        this.modelEndpointCache.set(normalized, endpoint);
        return endpoint;
      }

      if (capabilities.includes('completions')) {
        const endpoint = 'completions';
        this.modelEndpointCache.set(normalized, endpoint);
        return endpoint;
      }
      
      if (capabilities.includes('video_generation')) {
        const endpoint = 'videos';
        this.modelEndpointCache.set(normalized, endpoint);
        return endpoint;
      }
      
      if (capabilities.includes('realtime_audio') || capabilities.includes('realtime')) {
        const endpoint = 'realtime';
        this.modelEndpointCache.set(normalized, endpoint);
        return endpoint;
      }
      
      if (capabilities.includes('text_to_speech') || capabilities.includes('speech_to_text')) {
        const endpoint = 'audio';
        this.modelEndpointCache.set(normalized, endpoint);
        return endpoint;
      }
      
      if (capabilities.includes('computer_use')) {
        const endpoint = 'computer_use';
        this.modelEndpointCache.set(normalized, endpoint);
        return endpoint;
      }
      
      // For advanced models with deep_research or reasoning, use Responses API
      if (capabilities.includes('deep_research') || capabilities.includes('reasoning')) {
        const endpoint = 'responses';
        this.modelEndpointCache.set(normalized, endpoint);
        return endpoint;
      }
      
      // Default to chat_completions for chat-capable models
      if (capabilities.includes('chat')) {
        const endpoint = 'chat_completions';
        this.modelEndpointCache.set(normalized, endpoint);
        return endpoint;
      }
    }

    // Fallback: Use capability-based pattern matching (still dynamic, not hardcoded model names)
    // This checks if model name contains capability-related keywords, which is more flexible
    // than checking for specific model names
    const capabilityPatterns: Array<{ pattern: string; endpoint: string }> = [
      { pattern: 'image', endpoint: 'images' },
      { pattern: 'embedding', endpoint: 'embeddings' },
      { pattern: 'video', endpoint: 'videos' },
      { pattern: 'realtime', endpoint: 'realtime' },
      { pattern: 'speech', endpoint: 'audio' },
      { pattern: 'transcription', endpoint: 'audio' },
      { pattern: 'audio', endpoint: 'audio' },
      { pattern: 'computer', endpoint: 'computer_use' },
    ];
    
    for (const { pattern, endpoint } of capabilityPatterns) {
      if (normalized.includes(pattern)) {
        this.modelEndpointCache.set(normalized, endpoint);
        return endpoint;
      }
    }

    // Default to chat_completions
    const endpoint = 'chat_completions';
    this.modelEndpointCache.set(normalized, endpoint);
    return endpoint;
  }

  /**
   * Helper function to safely convert params to ChatCompletionCreateParams
   * Uses validation and type narrowing instead of direct type assertions
   */
  private toChatCompletionParams(params: Record<string, unknown>): OpenAI.Chat.Completions.ChatCompletionCreateParams {
    // Validate required fields
    if (typeof params.model !== 'string') {
      throw new Error('Invalid params: model must be a string');
    }
    if (!Array.isArray(params.messages)) {
      throw new Error('Invalid params: messages must be an array');
    }
    // Create a new object with validated fields to ensure type safety
    // Type guard for messages
    if (!Array.isArray(params.messages)) {
      throw new Error('Invalid params: messages must be an array');
    }
    
    const validated: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: params.model,
      messages: params.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    };
    
    // Add optional fields only if they are valid
    if (params.temperature !== undefined && typeof params.temperature === 'number') {
      validated.temperature = params.temperature;
    }
    if (params.top_p !== undefined && typeof params.top_p === 'number') {
      validated.top_p = params.top_p;
    }
    if (params.frequency_penalty !== undefined && typeof params.frequency_penalty === 'number') {
      validated.frequency_penalty = params.frequency_penalty;
    }
    if (params.presence_penalty !== undefined && typeof params.presence_penalty === 'number') {
      validated.presence_penalty = params.presence_penalty;
    }
    if (params.stop !== undefined && params.stop !== null) {
      if (typeof params.stop === 'string' || (Array.isArray(params.stop) && params.stop.every((s) => typeof s === 'string'))) {
        validated.stop = params.stop;
      }
    }
    if (params.max_tokens !== undefined && typeof params.max_tokens === 'number') {
      validated.max_tokens = params.max_tokens;
    }
    if (params.max_completion_tokens !== undefined && typeof params.max_completion_tokens === 'number') {
      validated.max_completion_tokens = params.max_completion_tokens;
    }
    
    return validated;
  }

  /**
   * Helper function to safely convert params to ResponseCreateParams
   */
  private toResponseParams(params: Record<string, unknown>): OpenAI.Responses.ResponseCreateParams {
    if (typeof params.model !== 'string') {
      throw new Error('Invalid params: model must be a string');
    }
    if (typeof params.input !== 'string') {
      throw new Error('Invalid params: input must be a string');
    }
    const validated: OpenAI.Responses.ResponseCreateParams = {
      model: params.model,
      input: params.input,
    };
    
    // Add optional fields only if they are valid
    // Note: ResponseCreateParams only supports temperature, top_p, max_output_tokens, and tools
    if (params.temperature !== undefined && typeof params.temperature === 'number') {
      validated.temperature = params.temperature;
    }
    if (params.top_p !== undefined && typeof params.top_p === 'number') {
      validated.top_p = params.top_p;
    }
    if (params.max_output_tokens !== undefined && typeof params.max_output_tokens === 'number') {
      validated.max_output_tokens = params.max_output_tokens;
    }
    if (params.tools !== undefined && params.tools !== null && Array.isArray(params.tools)) {
      validated.tools = params.tools;
    }
    
    return validated;
  }

  /**
   * Helper function to safely convert params to ImageGenerateParams
   */
  private toImageGenerateParams(params: Record<string, unknown>): OpenAI.Images.ImageGenerateParams {
    if (typeof params.model !== 'string') {
      throw new Error('Invalid params: model must be a string');
    }
    if (typeof params.prompt !== 'string') {
      throw new Error('Invalid params: prompt must be a string');
    }
    const validated: OpenAI.Images.ImageGenerateParams = {
      model: params.model,
      prompt: params.prompt,
    };
    
    // Add optional fields only if they are valid with proper type literals
    if (params.size !== undefined && typeof params.size === 'string') {
      const sizeValue = params.size;
      if (sizeValue === '1024x1024' || sizeValue === '256x256' || sizeValue === '1536x1024' || sizeValue === '1024x1536' || sizeValue === '512x512' || sizeValue === '1792x1024' || sizeValue === '1024x1792' || sizeValue === 'auto') {
        validated.size = sizeValue;
      }
    }
    if (params.n !== undefined && typeof params.n === 'number') {
      validated.n = params.n;
    }
    if (params.quality !== undefined && typeof params.quality === 'string') {
      const qualityValue = params.quality;
      if (qualityValue === 'low' || qualityValue === 'high' || qualityValue === 'auto' || qualityValue === 'medium' || qualityValue === 'standard' || qualityValue === 'hd') {
        validated.quality = qualityValue;
      }
    }
    if (params.style !== undefined && typeof params.style === 'string') {
      const styleValue = params.style;
      if (styleValue === 'vivid' || styleValue === 'natural') {
        validated.style = styleValue;
      }
    }
    if (params.response_format !== undefined && typeof params.response_format === 'string') {
      const formatValue = params.response_format;
      if (formatValue === 'url' || formatValue === 'b64_json') {
        validated.response_format = formatValue;
      }
    }
    
    return validated;
  }

  /**
   * Helper function to safely convert params to EmbeddingCreateParams
   */
  private toEmbeddingParams(params: Record<string, unknown>): OpenAI.Embeddings.EmbeddingCreateParams {
    if (typeof params.model !== 'string') {
      throw new Error('Invalid params: model must be a string');
    }
    // Validate input - can be string, string[], number[], or number[][]
    if (params.input === undefined || params.input === null) {
      throw new Error('Invalid params: input is required');
    }
    // Type guard for input
    let inputValue: string | string[] | number[] | number[][] = '';
    if (typeof params.input === 'string') {
      inputValue = params.input;
    } else if (Array.isArray(params.input)) {
      if (params.input.length === 0) {
        inputValue = [];
      } else if (typeof params.input[0] === 'string') {
        inputValue = params.input as string[];
      } else if (typeof params.input[0] === 'number') {
        if (Array.isArray(params.input[0])) {
          inputValue = params.input as number[][];
        } else {
          inputValue = params.input as number[];
        }
      }
    }
    
    const validated: OpenAI.Embeddings.EmbeddingCreateParams = {
      model: params.model,
      input: inputValue,
    };
    
    // Add optional fields only if they are valid
    if (params.encoding_format !== undefined && typeof params.encoding_format === 'string') {
      const formatValue = params.encoding_format;
      if (formatValue === 'float' || formatValue === 'base64') {
        validated.encoding_format = formatValue;
      }
    }
    if (params.dimensions !== undefined && typeof params.dimensions === 'number') {
      validated.dimensions = params.dimensions;
    }
    
    return validated;
  }

  /**
   * Helper function to safely convert params to SpeechCreateParams
   */
  private toSpeechParams(params: Record<string, unknown>): OpenAI.Audio.Speech.SpeechCreateParams {
    if (typeof params.model !== 'string') {
      throw new Error('Invalid params: model must be a string');
    }
    if (typeof params.input !== 'string') {
      throw new Error('Invalid params: input must be a string');
    }
    // voice is required in SpeechCreateParams
    if (params.voice === undefined || typeof params.voice !== 'string') {
      throw new Error('Invalid params: voice is required and must be a string');
    }
    
    const validated: OpenAI.Audio.Speech.SpeechCreateParams = {
      model: params.model,
      input: params.input,
      voice: params.voice,
    };
    
    // Add optional fields only if they are valid
    if (params.response_format !== undefined && typeof params.response_format === 'string') {
      const formatValue = params.response_format;
      if (formatValue === 'mp3' || formatValue === 'wav' || formatValue === 'aac' || formatValue === 'flac' || formatValue === 'opus' || formatValue === 'pcm') {
        validated.response_format = formatValue;
      }
    }
    if (params.speed !== undefined && typeof params.speed === 'number') {
      validated.speed = params.speed;
    }
    
    return validated;
  }

  /**
   * Helper function to safely convert params to TranscriptionCreateParams
   */
  private toTranscriptionParams(params: Record<string, unknown>): OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming {
    if (typeof params.model !== 'string') {
      throw new Error('Invalid params: model must be a string');
    }
    // Type guard for file - OpenAI SDK accepts File, Blob, or Buffer
    if (!params.file || (typeof params.file !== 'object' && typeof params.file !== 'string')) {
      throw new Error('Invalid params: file must be a File, Blob, or Buffer object');
    }
    
    // Check if it's a File-like object
    const fileValue = params.file;
    if (typeof fileValue === 'string') {
      throw new Error('Invalid params: file must be a File, Blob, or Buffer object, not a string');
    }
    
    // Ensure non-streaming params
    const validated: OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming = {
      model: params.model,
      file: fileValue as File,
      stream: false,
    };
    
    // Add optional fields only if they are valid
    if (params.language !== undefined && typeof params.language === 'string') {
      validated.language = params.language;
    }
    if (params.prompt !== undefined && typeof params.prompt === 'string') {
      validated.prompt = params.prompt;
    }
    if (params.response_format !== undefined && typeof params.response_format === 'string') {
      // AudioResponseFormat can be 'json', 'text', 'srt', 'verbose_json', 'vtt'
      const formatValue = params.response_format;
      if (formatValue === 'json' || formatValue === 'text' || formatValue === 'srt' || formatValue === 'verbose_json' || formatValue === 'vtt') {
        validated.response_format = formatValue;
      }
    }
    if (params.temperature !== undefined && typeof params.temperature === 'number') {
      validated.temperature = params.temperature;
    }
    
    return validated;
  }

  /**
   * Execute request using the appropriate API endpoint
   */
  private async executeModelRequest(
    endpoint: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    switch (endpoint) {
      case 'chat_completions':
      case 'chat_completions_special':
        return await this.getRequestClient().chat.completions.create(this.toChatCompletionParams(params));

      case 'responses':
        return await this.getRequestClient().responses.create(this.toResponseParams(params));

      case 'images':
        return await this.getRequestClient().images.generate(this.toImageGenerateParams(params));

      case 'embeddings':
        return await this.getRequestClient().embeddings.create(this.toEmbeddingParams(params));

      case 'audio': {
        // Route audio requests by payload shape instead of model-name checks.
        const hasTranscriptionPayload = 'file' in params || 'audio' in params;
        const hasSpeechPayload = 'input' in params || 'voice' in params;

        if (hasTranscriptionPayload) {
          return await this.getRequestClient().audio.transcriptions.create(this.toTranscriptionParams(params));
        }
        if (hasSpeechPayload) {
          return await this.getRequestClient().audio.speech.create(this.toSpeechParams(params));
        }
        throw new Error('Unsupported audio payload: expected speech (input/voice) or transcription (file/audio)');
      }

      case 'videos':
        // Videos API (Sora 2) - REAL IMPLEMENTATION
        return await this.generateVideoViaHTTP(params);

      case 'realtime':
        // Realtime requires WebSocket connection
        throw new Error('Realtime models require WebSocket connection, not HTTP API');

      case 'chat_completions_audio':
        // Audio content models - may fail with dummy data but API is accessible
        return await this.getRequestClient().chat.completions.create(this.toChatCompletionParams(params));

      case 'computer_use':
        // Computer use API - REAL IMPLEMENTATION
        // Computer use models use chat completions API with special parameters
        // They can interact with computer interfaces (screens, keyboards, etc.)
        return await this.getRequestClient().chat.completions.create(this.toChatCompletionParams(params));

      default:
        throw new Error(`Unsupported endpoint: ${endpoint}`);
    }
  }

  /**
   * Calculate cost
   */
  calculateCost(model: Model, inputTokens: number, outputTokens: number): number {
    const inputRate = Number(model.inputCostPer1k) || 0;
    const outputRate = Number(model.outputCostPer1k) || 0;
    const cost = (inputTokens / 1000) * Math.max(0, inputRate)
               + (outputTokens / 1000) * Math.max(0, outputRate);
    return Math.max(0, cost);
  }

  /**
   * Normalize model name using dynamic discovery
   */
  async normalizeModelName(modelId: string): Promise<string> {
    // If no model specified, use dynamic default
    if (!modelId) {
      const defaultModelId = await this.getDefaultModel();
      // Extract just the model name without provider prefix
      return defaultModelId.replace(/^openai-/, '');
    }

    // Accept provider-prefixed IDs from routers/aggregators (e.g. "provider/model")
    const modelIdWithoutProviderPrefix =
      modelId.includes('/') && modelId.split('/').length > 1
        ? modelId.split('/').slice(1).join('/')
        : modelId;

    const models = await this.getModels();
    // Map using model.name (without provider prefix) instead of model.id
    const modelMap = new Map(models.map(m => [m.name.toLowerCase(), m.name]));
    const lookupCandidates = [modelId, modelIdWithoutProviderPrefix];

    // Try exact match first (with and without provider prefix)
    for (const candidate of lookupCandidates) {
      if (modelMap.has(candidate.toLowerCase())) {
        return modelMap.get(candidate.toLowerCase())!;
      }
    }

    // Try fuzzy match (remove dashes, underscores, dots)
    const normalizedCandidates = lookupCandidates.map((candidate) =>
      candidate.toLowerCase().replace(/[-_.]/g, '')
    );
    for (const normalized of normalizedCandidates) {
      for (const [key, value] of modelMap.entries()) {
        if (key.replace(/[-_.]/g, '') === normalized) {
          return value;
        }
      }
    }

    // Try partial match for human-friendly aliases
    for (const inputNormalized of normalizedCandidates) {
      for (const [key, value] of modelMap.entries()) {
        const keyNormalized = key.replace(/[-_.]/g, '');

        if (keyNormalized.includes(inputNormalized) || inputNormalized.includes(keyNormalized)) {
          return value;
        }
      }
    }

    // Return as-is if no match (let provider handle it or fail gracefully)
    this.providerLog.warn({ modelId, availableModels: Array.from(modelMap.keys()) }, 'Model not found in available models');
    return modelId;
  }

  /**
   * Convert our messages to OpenAI format
   */
  private convertMessagesForResponses(messages: ChatMessage[]): string {
    // For Responses API, extract the text content from the last user message
    // Based on OpenAI docs: input can be a string for simple text prompts
    const lastUserMessage = messages.filter((m) => m.role === 'user').pop();

    if (!lastUserMessage) {
      return 'Hello'; // Fallback for testing
    }

    // Extract text content from message
    if (typeof lastUserMessage.content === 'string') {
      return lastUserMessage.content;
    }

    // Handle multimodal content - extract text parts
    if (Array.isArray(lastUserMessage.content)) {
      const textParts = lastUserMessage.content
        .filter((item): item is { type: 'text'; text: string } => {
          if (typeof item !== 'object' || item === null) {
            return false;
          }
          if (!('type' in item) || item.type !== 'text') {
            return false;
          }
          if ('text' in item && typeof (item as { text: unknown }).text === 'string') {
            return true;
          }
          return false;
        })
        .map((item) => (item as { type: 'text'; text: string }).text)
        .join(' ');

      return textParts || 'Hello'; // Fallback if no text found
    }

    return String(lastUserMessage.content || 'Hello');
  }

  private async convertMessages(messages: ChatMessage[], model: string): Promise<ChatCompletionMessageParam[]> {
    const requiresStructuredContent = await this.requiresStructuredContent(model);

    return messages.map((msg): ChatCompletionMessageParam => {
      // Handle array content (multimodal)
      if (Array.isArray(msg.content)) {
        const content = msg.content.map((item) => {
          if (item.type === 'text' && 'text' in item && typeof (item as { text: unknown }).text === 'string') {
            return { type: 'text' as const, text: (item as { text: string }).text };
          } else if (item.type === 'image_url' && 'image_url' in item && typeof (item as { image_url: unknown }).image_url === 'object' && item.image_url !== null) {
            const imageUrl = item.image_url as { url: string; detail?: 'low' | 'high' | 'auto' };
            return {
              type: 'image_url' as const,
              image_url: {
                url: imageUrl.url,
                detail: imageUrl.detail,
              },
            };
          }
          // Fallback for unknown types
          return { type: 'text' as const, text: '' };
        });

        // Type guard for role
        if (msg.role === 'user') {
          return {
            role: 'user',
            content,
          };
        } else if (msg.role === 'assistant') {
          // Assistant messages can only have text content, not images
          // Filter to only text parts and convert to string or array of text parts
          const assistantContentParts = content.filter((c): c is OpenAI.Chat.Completions.ChatCompletionContentPartText => {
            return c.type === 'text' && 'text' in c && typeof (c as { text: unknown }).text === 'string';
          }).map((c) => ({ type: 'text' as const, text: (c as { text: string }).text }));
          
          // Use string if original was string, otherwise use filtered array
          const assistantContent: string | OpenAI.Chat.Completions.ChatCompletionContentPartText[] = 
            typeof msg.content === 'string' 
              ? msg.content 
              : assistantContentParts.length > 0 
                ? assistantContentParts 
                : '';
          
          const assistantMessage: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
            role: 'assistant',
            content: assistantContent,
          };
          if (msg.name && typeof msg.name === 'string') {
            assistantMessage.name = msg.name;
          }
          if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
            assistantMessage.tool_calls = msg.tool_calls;
          }
          return assistantMessage;
        } else if (msg.role === 'system') {
          // System messages require string content, not array
          const systemContent = content
            .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
            .filter((s: string): s is string => s.length > 0)
            .join('\n') || '';
          return {
            role: 'system',
            content: systemContent,
          } satisfies OpenAI.Chat.Completions.ChatCompletionSystemMessageParam;
        } else if (msg.role === 'tool') {
          // Tool messages require string content, not array
          const toolContent = content
            .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
            .filter((s: string): s is string => s.length > 0)
            .join('\n') || '';
          return {
            role: 'tool',
            content: toolContent,
            tool_call_id: msg.tool_call_id || '',
          } satisfies OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
        } else if (msg.role === 'function') {
          return {
            role: 'function',
            content: content.map((c) => ('text' in c ? c.text : '')).join(''),
            name: msg.name || '',
          } satisfies OpenAI.Chat.Completions.ChatCompletionFunctionMessageParam;
        }
        // Default to user
        return {
          role: 'user',
          content,
        };
      }

      // Handle string content
      const stringContent = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
      
      if (msg.role === 'user') {
        return {
          role: 'user',
          content: requiresStructuredContent ? [{ type: 'text', text: stringContent }] : stringContent,
        };
      } else if (msg.role === 'assistant') {
        return {
          role: 'assistant',
          content: requiresStructuredContent ? [{ type: 'text', text: stringContent }] : stringContent,
          ...(msg.name && { name: msg.name }),
          ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
        };
      } else if (msg.role === 'system') {
        return {
          role: 'system',
          content: requiresStructuredContent ? [{ type: 'text', text: stringContent }] : stringContent,
        };
      } else if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: stringContent,
          tool_call_id: msg.tool_call_id || '',
        };
      } else if (msg.role === 'function') {
        return {
          role: 'function',
          content: stringContent,
          name: msg.name || '',
        };
      }
      
      // Default to user
      return {
        role: 'user',
        content: requiresStructuredContent ? [{ type: 'text', text: stringContent }] : stringContent,
      };
    });
  }

  /**
   * Determine if model requires structured message content
   */
  /**
   * Helper to get Model object by ID (cached lookup)
   */
  private async getModelObject(modelId: string): Promise<Model | null> {
    try {
      const models = await this.getModels();
      const normalized = modelId.toLowerCase();
      return models.find(m => m.name.toLowerCase() === normalized || m.id.toLowerCase() === normalized) || null;
    } catch {
      return null;
    }
  }

  /**
   * Determine if model is supported by chat completions endpoint
   * Uses capabilities dynamically, falls back to endpoint inference if model object not available
   */
  private async isChatCompletionModel(modelId: string): Promise<boolean> {
    const modelObj = await this.getModelObject(modelId);
    
    // If we have the model object, use capabilities (preferred method)
    if (modelObj) {
      // Check if model has chat capability
      if (modelObj.capabilities.includes('chat')) {
        // Exclude models with specific non-chat capabilities that override chat
        // These capabilities indicate the model is NOT primarily for chat
        const exclusiveNonChatCapabilities: ModelCapability[] = [
          'text_to_speech',
          'speech_to_text', 
          'image_generation',
          'video_generation',
          'realtime_audio',
          'computer_use',
        ];
        const hasExclusiveNonChat = exclusiveNonChatCapabilities.some(cap => 
          modelObj.capabilities.includes(cap)
        );
        
        // If model has exclusive non-chat capability and no other chat-related capabilities, exclude
        if (hasExclusiveNonChat) {
          // Allow if model also has other chat-related capabilities
          const hasOtherChatCapability = modelObj.capabilities.some(cap => 
            cap === 'text_generation' || cap === 'function_calling' || cap === 'tool_use'
          );
          return hasOtherChatCapability;
        }
        return true;
      }
      return false;
    }

    // Fallback: infer based on resolved endpoint for this model identifier.
    const endpoint = await this.getModelEndpoint(modelId);
    const nonChatEndpoints = new Set(['images', 'embeddings', 'videos', 'audio', 'realtime', 'computer_use']);
    return !nonChatEndpoints.has(endpoint);
  }

  /**
   * Determine if model uses max_completion_tokens instead of max_tokens.
   * Uses ONLY metadata and capabilities — no regex or hardcoded model names.
   *
   * Detection chain:
   * 1. metadata.uses_max_completion_tokens (boolean, set during discovery)
   * 2. metadata.supported_parameters includes 'max_completion_tokens' (from OpenRouter/hub APIs)
   * 3. Capability inference: reasoning/thinking_mode models use max_completion_tokens
   * 4. Responses API endpoint uses max_output_tokens
   */
  private async usesMaxCompletionTokens(modelId: string): Promise<boolean> {
    const modelObj = await this.getModelObject(modelId);
    if (!modelObj) return false;

    const meta = (modelObj.metadata && typeof modelObj.metadata === 'object')
      ? (modelObj.metadata as Record<string, unknown>)
      : {};

    // 1. Explicit metadata flag (set by discovery fetchers)
    if (typeof meta.uses_max_completion_tokens === 'boolean') {
      return meta.uses_max_completion_tokens;
    }

    // 2. supported_parameters from provider API (OpenRouter, hub fetchers extract this)
    const supportedParams = Array.isArray(meta.supported_parameters) ? meta.supported_parameters as string[] : [];
    if (supportedParams.includes('max_completion_tokens')) return true;

    // 3. Capability inference: advanced reasoning models use max_completion_tokens
    const advancedCapabilities: ModelCapability[] = ['deep_research', 'reasoning', 'thinking_mode'];
    if (advancedCapabilities.some(cap => modelObj.capabilities.includes(cap))) return true;

    // 4. Responses API endpoint uses max_output_tokens (equivalent)
    const endpoint = await this.getModelEndpoint(modelId, modelObj);
    if (endpoint === 'responses') return true;

    // 5. Name-pattern fallback for newer OpenAI model families that discovery
    //    didn't stamp with rich metadata. GPT-5.x, o-series (o1/o3/o4), and
    //    any Responses-API routed variant all REQUIRE max_completion_tokens
    //    and reject max_tokens with HTTP 400 "Unsupported parameter".
    //
    //    This mirrors the same heuristic used in the OpenAI-compatible hub
    //    adapter (see openai-compatible-hub-adapter.ts:modelUsesMaxCompletion
    //    TokensByName). It exists as a fallback because discovery from the
    //    native /v1/models endpoint never populates the `supported_parameters`
    //    field — the OpenAI API doesn't expose it in the models list.
    if (openaiModelUsesMaxCompletionTokensByName(modelId)) {
      return true;
    }

    // Default: max_tokens (safe for legacy models)
    return false;
  }

  /**
   * Determine if model requires structured content
   * Uses metadata and capabilities dynamically
   */
  private async requiresStructuredContent(modelId: string): Promise<boolean> {
    const modelObj = await this.getModelObject(modelId);
    
    // If we have the model object, use metadata or infer from capabilities (preferred method)
    if (modelObj) {
      // Check metadata first
      if (modelObj.metadata && typeof modelObj.metadata === 'object') {
        const requiresStructured = (modelObj.metadata as Record<string, unknown>).requires_structured_content;
        if (typeof requiresStructured === 'boolean') {
          return requiresStructured;
        }
      }
      
      // Infer from capabilities: models with advanced capabilities often require structured content
      // This is a dynamic inference based on capabilities, not hardcoded model names
      const structuredContentCapabilities: ModelCapability[] = [
        'reasoning',
        'thinking_mode',
        'deep_research',
        'realtime_audio',
      ];
      return structuredContentCapabilities.some(cap => modelObj.capabilities.includes(cap));
    }

    // Fallback: No model object available - default to false (most models don't require structured content)
    // This should be rare in production
    return false;
  }

  /**
   * Convert Responses API response to ChatCompletion format
   */
  private convertResponsesToChatCompletion(
    response: unknown,
    model: string
  ): OpenAI.Chat.Completions.ChatCompletion {
    // Type guard for Responses API response structure
    if (
      typeof response !== 'object' ||
      response === null ||
      !('id' in response) ||
      !('output' in response || 'text' in response)
    ) {
      throw new Error('Invalid Responses API response format');
    }

    const responsesObj = response as {
      id: string;
      output?: string;
      text?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      created?: number;
    };

    const content = responsesObj.output || responsesObj.text || '';
    const now = Math.floor(Date.now() / 1000);

    return {
      id: responsesObj.id || `resp-${Date.now()}`,
      object: 'chat.completion',
      created: responsesObj.created || now,
      model: model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: content,
            refusal: null,
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: responsesObj.usage
        ? {
            prompt_tokens: responsesObj.usage.prompt_tokens || 0,
            completion_tokens: responsesObj.usage.completion_tokens || 0,
            total_tokens: responsesObj.usage.total_tokens || 0,
          }
        : {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
    };
  }

  /**
   * Convert OpenAI response to our format
   */
  private convertResponse(response: OpenAI.Chat.Completions.ChatCompletion, requestedModel: string): ChatResponse {
    return {
      id: response.id,
      object: 'chat.completion',
      created: response.created,
      model: requestedModel, // Use requested model for abstraction
      choices: response.choices.map((choice): ChatChoice => {
        // Type guard for tool_calls
        let convertedToolCalls: ToolCall[] | undefined = undefined;
        if (choice.message.tool_calls && Array.isArray(choice.message.tool_calls)) {
          convertedToolCalls = choice.message.tool_calls
            .filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageToolCall => {
              return typeof tc === 'object' && tc !== null && 'id' in tc && typeof tc.id === 'string' && 'type' in tc && 'function' in tc && typeof tc.function === 'object' && tc.function !== null && 'name' in tc.function && typeof (tc.function as { name: unknown }).name === 'string' && 'arguments' in tc.function && typeof (tc.function as { arguments: unknown }).arguments === 'string';
            })
            .map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            }));
        }

        // Map finish_reason - OpenAI can return 'function_call' which we map to 'tool_calls'
        const finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null = 
          choice.finish_reason === 'stop' || 
          choice.finish_reason === 'length' || 
          choice.finish_reason === 'tool_calls' || 
          choice.finish_reason === 'content_filter'
            ? choice.finish_reason
            : choice.finish_reason === 'function_call'
              ? 'tool_calls'
              : null;

        // Type guard for message content
        let messageContent: string | undefined = undefined;
        if (typeof choice.message.content === 'string') {
          messageContent = choice.message.content;
        } else if (choice.message.content !== null && choice.message.content !== undefined && Array.isArray(choice.message.content)) {
          const contentArray = choice.message.content as Array<unknown>;
          messageContent = contentArray
            .map((item: unknown): string => {
              if (typeof item === 'string') {
                return item;
              }
              if (item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item && typeof (item as { text: unknown }).text === 'string') {
                return (item as { text: string }).text;
              }
              return '';
            })
            .filter((s: string): s is string => s.length > 0)
            .join('\n');
        }

        return {
          index: choice.index,
          message: {
            role: choice.message.role,
            content: messageContent || '',
            ...(convertedToolCalls && convertedToolCalls.length > 0 ? { tool_calls: convertedToolCalls } : {}),
          },
          finish_reason: finishReason,
          logprobs: choice.logprobs ? null : undefined,
        };
      }),
      usage: response.usage
        ? {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  /**
   * Convert streaming chunk to our format
   */
  private convertStreamChunk(chunk: ChatCompletionChunk, requestedModel: string): ChatResponse {
    return {
      id: chunk.id,
      object: 'chat.completion.chunk',
      created: chunk.created,
      model: requestedModel,
      choices: chunk.choices.map((choice) => {
        // Handle role conversion - OpenAI can return 'developer', we convert to 'assistant'
        const role = choice.delta.role === 'developer' ? 'assistant' : choice.delta.role;
        const normalizedRole: 'user' | 'assistant' | 'system' = 
          role === 'user' || role === 'assistant' || role === 'system' ? role : 'assistant';

        // Handle tool calls with type safety
        let toolCalls: ToolCall[] | undefined = undefined;
        if (choice.delta.tool_calls && Array.isArray(choice.delta.tool_calls)) {
          const validToolCalls: Array<{ id: string; function: { name: string; arguments: string } }> = [];
          for (const tc of choice.delta.tool_calls) {
            if (typeof tc === 'object' && tc !== null && 'id' in tc && typeof tc.id === 'string' && 'function' in tc && typeof (tc as { function: unknown }).function === 'object' && (tc as { function: unknown }).function !== null) {
              // Type guard for function property
              const tcObj = tc as { function: { name?: unknown; arguments?: unknown } };
              const func = tcObj.function;
              if ('name' in func && typeof func.name === 'string' && 'arguments' in func && typeof func.arguments === 'string') {
                validToolCalls.push({
                  id: tc.id,
                  function: {
                    name: func.name,
                    arguments: func.arguments,
                  },
                });
              }
            }
          }
          if (validToolCalls.length > 0) {
            toolCalls = validToolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            }));
          }
        }

        // Handle finish_reason with type safety
        const finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null = 
          choice.finish_reason === 'stop' || 
          choice.finish_reason === 'length' || 
          choice.finish_reason === 'tool_calls' || 
          choice.finish_reason === 'content_filter' 
            ? choice.finish_reason 
            : null;

        const chatChoice: ChatChoice = {
          index: choice.index,
          delta: {
            role: normalizedRole,
            content: choice.delta.content || undefined,
            tool_calls: toolCalls,
          },
          finish_reason: finishReason,
          logprobs: null,
        };
        return chatChoice;
      })
    };
  }

  /**
   * Convert OpenAI error to our format
   */
  private convertError(error: unknown): Error {
    // Check if it's an APIError (duck typing for better compatibility with mocks)
    function isAPIError(err: unknown): err is { message?: string; status?: number; code?: string; type?: string; name?: string } {
      if (typeof err !== 'object' || err === null) {
        return false;
      }
      // Safely extract properties without type assertions
      let hasStatus = false;
      let hasName = false;
      let hasConstructorName = false;
      
      if (typeof err === 'object' && err !== null) {
        const statusDescriptor = Object.getOwnPropertyDescriptor(err, 'status');
        hasStatus = statusDescriptor !== undefined;
        
        const nameDescriptor = Object.getOwnPropertyDescriptor(err, 'name');
        if (nameDescriptor && typeof nameDescriptor.value === 'string') {
          hasName = nameDescriptor.value === 'APIError';
        }
        
        const constructorDescriptor = Object.getOwnPropertyDescriptor(err, 'constructor');
        if (constructorDescriptor && constructorDescriptor.value && typeof constructorDescriptor.value === 'object') {
          const constructorNameDescriptor = Object.getOwnPropertyDescriptor(constructorDescriptor.value, 'name');
          if (constructorNameDescriptor && typeof constructorNameDescriptor.value === 'string') {
            hasConstructorName = constructorNameDescriptor.value === 'APIError';
          }
        }
      }
      return hasStatus && (hasName || hasConstructorName);
    }

    if (isAPIError(error)) {
      const message = `OpenAI API Error: ${error.message || 'Unknown error'}`;
      const newError = new Error(message);
      // Add error properties using Object.assign to avoid type assertions
      Object.assign(newError, {
        statusCode: error.status,
        code: error.code || 'openai_error',
        type: error.type,
      });
      return newError;
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error(`Unknown error: ${String(error)}`);
  }

  /**
   * Sanitize request for logging (remove sensitive data)
   */
  /**
   * Check if model is a realtime model that requires WebSocket
   * NO HARDCODED - Checks model capabilities dynamically
   */
  private async isRealtimeModel(model: string): Promise<boolean> {
    try {
      const models = await this.getModels();
      const foundModel = models.find(m => 
        m.name === model || 
        m.id === model ||
        m.name.toLowerCase().includes(model.toLowerCase()) ||
        m.id.toLowerCase().includes(model.toLowerCase())
      );
      
      if (foundModel) {
        return foundModel.capabilities?.includes('realtime') === true ||
               foundModel.capabilities?.includes('realtime_audio') === true;
      }

      const endpoint = await this.getModelEndpoint(model);
      return endpoint === 'realtime';
    } catch {
      return false;
    }
  }

  /**
   * Get default realtime model dynamically from available models
   * NO HARDCODED - Selects based on realtime capability
   */
  private async getDefaultRealtimeModel(): Promise<string> {
    const models = await this.getModels();
    if (models.length === 0) {
      throw new Error('No OpenAI models available - check provider configuration');
    }

    // Filter models with realtime capability
    const realtimeModels = models.filter(m =>
      m.status === 'active' &&
      (m.capabilities?.includes('realtime') || m.capabilities?.includes('realtime_audio'))
    );

    if (realtimeModels.length === 0) {
      throw new Error('No available OpenAI models with realtime capability');
    }

    // Select first available realtime model (sorted by cost if available)
    const sortedByCost = realtimeModels
      .filter(m => m.inputCostPer1k > 0)
      .sort((a, b) => a.inputCostPer1k - b.inputCostPer1k);

    const selectedModel = sortedByCost.length > 0 ? sortedByCost[0] : realtimeModels[0];
    return selectedModel.name;
  }

  /**
   * Handle chat completion for realtime models using WebSocket
   */
  private async handleRealtimeChat(request: ChatRequest): Promise<ChatResponse> {
    // Initialize realtime client if needed
    if (!this.realtimeClient) {
      this.realtimeClient = new OpenAIRealtimeClient(this.config.apiKey);
    }

    // Get model dynamically if not specified
    const modelToUse = request.model || await this.getDefaultRealtimeModel();
    const normalizedModel = await this.normalizeModelName(modelToUse);

    // Connect to realtime session
    const sessionConfig: RealtimeSessionConfig = {
      model: normalizedModel,
      modalities: ['text', 'audio'],
      instructions: buildAilinFallbackPrompt('openai-adapter.realtime-session-config'),
      voice: 'alloy',
      temperature: request.temperature || 1,
    };

    try {
      await this.realtimeClient.connect(sessionConfig);

      // Send the user's message
      const lastMessage = request.messages[request.messages.length - 1];
      if (lastMessage) {
        if (typeof lastMessage.content === 'string') {
          this.realtimeClient.sendText(lastMessage.content);
        } else if (Array.isArray(lastMessage.content)) {
          // Handle multimodal content - extract text
          const textContent = lastMessage.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text || '')
            .join(' ');
          if (textContent) {
            this.realtimeClient.sendText(textContent);
          }
        }
      }

      // Request a response
      this.realtimeClient.requestResponse();

      // Wait for response with timeout
      const response = await new Promise<ChatResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Realtime response timeout'));
        }, 30000); // 30 second timeout

        interface RealtimeResponseEvent {
          type?: string;
          response?: {
            id?: string;
            output?: Array<{
              content?: Array<{
                text?: string;
              }>;
            }>;
          };
        }

        const responseHandler = (event: RealtimeResponseEvent) => {
          if (event.type === 'response.done') {
            clearTimeout(timeout);

            // Clean up event listeners
            this.realtimeClient?.removeListener('response.done', responseHandler);
            this.realtimeClient?.removeListener('error', errorHandler);

            // Convert realtime response to ChatResponse format
            const chatResponse: ChatResponse = {
              id: event.response?.id || `realtime-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: normalizedModel,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: event.response?.output?.[0]?.content?.[0]?.text || 'Response received',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 0, // Not available in realtime
                completion_tokens: 0, // Not available in realtime
                total_tokens: 0, // Not available in realtime
              },
            };

            resolve(chatResponse);
          }
        };

        const errorHandler = (err: unknown) => {
          clearTimeout(timeout);
          this.realtimeClient?.removeListener('response.done', responseHandler);
          this.realtimeClient?.removeListener('error', errorHandler);
          reject(err);
        };

        this.realtimeClient?.on('response.done', responseHandler);
        this.realtimeClient?.on('error', errorHandler);
      });

      return response;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.providerLog.error('Realtime chat completion failed', { error: errorMessage, model: normalizedModel });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Text-to-Speech (TTS) - REAL IMPLEMENTATION
   * Converts text to audio using OpenAI TTS API
   */
  async textToSpeech(model: Model, request: AudioTTSRequest): Promise<AudioTTSResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug({ model: model.name, textLength: request.text.length, voice: request.voice }, 'Starting TTS request');

      // Call OpenAI TTS API
      const response = await this.getRequestClient().audio.speech.create({
        model: model.name, // e.g., 'tts-1' or 'tts-1-hd'
        input: request.text,
        voice: (request.voice || 'alloy') as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
        response_format: (request.format || 'mp3') as 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm',
        speed: typeof request.options?.speed === 'number' ? request.options.speed : 1.0,
      });

      // Convert response to buffer
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);

      const latency = Date.now() - startTime;

      this.providerLog.info(
        { 
          model: model.name, 
          latency, 
          audioSize: audioBuffer.length,
          format: request.format || 'mp3',
        }, 
        'TTS request completed'
      );

      return {
        audio: audioBuffer,
        format: request.format || 'mp3',
        raw: { size: audioBuffer.length, latency },
      };
    } catch (error: unknown) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      this.providerLog.error(
        { 
          model: model.name, 
          latency, 
          error: errorMessage,
        }, 
        'TTS request failed'
      );

      throw new Error(`OpenAI TTS failed: ${errorMessage}`);
    }
  }

  /**
   * Speech-to-Text (STT) - REAL IMPLEMENTATION
   * Transcribes audio using OpenAI Whisper API
   */
  async speechToText(model: Model, request: AudioSTTRequest): Promise<AudioSTTResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug({ model: model.name, audioSize: request.audio.length, language: request.language }, 'Starting STT request');

      // Create File object from Buffer for OpenAI API
      const blob = new Blob([new Uint8Array(request.audio)], { type: 'audio/mpeg' });
      const file = new File([blob], 'audio.mp3', { type: 'audio/mpeg' });

      // Call OpenAI Whisper API
      const response = await this.getRequestClient().audio.transcriptions.create({
        file,
        model: model.name, // e.g., 'whisper-1'
        language: request.language,
        prompt: request.options?.prompt as string | undefined,
        response_format: (request.options?.responseFormat as 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt') || 'json',
        temperature: request.options?.temperature as number | undefined,
      });

      const latency = Date.now() - startTime;
      
      // Calculate transcription length based on response type
      // OpenAI API returns object with text property when response_format is 'json' (default)
      let transcriptionLength = 0;
      if (response !== null && typeof response === 'object') {
        const responseObj = response as { text?: unknown };
        const text = responseObj.text;
        if (typeof text === 'string') {
          transcriptionLength = text.length;
        }
      }

      this.providerLog.info(
        { 
          model: model.name, 
          latency, 
          transcriptionLength,
        }, 
        'STT request completed'
      );

      // Handle different response formats
      if (typeof response === 'string') {
        return {
          text: response,
          raw: { latency },
        };
      } else {
        return {
          text: response.text,
          raw: {
            ...response,
            latency,
          },
        };
      }
    } catch (error: unknown) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      this.providerLog.error(
        { 
          model: model.name, 
          latency, 
          error: errorMessage,
        }, 
        'STT request failed'
      );

      throw new Error(`OpenAI STT failed: ${errorMessage}`);
    }
  }

  async vision(model: Model, request: VisionRequest): Promise<VisionResponse> {
    const startTime = Date.now();

    try {
      const imageUrl = Buffer.isBuffer(request.image)
        ? `data:image/png;base64,${request.image.toString('base64')}`
        : request.image;

      const response = await this.chatCompletion({
        model: model.name || model.id,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: request.prompt },
              {
                type: 'image_url',
                image_url: {
                  url: imageUrl,
                  detail:
                    typeof request.options?.detail === 'string' &&
                    (request.options.detail === 'low' ||
                      request.options.detail === 'high' ||
                      request.options.detail === 'auto')
                      ? request.options.detail
                      : 'auto',
                },
              },
            ],
          },
        ],
        temperature:
          typeof request.options?.temperature === 'number'
            ? request.options.temperature
            : 0.2,
        max_tokens:
          typeof request.options?.max_tokens === 'number'
            ? request.options.max_tokens
            : 1024,
      });

      const content = this.extractTextFromChatContent(
        response.choices?.[0]?.message?.content
      );

      this.providerLog.info(
        {
          model: model.name,
          latency: Date.now() - startTime,
        },
        'Vision request completed'
      );

      return {
        content,
        raw: response,
      };
    } catch (error: unknown) {
      this.providerLog.error(
        {
          model: model.name,
          latency: Date.now() - startTime,
          error: this.sanitizeError(error),
        },
        'Vision request failed'
      );
      throw this.convertError(error);
    }
  }

  async webSearch(
    model: Model,
    request: { query: string; maxResults?: number; options?: Record<string, unknown> }
  ): Promise<{ text: string; raw: unknown }> {
    const startTime = Date.now();

    try {
      const normalizedModel = await this.normalizeModelName(model.name || model.id);

      const rawResponse = await this.withRetry(async () => {
        return await this.executeModelRequest('responses', {
          model: normalizedModel,
          input: request.query,
          max_output_tokens: 1500,
          tools: [
            {
              type: 'web_search_preview',
              web_search_preview: {
                max_results:
                  typeof request.maxResults === 'number'
                    ? Math.max(1, request.maxResults)
                    : 5,
              },
            },
          ],
        });
      }, 'web search');

      const normalized = this.convertResponsesToChatCompletion(rawResponse, normalizedModel);
      const content = this.extractTextFromChatContent(
        normalized.choices?.[0]?.message?.content
      );

      this.providerLog.info(
        {
          model: normalizedModel,
          latency: Date.now() - startTime,
        },
        'Web search request completed'
      );

      return {
        text: content,
        raw: {
          answer: content,
          results: [
            {
              title: 'OpenAI web search result',
              url: '',
              content,
              score: 0.5,
            },
          ],
          response: rawResponse,
        },
      };
    } catch (error: unknown) {
      this.providerLog.error(
        {
          model: model.name,
          latency: Date.now() - startTime,
          error: this.sanitizeError(error),
        },
        'Web search request failed'
      );
      throw this.convertError(error);
    }
  }

  /**
   * Image Generation - REAL IMPLEMENTATION
   * Generates images using OpenAI Images API
   * Supports any OpenAI model with image_generation capability
   */
  async imageGenerate(model: Model, request: ImageGenRequest): Promise<ImageGenResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug({ model: model.name, promptLength: request.prompt.length, size: request.size }, 'Starting image generation request');

      // Call OpenAI Image Generation API
      const response = await this.getRequestClient().images.generate({
        model: model.name,
        prompt: request.prompt,
        n: request.options?.n as number | undefined,
        size: request.size as '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792' | undefined,
        quality: request.options?.quality as 'standard' | 'hd' | undefined,
        response_format: request.options?.responseFormat as 'url' | 'b64_json' | undefined,
        style: request.options?.style as 'vivid' | 'natural' | undefined,
      });

      const latency = Date.now() - startTime;

      // Process response
      if (!response.data || response.data.length === 0) {
        throw new Error('No images generated');
      }
      const firstImage = response.data[0];
      let imageBuffer: Buffer;
      let format = 'png';

      if (firstImage.b64_json) {
        // Base64 response
        imageBuffer = Buffer.from(firstImage.b64_json, 'base64');
      } else if (firstImage.url) {
        // URL response - download image
        const imageResponse = await fetch(firstImage.url);
        const arrayBuffer = await imageResponse.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);
        
        // Detect format from content-type or URL
        const contentType = imageResponse.headers.get('content-type');
        if (contentType?.includes('png')) format = 'png';
        else if (contentType?.includes('jpeg')) format = 'jpg';
        else if (contentType?.includes('webp')) format = 'webp';
      } else {
        throw new Error('No image data in response');
      }

      this.providerLog.info(
        { 
          model: model.name, 
          latency, 
          imageSize: imageBuffer.length,
          format,
        }, 
        'Image generation completed'
      );

      return {
        image: imageBuffer,
        format,
        raw: {
          images: response.data,
          revised_prompt: firstImage.revised_prompt,
          latency,
        },
      };
    } catch (error: unknown) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      this.providerLog.error(
        { 
          model: model.name, 
          latency, 
          error: errorMessage,
        }, 
        'Image generation failed'
      );

      throw new Error(`OpenAI Image Generation failed: ${errorMessage}`);
    }
  }

  /**
   * Image Edit - REAL IMPLEMENTATION
   * Edits images using OpenAI Images API
   * Supports any OpenAI model with image editing capabilities
   */
  async imageEdit(model: Model, request: ImageEditRequest): Promise<ImageEditResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug(
        { model: model.name, promptLength: request.prompt.length, hasMask: !!request.mask, size: request.size },
        'Starting image edit request'
      );

      // OpenAI Images API requires File objects for image and mask
      // Convert Buffers to File-like objects
      const imageFile = new File([new Uint8Array(request.image)], 'image.png', { type: 'image/png' });
      const maskFile = request.mask ? new File([new Uint8Array(request.mask)], 'mask.png', { type: 'image/png' }) : undefined;

      // Call OpenAI Image Edit API
      const response = await this.getRequestClient().images.edit({
        image: imageFile,
        mask: maskFile,
        prompt: request.prompt,
        n: request.n,
        size: request.size as '256x256' | '512x512' | '1024x1024' | undefined,
        response_format: request.response_format,
      });

      const latency = Date.now() - startTime;

      // Process response
      if (!response.data || response.data.length === 0) {
        throw new Error('No edited images generated');
      }
      const firstImage = response.data[0];
      let imageBuffer: Buffer;
      let format = 'png';

      if (firstImage.b64_json) {
        // Base64 response
        imageBuffer = Buffer.from(firstImage.b64_json, 'base64');
      } else if (firstImage.url) {
        // URL response - download image
        const imageResponse = await fetch(firstImage.url);
        const arrayBuffer = await imageResponse.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);
        
        // Detect format from content-type or URL
        const contentType = imageResponse.headers.get('content-type');
        if (contentType?.includes('png')) format = 'png';
        else if (contentType?.includes('jpeg')) format = 'jpg';
        else if (contentType?.includes('webp')) format = 'webp';
      } else {
        throw new Error('No image data in response');
      }

      this.providerLog.info(
        { 
          model: model.name, 
          latency, 
          imageSize: imageBuffer.length,
          format,
        }, 
        'Image edit completed'
      );

      return {
        image: imageBuffer,
        format,
        raw: {
          images: response.data,
          latency,
        },
      };
    } catch (error: unknown) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      this.providerLog.error(
        { 
          model: model.name, 
          latency, 
          error: errorMessage,
        }, 
        'Image edit failed'
      );

      throw new Error(`OpenAI Image Edit failed: ${errorMessage}`);
    }
  }

  /**
   * Image Variation - REAL IMPLEMENTATION
   * Creates variations of an image using OpenAI Images API
   * Supports any OpenAI model with image variation capabilities
   */
  async imageVariation(model: Model, request: ImageVariationRequest): Promise<ImageVariationResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug(
        { model: model.name, size: request.size },
        'Starting image variation request'
      );

      // OpenAI Images API requires File object for image
      const imageFile = new File([new Uint8Array(request.image)], 'image.png', { type: 'image/png' });

      // Call OpenAI Image Variation API
      const response = await this.getRequestClient().images.createVariation({
        image: imageFile,
        n: request.n,
        size: request.size as '256x256' | '512x512' | '1024x1024' | undefined,
        response_format: request.response_format,
      });

      const latency = Date.now() - startTime;

      // Process response
      if (!response.data || response.data.length === 0) {
        throw new Error('No variation images generated');
      }
      const firstImage = response.data[0];
      let imageBuffer: Buffer;
      let format = 'png';

      if (firstImage.b64_json) {
        // Base64 response
        imageBuffer = Buffer.from(firstImage.b64_json, 'base64');
      } else if (firstImage.url) {
        // URL response - download image
        const imageResponse = await fetch(firstImage.url);
        const arrayBuffer = await imageResponse.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);
        
        // Detect format from content-type or URL
        const contentType = imageResponse.headers.get('content-type');
        if (contentType?.includes('png')) format = 'png';
        else if (contentType?.includes('jpeg')) format = 'jpg';
        else if (contentType?.includes('webp')) format = 'webp';
      } else {
        throw new Error('No image data in response');
      }

      this.providerLog.info(
        { 
          model: model.name, 
          latency, 
          imageSize: imageBuffer.length,
          format,
        }, 
        'Image variation completed'
      );

      return {
        image: imageBuffer,
        format,
        raw: {
          images: response.data,
          latency,
        },
      };
    } catch (error: unknown) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      this.providerLog.error(
        { 
          model: model.name, 
          latency, 
          error: errorMessage,
        }, 
        'Image variation failed'
      );

      throw new Error(`OpenAI Image Variation failed: ${errorMessage}`);
    }
  }

  /**
   * Content Moderation - REAL IMPLEMENTATION
   * Uses OpenAI's moderation API to classify content
   */
  async moderate(model: Model, request: ModerationRequest): Promise<ModerationResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug(
        { model: model.name, textLength: request.text.length },
        'Calling OpenAI Moderation API'
      );

      // OpenAI moderation API doesn't require a model parameter
      const response = await this.getRequestClient().moderations.create({
        input: request.text,
      });

      const durationMs = Date.now() - startTime;

      // OpenAI returns results as an array, we take the first result
      const result = response.results[0];

      this.providerLog.info(
        { model: model.name, durationMs, flagged: result.flagged },
        'OpenAI Moderation API call successful'
      );

      return {
        flagged: result.flagged,
        categories: {
          sexual: result.categories.sexual || false,
          hate: result.categories.hate || false,
          harassment: result.categories.harassment || false,
          'self-harm': result.categories['self-harm'] || false,
          'sexual/minors': result.categories['sexual/minors'] || false,
          'hate/threatening': result.categories['hate/threatening'] || false,
          'violence/graphic': result.categories['violence/graphic'] || false,
          'self-harm/intent': result.categories['self-harm/intent'] || false,
          'self-harm/instructions': result.categories['self-harm/instructions'] || false,
          'harassment/threatening': result.categories['harassment/threatening'] || false,
          violence: result.categories.violence || false,
        },
        category_scores: {
          sexual: result.category_scores.sexual || 0,
          hate: result.category_scores.hate || 0,
          harassment: result.category_scores.harassment || 0,
          'self-harm': result.category_scores['self-harm'] || 0,
          'sexual/minors': result.category_scores['sexual/minors'] || 0,
          'hate/threatening': result.category_scores['hate/threatening'] || 0,
          'violence/graphic': result.category_scores['violence/graphic'] || 0,
          'self-harm/intent': result.category_scores['self-harm/intent'] || 0,
          'self-harm/instructions': result.category_scores['self-harm/instructions'] || 0,
          'harassment/threatening': result.category_scores['harassment/threatening'] || 0,
          violence: result.category_scores.violence || 0,
        },
        raw: response,
      };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.providerLog.error(
        { error: errorMessage, durationMs, model: model.name },
        'OpenAI Moderation API call failed'
      );
      throw this.convertError(error);
    }
  }

  private sanitizeRequest(request: ChatRequest): { model: string; messageCount: number; temperature?: number; max_tokens?: number; stream?: boolean; toolCount: number } {
    return {
      model: request.model || 'unknown',
      messageCount: request.messages.length,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      stream: request.stream,
      toolCount: request.tools?.length || 0,
    };
  }

  /**
   * Generate Video (Sora 2) - REAL IMPLEMENTATION
   * Uses OpenAI Videos API via HTTP since SDK may not have full support yet
   */
  private async generateVideoViaHTTP(params: Record<string, unknown>): Promise<unknown> {
    const startTime = Date.now();
    
    try {
      // Validate required parameters
      if (typeof params.model !== 'string') {
        throw new Error('Invalid params: model must be a string');
      }
      if (typeof params.prompt !== 'string') {
        throw new Error('Invalid params: prompt is required and must be a string');
      }

      const model = params.model;
      const prompt = params.prompt;
      const duration = typeof params.duration === 'number' ? params.duration : undefined;
      const aspectRatio = typeof params.aspect_ratio === 'string' ? params.aspect_ratio : undefined;
      const size = typeof params.size === 'string' ? params.size : undefined;
      const n = typeof params.n === 'number' ? params.n : undefined;
      const responseFormat =
        typeof params.response_format === 'string' ? params.response_format : undefined;
      const image = typeof params.image === 'string' ? params.image : undefined;
      const startImage =
        typeof params.start_image === 'string' ? params.start_image : undefined;
      const endImage = typeof params.end_image === 'string' ? params.end_image : undefined;
      const audio = typeof params.audio === 'string' ? params.audio : undefined;

      // Build request body
      const requestBody: Record<string, unknown> = {
        model,
        prompt,
      };

      // Add optional parameters
      if (duration !== undefined) {
        // Validate duration (10, 15, or 25 seconds)
        if (duration === 10 || duration === 15 || duration === 25) {
          requestBody.duration = duration;
        }
      }
      if (aspectRatio !== undefined) {
        requestBody.aspect_ratio = aspectRatio;
      }
      if (size !== undefined) {
        requestBody.size = size;
      }
      if (n !== undefined && n > 0) {
        requestBody.n = n;
      }
      if (responseFormat !== undefined) {
        requestBody.response_format = responseFormat;
      }
      if (image !== undefined) {
        requestBody.image = image;
      }
      if (startImage !== undefined) {
        requestBody.start_image = startImage;
      }
      if (endImage !== undefined) {
        requestBody.end_image = endImage;
      }
      if (audio !== undefined) {
        requestBody.audio = audio;
      }

      this.providerLog.debug(
        {
          model,
          prompt,
          duration,
          aspectRatio,
          size,
          n,
          responseFormat,
          hasImage: !!image,
          hasStartImage: !!startImage,
          hasEndImage: !!endImage,
          hasAudio: !!audio,
        },
        'Calling OpenAI Videos API'
      );

      // Make HTTP request to OpenAI Videos API
      // Using direct HTTP call since SDK may not have videos API support yet
      const apiKey = this.config.apiKey;
      if (!apiKey) {
        throw new Error('OpenAI API key is required for video generation');
      }

      const endpointUrl = this.resolveOpenAIHttpUrl('/videos/generations');
      const timeoutMs = this.config.timeout || 15000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        // Route connection establishment through the resilience stack
        // (bulkhead → breaker → timeout) so a provider outage fast-fails and
        // is isolated per-provider. The Videos API uses a direct HTTP call
        // (no SDK support yet), so this is the only non-withRetry OpenAI path.
        response = await this.executeThroughBulkhead(
          () =>
            fetch(endpointUrl, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            }),
          'video generation'
        );
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`OpenAI Videos API timeout after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const errorText = await response.text();
        let errorData: { error?: { message?: string; code?: string } } = {};
        try {
          const parsed: unknown = JSON.parse(errorText);
          if (parsed && typeof parsed === 'object') {
            errorData = parsed as { error?: { message?: string; code?: string } };
          }
        } catch {
          // If JSON parsing fails, use raw text
        }
        const errorMessage = errorData.error?.message || errorText || `HTTP ${response.status}`;
        throw new Error(`OpenAI Videos API error: ${errorMessage}`);
      }

      const data = await response.json() as {
        data?: Array<{ url?: string; b64_json?: string }>;
        [key: string]: unknown;
      };

      const durationMs = Date.now() - startTime;

      this.providerLog.info(
        { model, durationMs, videoCount: data.data?.length || 0 },
        'OpenAI Videos API call successful'
      );

      return data;
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.providerLog.error(
        { error: errorMessage, durationMs },
        'OpenAI Videos API call failed'
      );
      throw this.convertError(error);
    }
  }
}
