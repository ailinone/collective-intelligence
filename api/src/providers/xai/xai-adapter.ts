// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { logger } from '@/utils/logger';
import { isObject, narrowAs } from '@/utils/type-guards';
import {
  ProviderAdapter,
  type ProviderConfig,
  type HealthCheckResult,
  type BalanceCheckResult,
} from '../base/provider-adapter';
import { MODERATION_ANALYZER_SYSTEM_PROMPT } from '../base/moderation-prompt';
import type {
  ChatRequest,
  ChatResponse,
  ChatChoice,
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
import { getModelsByProvider } from '@/services/model-catalog-service';

const log = logger.child({ provider: 'xai-adapter' });

/**
 * XAI (Grok) Provider Adapter
 *
 * X.AI's Grok models - known for real-time knowledge and reasoning.
 * OpenAI-compatible API.
 *
 * Key Features:
 * - Grok 2: Latest flagship model
 * - Grok 2 Mini: Cost-effective version
 * - Real-time information access
 * - Strong reasoning capabilities
 */
export class XAIAdapter extends ProviderAdapter {
  private baseURL: string;
  private apiKey: string;

  constructor(config: ProviderConfig) {
    super('xai', 'xAI (Grok)', config);
    this.apiKey = config.apiKey;
    this.baseURL = config.baseUrl || 'https://api.x.ai/v1';
  }

  async getModels(): Promise<Model[]> {
    const models = await getModelsByProvider('xai');

    if (!models.length) {
      log.warn('No models registered in catalog for xAI');
    }

    // Remove provider prefix from model IDs to return normalized names
    return models.map(model => ({
      ...model,
      id: model.name, // Use 'name' which is the normalized ID without prefix
    }));
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();

    return {
      id: 'xai',
      name: 'xai',
      displayName: 'xAI (Grok)',
      status: health.healthy ? 'active' : 'disabled',
      models,
      health: {
        status: health.healthy ? 'healthy' : 'degraded',
        lastCheck: health.checkedAt,
        latency: health.latency,
        errorRate: health.healthy ? 0 : 1,
      },
    };
  }

  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    // Route through the resilience stack (bulkhead → breaker → timeout) so an
    // X.AI outage fast-fails and is isolated from other providers.
    return this.executeThroughBulkhead(async () => {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.max_tokens,
          stream: false,
          tools: request.tools,
        }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string; message?: string; [key: string]: unknown };
        throw new Error(`XAI API error: ${JSON.stringify(error)}`);
      }

      return (await response.json()) as ChatResponse;
    }, 'chat completion');
  }

  async *chatCompletionStream(_request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    // Only connection establishment runs through the resilience stack; the SSE
    // read loop below stays outside the bulkhead slot.
    const response = await this.executeThroughBulkhead(async () => {
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: _request.model,
          messages: _request.messages,
          temperature: _request.temperature,
          max_tokens: _request.max_tokens,
          stream: true,
          tools: _request.tools,
        }),
      });

      if (!res.ok) {
        throw new Error(`XAI API error: ${res.status}`);
      }

      return res;
    }, 'chat completion stream');

    if (!response.body) throw new Error('Response body is null');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      let streamDone = false;
      while (!streamDone) {
        const result = await reader.read();
        streamDone = result.done;
        if (streamDone) break;
        const value: unknown = result.value;
        if (!(value instanceof Uint8Array)) continue;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const data: unknown = JSON.parse(trimmed.slice(6));
              yield this.convertStreamChunk(data, _request.model || 'grok-2-latest');
            } catch {
              continue;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Generate embeddings
   * X.AI (Grok) does not provide a dedicated embeddings API
   * 
   * Automatically falls back to a configured provider with embeddings support (OpenAI, Google).
   * If no fallback is available, throws a clear error.
   * 
   * This ensures semantic accuracy for vector search and other embeddings-dependent functionality.
   */
  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    // Check if fallback is enabled via config (default: enabled)
    const fallbackEnabled = process.env.XAI_EMBEDDINGS_FALLBACK !== 'false';
    
    if (!fallbackEnabled) {
      throw new Error(
        'X.AI (Grok) does not support embeddings natively. ' +
        'Set XAI_EMBEDDINGS_FALLBACK=true to enable automatic fallback to OpenAI/Google embeddings, ' +
        'or use a provider with native embeddings support directly.'
      );
    }

    try {
      // Try to find a fallback provider with embeddings support
      const { getProviderRegistry } = await import('@/providers/provider-registry.js');
      const registry = getProviderRegistry();
      
      // Priority order: OpenAI > Google (both have excellent embeddings APIs)
      const fallbackProviders = ['openai', 'google'];
      
      for (const providerId of fallbackProviders) {
        const models = await registry.getAllModels();
        const embeddingModel = models.find(
          (m) => m.providerId === providerId && 
                 (m.capabilities?.includes('embeddings') || m.id.includes('embedding'))
        );

        if (embeddingModel) {
          const providerResult = await registry.findModel(embeddingModel.id);
          if (providerResult?.adapter) {
            log.info(
              { 
                xaiModel: request.model,
                fallbackProvider: providerId,
                fallbackModel: embeddingModel.id 
              },
              'Using embeddings fallback provider for X.AI request'
            );

            const embeddingResponse = await providerResult.adapter.generateEmbeddings({
              ...request,
              model: embeddingModel.id,
            });

            // Return response with updated model name
            log.info({
              originalProvider: 'xai',
              originalModel: request.model,
              fallbackProvider: providerId,
              fallbackModel: embeddingModel.id,
              reason: 'X.AI does not provide embeddings API',
            }, 'Embeddings request handled by fallback provider');

            return {
              ...embeddingResponse,
              model: request.model || 'xai-unknown',
            };
          }
        }
      }

      // No fallback available
      throw new Error(
        'X.AI does not support embeddings and no fallback provider is available. ' +
        'Please configure OpenAI or Google provider for embeddings support. ' +
        'Embeddings are required for semantic search and other vector operations.'
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('X.AI does not support')) {
        throw error; // Re-throw our clear error messages
      }
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error({ error: errorMessage }, 'Embeddings fallback failed');
      
      throw new Error(
        `X.AI embeddings failed: ${errorMessage}. ` +
        `X.AI does not provide embeddings API. Please use a provider with native embeddings support (OpenAI, Google) or configure fallback.`
      );
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });

      return {
        healthy: response.ok,
        latency: Date.now() - startTime,
        checkedAt: new Date(),
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        healthy: false,
        latency: Date.now() - startTime,
        checkedAt: new Date(),
        error: errorMessage,
      };
    }
  }

  /**
   * Check xAI credit balance via billing API.
   */
  async checkBalance(): Promise<BalanceCheckResult | null> {
    try {
      const res = await fetch(`${this.baseURL}/billing/credits`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { total_available?: number; balance?: number };
      const balance = typeof data.total_available === 'number'
        ? data.total_available
        : typeof data.balance === 'number' ? data.balance : undefined;
      return {
        hasCredits: balance !== undefined ? balance > 0 : true,
        balance,
        currency: 'USD',
      };
    } catch {
      return null;
    }
  }

  calculateCost(model: Model, inputTokens: number, outputTokens: number): number {
    const inputRate = Math.max(0, Number(model.inputCostPer1k) || 0);
    const outputRate = Math.max(0, Number(model.outputCostPer1k) || 0);
    const cost = (inputTokens / 1000) * inputRate
               + (outputTokens / 1000) * outputRate;
    return Math.max(0, cost);
  }

  normalizeModelName(modelName: string): string {
    return modelName;
  }

  private convertStreamChunk(rawChunk: unknown, requestedModel: string): ChatResponse {
    // SSE chunk arrives as untrusted JSON. Narrow once at the entry point;
    // the function body still uses optional chaining and the existing
    // `isToolCallShape` guard for deeper levels.
    const chunk: { id?: string; created?: number; choices?: Array<{ index?: number; delta?: { role?: string; content?: string; tool_calls?: unknown }; finish_reason?: string }>; usage?: unknown } =
      isObject(rawChunk) ? narrowAs(rawChunk) : {};
    // Type guard for role
    function normalizeRole(role: string | undefined): 'user' | 'assistant' | 'system' {
      if (role === 'user' || role === 'assistant' || role === 'system') {
        return role;
      }
      return 'assistant';
    }

    // Type guard for finish_reason
    function normalizeFinishReason(reason: string | undefined): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
      if (reason === 'stop' || reason === 'length' || reason === 'tool_calls' || reason === 'content_filter') {
        return reason;
      }
      return null;
    }

    const isToolCallShape = (
      value: unknown,
    ): value is { id: string; type: 'function'; function: { name: string; arguments?: unknown } } => {
      if (typeof value !== 'object' || value === null) return false;
      const v = value as { id?: unknown; type?: unknown; function?: unknown };
      if (typeof v.id !== 'string') return false;
      if (v.type !== 'function') return false;
      if (typeof v.function !== 'object' || v.function === null) return false;
      const fn = v.function as { name?: unknown };
      return typeof fn.name === 'string';
    };

    const choices: ChatChoice[] = (chunk.choices || []).map((choice) => {
      // Type guard for tool_calls — same predicate-style narrow used in
      // mistral/deepseek adapters.
      let toolCalls: ToolCall[] | undefined = undefined;
      if (choice.delta?.tool_calls !== undefined && choice.delta.tool_calls !== null && Array.isArray(choice.delta.tool_calls)) {
        const validToolCalls: ToolCall[] = [];
        for (const tc of choice.delta.tool_calls) {
          if (!isToolCallShape(tc)) continue;
          const args = typeof tc.function.arguments === 'string' ? tc.function.arguments : '{}';
          validToolCalls.push({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: args,
            },
          });
        }
        if (validToolCalls.length > 0) {
          toolCalls = validToolCalls;
        }
      }
      
      return {
        index: choice.index || 0,
        delta: {
          role: normalizeRole(choice.delta?.role),
          content: choice.delta?.content || undefined,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: normalizeFinishReason(choice.finish_reason),
        logprobs: null,
      };
    });

    return {
      id: chunk.id || `xai-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: chunk.created || Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices,
      usage: (() => {
        if (!chunk.usage || typeof chunk.usage !== 'object') {
          return undefined;
        }
        const usageObj = chunk.usage as Record<string, unknown>;
        return {
          prompt_tokens: typeof usageObj.prompt_tokens === 'number' ? usageObj.prompt_tokens : 0,
          completion_tokens: typeof usageObj.completion_tokens === 'number' ? usageObj.completion_tokens : 0,
          total_tokens: typeof usageObj.total_tokens === 'number' ? usageObj.total_tokens : 0,
        };
      })(),
    };
  }

  /**
   * Content Moderation
   * X.AI (Grok) does not have a dedicated moderation API
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
      log.warn({ error: errorMessage }, 'Moderation analysis failed, returning safe defaults');
      
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
        raw: { error: errorMessage, provider: 'xai', note: 'Fallback moderation response' },
      };
    }
  }

  /**
   * Image Edit
   * X.AI (Grok) does not have image editing capability
   */
  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('X.AI (Grok) image editing is not yet implemented. X.AI does not provide image editing capabilities. Use OpenAI DALL-E for image editing.');
  }

  /**
   * Image Variation
   * X.AI (Grok) does not have image variation capability
   */
  async imageVariation(_model: Model, _request: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('X.AI (Grok) image variation is not yet implemented. X.AI does not provide image variation capabilities. Use OpenAI DALL-E for image variations.');
  }
}
