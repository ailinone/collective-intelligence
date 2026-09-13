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
  MessageContent,
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
import { recordProviderPromptCacheUsage } from '@/observability/ci-metrics';
import { TextDecoder } from 'node:util';

const log = logger.child({ provider: 'cohere-adapter' });

/** Chat API v2 message shape — `docs.cohere.com/v2/reference/chat`. */
interface CohereV2Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/** Chat API v2 usage shape, including the `cached_tokens` field v1 never had. */
interface CohereV2Usage {
  billed_units?: { input_tokens?: number; output_tokens?: number };
  tokens?: { input_tokens?: number; output_tokens?: number };
  cached_tokens?: number;
}

interface CohereV2ChatResponse {
  id?: string;
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  finish_reason?: string;
  usage?: CohereV2Usage;
}

/**
 * Chat API v2 SSE event, `POST /v2/chat` with `stream: true`
 * (`docs.cohere.com/v2/docs/streaming`, verified live 2026-09-09). Every
 * event is one `data: {...}` line self-describing its own `type` — no
 * separate `event:` SSE field to track, matching the loop structure this
 * file already used for v1.
 */
interface CohereV2StreamEvent {
  type?: string;
  /** Present on `message-start`. */
  id?: string;
  delta?: {
    /** Present on `content-delta`. */
    message?: { content?: { text?: string } };
    /** Present on `message-end`. */
    finish_reason?: string;
    /** Present on `message-end`. */
    usage?: CohereV2Usage;
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
 *
 * ### Chat API v2 migration (ADR-025 follow-up, 2026-09-09)
 *
 * Chat completions (`chatCompletion` / `chatCompletionStream`) now target
 * Cohere's Chat API **v2** (`POST /v2/chat`), not the legacy v1 `/chat`
 * endpoint this class used before. This is a real, verified gap-closure, not
 * a style change: v1's response has no cache-related field at all, while v2
 * documents `usage.cached_tokens` — "the number of prompt tokens that hit
 * the inference cache" (docs.cohere.com/v2/reference/chat, verified live
 * 2026-09-09) — with no request-side field to set (automatic, server-side).
 * There was no way to close this gap without moving off v1.
 *
 * v2 also simplifies the wire shape: a single `messages` array (role
 * `system`/`user`/`assistant`/`tool`) replaces v1's split
 * `message` + `chat_history`, and the assistant's text lives at
 * `message.content[].text` instead of a flat `text` field. `finish_reason`
 * is read from the real documented enum (`COMPLETE`, `STOP_SEQUENCE`,
 * `MAX_TOKENS`, `TOOL_CALL`, `ERROR`, `TIMEOUT`) rather than the previous
 * unconditional `'stop'`.
 *
 * Embeddings (`generateEmbeddings`) and the API-key health check are
 * DELIBERATELY left on v1 (`${baseURL}/embed`, `${baseURL}/check-api-key`) —
 * out of scope for this fix, and v1 has no known deprecation date for those
 * two endpoints specifically.
 */
export class CohereAdapter extends ProviderAdapter {
  private readonly baseURL: string;
  private readonly apiKey: string;

  constructor(config: ProviderConfig) {
    super('cohere', 'Cohere', config);
    this.apiKey = config.apiKey;
    this.baseURL = config.baseUrl || 'https://api.cohere.ai/v1';
  }

  /**
   * Chat API v2 lives under `/v2` while everything else in this adapter
   * (embeddings, health) stays on the `/v1` root already configured via
   * `baseURL`. Swap a trailing `/v1` for `/v2` when present (the default
   * configuration); otherwise assume the configured root carries no version
   * segment and append `/v2` (covers an operator-supplied `baseUrl` pointed
   * at a bare host or a compatible proxy).
   */
  private get chatV2BaseURL(): string {
    return /\/v1\/?$/.test(this.baseURL)
      ? this.baseURL.replace(/\/v1\/?$/, '/v2')
      : `${this.baseURL.replace(/\/+$/, '')}/v2`;
  }

  async getModels(): Promise<Model[]> {
    const models = await getModelsByProvider('cohere');

    if (!models.length) {
      log.warn('No models registered in catalog for Cohere');
    }

    // Remove provider prefix from model IDs to return normalized names
    return models.map((model) => ({
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
    const messages = this.toCohereV2Messages(request);

    // Get default model dynamically from available models (no hardcoding)
    let modelId = request.model;
    if (!modelId) {
      const models = await this.getModels();
      const chatModels = models.filter(
        (m) =>
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
      const response = await fetch(`${this.chatV2BaseURL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(this.config.timeout ?? 60000),
        body: JSON.stringify({
          model: modelId,
          messages,
          temperature: request.temperature,
          max_tokens: request.max_tokens,
          stream: false,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(`Cohere API error: ${JSON.stringify(error)}`);
      }

      const cohereResponse = (await response.json()) as CohereV2ChatResponse;
      const text = (cohereResponse.message?.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');

      return {
        id: cohereResponse.id || `cohere-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text,
            },
            finish_reason: this.mapFinishReason(cohereResponse.finish_reason),
            logprobs: null,
          },
        ],
        usage: this.toUsageV2(cohereResponse.usage),
      };
    }, 'chat completion');
  }

  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    const messages = this.toCohereV2Messages(request);

