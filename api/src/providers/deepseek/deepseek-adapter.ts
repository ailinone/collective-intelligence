// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { ProviderAdapter, type HealthCheckResult } from '../base/provider-adapter';
import { MODERATION_ANALYZER_SYSTEM_PROMPT } from '../base/moderation-prompt';
import type {
  Model,
  Provider,
  ProviderConfig,
  ChatRequest,
  ChatResponse,
  ToolCall,
  EmbeddingRequest,
  EmbeddingResponse,
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
import { logger } from '@/utils/logger';

const log = logger.child({ provider: 'deepseek-adapter' });

/**
 * DeepSeek Provider Adapter
 *
 * DeepSeek offers ultra-cheap models with competitive quality.
 * Known for excellent cost/performance ratio.
 *
 * Key Features:
 * - DeepSeek V3: Latest flagship model (best quality)
 * - DeepSeek Chat: Balanced quality/cost
 * - DeepSeek Coder: Specialized for coding tasks
 * - Extremely competitive pricing ($0.14-$2.19 per 1M tokens)
 *
 * API Compatibility: OpenAI-compatible API
 */
export class DeepSeekAdapter extends ProviderAdapter {
  private baseURL: string;
  private apiKey: string;

  constructor(config: ProviderConfig) {
    super('deepseek', 'DeepSeek AI', config);
    this.apiKey = config.apiKey;
    this.baseURL = config.baseUrl || 'https://api.deepseek.com/v1';
  }

  async getModels(): Promise<Model[]> {
    const models = await getModelsByProvider('deepseek');

    if (!models.length) {
      log.warn('No models registered in catalog for DeepSeek');
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
      id: 'deepseek',
      name: 'deepseek',
      displayName: 'DeepSeek AI',
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
    // Route through the resilience stack (bulkhead → breaker → timeout) so a
    // DeepSeek outage fast-fails and is isolated from other providers.
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
          top_p: request.top_p,
          frequency_penalty: request.frequency_penalty,
          presence_penalty: request.presence_penalty,
          stop: request.stop,
          stream: false,
          // DeepSeek supports function calling (OpenAI compatible)
          tools: request.tools,
          tool_choice: request.tool_choice,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(`DeepSeek API error: ${JSON.stringify(error)}`);
      }

      return (await response.json()) as ChatResponse;
    }, 'chat completion');
  }

  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse> {
    // Only connection establishment runs through the resilience stack; the SSE
    // read loop below stays outside the bulkhead slot so the slot is not held
    // for the stream's lifetime.
    const response = await this.executeThroughBulkhead(async () => {
      const res = await fetch(`${this.baseURL}/chat/completions`, {
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
          top_p: request.top_p,
          frequency_penalty: request.frequency_penalty,
          presence_penalty: request.presence_penalty,
          stop: request.stop,
          stream: true,
          tools: request.tools,
          tool_choice: request.tool_choice,
        }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(`DeepSeek API error: ${JSON.stringify(error)}`);
      }

      return res;
    }, 'chat completion stream');

    if (!response.body) {
      throw new Error('Response body is null');
    }

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
              yield this.convertStreamChunk(data, request.model || 'deepseek-chat');
            } catch {
              // Skip invalid SSE data
              continue;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    // DeepSeek doesn't currently offer embeddings API
    // This is a placeholder for future implementation
    throw new Error('DeepSeek embeddings not yet supported');
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(5000),
      });

      const latency = Date.now() - startTime;

      return {
        healthy: response.ok,
        latency,
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

  calculateCost(model: Model, inputTokens: number, outputTokens: number): number {
    const inputRate = Number(model.inputCostPer1k) || 0;
    const outputRate = Number(model.outputCostPer1k) || 0;
    const cost = (inputTokens / 1000) * Math.max(0, inputRate)
               + (outputTokens / 1000) * Math.max(0, outputRate);
    return Math.max(0, cost);
  }

  normalizeModelName(modelName: string): string {
    // DeepSeek model names are already normalized
    return modelName;
  }

  /**
   * Convert stream chunk to ChatResponse format
   */
  private convertStreamChunk(chunk: unknown, requestedModel: string): ChatResponse {
    // Type guard for chunk structure
    if (!chunk || typeof chunk !== 'object') {
      throw new Error('Invalid chunk format');
    }

    const chunkObj = chunk as Record<string, unknown>;
    const choices = Array.isArray(chunkObj.choices) ? chunkObj.choices : [];

    // Type guard for role
    const isValidRole = (role: unknown): role is 'system' | 'user' | 'assistant' | 'function' | 'tool' => {
      return typeof role === 'string' && ['system', 'user', 'assistant', 'function', 'tool'].includes(role);
    };

    // Type guard for finish_reason
    const isValidFinishReason = (reason: unknown): reason is 'stop' | 'length' | 'tool_calls' | 'content_filter' | null => {
      return reason === null || (typeof reason === 'string' && ['stop', 'length', 'tool_calls', 'content_filter'].includes(reason));
    };

    return {
      id: (typeof chunkObj.id === 'string' ? chunkObj.id : `deepseek-${Date.now()}`),
      object: 'chat.completion.chunk',
      created: (typeof chunkObj.created === 'number' ? chunkObj.created : Math.floor(Date.now() / 1000)),
      model: requestedModel,
      choices: choices.map((choice: unknown) => {
        if (!choice || typeof choice !== 'object') {
          throw new Error('Invalid choice format');
        }
        const choiceObj = choice as Record<string, unknown>;
        const delta = choiceObj.delta && typeof choiceObj.delta === 'object' ? choiceObj.delta as Record<string, unknown> : {};
        const role = delta.role && isValidRole(delta.role) ? delta.role : undefined;
        const finishReason = choiceObj.finish_reason && isValidFinishReason(choiceObj.finish_reason) 
          ? choiceObj.finish_reason 
          : null;

        // Type guard for delta content
        let deltaContent: string | undefined = undefined;
        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content === 'string') {
            deltaContent = delta.content;
          } else if (Array.isArray(delta.content)) {
            // Convert MessageContent[] to string
            const contentArray = delta.content as Array<unknown>;
            deltaContent = contentArray
              .map((item: unknown): string => {
                if (typeof item === 'string') {
                  return item;
                }
                if (item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item && typeof (item as { text: unknown }).text === 'string') {
                  return (item as { text: string }).text;
                }
                return '';
              })
              .filter((s): s is string => s.length > 0)
              .join('\n');
          }
        }

        // Type guard for tool_calls — predicate-style narrow gives the inside
        // of the loop a real type instead of `any` (see mistral-adapter for
        // the same pattern).
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

        let toolCalls: ToolCall[] | undefined = undefined;
        if (delta.tool_calls !== undefined && delta.tool_calls !== null && Array.isArray(delta.tool_calls)) {
          const validToolCalls: ToolCall[] = [];
          for (const tc of delta.tool_calls) {
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
          index: typeof choiceObj.index === 'number' ? choiceObj.index : 0,
          delta: {
            ...(role ? { role } : {}),
            ...(deltaContent !== undefined ? { content: deltaContent } : {}),
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
          logprobs: null,
        };
      }),
      usage: (() => {
        if (!chunkObj.usage || typeof chunkObj.usage !== 'object') {
          return undefined;
        }
        const usageObj = chunkObj.usage as Record<string, unknown>;
        const promptTokens = typeof usageObj.prompt_tokens === 'number' ? usageObj.prompt_tokens : undefined;
        const completionTokens = typeof usageObj.completion_tokens === 'number' ? usageObj.completion_tokens : undefined;
        const totalTokens = typeof usageObj.total_tokens === 'number' ? usageObj.total_tokens : undefined;
        
        if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
          return undefined;
        }
        
        return {
          prompt_tokens: promptTokens ?? 0,
          completion_tokens: completionTokens ?? 0,
          total_tokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
        };
      })(),
    };
  }

  /**
   * Content Moderation
   * DeepSeek does not have a dedicated moderation API
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
        raw: { error: errorMessage, provider: 'deepseek', note: 'Fallback moderation response' },
      };
    }
  }

  /**
   * Image Edit
   * DeepSeek does not have native image editing capability
   * Returns an error response indicating the limitation
   */
  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('DeepSeek does not support image editing. This provider does not have image manipulation capabilities. Please use OpenAI DALL-E or another provider that supports image editing.');
  }

  /**
   * Image Variation
   * DeepSeek does not have native image variation capability
   * Returns an error response indicating the limitation
   */
  async imageVariation(_model: Model, _request: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('DeepSeek does not support image variations. This provider does not have image manipulation capabilities. Please use OpenAI DALL-E or another provider that supports image variations.');
  }
}
