// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { logger } from '@/utils/logger';
import {
  ProviderAdapter,
  type ProviderConfig,
  type HealthCheckResult,
} from '../base/provider-adapter';
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
import { deriveSessionKey } from '@/services/session-affinity-service';
import { recordProviderPromptCacheUsage } from '@/observability/ci-metrics';

const log = logger.child({ provider: 'mistral-adapter' });

/**
 * Surface Mistral's own reported cache-hit tokens into ci's provider-cache
 * observability metric (ADR-025 follow-up, 2026-09).
 *
 * Mistral's usage object nests the cached count under
 * `prompt_tokens_details.cached_tokens` — the SAME shape as OpenAI/xAI —
 * per docs.mistral.ai/studio-api/conversations/advanced/prompt-caching
 * (verified live 2026-09-08), which also documents that prompts under 64
 * tokens never produce a cache hit (Mistral's cache blocks are 64 tokens
 * each; this is the vendor's own internal eligibility rule, not something
 * this adapter's request needs to gate on — `prompt_cache_key` is just a
 * stable string, unconditionally safe to send regardless of prompt size,
 * exactly like OpenAI's identical mechanism). Mistral only reports the hit
 * count directly, so the miss count is derived as
 * `prompt_tokens - cached_tokens`. A no-op when the field is absent.
 */
function recordMistralCacheUsage(usage: unknown): void {
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
    provider: 'mistral',
    hitTokens: cachedTokens,
    missTokens: typeof promptTokens === 'number' ? Math.max(0, promptTokens - cachedTokens) : undefined,
  });
}

/**
 * Mistral AI Provider Adapter
 *
 * Mistral AI offers European-based open-source models with strong performance.
 * Known for excellent quality/cost ratio and GDPR compliance.
 *
 * Key Features:
 * - Mistral Large: Flagship model (competitive with GPT-4)
 * - Mistral Medium: Balanced performance/cost
 * - Mistral Small: Fast and cost-effective
 * - Mistral Tiny: Ultra-cheap for simple tasks
 * - European infrastructure (GDPR compliant)
 * - Function calling support
 *
 * API Compatibility: OpenAI-compatible API
 */
export class MistralAdapter extends ProviderAdapter {
  private baseURL: string;
  private apiKey: string;

  constructor(config: ProviderConfig) {
    super('mistral', 'Mistral AI', config);
    this.apiKey = config.apiKey;
    this.baseURL = config.baseUrl || 'https://api.mistral.ai/v1';
  }

  async getModels(): Promise<Model[]> {
    const models = await getModelsByProvider('mistral');

    if (!models.length) {
      log.warn('No models registered in catalog for Mistral');
    }

    // Remove provider prefix from model IDs to return normalized names
    return models.map((model) => ({
      ...model,
      id: model.name, // Use 'name' which is the normalized ID without prefix
    }));
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
      throw new Error('No Mistral models available - check provider configuration');
    }

    // Filter available models
    const availableModels = models.filter(
      (m) =>
        m.status === 'active' &&
        (m.capabilities?.includes('chat') || m.capabilities?.includes('text_generation'))
    );

    if (availableModels.length === 0) {
      throw new Error('No available Mistral models with chat capability');
    }