    // Get default model dynamically from available models (no hardcoding)
    let modelId = request.model;
    if (!modelId) {
      const models = await this.getModels();
      const chatModels = models.filter(
        (m) =>
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
      const res = await fetch(`${this.chatV2BaseURL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(this.config.timeout ?? 60000),
        body: JSON.stringify({
          model: modelId,
          messages,
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
    let messageId = `cohere-${Date.now()}`;

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
        if (!payload || payload === '[DONE]') {
          continue;
        }

        let event: CohereV2StreamEvent;
        try {
          event = JSON.parse(payload) as CohereV2StreamEvent;
        } catch (error) {
          // Skip malformed chunks but continue streaming
          continue;
        }

        if (event.type === 'message-start' && typeof event.id === 'string') {
          messageId = event.id;
        }

        if (event.type === 'content-delta') {
          const chunkText = event.delta?.message?.content?.text ?? '';
          if (!chunkText) {
            continue;
          }

          yield {
            id: messageId,
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

        if (event.type === 'message-end') {
          const finishReason = this.mapFinishReason(event.delta?.finish_reason);
          const finalUsage = this.toUsageV2(event.delta?.usage);

          yield {
            id: messageId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
              {
                index: 0,
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
    const cost =
      (inputTokens / 1000) * Math.max(0, inputRate) +
      (outputTokens / 1000) * Math.max(0, outputRate);
    return Math.max(0, cost);
  }

  normalizeModelName(modelName: string): string {
    return modelName;
  }

  private toCohereV2Messages(request: ChatRequest): CohereV2Message[] {
    return request.messages.map((message) => ({
      // v2's role enum has no 'function' — Cohere's own 'tool' role is the
      // closest equivalent (a tool-result message), same mapping OpenAI's
      // ecosystem generally uses when normalizing away 'function'.
      role: message.role === 'function' ? 'tool' : message.role,
      content: this.extractTextContent(message.content),
    }));
  }

  /**
   * v2's `content` field accepts a plain string OR OpenAI-style content
   * blocks. This adapter forwards plain text only — matching the prior v1
   * behavior's scope (image/multimodal content was never wired here either;
   * v1 fell back to `JSON.stringify`, which is not a real content format
   * Cohere accepts, so this is a genuine (if narrow) correctness fix, not
   * just a v2 port).
   */
  private extractTextContent(content: string | MessageContent[]): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter((text) => text.length > 0)
      .join('\n');
  }

  /**
   * v2's finish_reason enum (`COMPLETE`, `STOP_SEQUENCE`, `MAX_TOKENS`,
   * `TOOL_CALL`, `ERROR`, `TIMEOUT` — docs.cohere.com/v2/reference/chat,
   * verified live 2026-09-09) mapped onto ci's shared finish-reason union.
   * `ERROR`/`TIMEOUT`/anything undocumented fall back to `'stop'` rather
   * than `null`, preserving this adapter's prior (v1) behavior of always
   * reporting a definite reason when the vendor returned one at all.
   */
  private mapFinishReason(reason?: string): 'stop' | 'length' | 'tool_calls' | null {
    if (!reason) return null;
    if (reason === 'MAX_TOKENS') return 'length';
    if (reason === 'TOOL_CALL') return 'tool_calls';
    return 'stop';
  }

  /**
   * Cohere v2 usage → ci's `Usage` shape, plus prompt-cache observability
   * (ADR-025 follow-up, 2026-09-09). `tokens.input_tokens` (the vendor's
   * "Total input tokens consumed") is preferred over `billed_units
   * .input_tokens` for the prompt-token count used both here and to derive
   * the cache miss count, since `billed_units` is already
   * post-cache-discount billing and would otherwise understate real prompt
   * size. Falls back to `billed_units` only when `tokens` is absent.
   */
  private toUsageV2(usage?: CohereV2Usage): Usage | undefined {
    if (!usage) {
      return undefined;
    }

    const promptTokens = usage.tokens?.input_tokens ?? usage.billed_units?.input_tokens ?? 0;
    const completionTokens = usage.tokens?.output_tokens ?? usage.billed_units?.output_tokens ?? 0;
    this.recordCacheUsage(usage, promptTokens);

    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  }

  /**
   * Surface Cohere's own reported cache-hit tokens into ci's provider-cache
   * observability metric. Cohere's Chat API v2 documents `usage
   * .cached_tokens` as "the number of prompt tokens that hit the inference
   * cache" (docs.cohere.com/v2/reference/chat, verified live 2026-09-09) —
   * fully automatic, no request-side field to set, and the ONLY place this
   * is exposed at all (v1 has no equivalent field, which is why this
   * adapter had to move to v2 to close this gap). Cohere only reports the
   * hit count directly, so the miss count is derived as
   * `promptTokens - cached_tokens`, same pattern as every other
   * hit-only-reporting provider in this follow-up.
   */
  private recordCacheUsage(usage: CohereV2Usage, promptTokens: number): void {
    if (typeof usage.cached_tokens !== 'number') {
      return;
    }
    recordProviderPromptCacheUsage({
      provider: 'cohere',
      hitTokens: usage.cached_tokens,
      missTokens: Math.max(0, promptTokens - usage.cached_tokens),
    });
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
      const contentStr =
        typeof messageContent === 'string' ? messageContent : JSON.stringify(messageContent ?? {});
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
          'self-harm/instructions':
            moderationResult.categories?.['self-harm/instructions'] || false,
          'harassment/threatening':
            moderationResult.categories?.['harassment/threatening'] || false,
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
          'self-harm/instructions':
            moderationResult.category_scores?.['self-harm/instructions'] || 0,
          'harassment/threatening':
            moderationResult.category_scores?.['harassment/threatening'] || 0,
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
    throw new Error(
      'Cohere image editing is not yet implemented. Cohere does not provide image editing capabilities. Use OpenAI DALL-E for image editing.'
    );
  }

  /**
   * Image Variation
   * Cohere does not have image variation capability
   */
  async imageVariation(
    _model: Model,
    _request: ImageVariationRequest
  ): Promise<ImageVariationResponse> {
    throw new Error(
      'Cohere image variation is not yet implemented. Cohere does not provide image variation capabilities. Use OpenAI DALL-E for image variations.'
    );
  }
}
