// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Anthropic Provider Adapter
 * Production-ready implementation for Claude models
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderAdapter,
  type ProviderConfig,
  type HealthCheckResult,
} from '../base/provider-adapter';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  Tool,
  ToolCall,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  Provider,
} from '@/types';
import type {
  ModerationRequest,
  ModerationResponse,
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
} from '@/types/model-client';
import { logger } from '@/utils/logger';
import { getModelsByProvider } from '@/services/model-catalog-service';

/**
 * Anthropic model definitions with accurate pricing (as of Nov 2024)
 */

/**
 * Anthropic Provider Adapter Implementation
 */
export class AnthropicAdapter extends ProviderAdapter {
  private client: Anthropic;
  // Scale-to-100k Phase 2 (issue #152): one SDK client per pooled account
  // (ANTHROPIC_API_KEY_POOL), or just [this.client] with none configured.
  // See the OpenAI adapter for the original reference implementation.
  private clientPool: Anthropic[];
  private providerLog = logger.child({ provider: 'anthropic' });

  constructor(config: ProviderConfig) {
    super('anthropic', 'Anthropic', config);
    this.validateConfig();

    const buildClient = (apiKey: string) =>
      new Anthropic({
        apiKey,
        baseURL: config.baseUrl,
        timeout: config.timeout || 60000,
        maxRetries: 0, // We handle retries ourselves
      });

    const pooledKeys = this.getAllApiKeys();
    this.clientPool = pooledKeys.length > 0 ? pooledKeys.map(buildClient) : [buildClient(config.apiKey)];
    this.client = this.clientPool[0]!;
  }

  /** Round-robins across clientPool when ANTHROPIC_API_KEY_POOL is configured. */
  private getRequestClient(): Anthropic {
    if (this.clientPool.length <= 1) return this.client;
    return this.clientPool[this.nextPoolIndex(this.clientPool.length)]!;
  }

  /** Rough token-cost estimate fed into the TPM budget check (issue #152). */
  private estimateTokenCost(request: ChatRequest): number {
    const promptChars = request.messages.reduce((sum, message) => {
      const content =
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      return sum + content.length;
    }, 0);
    return Math.ceil(promptChars / 4) + (request.max_tokens || 4096);
  }

