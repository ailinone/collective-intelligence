// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import {
  ProviderAdapter,
  type ProviderConfig,
  type HealthCheckResult,
} from '../base/provider-adapter';
import { MODERATION_ANALYZER_SYSTEM_PROMPT } from '../base/moderation-prompt';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  Provider,
  Usage,
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
import { TextDecoder } from 'node:util';

const log = logger.child({ provider: 'cohere-adapter' });

interface CohereChatMessage {
  role: 'SYSTEM' | 'USER' | 'CHATBOT';
  message: string;
}

interface CohereStreamEvent {
  event: string;
  text?: string;
  delta?: string;
  generation_id?: string;
  is_finished?: boolean;
  response?: {
    id?: string;
    text?: string;
    finish_reason?: string;
    meta?: {
      tokens?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };
  };
}

/**
 * Cohere Provider Adapter
 *
 * Cohere offers enterprise-focused models with strong embedding capabilities.
 * Known for excellent RAG (Retrieval Augmented Generation) support.
 *
 * Key Features:
 * - Command R+: Flagship model for complex tasks
 * - Command R: Balanced performance/cost
 * - Command Light: Fast and economical
 * - Excellent embeddings API
 * - Enterprise support and compliance
 */
export class CohereAdapter extends ProviderAdapter {
  private readonly baseURL: string;
  private readonly apiKey: string;

  constructor(config: ProviderConfig) {
    super('cohere', 'Cohere', config);
    this.apiKey = config.apiKey;
    this.baseURL = config.baseUrl || 'https://api.cohere.ai/v1';
  }

  async getModels(): Promise<Model[]> {
    const models = await getModelsByProvider('cohere');

    if (!models.length) {
      log.warn('No models registered in catalog for Cohere');
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
      id: 'cohere',
      name: 'cohere',
      displayName: 'Cohere',
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
    const messages = this.toCohereMessages(request);
    
    // Get default model dynamically from available models (no hardcoding)
    let modelId = request.model;
    if (!modelId) {
      const models = await this.getModels();
      const chatModels = models.filter(m => 
        m.status === 'active' && 
        (m.capabilities?.includes('chat') || m.capabilities?.includes('text_generation'))
      );
      if (chatModels.length > 0) {
        // Select cheapest model
        const sortedByCost = chatModels.sort((a, b) => a.inputCostPer1k - b.inputCostPer1k);
        modelId = sortedByCost[0].id;
      } else {
        throw new Error('No Cohere models available with chat capability');
      }
    }

    // Route through the resilience stack (bulkhead → breaker → timeout) so a
    // Cohere outage fast-fails and is isolated from other providers.
    return this.executeThroughBulkhead(async () => {
      const response = await fetch(`${this.baseURL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(this.config.timeout ?? 60000),
        body: JSON.stringify({
          model: modelId,
          message: messages[messages.length - 1]?.message ?? '',
          chat_history: messages.slice(0, -1),
          temperature: request.temperature,
          max_tokens: request.max_tokens,
          stream: false,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(`Cohere API error: ${JSON.stringify(error)}`);
      }

      const cohereResponse = (await response.json()) as {
        generation_id?: string;
        text: string;
        meta?: {
          tokens?: {
            input_tokens?: number;
            output_tokens?: number;
          };
        };
        [key: string]: unknown;
      };
      const usage = this.toUsage(cohereResponse.meta?.tokens);

      return {
        id: cohereResponse.generation_id || `cohere-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: cohereResponse.text,
            },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        usage,
      };
    }, 'chat completion');
  }

  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    const messages = this.toCohereMessages(request);
    
