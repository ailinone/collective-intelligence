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
import { resolveReasoningEffort, type ReasoningEffort } from '@/utils/reasoning-effort';
import { deriveSessionKey } from '@/services/session-affinity-service';
import { recordProviderPromptCacheUsage } from '@/observability/ci-metrics';

const log = logger.child({ provider: 'xai-adapter' });

/**
 * xAI's Grok API only accepts the `reasoning_effort` request parameter for
 * the Grok 3 Mini reasoning family (`grok-3-mini`, `grok-3-mini-fast`, and
 * any dated/suffixed variant of them) — per xAI's reasoning guide
 * (https://docs.x.ai/docs/guides/reasoning): "grok-3-mini and
 * grok-3-mini-fast are currently the only models that support the
 * reasoning_effort parameter." Every other Grok model either always reasons
 * internally with no user-tunable knob (grok-4 and later) or doesn't reason
 * at all, and REJECTS the field outright with an API error if it is sent —
 * so this must gate, not just translate.
 *
 * Name-pattern detection (a family regex, not a hardcoded exact-model
 * allowlist) mirrors this adapter's own `extractTier()` fetcher logic
 * (xai-model-fetcher.ts), which already infers the "mini/fast" tier from
 * the same substring — kept in sync automatically as xAI ships new dated
 * snapshots of the same mini family.
 */
function xaiModelSupportsReasoningEffort(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return /grok-3-mini/i.test(modelId);
}

/**
 * Translate the canonical 3-tier `reasoning_effort` (low/medium/high — see
 * utils/reasoning-effort.ts) onto xAI's real 2-tier wire enum, which is only
 * `'low' | 'high'` (grok-3-mini has no `medium`). `medium` rounds UP to
 * `high`: xAI's own docs reserve `low` for "simple problems", so an
 * explicit non-minimal reasoning request is better served erring toward
 * more reasoning budget than silently truncating the caller's intent down
 * to xAI's most restrictive tier.
 */