  /**
   * Get provider information
   */
  async getProvider(): Promise<Provider> {
    const models = await this.getModels();
    const health = await this.healthCheck();

    return {
      id: 'anthropic',
      name: 'anthropic',
      displayName: 'Anthropic',
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
    const models = await getModelsByProvider('anthropic');

    if (!models.length) {
      logger.warn('No models registered in catalog for Anthropic');
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
      throw new Error('No Anthropic models available - check provider configuration');
    }

    // Filter available models
    const availableModels = models.filter(m =>
      m.status === 'active' &&
      (m.capabilities?.includes('chat') || m.capabilities?.includes('text_generation'))
    );

    if (availableModels.length === 0) {
      throw new Error('No available Anthropic models with chat capability');
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

  /**
   * Chat completion (non-streaming)
   */
  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const startTime = Date.now();

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
      const { system, messages } = this.convertMessages(request.messages, normalizedModel);

      const response = await this.withRetry(async () => {
        const params: Anthropic.MessageCreateParams = {
          model: normalizedModel,
          max_tokens: request.max_tokens || 4096,
          temperature: request.temperature,
          top_p: request.top_p,
          system,
          messages,
          stream: false,
        };
        // Add tools if provided (Anthropic SDK supports tools in MessageCreateParams)
        if (request.tools && request.tools.length > 0) {
          params.tools = this.convertTools(request.tools);
        }
        return await this.getRequestClient().messages.create(params);
      }, 'chat completion', this.estimateTokenCost(request));

      const duration = Date.now() - startTime;

      this.providerLog.debug(
        {
          model: response.model,
          usage: response.usage,
          duration,
          stopReason: response.stop_reason,
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
      const { system, messages } = this.convertMessages(request.messages, normalizedModel);

      const stream = await this.withRetry(async () => {
        const params: Anthropic.MessageCreateParams = {
          model: normalizedModel,
          max_tokens: request.max_tokens || 4096,
          temperature: request.temperature,
          top_p: request.top_p,
          system,
          messages,
          stream: true,
        };
        // Add tools if provided (Anthropic SDK supports tools in MessageCreateParams)
        if (request.tools && request.tools.length > 0) {
          params.tools = this.convertTools(request.tools);
        }
        return await this.getRequestClient().messages.create(params);
      }, 'streaming chat completion', this.estimateTokenCost(request));

      let firstChunk = true;

      for await (const event of stream) {
        if (firstChunk) {
          const duration = Date.now() - startTime;
          this.providerLog.debug({ duration }, 'First chunk received');
          firstChunk = false;
        }

        // Only yield content deltas
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield this.convertStreamChunk(event, modelToUse);
        }
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
   * Note: Anthropic doesn't support embeddings natively
   */
  async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error('Anthropic does not support embeddings. Use OpenAI or Google for embeddings.');
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      // Simple health check using a minimal request
      await this.client.messages.create({
        model: await this.getDefaultModel(), // Use dynamic default model
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      });

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
      return await this.getDefaultModel();
    }

    const models = await this.getModels();
    const modelMap = new Map(models.map(m => [m.id.toLowerCase(), m.id]));

    // Try exact match first
    if (modelMap.has(modelId.toLowerCase())) {
      return modelMap.get(modelId.toLowerCase())!.replace(/^anthropic[-_]/, '');
    }

    // Try fuzzy match (remove dashes, underscores, dots)
    const normalized = modelId.toLowerCase().replace(/[-_.]/g, '');
    for (const [key, value] of modelMap.entries()) {
      if (key.replace(/[-_.]/g, '') === normalized) {
        return value.replace(/^anthropic[-_]/, '');
      }
    }

    // Try partial match (e.g., "claude3" matches "claude-3-5-sonnet")
    // Prefer longer/more specific matches (e.g., "sonnet" should match "claude-3-5-sonnet" over "claude-3-sonnet")
    const partialMatches: Array<{ key: string; value: string; specificity: number }> = [];
    
    for (const [key, value] of modelMap.entries()) {
      const keyNormalized = key.replace(/[-_.]/g, '');
      const inputNormalized = normalized;

      if (keyNormalized.includes(inputNormalized) || inputNormalized.includes(keyNormalized)) {
        // Calculate specificity: prefer longer model names and exact substring matches
        const specificity = key.length + (keyNormalized.includes(inputNormalized) ? 1000 : 0);
        partialMatches.push({ key, value, specificity });
      }
    }
    
    // Sort by specificity (descending) and return the best match
    if (partialMatches.length > 0) {
      partialMatches.sort((a, b) => b.specificity - a.specificity);
      return partialMatches[0].value.replace(/^anthropic[-_]/, '');
    }

    // Return as-is if no match (let provider handle it or fail gracefully)
    logger.warn({ modelId, availableModels: Array.from(modelMap.keys()) }, 'Model not found in available models');
    return modelId;
  }

  /**
   * Convert our messages to Anthropic format
   */
  private convertMessages(
    messages: ChatMessage[],
    model: string
  ): {
    system?: string;
    messages: Anthropic.MessageParam[];
  } {
    // Extract system message (Anthropic handles it separately)
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    const requiresStructuredContent = this.requiresStructuredContent(model);

    const anthropicMessages: Anthropic.MessageParam[] = conversationMessages.map((msg) => {
      // Handle array content (multimodal)
      if (Array.isArray(msg.content)) {
        return {
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content.map((item) => {
            if (item.type === 'text') {
              return { type: 'text', text: item.text };
            } else if (item.type === 'image_url') {
              // Extract base64 image from data URL
              const match = item.image_url.url.match(/^data:image\/(\w+);base64,(.+)$/);
              if (match) {
                const imageType = match[1].toLowerCase();
                // Map to valid Anthropic media types
                let mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
                if (imageType === 'png') {
                  mediaType = 'image/png';
                } else if (imageType === 'jpeg' || imageType === 'jpg') {
                  mediaType = 'image/jpeg';
                } else if (imageType === 'gif') {
                  mediaType = 'image/gif';
                } else if (imageType === 'webp') {
                  mediaType = 'image/webp';
                } else {
                  // Default to jpeg for unknown types
                  mediaType = 'image/jpeg';
                }
                return {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: match[2],
                  },
                };
              }
              // If it's a URL, we need to fetch it (Anthropic requires base64)
              throw new Error('Image URLs must be base64 encoded for Anthropic');
            }
            return item;
          }),
        };
      }

      // Handle string content
      const textContent = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');

      return {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: requiresStructuredContent
          ? [
              {
                type: 'text',
                text: textContent,
              },
            ]
          : textContent,
      };
    });

    return {
      system: this.normalizeSystemContent(systemMessage?.content),
      messages: anthropicMessages,
    };
  }

  private normalizeSystemContent(content: ChatMessage['content'] | undefined): string | undefined {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }
          if (item && typeof item === 'object' && 'type' in item && item.type === 'text') {
            const textItem = item as { type: 'text'; text?: string };
            return textItem.text ?? '';
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }

    return undefined;
  }

  private requiresStructuredContent(model: string): boolean {
    const normalized = model.toLowerCase();
    const structuredModels = [
      'claude-3-5',
      'claude-3.5',
      'claude-3-sonnet',
      'claude-3-opus',
      'claude-3-haiku',
    ];

    return structuredModels.some((name) => normalized.includes(name));
  }

  /**
   * Convert tools to Anthropic format
   */
  private convertTools(tools: Tool[]): Anthropic.ToolUnion[] {
    return tools.map((tool) => {
      if (tool.type !== 'function' || !tool.function) {
        throw new Error('Invalid tool format: expected function tool');
      }
      return {
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters as Anthropic.Tool.InputSchema,
      };
    });
  }

  /**
   * Convert Anthropic response to our format
   */
  private convertResponse(response: Anthropic.Message, requestedModel: string): ChatResponse {
    // Type guards for content blocks
    function isTextBlock(block: unknown): block is Anthropic.TextBlock {
      return (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        (block as { type: unknown }).type === 'text' &&
        'text' in block &&
        typeof (block as { text: unknown }).text === 'string'
      );
    }
    
    // Type guard for tool use blocks
    // Anthropic SDK doesn't export ToolUseBlock, so we use a custom type guard
    type ToolUseBlockType = {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    };
    
    function isToolUseBlock(block: unknown): block is ToolUseBlockType {
      return (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        typeof (block as { type: unknown }).type === 'string' &&
        (block as { type: string }).type === 'tool_use' &&
        'id' in block &&
        typeof (block as { id: unknown }).id === 'string' &&
        'name' in block &&
        typeof (block as { name: unknown }).name === 'string' &&
        'input' in block &&
        typeof (block as { input: unknown }).input === 'object' &&
        (block as { input: unknown }).input !== null
      );
    }
    
    // Extract text content
    const textContent = response.content.find(isTextBlock);

    // Extract tool uses with type guard
    const toolUses: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> = [];
    for (const block of response.content) {
      if (isToolUseBlock(block)) {
        // Type guard ensures block is ToolUseBlockType, so we can safely access properties
        const toolUseBlock = block as ToolUseBlockType;
        toolUses.push({
          type: 'tool_use',
          id: toolUseBlock.id,
          name: toolUseBlock.name,
          input: toolUseBlock.input,
        });
      }
    }

    return {
      id: response.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textContent?.text || '',
            tool_calls:
              toolUses.length > 0
                ? toolUses.map((tu) => ({
                    id: tu.id,
                    type: 'function' as const,
                    function: {
                      name: tu.name,
                      arguments: JSON.stringify(tu.input),
                    },
                  } satisfies ToolCall))
                : undefined,
          },
          finish_reason: response.stop_reason ? this.mapStopReason(response.stop_reason) : null,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  /**
   * Convert streaming chunk to our format
   */
  private convertStreamChunk(event: Anthropic.ContentBlockDeltaEvent & { delta?: { text?: string } }, requestedModel: string): ChatResponse {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          delta: {
            content: event.delta.text,
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    };
  }

  /**
   * Map Anthropic stop reason to OpenAI format
   */
  private mapStopReason(
    stopReason: string | null
  ): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
    if (!stopReason) {
      return null;
    }
    const mapping: Record<string, 'stop' | 'length' | 'tool_calls'> = {
      end_turn: 'stop',
      max_tokens: 'length',
      stop_sequence: 'stop',
      tool_use: 'tool_calls',
    };
    return mapping[stopReason] || 'stop';
  }

  /**
   * Convert Anthropic error to our format
   */
  private convertError(error: unknown): Error {
    // Check if it's an APIError (duck typing for better compatibility with mocks)
    function isAPIError(err: unknown): err is { message?: string; status?: number; type?: string; name?: string } {
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
      const message = `Anthropic API Error: ${error.message || 'Unknown error'}`;
      const newError = new Error(message);
      // Add error properties using Object.assign to avoid type assertions
      Object.assign(newError, {
        statusCode: error.status,
        code: error.type || 'anthropic_error',
      });
      return newError;
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error(`Unknown error: ${String(error)}`);
  }

  /**
   * Content Moderation
   * Anthropic Claude does not have a dedicated moderation API
   * Content safety is handled via safety settings in messages API
   */
  async moderate(_model: Model, _request: ModerationRequest): Promise<ModerationResponse> {
    // Anthropic handles content safety via safety settings in the messages API
    // There is no separate moderation endpoint like OpenAI
    throw new Error('Anthropic Claude moderation is not yet implemented. Anthropic handles content safety via safety settings in the messages API, not a separate moderation endpoint. Use OpenAI moderation or implement Anthropic safety settings integration.');
  }

  /**
   * Image Edit
   * Anthropic Claude does not have image editing capability
   */
  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('Anthropic Claude image editing is not yet implemented. Anthropic Claude does not provide image editing capabilities. Use OpenAI DALL-E for image editing.');
  }

  /**
   * Image Variation
   * Anthropic Claude does not have image variation capability
   */
  async imageVariation(_model: Model, _request: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('Anthropic Claude image variation is not yet implemented. Anthropic Claude does not provide image variation capabilities. Use OpenAI DALL-E for image variations.');
  }

  /**
   * Sanitize request for logging (remove sensitive data)
   */
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
}