    // Get default model dynamically from available models (no hardcoding)
    let modelId = request.model;
    if (!modelId) {
      const models = await this.getModels();
      const chatModels = models.filter(m => 
        m.status === 'active' && 
        (m.capabilities?.includes('chat') || m.capabilities?.includes('text_generation'))
      );
      if (chatModels.length > 0) {
        // Select cheapest model
        const sortedByCost = chatModels.sort((a, b) => a.inputCostPer1k - b.inputCostPer1k);
        modelId = sortedByCost[0].id;
      } else {
        throw new Error('No Cohere models available with chat capability');
      }
    }
    // Only connection establishment runs through the resilience stack; the SSE
    // read loop below stays outside the bulkhead slot.
    const response = await this.executeThroughBulkhead(async () => {
      const res = await fetch(`${this.baseURL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(this.config.timeout ?? 60000),
        body: JSON.stringify({
          model: modelId,
          message: messages[messages.length - 1]?.message ?? '',
          chat_history: messages.slice(0, -1),
          temperature: request.temperature,
          max_tokens: request.max_tokens,
          stream: true,
        }),
      });

      if (!res.ok || !res.body) {
        const error = !res.ok
          ? await res.json().catch(() => ({ error: res.statusText }))
          : { error: 'Cohere streaming response did not include a readable body' };
        throw new Error(`Cohere streaming error: ${JSON.stringify(error)}`);
      }

      return res;
    }, 'chat completion stream');

    if (!response.body) {
      throw new Error('Cohere streaming response did not include a readable body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let generationId = `cohere-${Date.now()}`;
    let aggregatedText = '';
    let finalUsage: Usage | undefined;
    let finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null = null;

    let streamDone = false;
    while (!streamDone) {
      const result = await reader.read();
      streamDone = result.done;
      if (streamDone) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) continue;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.trim();

        if (!line || line === ':ok') {
          continue;
        }

        if (line === 'data: [DONE]') {
          return;
        }

        if (!line.startsWith('data:')) {
          continue;
        }

        const payload = line.slice(5).trim();
        if (!payload) {
          continue;
        }

        let event: CohereStreamEvent;
        try {
          event = JSON.parse(payload) as CohereStreamEvent;
        } catch (error) {
          // Skip malformed chunks but continue streaming
          continue;
        }

        if (event.generation_id) {
          generationId = event.generation_id;
        }

        if (event.event === 'text-generation' || event.event === 'text-generation-delta') {
          const chunkText = event.text ?? event.delta ?? '';
          if (!chunkText) {
            continue;
          }
          aggregatedText += chunkText;

          yield {
            id: generationId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: chunkText,
                },
                finish_reason: null,
                logprobs: null,
              },
            ],
          };
        }

        if (event.event === 'stream-end' || event.is_finished) {
          const responseMeta = event.response;
          if (responseMeta?.meta?.tokens) {
            finalUsage = this.toUsage(responseMeta.meta.tokens);
          }

          if (responseMeta?.finish_reason) {
            finishReason =
              responseMeta.finish_reason === 'COMPLETE'
                ? 'stop'
                : responseMeta.finish_reason === 'MAX_TOKENS'
                  ? 'length'
                  : null;
          }

          yield {
            id: responseMeta?.id ?? generationId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: responseMeta?.text ?? aggregatedText,
                },
                delta: {},
                finish_reason: finishReason,
                logprobs: null,
              },
            ],
            usage: finalUsage,
          };

          return;
        }
      }
    }
  }

  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];

    const cohereResponse = await this.executeThroughBulkhead(async () => {
      const response = await fetch(`${this.baseURL}/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(this.config.timeout ?? 60000),
        body: JSON.stringify({
          model: request.model ?? 'embed-english-v3.0',
          texts: inputs,
          input_type: 'search_document',
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(`Cohere embeddings error: ${JSON.stringify(error)}`);
      }

      return (await response.json()) as {
        embeddings: number[][];
        [key: string]: unknown;
      };
    }, 'embeddings');

    return {
      object: 'list',
      data: cohereResponse.embeddings.map((embedding: number[], index: number) => ({
        object: 'embedding',
        embedding,
        index,
      })),
      model: request.model ?? 'embed-english-v3.0',
      usage: {
        prompt_tokens: inputs.join('').length / 4,
        completion_tokens: 0,
        total_tokens: inputs.join('').length / 4,
      },
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const response = await fetch(`${this.baseURL}/check-api-key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
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

  calculateCost(model: Model, inputTokens: number, outputTokens: number): number {
    const inputRate = Number(model.inputCostPer1k) || 0;
    const outputRate = Number(model.outputCostPer1k) || 0;
    const cost = (inputTokens / 1000) * Math.max(0, inputRate)
               + (outputTokens / 1000) * Math.max(0, outputRate);
    return Math.max(0, cost);
  }

  normalizeModelName(modelName: string): string {
    return modelName;
  }

  private toCohereMessages(request: ChatRequest): CohereChatMessage[] {
    return request.messages.map((message) => ({
      role: message.role === 'system' ? 'SYSTEM' : message.role === 'user' ? 'USER' : 'CHATBOT',
      message:
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    }));
  }

  private toUsage(tokens?: { input_tokens?: number; output_tokens?: number }): Usage | undefined {
    if (!tokens) {
      return undefined;
    }

    const promptTokens = tokens.input_tokens ?? 0;
    const completionTokens = tokens.output_tokens ?? 0;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  }

  /**
   * Content Moderation
   * Cohere does not have a dedicated moderation API
   */
  /**
   * Content Moderation
   * Cohere does not have a dedicated moderation API
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
        raw: { error: errorMessage, provider: 'cohere', note: 'Fallback moderation response' },
      };
    }
  }

  /**
   * Image Edit
   * Cohere does not have image editing capability
   */
  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('Cohere image editing is not yet implemented. Cohere does not provide image editing capabilities. Use OpenAI DALL-E for image editing.');
  }

  /**
   * Image Variation
   * Cohere does not have image variation capability
   */
  async imageVariation(_model: Model, _request: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('Cohere image variation is not yet implemented. Cohere does not provide image variation capabilities. Use OpenAI DALL-E for image variations.');
  }
}