function toXaiReasoningEffort(effort: ReasoningEffort): 'low' | 'high' {
  return effort === 'low' ? 'low' : 'high';
}

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
    return models.map((model) => ({
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

  /**
   * Resolve the canonical `reasoning_effort` signal (LOTE AZ resolver) into
   * the `{ reasoning_effort: 'low' | 'high' }` fragment to spread into an
   * outgoing xAI request body — empty when the caller expressed no effort,
   * or when the target model doesn't support the parameter at all (see
   * `xaiModelSupportsReasoningEffort` above).
   */
  private buildReasoningEffortField(request: ChatRequest): { reasoning_effort?: 'low' | 'high' } {
    if (!xaiModelSupportsReasoningEffort(request.model)) return {};
    const { effort } = resolveReasoningEffort(request);
    if (!effort) return {};
    return { reasoning_effort: toXaiReasoningEffort(effort) };
  }

  /**
   * Prompt caching (ADR-025 follow-up, 2026-09): xAI's prompt cache is
   * automatic server-side, but per xAI's own docs
   * (docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works,
   * verified live 2026-09-08) the `x-grok-conv-id` HTTP header "routes
   * requests with the same conversation ID to the same server" on the
   * standard `/v1/chat/completions` endpoint, maximizing cache hit rate the
   * same way OpenAI's `prompt_cache_key` body field and Mistral's field of
   * the same name do for their own APIs. Reuses the SAME derivation session
   * affinity uses (session-affinity-service.ts) so it stays stable
   * turn-to-turn independent of whether session affinity itself is enabled.
   */
  private buildCacheRoutingHeader(request: ChatRequest): Record<string, string> {
    return { 'x-grok-conv-id': deriveSessionKey(request) };
  }

  /**
   * Surface xAI's own reported cache-hit tokens into ci's provider-cache
   * observability metric. xAI's OpenAI-compatible usage object nests the
   * cached count under `prompt_tokens_details.cached_tokens` (same
   * verified doc as `buildCacheRoutingHeader` above) rather than a flat
   * `cached_tokens` field — xAI only reports the hit count directly, so the
   * miss count is derived as `prompt_tokens - cached_tokens`. A no-op when
   * the field is absent (e.g. an older response shape, or a request too
   * small/fresh to have hit the cache at all).
   */
  private recordCacheUsage(usage: unknown): void {
    if (!usage || typeof usage !== 'object') return;
    const usageObj = usage as Record<string, unknown>;
    const promptTokens =
      typeof usageObj.prompt_tokens === 'number' ? usageObj.prompt_tokens : undefined;
    const details = usageObj.prompt_tokens_details;
    const cachedTokens =
      details && typeof details === 'object'
        ? (details as Record<string, unknown>).cached_tokens
        : undefined;
    if (typeof cachedTokens !== 'number') return;

    recordProviderPromptCacheUsage({
      provider: 'xai',
      hitTokens: cachedTokens,
      missTokens: typeof promptTokens === 'number' ? Math.max(0, promptTokens - cachedTokens) : undefined,
    });
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
          ...this.buildCacheRoutingHeader(request),
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.max_tokens,
          stream: false,
          tools: request.tools,
          // xAI's chat API is byte-identical to OpenAI here: 'auto' | 'none' |
          // 'required' | {type:'function', function:{name}} — confirmed
          // against https://docs.x.ai/docs/guides/function-calling. Forwarded
          // verbatim; `undefined` is dropped by JSON.stringify, preserving
          // today's behavior when the caller doesn't ask for tool-choice
          // control.
          tool_choice: request.tool_choice,
          ...this.buildReasoningEffortField(request),
        }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({ error: response.statusText }))) as {
          error?: string;
          message?: string;
          [key: string]: unknown;
        };
        throw new Error(`XAI API error: ${JSON.stringify(error)}`);
      }

      const parsed = (await response.json()) as ChatResponse;
      this.recordCacheUsage(parsed.usage);
      return parsed;
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
          ...this.buildCacheRoutingHeader(_request),
        },
        body: JSON.stringify({
          model: _request.model,
          messages: _request.messages,
          temperature: _request.temperature,
          max_tokens: _request.max_tokens,
          stream: true,
          tools: _request.tools,
          // See the non-streaming body above for the field's exact shape.
          tool_choice: _request.tool_choice,
          ...this.buildReasoningEffortField(_request),
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

    // Real xAI (OpenAI-compatible) streaming only sends `id` + `function.name`
    // on the FIRST delta chunk of a given tool call; every continuation chunk
    // carries only `{index, function: {arguments: <fragment>}}`. This map
    // tracks the id/name already seen per `index` so continuation fragments
    // can be correctly tagged instead of dropped. It is a plain local
    // variable scoped to this single generator invocation (one per request)
    // — it is never stored on `this`, so concurrent requests never share or
    // leak state through it.
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
              yield this.convertStreamChunk(data, _request.model || 'grok-2-latest', toolCallState);
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
          (m) =>
            m.providerId === providerId &&
            (m.capabilities?.includes('embeddings') || m.id.includes('embedding'))
        );

        if (embeddingModel) {
          const providerResult = await registry.findModel(embeddingModel.id);
          if (providerResult?.adapter) {
            log.info(
              {
                xaiModel: request.model,
                fallbackProvider: providerId,
                fallbackModel: embeddingModel.id,
              },
              'Using embeddings fallback provider for X.AI request'
            );

            const embeddingResponse = await providerResult.adapter.generateEmbeddings({
              ...request,
              model: embeddingModel.id,
            });

            // Return response with updated model name
            log.info(
              {
                originalProvider: 'xai',
                originalModel: request.model,
                fallbackProvider: providerId,
                fallbackModel: embeddingModel.id,
                reason: 'X.AI does not provide embeddings API',
              },
              'Embeddings request handled by fallback provider'
            );

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
      const balance =
        typeof data.total_available === 'number'
          ? data.total_available
          : typeof data.balance === 'number'
            ? data.balance
            : undefined;
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
    const cost = (inputTokens / 1000) * inputRate + (outputTokens / 1000) * outputRate;
    return Math.max(0, cost);
  }

  normalizeModelName(modelName: string): string {
    return modelName;
  }

  /**
   * Convert streaming chunk to our format
   *
   * @param toolCallState Per-stream accumulator (see the call site in
   * `chatCompletionStream`) tracking the `id`/`function.name` already seen
   * for each in-progress tool call `index`. Real xAI (OpenAI-compatible)
   * streaming sends those only on the first delta chunk of a tool call;
   * every continuation chunk carries just `{index, function: {arguments:
   * <fragment>}}`. Without this, continuation-only fragments have no
   * `id`/`name` to satisfy the (non-optional) `ToolCall` shape and were
   * previously dropped outright, silently truncating/corrupting
   * multi-fragment tool-call arguments.
   */
  private convertStreamChunk(
    rawChunk: unknown,
    requestedModel: string,
    toolCallState?: Map<number, { id: string; name: string }>
  ): ChatResponse {
    // SSE chunk arrives as untrusted JSON. Narrow once at the entry point;
    // the function body still uses optional chaining for deeper levels.
    const chunk: {
      id?: string;
      created?: number;
      choices?: Array<{
        index?: number;
        delta?: { role?: string; content?: string; tool_calls?: unknown };
        finish_reason?: string;
      }>;
      usage?: unknown;
    } = isObject(rawChunk) ? narrowAs(rawChunk) : {};
    // Type guard for role
    function normalizeRole(role: string | undefined): 'user' | 'assistant' | 'system' {
      if (role === 'user' || role === 'assistant' || role === 'system') {
        return role;
      }
      return 'assistant';
    }

    // Type guard for finish_reason
    function normalizeFinishReason(
      reason: string | undefined
    ): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
      if (
        reason === 'stop' ||
        reason === 'length' ||
        reason === 'tool_calls' ||
        reason === 'content_filter'
      ) {
        return reason;
      }
      return null;
    }

    const choices: ChatChoice[] = (chunk.choices || []).map((choice) => {
      // Handle tool calls with an id/name accumulator: real streaming only
      // sends id+name on the first chunk of a tool call, so a strict
      // "id+type+function.name" shape guard would silently drop every
      // continuation-only fragment. Track identity per wire-protocol
      // `index` instead of requiring it on every chunk.
      let toolCalls: ToolCall[] | undefined = undefined;
      if (
        choice.delta?.tool_calls !== undefined &&
        choice.delta.tool_calls !== null &&
        Array.isArray(choice.delta.tool_calls)
      ) {
        const validToolCalls: ToolCall[] = [];
        for (const [position, tcRaw] of choice.delta.tool_calls.entries()) {
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
        this.recordCacheUsage(chunk.usage);
        const usageObj = chunk.usage as Record<string, unknown>;
        return {
          prompt_tokens: typeof usageObj.prompt_tokens === 'number' ? usageObj.prompt_tokens : 0,
          completion_tokens:
            typeof usageObj.completion_tokens === 'number' ? usageObj.completion_tokens : 0,
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
        raw: { error: errorMessage, provider: 'xai', note: 'Fallback moderation response' },
      };
    }
  }

  /**
   * Image Edit
   * X.AI (Grok) does not have image editing capability
   */
  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error(
      'X.AI (Grok) image editing is not yet implemented. X.AI does not provide image editing capabilities. Use OpenAI DALL-E for image editing.'
    );
  }

  /**
   * Image Variation
   * X.AI (Grok) does not have image variation capability
   */
  async imageVariation(
    _model: Model,
    _request: ImageVariationRequest
  ): Promise<ImageVariationResponse> {
    throw new Error(
      'X.AI (Grok) image variation is not yet implemented. X.AI does not provide image variation capabilities. Use OpenAI DALL-E for image variations.'
    );
  }
}
