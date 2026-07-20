// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OpenRouter Provider Adapter
 * Unified API access to 400+ AI models from multiple providers
 */

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import OpenAI from 'openai';
import {
  ProviderAdapter,
  type ProviderConfig,
  type HealthCheckResult,
  type BalanceCheckResult,
} from '../base/provider-adapter';
import { MODERATION_ANALYZER_SYSTEM_PROMPT } from '../base/moderation-prompt';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  Model,
  Provider,
  ModelCapability,
  EmbeddingRequest,
  EmbeddingResponse,
} from '@/types';
import type {
  AudioSTTRequest,
  AudioSTTResponse,
  AudioTTSRequest,
  AudioTTSResponse,
  ImageGenRequest,
  ImageGenResponse,
  ModerationRequest,
  ModerationResponse,
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  VideoGenRequest,
  VideoGenResponse,
  VisionRequest,
  VisionResponse,
} from '@/types/model-client';
import { logger } from '@/utils/logger';
import { getProviderRegistry } from '@/providers/provider-registry';
import { inferModelCapabilities } from '@/services/model-capability-inference';

/**
 * OpenRouter-specific configuration
 */
export interface OpenRouterConfig extends ProviderConfig {
  appUrl?: string; // For HTTP-Referer header
  appName?: string; // For X-Title header
}

/**
 * OpenRouter model information from their API
 */
interface OpenRouterModel {
  id: string;
  name: string;
  description: string;
  context_length: number;
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
    tokenizer?: string;
    instruct_type?: string | null;
  };
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
    web_search?: string;
    internal_reasoning?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  top_provider: {
    context_length: number;
    max_completion_tokens: number;
    is_moderated: boolean;
  };
  supported_parameters?: string[];
  created: number;
}

/**
 * OpenRouter API response for models
 */
interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

/**
 * OpenRouter Provider Adapter Implementation
 */
export class OpenRouterAdapter extends ProviderAdapter {
  private providerLog = logger.child({ provider: 'openrouter' });

  constructor(config: OpenRouterConfig) {
    super('openrouter', 'OpenRouter', config);
    this.validateConfig();

    // Initialize HTTP client
    this.initializeClient();
  }

  /**
   * Initialize HTTP client
   */
  private initializeClient(): void {
    // OpenRouter uses standard REST API, we'll use fetch
    this.providerLog.info('OpenRouter adapter initialized');
  }

  /**
   * Validate OpenRouter-specific configuration
   */
  protected validateConfig(): void {
    const config = this.config as OpenRouterConfig;

    if (!config.apiKey) {
      throw new Error('OpenRouterAdapter requires apiKey in configuration');
    }

    // App URL and name are optional but recommended
    if (config.appUrl) {
      try {
        new URL(config.appUrl);
      } catch {
        throw new Error('Invalid appUrl format - must be a valid URL');
      }
    }
  }

  /**
   * Get provider information
   */
  async getProvider(): Promise<Provider> {
    const models = await this.getModels();
    const health = await this.healthCheck();

    return {
      id: this.name,
      name: this.displayName,
      displayName: this.displayName,
      status: health.healthy ? 'active' : 'disabled',
      health: {
        status: health.healthy ? 'healthy' : ('down' as const),
        lastCheck: new Date(),
        latency: health.latency,
      },
      models,
      metadata: {
        baseUrl: 'https://openrouter.ai/api/v1',
        totalModels: models.length,
        healthStatus: health,
        supportedFeatures: [
          'chat_completions',
          'streaming',
          'function_calling',
          'web_search',
          'structured_outputs',
          'reasoning',
        ],
      },
    };
  }