    // Selection strategy: cheapest model with streaming capability
    const sortedByCost = availableModels
      .filter((m) => {
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

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();

    return {
      id: 'mistral',
      name: 'mistral',
      displayName: 'Mistral AI',
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
    // Mistral outage fast-fails and is isolated from other providers.
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
          stop: request.stop,
          stream: false,
          // Mistral supports function calling (OpenAI compatible)
          tools: request.tools,
          tool_choice: request.tool_choice,
          // Prompt caching (ADR-025 follow-up, 2026-09): Mistral's own API
          // reference documents `prompt_cache_key` as a request field with
          // the SAME contract as OpenAI's field of the same name — "use the
          // same key for requests with shared prompt prefixes ... to
          // increase cache hits", with cached tokens billed at 10% of the
          // standard input token price (docs.mistral.ai/api, `Chat
          // Completion` -> request body, verified live 2026-09-08). Mistral
          // documents no minimum-prompt-length gate for this field (same as
          // OpenAI's identical mechanism) — it is just a stable string, so
          // there is nothing to conditionally omit below a size threshold.
          // Reuses the SAME derivation session affinity uses
          // (session-affinity-service.ts) so it stays stable turn-to-turn
          // independent of whether session affinity itself is enabled.
          prompt_cache_key: deriveSessionKey(request),
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(`Mistral API error: ${JSON.stringify(error)}`);
      }

      const parsed = (await response.json()) as ChatResponse;
      recordMistralCacheUsage(parsed.usage);
      return parsed;
    }, 'chat completion');
  }

  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    const modelToUse = request.model || (await this.getDefaultModel());
    if (!modelToUse) {
      throw new Error('Model is required for chat completion');
    }

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
          model: modelToUse,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.max_tokens,
          top_p: request.top_p,
          stop: request.stop,
          stream: true,
          tools: request.tools,
          tool_choice: request.tool_choice,
          // Prompt caching (ADR-025 follow-up, 2026-09) — see the
          // non-streaming chatCompletion()'s identical field for the
          // rationale and citation.
          prompt_cache_key: deriveSessionKey(request),
        }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(`Mistral API error: ${JSON.stringify(error)}`);
      }

      return res;
    }, 'chat completion stream');

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    // Real Mistral (OpenAI-compatible) streaming only sends `id` +
    // `function.name` on the FIRST delta chunk of a given tool call; every
    // continuation chunk carries only `{index, function: {arguments:
    // <fragment>}}`. This map tracks the id/name already seen per `index` so
    // continuation fragments can be correctly tagged instead of dropped. It
    // is a plain local variable scoped to this single generator invocation
    // (one per request) — it is never stored on `this`, so concurrent
    // requests never share or leak state through it.
    const toolCallState = new Map<number, { id: string; name: string }>();

    try {
      // Narrow each chunk to `Uint8Array` via runtime guard. This avoids both
      // the `any` widening from the underlying ReadableStream<R=any> default
      // and the `as unknown as` laundering pattern.
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
              // SSE `data` is `unknown` after JSON.parse — `convertStreamChunk`
              // does its own validation/narrowing internally.
              const data: unknown = JSON.parse(trimmed.slice(6));
              yield this.convertStreamChunk(data, modelToUse, toolCallState);
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

  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = request.model || (await this.getDefaultModel());
    return this.executeThroughBulkhead(async () => {
      const response = await fetch(`${this.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: Array.isArray(request.input) ? request.input : [request.input],
        }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({ error: response.statusText }))) as {
          error?: string;
          message?: string;
          [key: string]: unknown;
        };
        throw new Error(`Mistral API error: ${JSON.stringify(error)}`);
      }

      return (await response.json()) as EmbeddingResponse;
    }, 'embeddings');
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

  /**
   * Normalize model name using dynamic discovery
   */
  async normalizeModelName(modelId: string): Promise<string> {
    // If no model specified, use dynamic default
    if (!modelId) {
      return await this.getDefaultModel();
    }

    const models = await this.getModels();
    const modelMap = new Map(models.map((m) => [m.id.toLowerCase(), m.id]));

    // Try exact match first
    if (modelMap.has(modelId.toLowerCase())) {
      return modelMap.get(modelId.toLowerCase())!.replace(/^mistral[-_]/, '');
    }

    // Try fuzzy match (remove dashes, underscores, dots)
    const normalized = modelId.toLowerCase().replace(/[-_.]/g, '');
    for (const [key, value] of modelMap.entries()) {
      if (key.replace(/[-_.]/g, '') === normalized) {
        return value.replace(/^mistral[-_]/, '');
      }
    }

    // Try partial match (e.g., "mistral" matches "mistral-large-latest")
    // Prefer longer/more specific matches
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
      return partialMatches[0].value.replace(/^mistral[-_]/, '');
    }

    // Return as-is if no match (let provider handle it or fail gracefully)
    log.warn(
      { modelId, availableModels: Array.from(modelMap.keys()) },
      'Model not found in available models'
    );
    return modelId;
  }

  /**
   * Convert stream chunk to ChatResponse format
   *
   * @param toolCallState Per-stream accumulator (see the call site in
   * `chatCompletionStream`) tracking the `id`/`function.name` already seen
   * for each in-progress tool call `index`. Real Mistral (OpenAI-compatible)
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
    // Narrow the wire-format chunk to the shape we consume. Any field that
    // doesn't match falls back to a safe default — bad JSON yields an empty
    // chunk, never a crash.
    const chunk: {
      id?: string;
      created?: number;
      choices?: Array<{
        index?: number;
        delta?: { role?: string; content?: string; tool_calls?: unknown };
        finish_reason?: string;
      }>;
      usage?: unknown;
    } =
      typeof rawChunk === 'object' && rawChunk !== null
        ? (rawChunk as {
            id?: string;
            created?: number;
            choices?: Array<{
              index?: number;
              delta?: { role?: string; content?: string; tool_calls?: unknown };
              finish_reason?: string;
            }>;
            usage?: unknown;
          })
        : {};
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
      // Type guard for delta content
      let deltaContent: string | undefined = undefined;
      if (choice.delta?.content !== undefined && choice.delta.content !== null) {
        if (typeof choice.delta.content === 'string') {
          deltaContent = choice.delta.content;
        } else if (Array.isArray(choice.delta.content)) {
          // Convert MessageContent[] to string with type safety
          const contentArray = choice.delta.content as Array<unknown>;
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
            .filter((s: string): s is string => s.length > 0)
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
          ...(deltaContent !== undefined ? { content: deltaContent } : {}),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: normalizeFinishReason(choice.finish_reason),
        logprobs: null,
      };
    });

    // Type guard for usage
    let usage:
      { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined =
      undefined;
    if (chunk.usage && typeof chunk.usage === 'object') {
      recordMistralCacheUsage(chunk.usage);
      const usageObj = chunk.usage as Record<string, unknown>;
      const promptTokens =
        typeof usageObj.prompt_tokens === 'number'
          ? usageObj.prompt_tokens
          : typeof usageObj.promptTokens === 'number'
            ? usageObj.promptTokens
            : 0;
      const completionTokens =
        typeof usageObj.completion_tokens === 'number'
          ? usageObj.completion_tokens
          : typeof usageObj.completionTokens === 'number'
            ? usageObj.completionTokens
            : 0;
      const totalTokens =
        typeof usageObj.total_tokens === 'number'
          ? usageObj.total_tokens
          : typeof usageObj.totalTokens === 'number'
            ? usageObj.totalTokens
            : promptTokens + completionTokens;

      if (promptTokens > 0 || completionTokens > 0 || totalTokens > 0) {
        usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        };
      }
    }

    return {
      id: chunk.id || `mistral-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: chunk.created || Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices,
      usage,
    };
  }

  /**
   * Content Moderation
   * Mistral AI does not have a dedicated moderation API
   */
  async moderate(_model: Model, _request: ModerationRequest): Promise<ModerationResponse> {
    throw new Error(
      'Mistral AI moderation is not yet implemented. Mistral AI does not provide a dedicated moderation endpoint. Use OpenAI moderation or implement content filtering via chat API.'
    );
  }

  /**
   * Image Edit
   * Mistral AI does not have image editing capability
   */
  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error(
      'Mistral AI image editing is not yet implemented. Mistral AI does not provide image editing capabilities. Use OpenAI DALL-E for image editing.'
    );
  }

  /**
   * Image Variation
   * Mistral AI does not have image variation capability
   */
  async imageVariation(
    _model: Model,
    _request: ImageVariationRequest
  ): Promise<ImageVariationResponse> {
    throw new Error(
      'Mistral AI image variation is not yet implemented. Mistral AI does not provide image variation capabilities. Use OpenAI DALL-E for image variations.'
    );
  }
}
