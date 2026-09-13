// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { ProviderAdapter, type BalanceCheckResult, type HealthCheckResult } from '../base/provider-adapter';
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
import { recordProviderPromptCacheUsage } from '@/observability/ci-metrics';

const log = logger.child({ provider: 'deepseek-adapter' });

/**
 * Surface DeepSeek's own reported context-cache tokens into ci's
 * provider-cache observability metric (ADR-025 follow-up, 2026-09).
 *
 * DeepSeek's context caching on disk is fully automatic and transparent —
 * there is no request-side field to set — but the response `usage` object
 * directly reports BOTH `prompt_cache_hit_tokens` and
 * `prompt_cache_miss_tokens` (api-docs.deepseek.com/guides/kv_cache,
 * verified live 2026-09-08), unlike providers that only report a hit count.
 * A no-op when neither field is present (a response shape DeepSeek hasn't
 * populated, e.g. a request too small to ever have been cached).
 */
function recordDeepSeekCacheUsage(usage: unknown): void {
  if (!usage || typeof usage !== 'object') return;
  const usageObj = usage as Record<string, unknown>;
  const hitTokens =
    typeof usageObj.prompt_cache_hit_tokens === 'number'
      ? usageObj.prompt_cache_hit_tokens
      : undefined;
  const missTokens =
    typeof usageObj.prompt_cache_miss_tokens === 'number'
      ? usageObj.prompt_cache_miss_tokens
      : undefined;
  if (hitTokens === undefined && missTokens === undefined) return;

  recordProviderPromptCacheUsage({ provider: 'deepseek', hitTokens, missTokens });
}

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
    return models.map((model) => ({
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

  /**
   * Check DeepSeek account balance via GET /user/balance.
   * Endpoint lives outside the /v1 prefix, so strip it from baseURL.
   */
  async checkBalance(): Promise<BalanceCheckResult | null> {
    try {
      const balanceUrl = `${this.baseURL.replace(/\/v1\/?$/, '')}/user/balance`;
      const res = await fetch(balanceUrl, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        is_available?: boolean;
        balance_infos?: Array<{ currency: string; total_balance?: string }>;
      };
      const info = data.balance_infos?.[0];
      if (!info) return null;
      const balance = Number.parseFloat(info.total_balance ?? '');
      return {
        hasCredits: data.is_available ?? (Number.isFinite(balance) ? balance > 0 : true),
        balance: Number.isFinite(balance) ? balance : undefined,
        currency: info.currency === 'CNY' ? 'CNY' : 'USD',
      };
    } catch {
      return null;
    }
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

      const parsed = (await response.json()) as ChatResponse;
      recordDeepSeekCacheUsage(parsed.usage);
      return parsed;
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

    // Real DeepSeek (OpenAI-compatible) streaming only sends `id` +
    // `function.name` on the FIRST delta chunk of a given tool call; every
    // continuation chunk carries only `{index, function: {arguments:
    // <fragment>}}`. This map tracks the id/name already seen per `index` so
    // continuation fragments can be correctly tagged instead of dropped. It
    // is a plain local variable scoped to this single generator invocation
    // (one per request) — it is never stored on `this`, so concurrent
    // requests never share or leak state through it.
    const toolCallState = new Map<number, { id: string; name: string }>();

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
              yield this.convertStreamChunk(data, request.model || 'deepseek-chat', toolCallState);
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
    const cost =
      (inputTokens / 1000) * Math.max(0, inputRate) +
      (outputTokens / 1000) * Math.max(0, outputRate);
    return Math.max(0, cost);
  }

  normalizeModelName(modelName: string): string {
    // DeepSeek model names are already normalized
    return modelName;
  }

  /**
   * Convert stream chunk to ChatResponse format
   *
   * @param toolCallState Per-stream accumulator (see the call site in
   * `chatCompletionStream`) tracking the `id`/`function.name` already seen
   * for each in-progress tool call `index`. Real DeepSeek (OpenAI-compatible)
   * streaming sends those only on the first delta chunk of a tool call;
   * every continuation chunk carries just `{index, function: {arguments:
   * <fragment>}}`. Without this, continuation-only fragments have no
   * `id`/`name` to satisfy the (non-optional) `ToolCall` shape and were
   * previously dropped outright, silently truncating/corrupting
   * multi-fragment tool-call arguments.
   */
  private convertStreamChunk(
    chunk: unknown,
    requestedModel: string,
    toolCallState?: Map<number, { id: string; name: string }>
  ): ChatResponse {
    // Type guard for chunk structure
    if (!chunk || typeof chunk !== 'object') {
      throw new Error('Invalid chunk format');
    }

    const chunkObj = chunk as Record<string, unknown>;
    const choices = Array.isArray(chunkObj.choices) ? chunkObj.choices : [];

    // Type guard for role
    const isValidRole = (
      role: unknown
    ): role is 'system' | 'user' | 'assistant' | 'function' | 'tool' => {
      return (
        typeof role === 'string' &&
        ['system', 'user', 'assistant', 'function', 'tool'].includes(role)
      );
    };

    // Type guard for finish_reason
    const isValidFinishReason = (
      reason: unknown
    ): reason is 'stop' | 'length' | 'tool_calls' | 'content_filter' | null => {
      return (
        reason === null ||
        (typeof reason === 'string' &&
          ['stop', 'length', 'tool_calls', 'content_filter'].includes(reason))
      );
    };

    return {
      id: typeof chunkObj.id === 'string' ? chunkObj.id : `deepseek-${Date.now()}`,
      object: 'chat.completion.chunk',
      created:
        typeof chunkObj.created === 'number' ? chunkObj.created : Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: choices.map((choice: unknown) => {
        if (!choice || typeof choice !== 'object') {
          throw new Error('Invalid choice format');
        }
        const choiceObj = choice as Record<string, unknown>;
        const delta =
          choiceObj.delta && typeof choiceObj.delta === 'object'
            ? (choiceObj.delta as Record<string, unknown>)
            : {};
        const role = delta.role && isValidRole(delta.role) ? delta.role : undefined;
        const finishReason =
          choiceObj.finish_reason && isValidFinishReason(choiceObj.finish_reason)
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
                if (
                  item &&
                  typeof item === 'object' &&
                  'type' in item &&
                  item.type === 'text' &&
                  'text' in item &&
                  typeof (item as { text: unknown }).text === 'string'
                ) {
                  return (item as { text: string }).text;
                }
                return '';
              })
              .filter((s): s is string => s.length > 0)
              .join('\n');
          }
        }

        // Handle tool calls with an id/name accumulator: real streaming only
        // sends id+name on the first chunk of a tool call, so a strict
        // "id+type+function.name" shape guard would silently drop every
        // continuation-only fragment. Track identity per wire-protocol
        // `index` instead of requiring it on every chunk.
        let toolCalls: ToolCall[] | undefined = undefined;
        if (
          delta.tool_calls !== undefined &&
          delta.tool_calls !== null &&
          Array.isArray(delta.tool_calls)
        ) {
          const validToolCalls: ToolCall[] = [];
          for (const [position, tcRaw] of delta.tool_calls.entries()) {
            if (!tcRaw || typeof tcRaw !== 'object') continue;
            const tc = tcRaw as Record<string, unknown>;

            // The real wire-protocol `index` is what correlates fragments of
            // the SAME tool call across chunks — array position is only a
            // fallback for a malformed/legacy payload that omits it.
            const index = typeof tc.index === 'number' ? tc.index : position;

            const func =
              tc.function && typeof tc.function === 'object'
                ? (tc.function as Record<string, unknown>)
                : undefined;
            const rawId = typeof tc.id === 'string' ? tc.id : undefined;
            const rawName = func && typeof func.name === 'string' ? func.name : undefined;
            const rawArgs = func && typeof func.arguments === 'string' ? func.arguments : undefined;

            // First chunk of a tool call carries id and/or name — remember it
            // so later continuation chunks (which omit both) can still be
            // tagged with the right identity.
            let tracked = toolCallState?.get(index);
            if (rawId !== undefined || rawName !== undefined) {
              tracked = {
                id: rawId ?? tracked?.id ?? '',
                name: rawName ?? tracked?.name ?? '',
              };
              toolCallState?.set(index, tracked);
            }

            // Nothing usable at all (no tracked identity yet, no fragment) —
            // this is the only case worth dropping.
            if (!tracked && rawArgs === undefined) continue;

            validToolCalls.push({
              id: tracked?.id ?? rawId ?? '',
              type: 'function',
              function: {
                name: tracked?.name ?? rawName ?? '',
                // Forward the fragment as-is (NOT the accumulated total) so a
                // caller doing the standard OpenAI-client-style
                // `arguments += delta` reconstruction gets the right result.
                arguments: rawArgs ?? '',
              },
              index,
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
        // Real DeepSeek streaming carries `prompt_cache_hit_tokens`/
        // `prompt_cache_miss_tokens` on the same usage-bearing final chunk
        // as `prompt_tokens`/`completion_tokens`/`total_tokens` — surface
        // them to observability BEFORE narrowing to the fixed `Usage` shape
        // below (see `recordDeepSeekCacheUsage`'s module comment for why
        // this isn't added to the returned object's type instead).
        recordDeepSeekCacheUsage(chunkObj.usage);
        const usageObj = chunkObj.usage as Record<string, unknown>;
        const promptTokens =
          typeof usageObj.prompt_tokens === 'number' ? usageObj.prompt_tokens : undefined;
        const completionTokens =
          typeof usageObj.completion_tokens === 'number' ? usageObj.completion_tokens : undefined;
        const totalTokens =
          typeof usageObj.total_tokens === 'number' ? usageObj.total_tokens : undefined;

        if (
          promptTokens === undefined &&
          completionTokens === undefined &&
          totalTokens === undefined
        ) {
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
    throw new Error(
      'DeepSeek does not support image editing. This provider does not have image manipulation capabilities. Please use OpenAI DALL-E or another provider that supports image editing.'
    );
  }

  /**
   * Image Variation
   * DeepSeek does not have native image variation capability
   * Returns an error response indicating the limitation
   */
  async imageVariation(
    _model: Model,
    _request: ImageVariationRequest
  ): Promise<ImageVariationResponse> {
    throw new Error(
      'DeepSeek does not support image variations. This provider does not have image manipulation capabilities. Please use OpenAI DALL-E or another provider that supports image variations.'
    );
  }
}