  /**
   * Get available models from OpenRouter API
   */
  async getModels(): Promise<Model[]> {
    try {
      const response = await this.makeRequest('/models', 'GET');

      if (!response.ok) {
        throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as OpenRouterModelsResponse;

      return data.data.map((model) => this.convertOpenRouterModel(model));
    } catch (error) {
      this.providerLog.error({ error }, 'Failed to fetch models from OpenRouter');
      // Return empty array on error - models will be loaded from database
      return [];
    }
  }

  /**
   * Convert OpenRouter model format to our internal Model format
   */
  private convertOpenRouterModel(orModel: OpenRouterModel): Model {
    const capabilities = this.extractCapabilities(orModel);
    const pricing = this.extractPricing(orModel);
    const originProvider = this.extractProviderFromId(orModel.id);

    return {
      id: orModel.id,
      providerId: this.name,
      provider: originProvider,
      name: orModel.id, // Use the full OpenRouter ID as name
      displayName: orModel.name,
      contextWindow: orModel.context_length,
      maxOutputTokens: orModel.top_provider?.max_completion_tokens || 4096,
      inputCostPer1k: pricing.inputCostPer1M / 1000,
      outputCostPer1k: pricing.outputCostPer1M / 1000,
      capabilities,
      performance: {
        latencyMs: 2000, // Estimated based on typical LLM latency
        throughput: 50, // Estimated throughput
        quality: 0.95, // High quality due to multiple providers
        reliability: 0.98,
      },
      status: 'active' as const,
      metadata: {
        executionProvider: this.name,
        originalProvider: originProvider,
      },
    };
  }

  /**
   * Extract capabilities from OpenRouter model
   */
  private extractCapabilities(model: OpenRouterModel): ModelCapability[] {
    return inferModelCapabilities({
      modelId: model.id,
      metadata: {
        architecture: model.architecture,
        supported_parameters: model.supported_parameters || [],
        description: model.description,
      },
    });
  }

  /**
   * Extract pricing from OpenRouter model
   */
  private extractPricing(model: OpenRouterModel): {
    inputCostPer1M: number;
    outputCostPer1M: number;
    requestCost: number;
    imageCost: number;
    webSearchCost: number;
    internalReasoningCost: number;
    inputCacheReadCost: number;
    inputCacheWriteCost: number;
  } {
    return {
      inputCostPer1M: parseFloat(model.pricing.prompt) * 1000000,
      outputCostPer1M: parseFloat(model.pricing.completion) * 1000000,
      requestCost: model.pricing.request ? parseFloat(model.pricing.request) : 0,
      imageCost: model.pricing.image ? parseFloat(model.pricing.image) : 0,
      webSearchCost: model.pricing.web_search ? parseFloat(model.pricing.web_search) : 0,
      internalReasoningCost: model.pricing.internal_reasoning
        ? parseFloat(model.pricing.internal_reasoning)
        : 0,
      inputCacheReadCost: model.pricing.input_cache_read
        ? parseFloat(model.pricing.input_cache_read)
        : 0,
      inputCacheWriteCost: model.pricing.input_cache_write
        ? parseFloat(model.pricing.input_cache_write)
        : 0,
    };
  }

  /**
   * Extract provider from model ID (e.g., "openai/gpt-4o" -> "openai")
   */
  private extractProviderFromId(modelId: string): string {
    return modelId.split('/')[0] || 'unknown';
  }

  /**
   * Extract features from OpenRouter model
   */
  private extractFeatures(model: OpenRouterModel): string[] {
    const features: string[] = [];

    if (model.architecture.tokenizer) {
      features.push(`tokenizer:${model.architecture.tokenizer}`);
    }

    if (model.architecture.instruct_type) {
      features.push(`instruct_type:${model.architecture.instruct_type}`);
    }

    if (model.top_provider?.is_moderated) {
      features.push('content_moderation');
    }

    const params = model.supported_parameters || [];
    if (params.includes('tools')) {
      features.push('function_calling');
    }
    if (params.includes('web_search') || model.pricing.web_search) {
      features.push('web_search');
    }
    if (params.includes('reasoning')) {
      features.push('reasoning');
    }

    return features;
  }

  /**
   * Health check for OpenRouter service
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const response = await this.makeRequest('/models', 'GET');

      const latency = Date.now() - startTime;
      const healthy = response.ok;

      return {
        healthy,
        latency,
        error: healthy ? undefined : `HTTP ${response.status}`,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        checkedAt: new Date(),
      };
    }
  }

  /**
   * Check OpenRouter account balance/credits.
   * Uses the /auth/key endpoint to retrieve remaining credits.
   */
  async checkBalance(): Promise<BalanceCheckResult | null> {
    try {
      const response = await this.makeRequest('/auth/key', 'GET');

      if (!response.ok) {
        this.providerLog.debug(
          { status: response.status },
          'OpenRouter balance check endpoint returned non-OK status'
        );
        return null; // Can't determine balance
      }

      const data = (await response.json()) as {
        data?: {
          limit?: number | null;
          limit_remaining?: number | null;
          usage?: number;
          is_free_tier?: boolean;
        };
      };

      const info = data?.data;
      if (!info) {
        return null;
      }

      // If limit is null, the key has unlimited credits (pay-as-you-go)
      if (info.limit === null || info.limit === undefined) {
        return { hasCredits: true, balance: undefined, currency: 'USD' };
      }

      const remaining = typeof info.limit_remaining === 'number' ? info.limit_remaining : 0;

      return {
        hasCredits: remaining > 0,
        balance: remaining,
        currency: 'USD',
      };
    } catch (error) {
      this.providerLog.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'OpenRouter balance check failed (non-critical)'
      );
      return null;
    }
  }

  /**
   * Chat completion implementation
   */
  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const startTime = Date.now();

    try {
      // Convert our internal format to OpenRouter format
      const openRouterMessages = this.convertMessagesToOpenRouter(request.messages);

      // Type-safe message content
      type OpenRouterMessageContent = 
        | string 
        | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }>;

      // Type-safe tool calls
      type OpenRouterToolCall = Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;

      interface OpenRouterMessage {
        role: string;
        content: OpenRouterMessageContent;
        tool_calls?: OpenRouterToolCall;
        tool_call_id?: string;
      }

      interface OpenRouterPayload {
        model?: string;
        messages: OpenRouterMessage[];
        stream?: boolean;
        temperature?: number;
        max_tokens?: number;
        top_p?: number;
        frequency_penalty?: number;
        presence_penalty?: number;
        tools?: Array<Record<string, unknown>>;
        tool_choice?: string | { type: string; function: { name: string } };
        response_format?: { type: string };
        plugins?: Array<{ id: string; [key: string]: unknown }>;
      }

      // Convert ChatCompletionMessageParam[] to OpenRouter format with type safety
      const openRouterMessagesFormatted: OpenRouterMessage[] = openRouterMessages.map((msg): OpenRouterMessage => {
        // Type-safe content conversion
        let contentValue: OpenRouterMessageContent = '';
        if (typeof msg.content === 'string') {
          contentValue = msg.content;
        } else if (Array.isArray(msg.content)) {
          contentValue = msg.content.map((item) => {
            if (item && typeof item === 'object' && 'type' in item) {
              if (item.type === 'text' && 'text' in item && typeof (item as { text: unknown }).text === 'string') {
                return { type: 'text' as const, text: (item as { text: string }).text };
              } else if (item.type === 'image_url' && 'image_url' in item && typeof (item as { image_url: unknown }).image_url === 'object' && item.image_url !== null) {
                const imgUrl = item.image_url as { url: string; detail?: 'low' | 'high' | 'auto' };
                return {
                  type: 'image_url' as const,
                  image_url: {
                    url: imgUrl.url,
                    detail: imgUrl.detail,
                  },
                };
              }
            }
            return { type: 'text' as const, text: String(item || '') };
          });
        } else {
          contentValue = String(msg.content || '');
        }

        const base: OpenRouterMessage = {
          role: msg.role,
          content: contentValue,
        };

        // Type-safe tool_calls conversion
        if ('tool_calls' in msg && msg.tool_calls !== undefined && Array.isArray(msg.tool_calls)) {
          base.tool_calls = msg.tool_calls as OpenRouterToolCall;
        }

        // Type-safe tool_call_id
        if ('tool_call_id' in msg && msg.tool_call_id !== undefined && typeof msg.tool_call_id === 'string') {
          base.tool_call_id = msg.tool_call_id;
        }

        return base;
      });

      const payload: OpenRouterPayload = {
        model: request.model,
        messages: openRouterMessagesFormatted,
        stream: request.stream || false,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        top_p: request.top_p,
        frequency_penalty: request.frequency_penalty,
        presence_penalty: request.presence_penalty,
      };

      // Add optional parameters based on model capabilities
      if (request.tools && request.tools.length > 0) {
        // Convert Tool[] to Array<Record<string, unknown>>
        payload.tools = request.tools.map((tool) => ({
          type: tool.type,
          function: tool.function,
        }));
        payload.tool_choice = request.tool_choice || 'auto';
      }

      if (request.response_format) {
        payload.response_format = request.response_format;
      }

      // Add web search plugin if requested
      if (request.webSearch) {
        payload.plugins = [{ id: 'web' }];
        if (request.webSearchOptions) {
          payload.plugins[0] = {
            ...payload.plugins[0],
            ...request.webSearchOptions,
          };
        }
      }

      const toPayloadRecord = (candidate: OpenRouterPayload): Record<string, unknown> => ({
        model: candidate.model,
        messages: candidate.messages,
        ...(candidate.stream !== undefined && { stream: candidate.stream }),
        ...(candidate.temperature !== undefined && { temperature: candidate.temperature }),
        ...(candidate.max_tokens !== undefined && { max_tokens: candidate.max_tokens }),
        ...(candidate.top_p !== undefined && { top_p: candidate.top_p }),
        ...(candidate.frequency_penalty !== undefined && {
          frequency_penalty: candidate.frequency_penalty,
        }),
        ...(candidate.presence_penalty !== undefined && {
          presence_penalty: candidate.presence_penalty,
        }),
        ...(candidate.tools !== undefined && { tools: candidate.tools }),
        ...(candidate.tool_choice !== undefined && { tool_choice: candidate.tool_choice }),
        ...(candidate.response_format !== undefined && {
          response_format: candidate.response_format,
        }),
        ...(candidate.plugins !== undefined && { plugins: candidate.plugins }),
      });

      const extractUnsupportedParameter = (errorText: string): string | undefined => {
        const quotedMatch = errorText.match(/Unsupported parameter:\s*'([^']+)'/i);
        if (quotedMatch?.[1]) {
          return quotedMatch[1].toLowerCase();
        }

        const genericMatch = errorText.match(
          /parameter[:\s]*["'`]?([a-z0-9_]+)["'`]?.{0,30}not supported/i
        );
        return genericMatch?.[1]?.toLowerCase();
      };

      const removeUnsupportedParameter = (
        candidate: OpenRouterPayload,
        parameterName: string
      ): boolean => {
        const normalized = parameterName.replace(/-/g, '_');
        const mapToPayloadKey: Record<string, keyof OpenRouterPayload> = {
          temperature: 'temperature',
          max_tokens: 'max_tokens',
          top_p: 'top_p',
          frequency_penalty: 'frequency_penalty',
          presence_penalty: 'presence_penalty',
          tools: 'tools',
          tool_choice: 'tool_choice',
          response_format: 'response_format',
          plugins: 'plugins',
        };
        const key = mapToPayloadKey[normalized];
        if (!key || candidate[key] === undefined) {
          return false;
        }
        delete candidate[key];
        return true;
      };

      // Route the network operation (param-stripping retry loop + parse)
      // through the resilience stack (bulkhead → breaker → timeout) so an
      // OpenRouter outage fast-fails and is isolated from other providers.
      const typedData = await this.executeThroughBulkhead(async () => {
        let response: Response | null = null;
        let errorData = '';

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          response = await this.makeRequest('/chat/completions', 'POST', toPayloadRecord(payload));
          if (response.ok) {
            break;
          }

          errorData = await response.text();
          if (response.status !== 400) {
            break;
          }

          const unsupportedParameter = extractUnsupportedParameter(errorData);
          if (!unsupportedParameter || !removeUnsupportedParameter(payload, unsupportedParameter)) {
            break;
          }

          this.providerLog.warn(
            {
              model: payload.model,
              unsupportedParameter,
              attempt,
            },
            'Retrying OpenRouter request without unsupported parameter'
          );
        }

        if (!response || !response.ok) {
          throw new Error(`OpenRouter API error: ${response?.status ?? 0} - ${errorData}`);
        }

        const data = await response.json();

        return data as {
          id: string;
          model: string;
          choices?: Array<{
            index?: number;
            message?: {
              role?: string;
              content?: string;
              tool_calls?: unknown;
            };
            finish_reason?: string;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };
      }, 'chat completion');

      return {
        id: typedData.id,
        object: 'chat.completion' as const,
        created: Math.floor(Date.now() / 1000),
        model: typedData.model,
        choices: (typedData.choices || []).map((choice) => {
          const finishReason = choice.finish_reason ? (choice.finish_reason as 'stop' | 'length' | 'tool_calls' | 'content_filter') : null;
          return {
            index: choice.index || 0,
            message: {
              role: (choice.message?.role || 'assistant') as 'function' | 'system' | 'user' | 'assistant' | 'tool',
              content: choice.message?.content || '',
              toolCalls: choice.message?.tool_calls,
            },
            finishReason,
            finish_reason: finishReason,
          };
        }),
        usage: {
          prompt_tokens: typedData.usage?.prompt_tokens || 0,
          completion_tokens: typedData.usage?.completion_tokens || 0,
          total_tokens: typedData.usage?.total_tokens || 0,
        },
        ailin_metadata: {
          strategy_used: 'direct',
          provider: this.name,
          execution_time_ms: Date.now() - startTime,
          models_used: [typedData.model],
          model_count: 1,
          cost_usd: 0, // Would need to calculate based on usage
          cache_hit: false,
        },
      };
    } catch (error) {
      this.providerLog.error({ error, model: request.model }, 'Chat completion failed');
      const providerError = new Error(
        error instanceof Error ? error.message : 'OpenRouter chat completion failed'
      );
      throw Object.assign(providerError, {
        statusCode: 500,
        provider: this.name,
        code: 'provider_chat_completion_failed',
      });
    }
  }

  /**
   * Convert internal message format to OpenRouter format
   */
  private convertMessagesToOpenRouter(messages: ChatMessage[]): ChatCompletionMessageParam[] {
    return messages.map((message): ChatCompletionMessageParam => {
      // Convert content to proper format
      let contentValue: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }> = '';
      
      if (typeof message.content === 'string') {
        contentValue = message.content;
      } else if (Array.isArray(message.content)) {
        contentValue = message.content.map((item) => {
          if (item.type === 'text' && 'text' in item && typeof (item as { text: unknown }).text === 'string') {
            return { type: 'text' as const, text: (item as { text: string }).text };
          } else if (item.type === 'image_url' && 'image_url' in item && typeof (item as { image_url: unknown }).image_url === 'object' && item.image_url !== null) {
            const imgUrl = item.image_url as { url: string; detail?: 'low' | 'high' | 'auto' };
            return {
              type: 'image_url' as const,
              image_url: {
                url: imgUrl.url,
                detail: imgUrl.detail,
              },
            };
          }
          return { type: 'text' as const, text: '' };
        });
      } else {
        contentValue = String(message.content || '');
      }

      switch (message.role) {
        case 'user': {
          return {
            role: 'user',
            content: contentValue,
          };
        }
        case 'assistant': {
          // Assistant messages can only have text content, not images
          // Filter to only text parts if it's an array
          let assistantContent: string | OpenAI.Chat.Completions.ChatCompletionContentPartText[] = '';
          if (typeof contentValue === 'string') {
            assistantContent = contentValue;
          } else if (Array.isArray(contentValue)) {
            const textParts = contentValue.filter((c): c is OpenAI.Chat.Completions.ChatCompletionContentPartText => {
              return c.type === 'text' && 'text' in c && typeof (c as { text: unknown }).text === 'string';
            }).map((c) => ({ type: 'text' as const, text: (c as { text: string }).text }));
            assistantContent = textParts.length > 0 ? textParts : '';
          }
          
          const assistantMessage: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
            role: 'assistant',
            content: assistantContent,
          };
          if (message.tool_calls && Array.isArray(message.tool_calls)) {
            assistantMessage.tool_calls = message.tool_calls;
          }
          if (message.name && typeof message.name === 'string') {
            assistantMessage.name = message.name;
          }
          return assistantMessage;
        }
        case 'tool': {
          const toolContent = typeof contentValue === 'string' 
            ? contentValue 
            : contentValue.map((c) => ('text' in c ? c.text : '')).join('\n');
          return {
            role: 'tool',
            content: toolContent,
            tool_call_id: message.tool_call_id || '',
          };
        }
        case 'system': {
          const systemContent = typeof contentValue === 'string' 
            ? contentValue 
            : contentValue.map((c) => ('text' in c ? c.text : '')).join('\n');
          return {
            role: 'system',
            content: systemContent,
          };
        }
        default: {
          return {
            role: 'user',
            content: typeof contentValue === 'string' ? contentValue : String(message.content || ''),
          };
        }
      }
    });
  }

  private buildRequestHeaders(includeJsonContentType: boolean): Record<string, string> {
    const config = this.config as OpenRouterConfig;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
    };

    if (includeJsonContentType) {
      headers['Content-Type'] = 'application/json';
    }

    if (config.appUrl) {
      headers['HTTP-Referer'] = config.appUrl;
    }
    if (config.appName) {
      headers['X-Title'] = config.appName;
    }

    return headers;
  }

  private buildApiUrl(endpoint: string): string {
    return `https://openrouter.ai/api/v1${endpoint}`;
  }

  /**
   * Make JSON HTTP request to OpenRouter API.
   */
  private async makeRequest(
    endpoint: string,
    method: string = 'GET',
    body?: Record<string, unknown>
  ): Promise<Response> {
    const requestOptions: RequestInit = {
      method,
      headers: this.buildRequestHeaders(true),
    };

    if (body) {
      requestOptions.body = JSON.stringify(body);
    }

    return fetch(this.buildApiUrl(endpoint), requestOptions);
  }

  private async makeMultipartRequest(endpoint: string, formData: FormData): Promise<Response> {
    return fetch(this.buildApiUrl(endpoint), {
      method: 'POST',
      headers: this.buildRequestHeaders(false),
      body: formData,
    });
  }

  private async ensureSuccessfulResponse(
    operationFn: () => Promise<Response>,
    operation: string
  ): Promise<Response> {
    return this.withRetry(async () => {
      const response = await operationFn();
      if (response.ok) {
        return response;
      }

      const errorBody = await response.text();
      const error = new Error(
        `OpenRouter ${operation} failed: HTTP ${response.status} ${errorBody}`
      ) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }, operation);
  }

  private extractTextFromResponseContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') return item;
          if (!item || typeof item !== 'object') return '';
          const textDescriptor = Object.getOwnPropertyDescriptor(item, 'text');
          return typeof textDescriptor?.value === 'string' ? textDescriptor.value : '';
        })
        .filter((segment) => segment.length > 0)
        .join('\n')
        .trim();
    }

    return '';
  }

  private normalizeVisionImageInput(image: Buffer | string): string {
    if (Buffer.isBuffer(image)) {
      return `data:image/png;base64,${image.toString('base64')}`;
    }

    const trimmed = image.trim();
    if (
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('data:')
    ) {
      return trimmed;
    }

    if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length > 32) {
      return `data:image/png;base64,${trimmed.replace(/\s+/g, '')}`;
    }

    return trimmed;
  }

  private parseStructuredSearchOutput(content: string): {
    answer?: string;
    results: Array<{
      title: string;
      url: string;
      content: string;
      rawContent?: string;
      score: number;
      publishedDate?: string;
    }>;
    images?: string[];
  } {
    try {
      const parsed = JSON.parse(content) as {
        answer?: unknown;
        results?: unknown;
        images?: unknown;
      };

      const results = Array.isArray(parsed.results)
        ? parsed.results.reduce<
            Array<{
              title: string;
              url: string;
              content: string;
              rawContent?: string;
              score: number;
              publishedDate?: string;
            }>
          >((acc, item) => {
            if (!item || typeof item !== 'object') return acc;
            const obj = item as Record<string, unknown>;
            const normalized: {
              title: string;
              url: string;
              content: string;
              rawContent?: string;
              score: number;
              publishedDate?: string;
            } = {
              title: typeof obj.title === 'string' ? obj.title : 'Result',
              url: typeof obj.url === 'string' ? obj.url : '',
              content: typeof obj.content === 'string' ? obj.content : '',
              score: typeof obj.score === 'number' ? obj.score : 0.5,
            };
            if (typeof obj.rawContent === 'string') {
              normalized.rawContent = obj.rawContent;
            }
            if (typeof obj.publishedDate === 'string') {
              normalized.publishedDate = obj.publishedDate;
            }
            acc.push(normalized);
            return acc;
          }, [])
        : [];

      const images = Array.isArray(parsed.images)
        ? parsed.images.filter((entry): entry is string => typeof entry === 'string')
        : undefined;

      return {
        answer: typeof parsed.answer === 'string' ? parsed.answer : undefined,
        results,
        images,
      };
    } catch {
      return {
        answer: content,
        results: [
          {
            title: 'Search summary',
            url: '',
            content,
            score: 0.5,
          },
        ],
      };
    }
  }

  /**
   * Get bulkhead configuration for OpenRouter
   */
  protected getBulkheadConfig() {
    return {
      maxConcurrent: 30, // Higher concurrency due to unified API
      maxQueueSize: 150,
      queueTimeout: 30000,
    };
  }

  /**
   * Chat completion streaming for OpenRouter
   * Implements streaming by converting non-streaming response into chunks
   */
  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    const startTime = Date.now();
    
    try {
      // Get non-streaming response
      const fullResponse = await this.chatCompletion(request);
      
      // Extract text content from message (can be string or MessageContent[])
      const messageContent = fullResponse.choices[0]?.message?.content;
      let contentText = '';
      if (typeof messageContent === 'string') {
        contentText = messageContent;
      } else if (Array.isArray(messageContent)) {
        contentText = messageContent
          .map((item) => {
            if (typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string') {
              return item.text;
            }
            return '';
          })
          .join('');
      }
      
      // Split content into chunks for streaming simulation
      const chunkSize = 20; // Characters per chunk
      const chunks: string[] = [];
      
      for (let i = 0; i < contentText.length; i += chunkSize) {
        chunks.push(contentText.slice(i, i + chunkSize));
      }
      
      // Yield chunks progressively
      for (let i = 0; i < chunks.length; i++) {
        yield {
          id: fullResponse.id,
          object: 'chat.completion.chunk',
          created: fullResponse.created,
          model: fullResponse.model,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: chunks[i],
              },
              finish_reason: i === chunks.length - 1 ? fullResponse.choices[0]?.finish_reason || 'stop' : null,
              logprobs: null,
            },
          ],
          usage: i === chunks.length - 1 ? fullResponse.usage : undefined,
        };
        
        // Small delay to simulate streaming
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      
      const totalDuration = Date.now() - startTime;
      this.providerLog.debug({ duration: totalDuration, chunks: chunks.length }, 'Streaming completed');
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      this.providerLog.error(
        {
          error: error instanceof Error ? error.message : String(error),
          duration,
          model: request.model,
        },
        'Streaming chat completion failed'
      );
      throw error;
    }
  }

  /**
   * Generate embeddings (not supported by OpenRouter)
   */
  async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error('Embeddings not supported by OpenRouter');
  }

  /**
   * Calculate cost for OpenRouter usage
   */
  calculateCost(model: Model, inputTokens: number, outputTokens: number): number {
    // OpenRouter pricing varies by model, using average rates as fallback
    const inputRate = Math.max(0, Number(model.inputCostPer1k) || 0.001);
    const outputRate = Math.max(0, Number(model.outputCostPer1k) || 0.004);
    const cost = (inputTokens / 1000) * inputRate
               + (outputTokens / 1000) * outputRate;
    return Math.max(0, cost);
  }

  /**
   * Normalize model name for OpenRouter
   */
  normalizeModelName(modelName: string): string {
    return modelName; // OpenRouter model names are already normalized
  }

  /**
   * Vision via multimodal chat completion.
   */
  async vision(model: Model, request: VisionRequest): Promise<VisionResponse> {
    const response = await this.chatCompletion({
      model: model.id || model.name,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: request.prompt },
            {
              type: 'image_url',
              image_url: {
                url: this.normalizeVisionImageInput(request.image),
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
        typeof request.options?.temperature === 'number' ? request.options.temperature : 0.2,
      max_tokens:
        typeof request.options?.max_tokens === 'number' ? request.options.max_tokens : 1024,
    });

    const content = this.extractTextFromResponseContent(
      response.choices?.[0]?.message?.content
    );

    return {
      content,
      raw: response,
    };
  }

  /**
   * Web search via OpenRouter web plugin with structured JSON response.
   */
  async webSearch(
    model: Model,
    request: { query: string; maxResults?: number; options?: Record<string, unknown> }
  ): Promise<{ text: string; raw: unknown }> {
    const response = await this.chatCompletion({
      model: model.id || model.name,
      messages: [
        {
          role: 'system',
          content:
            'You are a grounded web search assistant. Use web results and return strict JSON: {"answer":"string","results":[{"title":"string","url":"string","content":"string","score":0.0}],"images":["url"]}.',
        },
        {
          role: 'user',
          content: request.query,
        },
      ],
      webSearch: true,
      webSearchOptions: {
        max_results:
          typeof request.maxResults === 'number' ? Math.max(1, request.maxResults) : 5,
        search_context_size:
          request.options && typeof request.options.search_context_size === 'string'
            ? (request.options.search_context_size as 'low' | 'medium' | 'high')
            : 'high',
      },
      temperature: 0.2,
      max_tokens: 1500,
    });

    const content = this.extractTextFromResponseContent(
      response.choices?.[0]?.message?.content
    );
    const parsed = this.parseStructuredSearchOutput(content);

    return {
      text: parsed.answer || content,
      raw: parsed,
    };
  }

  async textToSpeech(model: Model, request: AudioTTSRequest): Promise<AudioTTSResponse> {
    const payload: Record<string, unknown> = {
      model: model.id || model.name,
      input: request.text,
      voice:
        request.voice ||
        (typeof request.options?.voice === 'string' ? request.options.voice : 'alloy'),
      response_format:
        request.format ||
        (typeof request.options?.response_format === 'string'
          ? request.options.response_format
          : 'mp3'),
    };

    if (typeof request.options?.speed === 'number') {
      payload.speed = request.options.speed;
    }

    const response = await this.ensureSuccessfulResponse(
      () => this.makeRequest('/audio/speech', 'POST', payload),
      'text-to-speech'
    );

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    return {
      audio: audioBuffer,
      format:
        typeof payload.response_format === 'string' ? payload.response_format : request.format || 'mp3',
      raw: { size: audioBuffer.length },
    };
  }

  async speechToText(model: Model, request: AudioSTTRequest): Promise<AudioSTTResponse> {
    const formData = new FormData();
    const fileName =
      typeof request.options?.filename === 'string' ? request.options.filename : 'audio.wav';
    const mimeType =
      typeof request.options?.mimeType === 'string' ? request.options.mimeType : 'audio/wav';
    const file = new File([new Blob([new Uint8Array(request.audio)], { type: mimeType })], fileName, {
      type: mimeType,
    });

    formData.append('file', file);
    formData.append('model', model.id || model.name);

    if (typeof request.language === 'string') {
      formData.append('language', request.language);
    }
    if (typeof request.options?.prompt === 'string') {
      formData.append('prompt', request.options.prompt);
    }
    if (typeof request.options?.response_format === 'string') {
      formData.append('response_format', request.options.response_format);
    }
    if (typeof request.options?.temperature === 'number') {
      formData.append('temperature', String(request.options.temperature));
    }

    const response = await this.ensureSuccessfulResponse(
      () => this.makeMultipartRequest('/audio/transcriptions', formData),
      'speech-to-text'
    );

    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();
    let text = rawText;
    let parsedRaw: unknown = rawText;

    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(rawText) as { text?: unknown };
        parsedRaw = parsed;
        if (typeof parsed.text === 'string') {
          text = parsed.text;
        }
      } catch {
        // keep plain text fallback
      }
    }

    return {
      text,
      raw: parsedRaw,
    };
  }

  async imageGenerate(model: Model, request: ImageGenRequest): Promise<ImageGenResponse> {
    const options = request.options || {};
    const payload: Record<string, unknown> = {
      model: model.id || model.name,
      prompt: request.prompt,
      size: request.size || '1024x1024',
      n: typeof options.n === 'number' ? options.n : 1,
      response_format:
        typeof options.response_format === 'string'
          ? options.response_format
          : typeof options.responseFormat === 'string'
            ? options.responseFormat
            : 'url',
    };

    if (typeof options.quality === 'string') {
      payload.quality = options.quality;
    }
    if (typeof options.style === 'string') {
      payload.style = options.style;
    }

    const response = await this.ensureSuccessfulResponse(
      () => this.makeRequest('/images/generations', 'POST', payload),
      'image generation'
    );

    const raw = (await response.json()) as {
      data?: Array<{ url?: string; b64_json?: string }>;
    };
    const first = Array.isArray(raw.data) ? raw.data[0] : undefined;
    if (!first) {
      throw new Error('OpenRouter image generation returned no images');
    }

    if (typeof first.b64_json === 'string') {
      return {
        image: Buffer.from(first.b64_json, 'base64'),
        format: 'png',
        raw,
      };
    }

    if (typeof first.url === 'string') {
      const imageUrl = first.url;
      const imageResponse = await this.ensureSuccessfulResponse(
        () => fetch(imageUrl),
        'download generated image'
      );
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const contentType = imageResponse.headers.get('content-type') || '';
      const format = contentType.includes('jpeg')
        ? 'jpg'
        : contentType.includes('webp')
          ? 'webp'
          : 'png';
      return {
        image: imageBuffer,
        format,
        raw,
      };
    }

    throw new Error('OpenRouter image generation response is missing url and b64_json');
  }

  async videoGenerate(model: Model, request: VideoGenRequest): Promise<VideoGenResponse> {
    const options = request.options || {};
    const payload: Record<string, unknown> = {
      model: model.id || model.name,
      prompt: request.prompt,
    };

    if (typeof request.duration === 'number') payload.duration = request.duration;
    if (typeof request.aspectRatio === 'string') payload.aspect_ratio = request.aspectRatio;
    if (typeof request.size === 'string') payload.size = request.size;
    if (typeof request.image === 'string') payload.image = request.image;
    if (typeof request.startImage === 'string') payload.start_image = request.startImage;
    if (typeof request.endImage === 'string') payload.end_image = request.endImage;
    if (typeof request.audio === 'string') payload.audio = request.audio;
    if (typeof request.video === 'string') payload.video = request.video;

    if ('duration' in options && typeof options.duration === 'number') {
      payload.duration = options.duration;
    }
    if ('aspect_ratio' in options && typeof options.aspect_ratio === 'string') {
      payload.aspect_ratio = options.aspect_ratio;
    }
    if ('size' in options && typeof options.size === 'string') {
      payload.size = options.size;
    }
    if ('n' in options && typeof options.n === 'number') {
      payload.n = options.n;
    }
    if ('response_format' in options && typeof options.response_format === 'string') {
      payload.response_format = options.response_format;
    }

    const response = await this.ensureSuccessfulResponse(
      () => this.makeRequest('/videos/generations', 'POST', payload),
      'video generation'
    );
    const rawPayload = (await response.json()) as {
      data?: Array<{ id?: string; url?: string; b64_json?: string }>;
      [key: string]: unknown;
    };

    const videos = Array.isArray(rawPayload.data)
      ? rawPayload.data.map((item) => ({
          id: typeof item.id === 'string' ? item.id : undefined,
          url: typeof item.url === 'string' ? item.url : undefined,
          b64_json: typeof item.b64_json === 'string' ? item.b64_json : undefined,
        }))
      : [];

    return {
      video: videos,
      format: 'mp4',
      raw: rawPayload,
    };
  }

  /**
   * Content Moderation
   * OpenRouter proxies to other providers, moderation depends on underlying provider
   * Uses chat completion to analyze content for policy violations
   */
  async moderate(model: Model, request: ModerationRequest): Promise<ModerationResponse> {
    try {
      // Use chat completion to analyze content
      const moderationPrompt = `Analyze the following text for content policy violations. Respond with a JSON object indicating if the content is flagged and category scores (0.0-1.0) for: sexual, hate, harassment, self-harm, sexual/minors, hate/threatening, violence/graphic, self-harm/intent, self-harm/instructions, harassment/threatening, violence.
      
      Text to analyze: "${request.text}"
      
      Respond with JSON only: {"flagged": boolean, "categories": {...}, "category_scores": {...}}`;

      const chatResponse = await this.chatCompletion({
        model: model.id,
        messages: [
          { role: 'system', content: MODERATION_ANALYZER_SYSTEM_PROMPT },
          { role: 'user', content: moderationPrompt },
        ],
        temperature: 0.1,
        max_tokens: 500,
      });

      // Parse the response
      const messageContent = chatResponse.choices[0]?.message?.content;
      const contentStr = typeof messageContent === 'string' ? messageContent : JSON.stringify(messageContent ?? {});
      const moderationResult = JSON.parse(contentStr || '{}') as {
        flagged?: boolean;
        categories?: Record<string, boolean>;
        category_scores?: Record<string, number>;
      };

      return {
        flagged: moderationResult.flagged || false,
        categories: {
          sexual: moderationResult.categories?.sexual || false,
          hate: moderationResult.categories?.hate || false,
          harassment: moderationResult.categories?.harassment || false,
          'self-harm': moderationResult.categories?.['self-harm'] || false,
          'sexual/minors': moderationResult.categories?.['sexual/minors'] || false,
          'hate/threatening': moderationResult.categories?.['hate/threatening'] || false,
          'violence/graphic': moderationResult.categories?.['violence/graphic'] || false,
          'self-harm/intent': moderationResult.categories?.['self-harm/intent'] || false,
          'self-harm/instructions': moderationResult.categories?.['self-harm/instructions'] || false,
          'harassment/threatening': moderationResult.categories?.['harassment/threatening'] || false,
          violence: moderationResult.categories?.violence || false,
        },
        category_scores: {
          sexual: moderationResult.category_scores?.sexual || 0,
          hate: moderationResult.category_scores?.hate || 0,
          harassment: moderationResult.category_scores?.harassment || 0,
          'self-harm': moderationResult.category_scores?.['self-harm'] || 0,
          'sexual/minors': moderationResult.category_scores?.['sexual/minors'] || 0,
          'hate/threatening': moderationResult.category_scores?.['hate/threatening'] || 0,
          'violence/graphic': moderationResult.category_scores?.['violence/graphic'] || 0,
          'self-harm/intent': moderationResult.category_scores?.['self-harm/intent'] || 0,
          'self-harm/instructions': moderationResult.category_scores?.['self-harm/instructions'] || 0,
          'harassment/threatening': moderationResult.category_scores?.['harassment/threatening'] || 0,
          violence: moderationResult.category_scores?.violence || 0,
        },
        raw: moderationResult,
      };
    } catch (error) {
      // Fallback: return safe defaults if moderation fails
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.providerLog.warn({ error: errorMessage }, 'Moderation analysis failed, returning safe defaults');
      
      return {
        flagged: false,
        categories: {
          sexual: false,
          hate: false,
          harassment: false,
          'self-harm': false,
          'sexual/minors': false,
          'hate/threatening': false,
          'violence/graphic': false,
          'self-harm/intent': false,
          'self-harm/instructions': false,
          'harassment/threatening': false,
          violence: false,
        },
        category_scores: {
          sexual: 0,
          hate: 0,
          harassment: 0,
          'self-harm': 0,
          'sexual/minors': 0,
          'hate/threatening': 0,
          'violence/graphic': 0,
          'self-harm/intent': 0,
          'self-harm/instructions': 0,
          'harassment/threatening': 0,
          violence: 0,
        },
        raw: { error: errorMessage, provider: 'openrouter', note: 'Fallback moderation response' },
      };
    }
  }

  /**
   * Image Edit
   * REAL IMPLEMENTATION - Routes to OpenAI adapter for OpenAI image models
   * OpenRouter aggregates models but doesn't have direct image editing endpoints
   * For OpenAI models with image editing capabilities, we route directly to OpenAI adapter
   */
  async imageEdit(model: Model, request: ImageEditRequest): Promise<ImageEditResponse> {
    const startTime = Date.now();
    const modelId = model.id || model.name;

    try {
      this.providerLog.debug(
        { model: modelId, promptLength: request.prompt.length, hasMask: !!request.mask },
        'Image edit request via OpenRouter - routing to OpenAI adapter'
      );

      // Check if this is an OpenAI model via OpenRouter
      const isOpenAIModel = modelId.startsWith('openai/') || model.provider === 'openai';

      if (!isOpenAIModel) {
        throw new Error(
          `Image editing is only supported for OpenAI models via OpenRouter. Model ${modelId} is not an OpenAI model. Please use an OpenAI model with image editing capabilities (e.g., "openai/gpt-image-1.5", "openai/gpt-image-1", "openai/dall-e-3", "openai/dall-e-2").`
        );
      }

      // Route to OpenAI adapter directly
      const providerRegistry = getProviderRegistry();
      const openaiAdapter = providerRegistry.get('openai');

      if (!openaiAdapter) {
        throw new Error('OpenAI adapter not available in provider registry. Cannot route image edit request.');
      }

      // Type guard to check if adapter supports image editing
      interface ImageEditCapableAdapter {
        imageEdit: (model: Model, request: ImageEditRequest) => Promise<ImageEditResponse>;
      }

      const hasImageEdit = (adapter: unknown): adapter is ImageEditCapableAdapter => {
        return (
          typeof adapter === 'object' &&
          adapter !== null &&
          'imageEdit' in adapter &&
          typeof (adapter as { imageEdit: unknown }).imageEdit === 'function'
        );
      };

      if (!hasImageEdit(openaiAdapter)) {
        throw new Error('OpenAI adapter does not support image editing');
      }

      // Find corresponding OpenAI model (remove "openai/" prefix)
      const openaiModelId = modelId.replace(/^openai\//, '');
      const openaiModels = await openaiAdapter.getModels();
      const openaiModel = openaiModels.find((m) => m.id === openaiModelId || m.name === openaiModelId);

      if (!openaiModel) {
        throw new Error(`OpenAI model ${openaiModelId} not found. Available models: ${openaiModels.map((m) => m.id).join(', ')}`);
      }

      this.providerLog.info(
        { modelId, openaiModelId: openaiModel.id },
        'Routing image edit to OpenAI adapter'
      );

      // Call OpenAI adapter's imageEdit method (type-safe after guard)
      const result = await openaiAdapter.imageEdit(openaiModel, request);

      const latency = Date.now() - startTime;
      this.providerLog.info(
        { model: modelId, latency, imageSize: result.image.length, format: result.format },
        'Image edit completed via OpenAI adapter'
      );

      return result;
    } catch (error: unknown) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.providerLog.error(
        { model: modelId, latency, error: errorMessage },
        'Image edit failed via OpenRouter routing'
      );

      throw new Error(`OpenRouter Image Edit failed: ${errorMessage}`);
    }
  }

  /**
   * Image Variation
   * REAL IMPLEMENTATION - Routes to OpenAI adapter for OpenAI image models
   * OpenRouter aggregates models but doesn't have direct image variation endpoints
   * For OpenAI models with image variation capabilities, we route directly to OpenAI adapter
   */
  async imageVariation(model: Model, request: ImageVariationRequest): Promise<ImageVariationResponse> {
    const startTime = Date.now();
    const modelId = model.id || model.name;

    try {
      this.providerLog.debug(
        { model: modelId, size: request.size },
        'Image variation request via OpenRouter - routing to OpenAI adapter'
      );

      // Check if this is an OpenAI model via OpenRouter
      const isOpenAIModel = modelId.startsWith('openai/') || model.provider === 'openai';

      if (!isOpenAIModel) {
        throw new Error(
          `Image variation is only supported for OpenAI models via OpenRouter. Model ${modelId} is not an OpenAI model. Please use an OpenAI model with image variation capabilities (e.g., "openai/gpt-image-1.5", "openai/gpt-image-1", "openai/dall-e-3", "openai/dall-e-2").`
        );
      }

      // Route to OpenAI adapter directly
      const providerRegistry = getProviderRegistry();
      const openaiAdapter = providerRegistry.get('openai');

      if (!openaiAdapter) {
        throw new Error('OpenAI adapter not available in provider registry. Cannot route image variation request.');
      }

      // Type guard to check if adapter supports image variation
      interface ImageVariationCapableAdapter {
        imageVariation: (model: Model, request: ImageVariationRequest) => Promise<ImageVariationResponse>;
      }

      const hasImageVariation = (adapter: unknown): adapter is ImageVariationCapableAdapter => {
        return (
          typeof adapter === 'object' &&
          adapter !== null &&
          'imageVariation' in adapter &&
          typeof (adapter as { imageVariation: unknown }).imageVariation === 'function'
        );
      };

      if (!hasImageVariation(openaiAdapter)) {
        throw new Error('OpenAI adapter does not support image variation');
      }

      // Find corresponding OpenAI model (remove "openai/" prefix)
      const openaiModelId = modelId.replace(/^openai\//, '');
      const openaiModels = await openaiAdapter.getModels();
      const openaiModel = openaiModels.find((m) => m.id === openaiModelId || m.name === openaiModelId);

      if (!openaiModel) {
        throw new Error(`OpenAI model ${openaiModelId} not found. Available models: ${openaiModels.map((m) => m.id).join(', ')}`);
      }

      this.providerLog.info(
        { modelId, openaiModelId: openaiModel.id },
        'Routing image variation to OpenAI adapter'
      );

      // Call OpenAI adapter's imageVariation method (type-safe after guard)
      const result = await openaiAdapter.imageVariation(openaiModel, request);

      const latency = Date.now() - startTime;
      this.providerLog.info(
        { model: modelId, latency, imageSize: result.image.length, format: result.format },
        'Image variation completed via OpenAI adapter'
      );

      return result;
    } catch (error: unknown) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.providerLog.error(
        { model: modelId, latency, error: errorMessage },
        'Image variation failed via OpenRouter routing'
      );

      throw new Error(`OpenRouter Image Variation failed: ${errorMessage}`);
    }
  }
}
