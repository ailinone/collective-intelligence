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
  type HealthCheckResult,
  type BalanceCheckResult,
} from '../base/provider-adapter';
import type {
  ChatChoice,
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  Provider,
  ProviderConfig,
  ToolCall,
} from '@/types';
import type {
  AudioSTTRequest,
  AudioSTTResponse,
  AudioTTSRequest,
  AudioTTSResponse,
  ImageGenRequest,
  ImageGenResponse,
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
  VideoGenRequest,
  VideoGenResponse,
  VisionRequest,
  VisionResponse,
} from '@/types/model-client';
import { getModelsByProvider } from '@/services/model-catalog-service';

interface OpenAICompatibleHubMetadata {
  authHeaderName?: string;
  authScheme?: string;
  secondaryAuthHeaderName?: string;
  secondaryAuthScheme?: string;
  extraHeaders?: Record<string, string>;
  chatCompletionsPath?: string;
  embeddingsPath?: string;
  moderationsPath?: string;
  videosPath?: string;
  /**
   * Poll path template for async-queue video providers (`{taskId}` replaced
   * with the submit response's task id). Absent → `<videosPath>/<taskId>`.
   */
  videoPollPath?: string;
  /**
   * Body shape for the video endpoint: `flat` (OpenAI-style, default) or
   * `payload-wrap` (Together-style `{model, payload:{...}}`). See catalog
   * `videoRequestStyle` — proven by live probe 2026-07-17.
   */
  videoRequestStyle?: 'flat' | 'payload-wrap';
  imagesPath?: string;
  imagesEditsPath?: string;
  imagesVariationsPath?: string;
  audioSpeechPath?: string;
  audioTranscriptionsPath?: string;
  modelListPath?: string;
  /**
   * True when the catalog declares the provider's API key as optional (e.g.
   * self-hosted OAI-compatible servers like LM Studio / vLLM / Ollama that
   * run without auth). The catalog plugin passes this through so
   * `validateConfig` knows whether an empty apiKey should throw.
   */
  apiKeyOptional?: boolean;
}

export interface OpenAICompatibleHubAdapterConfig extends ProviderConfig {
  providerName: string;
  displayName?: string;
  metadata?: OpenAICompatibleHubMetadata;
}

type HubRequestError = Error & {
  status?: number;
  body?: string;
  terminal?: boolean;
};

/**
 * Async video job status classification (lowercased). Success and failure
 * must be told apart at submit time: a terminal-success submit with zero
 * videos is a legitimate empty sync response, while a terminal-failure submit
 * carries the provider's error and must not enter the poll loop.
 */
const VIDEO_TERMINAL_SUCCESS_STATUSES = new Set([
  'succeeded',
  'success',
  'completed',
  'complete',
]);
const VIDEO_TERMINAL_FAILURE_STATUSES = new Set([
  'failed',
  'error',
  'cancelled',
  'canceled',
]);

const DEFAULT_MODERATION_CATEGORY_KEYS = [
  'sexual',
  'hate',
  'harassment',
  'self-harm',
  'sexual/minors',
  'hate/threatening',
  'violence/graphic',
  'self-harm/intent',
  'self-harm/instructions',
  'harassment/threatening',
  'violence',
] as const;

function normalizeProviderName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function normalizeHubModelIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  // Already canonical or workspace-scoped.
  if (trimmed.includes('/')) {
    return trimmed;
  }

  // Convert provider@model to provider/model for OpenAI-compatible execution.
  const atIndex = trimmed.indexOf('@');
  if (atIndex > 0 && atIndex < trimmed.length - 1) {
    const provider = trimmed.slice(0, atIndex).trim();
    const model = trimmed.slice(atIndex + 1).trim();
    if (provider && model && !model.includes('/')) {
      return `${provider}/${model}`;
    }
  }

  return trimmed;
}

/**
 * Pattern-based detection for OpenAI model families that require
 * `max_completion_tokens` instead of `max_tokens`. This covers:
 *   - GPT-5.x family (gpt-5, gpt-5.1, ..., gpt-5.4-pro, chatgpt-5.x)
 *   - o-series reasoning models (o1, o3, o4 and dated variants)
 *   - Any Responses API routed variant (azure/openai-responses/*)
 *
 * Used as a fallback when discovery didn't stamp the metadata flag. Matches
 * against the full model id (including provider prefixes) so it works for
 * hub-routed variants like `openai/gpt-5.4` or `azure/openai-responses/gpt-5.4-pro`.
 */
function modelUsesMaxCompletionTokensByName(modelId: string): boolean {
  if (!modelId) return false;
  const lowered = modelId.toLowerCase();
  // Strip common provider prefixes so the test is purely on the model family.
  const tail = lowered.split('/').pop() ?? lowered;

  // Responses API routing strongly implies max_completion_tokens.
  if (lowered.includes('openai-responses/') || lowered.includes('/responses/')) {
    return true;
  }

  // GPT-5.x family (includes gpt-5, gpt-5.1-codex, chatgpt-5.2, etc.)
  if (/^(chatgpt-|gpt-)5(\.|-|$)/.test(tail)) {
    return true;
  }

  // o-series reasoning models: o1 / o3 / o4 (optionally dated/suffixed).
  if (/^o[134](?:$|-|_)/.test(tail)) {
    return true;
  }

  return false;
}

function buildDefaultModerationResponse(raw: unknown): ModerationResponse {
  const categories = Object.fromEntries(
    DEFAULT_MODERATION_CATEGORY_KEYS.map((key) => [key, false])
  ) as ModerationResponse['categories'];

  const categoryScores = Object.fromEntries(
    DEFAULT_MODERATION_CATEGORY_KEYS.map((key) => [key, 0])
  ) as ModerationResponse['category_scores'];

  return {
    flagged: false,
    categories,
    category_scores: categoryScores,
    raw,
  };
}

export class OpenAICompatibleHubAdapter extends ProviderAdapter {
  private readonly providerName: string;
  private readonly metadata: OpenAICompatibleHubMetadata;
  protected readonly baseURL: string;
  protected readonly apiKey: string;
  protected readonly providerLog;
  private defaultModelCache: { modelId: string; expiresAt: number } | null = null;
  private readonly DEFAULT_MODEL_CACHE_TTL_MS = 300_000;
  private readonly AUTO_MODEL_FALLBACK_MAX_ATTEMPTS = 20;

  constructor(config: OpenAICompatibleHubAdapterConfig) {
    const providerName = normalizeProviderName(config.providerName);
    super(providerName, config.displayName || providerName, config);

    this.providerName = providerName;
    this.metadata = config.metadata || {};
    this.baseURL = config.baseUrl || 'https://api.openai.com/v1';
    this.apiKey = config.apiKey;
    this.providerLog = logger.child({ provider: providerName });
    this.validateConfig();
  }

  /**
   * Override the base class's strict `apiKey`-required check. Self-hosted
   * OAI-compatible servers (vLLM, LM Studio, Xinference, Ollama, etc.) run
   * without auth by default — the catalog sets `apiKeyOptional: true` on
   * those rows so the adapter accepts an empty apiKey without throwing.
   *
   * Must match the base signature exactly (returns void; no other work).
   */
  protected override validateConfig(): void {
    // Metadata may not be initialized yet on the first super() call — in
    // that case, fall back to the base behavior (apiKey required).
    const apiKeyOptional = this.metadata?.apiKeyOptional === true;
    if (!apiKeyOptional && !this.config.apiKey) {
      throw new Error(`${this.name}: API key is required`);
    }
  }

  // In-memory model metadata cache (populated lazily from getModels)
  private _modelMetadataCache: Map<string, Record<string, unknown>> | null = null;
  private _modelMetadataCacheExpiry = 0;
  private static readonly MODEL_METADATA_CACHE_TTL_MS = 300_000; // 5 min

  /**
   * Look up model metadata by ID from cached models list.
   * Used by getMaxTokensParam to determine API parameter requirements
   * without hardcoded regex patterns.
   */
  protected async getModelMetadataById(modelId: string): Promise<Record<string, unknown> | null> {
    const now = Date.now();
    if (!this._modelMetadataCache || now > this._modelMetadataCacheExpiry) {
      try {
        const models = await this.getModels();
        this._modelMetadataCache = new Map();
        for (const m of models) {
          const meta = (m.metadata && typeof m.metadata === 'object' && !Array.isArray(m.metadata))
            ? (m.metadata as Record<string, unknown>)
            : {};
          // Also store capabilities in meta for convenience
          meta._capabilities = m.capabilities;
          this._modelMetadataCache.set(m.id, meta);
          if (m.name !== m.id) this._modelMetadataCache.set(m.name, meta);
        }
        this._modelMetadataCacheExpiry = now + OpenAICompatibleHubAdapter.MODEL_METADATA_CACHE_TTL_MS;
      } catch {
        return null;
      }
    }
    return this._modelMetadataCache?.get(modelId) ?? null;
  }

  /**
   * Determine correct max tokens parameter for a model.
   * Uses ONLY metadata and capabilities — no regex or hardcoded model names.
   *
   * Detection chain:
   * 1. metadata.uses_max_completion_tokens (set during discovery)
   * 2. metadata.supported_parameters includes 'max_completion_tokens' (from OpenRouter/hub APIs)
   * 3. Model capabilities: reasoning/thinking_mode → max_completion_tokens
   * 4. Default: max_tokens (safe for legacy models)
   */
  protected async getMaxTokensParamAsync(modelId: string, maxTokens?: number): Promise<Record<string, number | undefined>> {
    const meta = await this.getModelMetadataById(modelId);

    if (meta) {
      // 1. Explicit metadata flag
      if (meta.uses_max_completion_tokens === true) {
        return { max_completion_tokens: maxTokens };
      }

      // 2. supported_parameters (OpenRouter and hub fetchers extract this)
      const params = Array.isArray(meta.supported_parameters) ? meta.supported_parameters as string[] : [];
      if (params.includes('max_completion_tokens')) {
        return { max_completion_tokens: maxTokens };
      }

      // 3. Capabilities: reasoning/thinking models use max_completion_tokens
      const caps = Array.isArray(meta._capabilities) ? meta._capabilities as string[] : [];
      if (caps.some((c: string) => c === 'reasoning' || c === 'thinking_mode' || c === 'deep_research')) {
        return { max_completion_tokens: maxTokens };
      }
    }

    // 4. Name-pattern fallback for newer OpenAI model families discovered
    //    without rich metadata. GPT-5.x, o-series (o1/o3/o4), and the
    //    Responses-API "chatgpt-*" family all require `max_completion_tokens`
    //    and reject `max_tokens`. This mirrors the temperature-compatibility
    //    fallback and covers hub-routed variants (e.g. `openai/gpt-5.4`,
    //    `azure/openai-responses/gpt-5.4-pro@eastus2`).
    if (modelUsesMaxCompletionTokensByName(modelId)) {
      return { max_completion_tokens: maxTokens };
    }

    // Default: max_tokens (safe for all legacy models)
    return { max_tokens: maxTokens };
  }

  /**
   * Determine whether to include the `temperature` field in a chat completion
   * payload. Some OpenAI model families explicitly reject temperature:
   *   - Search preview models (`gpt-*-search-preview*`)
   *   - Realtime/audio models (`gpt-*-realtime*`, `gpt-audio*`)
   *   - Deep-research models (`*deep-research*`)
   *   - TTS / transcription models
   *
   * Hubs that proxy these models (edenai, aihubmix, requesty, etc.) surface the
   * original OpenAI error verbatim: `HTTP 400 "Model incompatible request argument
   * supplied: temperature"`. We use metadata when available, then fall back to
   * capability-based detection, then to an inexpensive name-pattern heuristic.
   *
   * Returns an object that can be spread into the payload: either
   * `{ temperature: n }` or `{}` (omitting the field entirely).
   */
  protected async getTemperatureParamAsync(
    modelId: string,
    temperature?: number,
  ): Promise<Record<string, number | undefined>> {
    if (typeof temperature !== 'number') {
      return {};
    }

    const meta = await this.getModelMetadataById(modelId);
    if (meta) {
      // Explicit metadata flag — highest precedence.
      if (meta.rejects_temperature === true || meta.supports_temperature === false) {
        return {};
      }
      const params = Array.isArray(meta.supported_parameters)
        ? (meta.supported_parameters as string[])
        : null;
      if (params && !params.includes('temperature')) {
        return {};
      }
      // Capability-based: search/realtime/audio/deep-research families reject it.
      const caps = Array.isArray(meta._capabilities) ? (meta._capabilities as string[]) : [];
      const temperatureRejecting = new Set([
        'web_search',
        'deep_search',
        'deep_research',
        'realtime',
        'audio_input',
        'audio_output',
        'speech_to_text',
        'text_to_speech',
        'tts',
      ]);
      if (caps.some((c) => temperatureRejecting.has(c))) {
        return {};
      }
    }

    // Name-pattern fallback for models discovered without rich metadata.
    const lowered = modelId.toLowerCase();
    const rejectPatterns = [
      'search-preview',
      'search-api',
      '-realtime',
      'realtime-',
      'gpt-audio',
      '-audio-',
      '/audio-',
      'deep-research',
      'tts',
      'whisper',
      'transcribe',
    ];
    if (rejectPatterns.some((p) => lowered.includes(p))) {
      return {};
    }

    return { temperature };
  }

  /**
   * Synchronous fallback for getMaxTokensParam when async is not possible.
   * Uses cached metadata if available, defaults to max_tokens otherwise.
   */
  protected getMaxTokensParam(modelId: string, maxTokens?: number): Record<string, number | undefined> {
    // Use cached metadata if available (populated by previous async calls)
    const meta = this._modelMetadataCache?.get(modelId);
    if (meta) {
      if (meta.uses_max_completion_tokens === true) return { max_completion_tokens: maxTokens };
      const params = Array.isArray(meta.supported_parameters) ? meta.supported_parameters as string[] : [];
      if (params.includes('max_completion_tokens')) return { max_completion_tokens: maxTokens };
      const caps = Array.isArray(meta._capabilities) ? meta._capabilities as string[] : [];
      if (caps.some((c: string) => c === 'reasoning' || c === 'thinking_mode' || c === 'deep_research')) {
        return { max_completion_tokens: maxTokens };
      }
    }
    // Name-pattern fallback (see async variant for rationale).
    if (modelUsesMaxCompletionTokensByName(modelId)) {
      return { max_completion_tokens: maxTokens };
    }
    return { max_tokens: maxTokens };
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();

    return {
      id: this.providerName,
      name: this.providerName,
      displayName: this.displayName,
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

  async getModels(): Promise<Model[]> {
    const models = await getModelsByProvider(this.providerName);
    if (!models.length) {
      this.providerLog.warn('No models registered in catalog for hub provider');
    }

    return models.map((model) => ({
      ...model,
      id: model.name,
    }));
  }

  private async getChatCapableModelsSorted(): Promise<Model[]> {
    const models = await this.getModels();
    const chatModels = models.filter(
      (model) =>
        model.status === 'active' &&
        (model.capabilities.includes('chat') || model.capabilities.includes('text_generation'))
    );

    return [...chatModels].sort((a, b) => {
      const aCost = Number.isFinite(a.inputCostPer1k) ? a.inputCostPer1k : Number.MAX_SAFE_INTEGER;
      const bCost = Number.isFinite(b.inputCostPer1k) ? b.inputCostPer1k : Number.MAX_SAFE_INTEGER;
      const costDiff = aCost - bCost;
      if (costDiff !== 0) {
        return costDiff;
      }
      return (b.contextWindow || 0) - (a.contextWindow || 0);
    });
  }

  private async getDefaultModel(): Promise<string> {
    if (this.defaultModelCache && Date.now() < this.defaultModelCache.expiresAt) {
      return this.defaultModelCache.modelId;
    }

    const sorted = await this.getChatCapableModelsSorted();
    if (sorted.length === 0) {
      throw new Error(`No models available for provider ${this.providerName}`);
    }

    const selected = sorted[0];
    if (!selected) {
      throw new Error(`No chat-capable models available for provider ${this.providerName}`);
    }
    this.defaultModelCache = {
      modelId: selected.id,
      expiresAt: Date.now() + this.DEFAULT_MODEL_CACHE_TTL_MS,
    };

    return selected.id;
  }

  /**
   * Extension hook for subclasses to inject provider-specific top-level
   * payload fields into every outgoing chat request (non-stream, auto-fallback,
   * and stream paths all call through this).
   *
   * The default is an empty object (no extras), so the hub retains its current
   * closed-payload behavior. Subclasses return a typed Record that is spread
   * into the payload body. Keeping this as a hook (not an override of
   * `chatCompletion`) means subclasses don't have to re-implement auto-fallback
   * and streaming.
   *
   * Added for Batch 1 providers that need reasoning/search/tier knobs
   * (Groq, Perplexity, Cerebras). Subsequent batches reuse it.
   */
  protected getExtraChatPayloadFields(
    _resolvedModel: string,
    _request: ChatRequest,
  ): Record<string, unknown> {
    return {};
  }

  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const path = this.metadata.chatCompletionsPath || '/chat/completions';

    if (request.model && request.model.trim().length > 0) {
      const normalizedModel = await this.normalizeModelName(request.model);
      const response = await this.sendJsonRequestWithRetry({
        path,
        operation: 'chat completion',
        payload: {
          model: normalizedModel,
          messages: request.messages,
          ...(await this.getTemperatureParamAsync(normalizedModel, request.temperature)),
          ...(await this.getMaxTokensParamAsync(normalizedModel, request.max_tokens)),
          top_p: request.top_p,
          ...(request.frequency_penalty ? { frequency_penalty: request.frequency_penalty } : {}),
          ...(request.presence_penalty ? { presence_penalty: request.presence_penalty } : {}),
          stop: request.stop,
          stream: false,
          tools: request.tools,
          tool_choice: request.tool_choice,
          response_format: request.response_format,
          ...(request.thinking_budget ? { thinking_budget: request.thinking_budget } : {}),
          ...this.getExtraChatPayloadFields(normalizedModel, request),
        },
      });
      return (await response.json()) as ChatResponse;
    }

    const candidates = await this.getChatCapableModelsSorted();
    if (candidates.length === 0) {
      throw new Error(`No chat-capable models available for provider ${this.providerName}`);
    }

    const dedupedCandidates = Array.from(
      new Set(
        candidates
          .map((model) => normalizeHubModelIdentifier(model.id || model.name || ''))
          .filter((modelId) => modelId.length > 0)
      )
    );

    const preferredCachedModel =
      this.defaultModelCache && this.defaultModelCache.expiresAt > Date.now()
        ? normalizeHubModelIdentifier(this.defaultModelCache.modelId)
        : undefined;

    if (preferredCachedModel) {
      const existingIndex = dedupedCandidates.findIndex((model) => model === preferredCachedModel);
      if (existingIndex > 0) {
        dedupedCandidates.splice(existingIndex, 1);
        dedupedCandidates.unshift(preferredCachedModel);
      } else if (existingIndex === -1) {
        dedupedCandidates.unshift(preferredCachedModel);
      }
    }

    const limitedCandidates = dedupedCandidates.slice(0, this.AUTO_MODEL_FALLBACK_MAX_ATTEMPTS);

    let lastError: unknown;
    for (const candidate of limitedCandidates) {
      try {
        const response = await this.sendJsonRequestWithRetry({
          path,
          operation: 'chat completion',
          payload: {
            model: candidate,
            messages: request.messages,
            ...(await this.getTemperatureParamAsync(candidate, request.temperature)),
            ...(await this.getMaxTokensParamAsync(candidate, request.max_tokens)),
            top_p: request.top_p,
            ...(request.frequency_penalty ? { frequency_penalty: request.frequency_penalty } : {}),
            ...(request.presence_penalty ? { presence_penalty: request.presence_penalty } : {}),
            stop: request.stop,
            stream: false,
            tools: request.tools,
            tool_choice: request.tool_choice,
            response_format: request.response_format,
            ...(request.thinking_budget ? { thinking_budget: request.thinking_budget } : {}),
            ...this.getExtraChatPayloadFields(candidate, request),
          },
        });
        this.defaultModelCache = {
          modelId: candidate,
          expiresAt: Date.now() + this.DEFAULT_MODEL_CACHE_TTL_MS,
        };
        return (await response.json()) as ChatResponse;
      } catch (error) {
        lastError = error;
        if (this.shouldFallbackToNextModel(error)) {
          this.providerLog.warn(
            {
              model: candidate,
              status: (error as HubRequestError).status,
            },
            'Hub model failed runtime auth/availability check; trying next candidate'
          );
          continue;
        }
        throw error;
      }
    }

    const lastErrorMessage =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `${this.providerName} chat completion failed after trying ${limitedCandidates.length} dynamic candidates: ${lastErrorMessage}`
    );
  }

  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse> {
    const modelToUse = request.model || (await this.getDefaultModel());
    const normalizedModel = await this.normalizeModelName(modelToUse);
    const path = this.metadata.chatCompletionsPath || '/chat/completions';

    const response = await this.sendJsonRequestWithRetry({
      path,
      operation: 'streaming chat completion',
      payload: {
        model: normalizedModel,
        messages: request.messages,
        ...(await this.getTemperatureParamAsync(normalizedModel, request.temperature)),
        ...this.getMaxTokensParam(normalizedModel, request.max_tokens),
        top_p: request.top_p,
        ...(request.frequency_penalty ? { frequency_penalty: request.frequency_penalty } : {}),
        ...(request.presence_penalty ? { presence_penalty: request.presence_penalty } : {}),
        stop: request.stop,
        stream: true,
        tools: request.tools,
        tool_choice: request.tool_choice,
        ...(request.thinking_budget ? { thinking_budget: request.thinking_budget } : {}),
        ...this.getExtraChatPayloadFields(normalizedModel, request),
      },
    });

    if (!response.body) {
      throw new Error(`${this.providerName} streaming response body is empty`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const readResult = await reader.read();
        if (readResult.done) {
          break;
        }

        const chunkValue: unknown = readResult.value;
        if (!(chunkValue instanceof Uint8Array)) {
          continue;
        }

        buffer += decoder.decode(chunkValue, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line === 'data: [DONE]') {
            continue;
          }

          if (!line.startsWith('data: ')) {
            continue;
          }

          try {
            const payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
            yield this.convertStreamChunk(payload, normalizedModel);
          } catch {
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const normalizedModel = await this.normalizeModelName(request.model || (await this.getDefaultModel()));
    const path = this.metadata.embeddingsPath || '/embeddings';

    const response = await this.sendJsonRequestWithRetry({
      path,
      operation: 'embeddings',
      payload: {
        model: normalizedModel,
        input: request.input,
        encoding_format: request.encoding_format,
        dimensions: request.dimensions,
        user: request.user,
      },
    });

    return (await response.json()) as EmbeddingResponse;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    const candidates = [
      this.metadata.modelListPath || '/models',
      '/v1/models',
    ].filter((path, index, all) => all.indexOf(path) === index);

    let lastError: string | undefined;

    for (const path of candidates) {
      try {
        const response = await fetch(this.buildUrl(path), {
          method: 'GET',
          headers: this.buildRequestHeaders(false),
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          return {
            healthy: true,
            latency: Date.now() - start,
            checkedAt: new Date(),
          };
        }

        if (response.status === 404 || response.status === 405) {
          lastError = `HTTP ${response.status} on ${path}`;
          continue;
        }

        return {
          healthy: false,
          latency: Date.now() - start,
          checkedAt: new Date(),
          error: `HTTP ${response.status} on ${path}`,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      healthy: false,
      latency: Date.now() - start,
      checkedAt: new Date(),
      error: lastError || 'No health endpoint available',
    };
  }

  /**
   * Check provider balance using provider-specific endpoints first,
   * then falling back to generic OpenAI-compatible billing paths.
   *
   * Known provider-specific endpoints:
   * - Poe: GET https://api.poe.com/usage/current_balance
   * - AIML: GET https://api.aimlapi.com/v1/billing/balance
   * - CometAPI: GET https://api.cometapi.com/api/user/self
   * - 302.ai: GET https://api.302.ai/dashboard/balance
   * - AiHubMix: GET https://aihubmix.com/api/user/self
   * - NanoGPT: GET https://nano-gpt.com/api/balance
   * - EdenAI: GET https://api.edenai.run/v2/user/balance
   * - Novita: GET https://api.novita.ai/v3/billing/balance
   * - Routeway: GET https://api.routeway.ai/v1/credits
   * - Requesty: generic billing fallback
   */
  async checkBalance(): Promise<BalanceCheckResult | null> {
    // 1) Try provider-specific endpoint
    const specific = this.getProviderBalanceEndpoint();
    if (specific) {
      try {
        const resp = await fetch(specific.url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const data = (await resp.json()) as Record<string, unknown>;
          const result = this.parseBalanceResponse(data);
          if (result) {
            this.providerLog.info(
              { provider: this.providerName, hasCredits: result.hasCredits, balance: result.balance },
              'Provider balance checked (specific endpoint)'
            );
            return result;
          }
        }
      } catch { /* fall through to generic */ }
    }

    // 2) Generic OpenAI-compatible billing paths
    for (const path of ['/dashboard/billing/credit_grants', '/v1/dashboard/billing/credit_grants', '/dashboard/billing/usage', '/v1/dashboard/billing/usage']) {
      try {
        const resp = await fetch(this.buildUrl(path), {
          method: 'GET',
          headers: this.buildRequestHeaders(false),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) {
          if (resp.status === 404 || resp.status === 405) continue;
          if (resp.status === 401 || resp.status === 403) return null;
          continue;
        }
        const data = (await resp.json()) as Record<string, unknown>;
        const result = this.parseBalanceResponse(data);
        if (result) return result;
      } catch { continue; }
    }

    return null;
  }

  /** Map provider name → specific balance API URL */
  private getProviderBalanceEndpoint(): { url: string } | null {
    const endpoints: Record<string, string> = {
      'poe': 'https://api.poe.com/usage/current_balance',
      'aiml': 'https://api.aimlapi.com/v1/billing/balance',
      'cometapi': 'https://api.cometapi.com/api/user/self',
      // Post-migration canonical id is `ai302`; the legacy `302ai` name
      // still appears in the discovery-service aliases so the adapter's
      // `providerName` field may arrive as either form — keep both keys.
      'ai302': 'https://api.302.ai/dashboard/balance',
      '302ai': 'https://api.302.ai/dashboard/balance',
      'aihubmix': 'https://aihubmix.com/api/user/self',
      'nanogpt': 'https://nano-gpt.com/api/balance',
      'edenai': 'https://api.edenai.run/v2/user/balance',
      'novita': 'https://api.novita.ai/v3/billing/balance',
      'routeway': 'https://api.routeway.ai/v1/credits',
      'requesty': 'https://router.requesty.ai/v1/dashboard/billing/credit_grants',
    };
    const url = endpoints[this.providerName.toLowerCase()];
    return url ? { url } : null;
  }

  /** Parse various balance response shapes into a uniform result */
  private parseBalanceResponse(data: Record<string, unknown>): BalanceCheckResult | null {
    // Shape: { balance: number }
    if (typeof data.balance === 'number') return { hasCredits: data.balance > 0, balance: data.balance, currency: 'USD' };
    // Shape: { total_balance: number }
    if (typeof data.total_balance === 'number') return { hasCredits: data.total_balance > 0, balance: data.total_balance, currency: 'USD' };
    // Shape: { credits: number }
    if (typeof data.credits === 'number') return { hasCredits: data.credits > 0, balance: data.credits, currency: 'USD' };
    // Shape: { total_available: number }
    if (typeof data.total_available === 'number') return { hasCredits: data.total_available > 0, balance: data.total_available, currency: 'USD' };
    // Shape: { remaining: number }
    if (typeof data.remaining === 'number') return { hasCredits: data.remaining > 0, balance: data.remaining, currency: 'USD' };
    // Shape: { quota: number }
    if (typeof data.quota === 'number') return { hasCredits: data.quota > 0, balance: data.quota, currency: 'USD' };
    // Shape: { credit_balance: number }
    if (typeof data.credit_balance === 'number') return { hasCredits: data.credit_balance > 0, balance: data.credit_balance, currency: 'USD' };
    // Nested: { data: { balance: number } }
    const nested = data.data as Record<string, unknown> | undefined;
    if (nested) {
      if (typeof nested.balance === 'number') return { hasCredits: nested.balance > 0, balance: nested.balance, currency: 'USD' };
      if (typeof nested.remaining === 'number') return { hasCredits: nested.remaining > 0, balance: nested.remaining, currency: 'USD' };
      if (typeof nested.quota === 'number') return { hasCredits: nested.quota > 0, balance: nested.quota, currency: 'USD' };
      // Grants array: { data: { grants: [{ remaining }] } }
      if (Array.isArray(nested.grants)) {
        const total = (nested.grants as Array<{ remaining?: number }>).reduce(
          (sum, g) => sum + (typeof g.remaining === 'number' ? g.remaining : 0), 0
        );
        return { hasCredits: total > 0, balance: total, currency: 'USD' };
      }
    }
    // Usage shape: { total_usage, hard_limit_usd } (in cents)
    if (typeof data.total_usage === 'number' && typeof data.hard_limit_usd === 'number') {
      const rem = data.hard_limit_usd - data.total_usage / 100;
      return { hasCredits: rem > 0, balance: rem, currency: 'USD' };
    }
    return null;
  }

  calculateCost(model: Model, inputTokens: number, outputTokens: number): number {
    const inputRate = Number(model.inputCostPer1k) || 0;
    const outputRate = Number(model.outputCostPer1k) || 0;
    const cost = (inputTokens / 1000) * Math.max(0, inputRate)
               + (outputTokens / 1000) * Math.max(0, outputRate);
    return Math.max(0, cost);
  }

  async normalizeModelName(modelId: string): Promise<string> {
    if (!modelId) {
      return this.getDefaultModel();
    }

    const sanitizedInput = normalizeHubModelIdentifier(modelId);
    if (!sanitizedInput) {
      return this.getDefaultModel();
    }

    const providerPrefixed = `${this.providerName}/`;
    const strippedProviderPrefixRaw = sanitizedInput.toLowerCase().startsWith(providerPrefixed)
      ? sanitizedInput.slice(providerPrefixed.length)
      : sanitizedInput;
    const strippedProviderPrefix = normalizeHubModelIdentifier(strippedProviderPrefixRaw);
    const genericProviderSuffix = (() => {
      const slashIndex = strippedProviderPrefix.indexOf('/');
      if (slashIndex > 0 && slashIndex < strippedProviderPrefix.length - 1) {
        return normalizeHubModelIdentifier(strippedProviderPrefix.slice(slashIndex + 1));
      }
      return strippedProviderPrefix;
    })();

    const models = await this.getModels();

    for (const model of models) {
      const normalizedModelId = normalizeHubModelIdentifier(model.id);
      const normalizedModelName = normalizeHubModelIdentifier(model.name);

      if (
        normalizedModelId === sanitizedInput ||
        normalizedModelName === sanitizedInput
      ) {
        return normalizedModelName;
      }
      if (
        normalizedModelId.toLowerCase() === sanitizedInput.toLowerCase() ||
        normalizedModelName.toLowerCase() === sanitizedInput.toLowerCase()
      ) {
        return normalizedModelName;
      }
      if (
        normalizedModelId.toLowerCase() === strippedProviderPrefix.toLowerCase() ||
        normalizedModelName.toLowerCase() === strippedProviderPrefix.toLowerCase()
      ) {
        return normalizedModelName;
      }
      if (
        genericProviderSuffix !== strippedProviderPrefix &&
        (normalizedModelId.toLowerCase() === genericProviderSuffix.toLowerCase() ||
          normalizedModelName.toLowerCase() === genericProviderSuffix.toLowerCase())
      ) {
        return normalizedModelName;
      }
    }

    return strippedProviderPrefix;
  }

  private extractTextFromMessageContent(content: unknown): string {
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
          >((acc, entry) => {
            if (!entry || typeof entry !== 'object') return acc;
            const obj = entry as Record<string, unknown>;
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

  private resolveFormDataFile(
    buffer: Buffer,
    fileName: string,
    mimeType: string
  ): File {
    return new File([new Blob([new Uint8Array(buffer)], { type: mimeType })], fileName, {
      type: mimeType,
    });
  }

  private resolveImageRequestOption(
    options: Record<string, unknown> | undefined,
    keys: string[],
    fallback: string
  ): string {
    for (const key of keys) {
      const value = options?.[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return fallback;
  }

  protected async downloadImageWithRetry(url: string, operation: string): Promise<{
    image: Buffer;
    format: string;
  }> {
    const imageResponse = await this.withRetry(async () => {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        const err = new Error(
          `${this.providerName} ${operation} image download failed: HTTP ${response.status}`
        ) as HubRequestError;
        err.status = response.status;
        throw err;
      }
      return response;
    }, `${operation} image download`);

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
    };
  }

  private async parseImageResult(
    raw: { data?: Array<{ url?: string; b64_json?: string }> },
    operation: string
  ): Promise<{ image: Buffer; format: string }> {
    const first = Array.isArray(raw.data) ? raw.data[0] : undefined;
    if (!first) {
      throw new Error(`${this.providerName} ${operation} returned no images`);
    }

    if (typeof first.b64_json === 'string') {
      return {
        image: Buffer.from(first.b64_json, 'base64'),
        format: 'png',
      };
    }

    if (typeof first.url === 'string') {
      return this.downloadImageWithRetry(first.url, operation);
    }

    throw new Error(`${this.providerName} ${operation} payload has no url or b64_json`);
  }

  async vision(model: Model, request: VisionRequest): Promise<VisionResponse> {
    const normalizedModel = await this.normalizeModelName(model.name || model.id);
    const response = await this.chatCompletion({
      model: normalizedModel,
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

    return {
      content: this.extractTextFromMessageContent(response.choices?.[0]?.message?.content),
      raw: response,
    };
  }

  async webSearch(
    model: Model,
    request: { query: string; maxResults?: number; options?: Record<string, unknown> }
  ): Promise<{ text: string; raw: unknown }> {
    const normalizedModel = await this.normalizeModelName(model.name || model.id);
    try {
      const responsesPayload: Record<string, unknown> = {
        model: normalizedModel,
        input: request.query,
        max_output_tokens: 1500,
        tools: [
          {
            type: 'web_search',
            web_search: {
              max_results:
                typeof request.maxResults === 'number' ? Math.max(1, request.maxResults) : 5,
            },
          },
        ],
      };
      const responses = await this.sendJsonRequestWithRetry({
        path: '/responses',
        operation: 'web search',
        payload: responsesPayload,
      });
      const rawResponses = (await responses.json()) as {
        output_text?: unknown;
        output?: unknown;
      };

      let text = '';
      if (typeof rawResponses.output_text === 'string') {
        text = rawResponses.output_text;
      } else if (Array.isArray(rawResponses.output)) {
        text = rawResponses.output
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return '';
            const obj = entry as Record<string, unknown>;
            const content = Array.isArray(obj.content) ? obj.content : [];
            return content
              .map((item) => {
                if (!item || typeof item !== 'object') return '';
                const maybeText = (item as Record<string, unknown>).text;
                return typeof maybeText === 'string' ? maybeText : '';
              })
              .filter((value) => value.length > 0)
              .join('\n');
          })
          .filter((value) => value.length > 0)
          .join('\n');
      }

      const parsed = this.parseStructuredSearchOutput(text);
      return {
        text: parsed.answer || text,
        raw: parsed,
      };
    } catch {
      // Fallback to chat completions when /responses web_search is unavailable on this hub.
      const response = await this.chatCompletion({
        model: normalizedModel,
        messages: [
          {
            role: 'system',
            content:
              'Return strict JSON: {"answer":"string","results":[{"title":"string","url":"string","content":"string","score":0.0}],"images":["url"]}.',
          },
          {
            role: 'user',
            content: request.query,
          },
        ],
        temperature: 0.2,
        max_tokens: 1500,
      });

      const content = this.extractTextFromMessageContent(
        response.choices?.[0]?.message?.content
      );
      const parsed = this.parseStructuredSearchOutput(content);

      return {
        text: parsed.answer || content,
        raw: parsed,
      };
    }
  }

  async textToSpeech(model: Model, request: AudioTTSRequest): Promise<AudioTTSResponse> {
    const normalizedModel = await this.normalizeModelName(model.name || model.id);
    const path = this.metadata.audioSpeechPath || '/audio/speech';
    const payload: Record<string, unknown> = {
      model: normalizedModel,
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

    const response = await this.sendJsonRequestWithRetry({
      path,
      operation: 'text-to-speech',
      payload,
    });
    const audioBuffer = Buffer.from(await response.arrayBuffer());

    return {
      audio: audioBuffer,
      format:
        typeof payload.response_format === 'string' ? payload.response_format : request.format || 'mp3',
      raw: { size: audioBuffer.length },
    };
  }

  async speechToText(model: Model, request: AudioSTTRequest): Promise<AudioSTTResponse> {
    const normalizedModel = await this.normalizeModelName(model.name || model.id);
    const path = this.metadata.audioTranscriptionsPath || '/audio/transcriptions';
    const formData = new FormData();
    const filename =
      typeof request.options?.filename === 'string' ? request.options.filename : 'audio.wav';
    const mimeType =
      typeof request.options?.mimeType === 'string' ? request.options.mimeType : 'audio/wav';
    const file = new File(
      [new Blob([new Uint8Array(request.audio)], { type: mimeType })],
      filename,
      { type: mimeType }
    );

    formData.append('file', file);
    formData.append('model', normalizedModel);
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

    const response = await this.sendMultipartRequestWithRetry({
      path,
      operation: 'speech-to-text',
      formData,
    });
    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();
    let text = rawText;
    let raw: unknown = rawText;

    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(rawText) as { text?: unknown };
        raw = parsed;
        if (typeof parsed.text === 'string') {
          text = parsed.text;
        }
      } catch {
        // keep text fallback
      }
    }

    return { text, raw };
  }

  async imageGenerate(model: Model, request: ImageGenRequest): Promise<ImageGenResponse> {
    const normalizedModel = await this.normalizeModelName(model.name || model.id);
    const path = this.metadata.imagesPath || '/images/generations';
    const options = request.options || {};
    const payload: Record<string, unknown> = {
      model: normalizedModel,
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

    const response = await this.sendJsonRequestWithRetry({
      path,
      operation: 'image generation',
      payload,
    });
    const raw = (await response.json()) as {
      data?: Array<{ url?: string; b64_json?: string }>;
    };
    const parsed = await this.parseImageResult(raw, 'image generation');

    return {
      image: parsed.image,
      format: parsed.format,
      raw,
    };
  }

  async moderate(_model: Model, request: ModerationRequest): Promise<ModerationResponse> {
    const path = this.metadata.moderationsPath || '/moderations';

    const response = await this.sendJsonRequestWithRetry({
      path,
      operation: 'moderation',
      payload: {
        input: request.text,
      },
    });

    const payload = (await response.json()) as {
      results?: Array<{
        flagged?: boolean;
        categories?: Record<string, boolean>;
        category_scores?: Record<string, number>;
      }>;
      [key: string]: unknown;
    };

    const firstResult = Array.isArray(payload.results) ? payload.results[0] : undefined;
    if (!firstResult) {
      return buildDefaultModerationResponse(payload);
    }

    const fallback = buildDefaultModerationResponse(payload);
    return {
      flagged: Boolean(firstResult.flagged),
      categories: {
        ...fallback.categories,
        ...(firstResult.categories || {}),
      },
      category_scores: {
        ...fallback.category_scores,
        ...(firstResult.category_scores || {}),
      },
      raw: payload,
    };
  }

  async videoGenerate(model: Model, request: VideoGenRequest): Promise<VideoGenResponse> {
    const normalizedModel = await this.normalizeModelName(model.name || model.id);
    const path = this.metadata.videosPath || '/videos/generations';
    const options = request.options || {};

    const payload: Record<string, unknown> = {
      model: normalizedModel,
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
    if ('image' in options && typeof options.image === 'string') {
      payload.image = options.image;
    }
    if ('start_image' in options && typeof options.start_image === 'string') {
      payload.start_image = options.start_image;
    }
    if ('end_image' in options && typeof options.end_image === 'string') {
      payload.end_image = options.end_image;
    }
    if ('audio' in options && typeof options.audio === 'string') {
      payload.audio = options.audio;
    }
    if ('video' in options && typeof options.video === 'string') {
      payload.video = options.video;
    }

    // Together-style providers require everything except `model` nested under
    // a `payload` map — the flat shape is rejected with "validation failed for
    // field 'payload': expected required" (live probe 2026-07-17).
    const requestBody: Record<string, unknown> =
      this.metadata.videoRequestStyle === 'payload-wrap'
        ? (() => {
            const { model: wrappedModel, ...rest } = payload;
            return { model: wrappedModel, payload: rest };
          })()
        : payload;

    // SUBMIT MUST NOT RE-POST (incident 2026-07-17): the submit enqueues an
    // ASYNC PAID JOB, so a retry after an ambiguous failure (timeout, 5xx
    // returned after enqueue) can start 2+ billed generations for a single
    // request. Fail the candidate instead — the orchestration fallback
    // advances to the next one.
    const response = await this.sendJsonRequestWithRetry({
      path,
      operation: 'video generation',
      payload: requestBody,
      maxRetriesOverride: 0,
    });
    const rawPayload = (await response.json()) as Record<string, unknown>;

    // Sync OAI-style response: finished videos (url/b64_json) already present.
    const syncVideos = this.extractVideoItems(rawPayload);
    if (syncVideos.length > 0) {
      return { video: syncVideos, format: 'mp4', raw: rawPayload };
    }

    // Async job-queue response: submit returns a task id + status and the
    // finished videos only exist after polling (e.g. FastRouter: POST /videos
    // → `{data:{taskId,status:"processing"}}`, GET /videos/{taskId} until
    // `data.generations[]`/`fastrouter_assets.urls[]` appear — live-proven
    // 2026-07-17). Detected dynamically by response shape, not provider name.
    // Poll ONLY while the submit status is NON-terminal: a terminal-success
    // submit with zero videos is a legitimate empty sync response (e.g.
    // `{id, status:'success', data:[]}`), not a job to wait on.
    const submitStatus = this.extractVideoStatus(rawPayload);
    const taskId = this.extractVideoTaskId(rawPayload);
    const submitIsTerminal =
      submitStatus !== undefined &&
      (VIDEO_TERMINAL_SUCCESS_STATUSES.has(submitStatus) ||
        VIDEO_TERMINAL_FAILURE_STATUSES.has(submitStatus));

    if (taskId && !submitIsTerminal) {
      const finalPayload = await this.pollVideoTask(path, taskId);
      const polledVideos = this.extractVideoItems(finalPayload);
      if (polledVideos.length === 0) {
        const status = this.extractVideoStatus(finalPayload);
        const detail = this.extractVideoErrorDetail(finalPayload);
        throw new Error(
          `${this.getName()} video task ${taskId} finished with status "${status}" and no video output${detail ? `: ${detail}` : ''}`
        );
      }
      return { video: polledVideos, format: 'mp4', raw: finalPayload };
    }

    if (submitStatus !== undefined && VIDEO_TERMINAL_FAILURE_STATUSES.has(submitStatus)) {
      const detail = this.extractVideoErrorDetail(rawPayload);
      throw new Error(
        `${this.getName()} video generation failed at submit with status "${submitStatus}"${detail ? `: ${detail}` : ''}`
      );
    }

    // Sync response without url/b64 output: keep id-only items (pre-existing
    // contract — async handles survive so the orchestration empty-generation
    // guard can tell a handle from a truly empty payload).
    return {
      video: this.extractVideoItems(rawPayload, { includeIdOnly: true }),
      format: 'mp4',
      raw: rawPayload,
    };
  }

  /**
   * Pull `{id?, url?, b64_json?}` video items out of the known response
   * shapes: OAI `data[]`, async-queue `data.generations[]`/`generations[]`,
   * and FastRouter's `fastrouter_assets.urls[]`. Explicit locations only —
   * no deep scanning, so unrelated URL-shaped fields can't leak in.
   *
   * `includeIdOnly` keeps items that carry only an `id` (async job handles) —
   * used on the no-poll sync return so handles survive to the orchestration
   * guard. Poll completion detection and post-poll extraction must NOT set it:
   * there an id without url/b64_json means "not finished yet".
   */
  private extractVideoItems(
    rawPayload: Record<string, unknown>,
    opts?: { includeIdOnly?: boolean }
  ): Array<{ id?: string; url?: string; b64_json?: string }> {
    const includeIdOnly = opts?.includeIdOnly === true;
    const collect = (value: unknown): Array<{ id?: string; url?: string; b64_json?: string }> => {
      if (!Array.isArray(value)) return [];
      return value
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const n = item as { id?: unknown; url?: unknown; b64_json?: unknown; video_url?: unknown };
          return {
            id: typeof n.id === 'string' ? n.id : undefined,
            url:
              typeof n.url === 'string'
                ? n.url
                : typeof n.video_url === 'string'
                  ? n.video_url
                  : undefined,
            b64_json: typeof n.b64_json === 'string' ? n.b64_json : undefined,
          };
        })
        .filter((item) => item.url || item.b64_json || (includeIdOnly && item.id));
    };

    const data = rawPayload.data;
    const dataObj =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : undefined;
    const assets =
      rawPayload.fastrouter_assets && typeof rawPayload.fastrouter_assets === 'object'
        ? (rawPayload.fastrouter_assets as Record<string, unknown>)
        : undefined;
    const assetUrls = Array.isArray(assets?.urls)
      ? (assets.urls as unknown[])
          .filter((u): u is string => typeof u === 'string')
          .map((url) => ({ url }))
      : [];

    return [
      ...collect(data),
      ...collect(dataObj?.generations),
      ...collect(rawPayload.generations),
      ...assetUrls,
    ];
  }

  /**
   * Task id from an async-queue submit/poll response. Accepts camelCase and
   * snake_case variants (`taskId`/`task_id`/`job_id`) both nested under
   * `data` and at the top level, plus the top-level job `id`.
   */
  private extractVideoTaskId(rawPayload: Record<string, unknown>): string | undefined {
    const dataObj =
      rawPayload.data && typeof rawPayload.data === 'object' && !Array.isArray(rawPayload.data)
        ? (rawPayload.data as Record<string, unknown>)
        : undefined;
    const candidate =
      dataObj?.taskId ??
      dataObj?.task_id ??
      dataObj?.job_id ??
      rawPayload.taskId ??
      rawPayload.task_id ??
      rawPayload.job_id ??
      rawPayload.id;
    // Only treat as an async job when a status accompanies the id — a bare
    // `id` is also present on ordinary sync responses (request ids).
    const hasStatus = this.extractVideoStatus(rawPayload) !== undefined;
    return typeof candidate === 'string' && candidate.length > 0 && hasStatus
      ? candidate
      : undefined;
  }

  private extractVideoStatus(rawPayload: Record<string, unknown>): string | undefined {
    const dataObj =
      rawPayload.data && typeof rawPayload.data === 'object' && !Array.isArray(rawPayload.data)
        ? (rawPayload.data as Record<string, unknown>)
        : undefined;
    const status = dataObj?.status ?? rawPayload.status;
    return typeof status === 'string' ? status.toLowerCase() : undefined;
  }

  /**
   * Provider error detail from a submit/poll payload: top-level `error` or
   * `data.error`. Objects are JSON-stringified; absent → '' (callers omit the
   * `: detail` suffix entirely rather than appending an empty string).
   */
  private extractVideoErrorDetail(rawPayload: Record<string, unknown>): string {
    const dataObj =
      rawPayload.data && typeof rawPayload.data === 'object' && !Array.isArray(rawPayload.data)
        ? (rawPayload.data as Record<string, unknown>)
        : undefined;
    const rawError = rawPayload.error ?? dataObj?.error;
    if (rawError === undefined || rawError === null) return '';
    if (typeof rawError === 'string') return rawError;
    return JSON.stringify(rawError);
  }

  /**
   * Poll an async video task until it reaches a terminal status or the time
   * budget expires. Interval/budget are env-tunable wall-clock bounds
   * (protective timeouts, not candidate caps).
   *
   * Transient poll failures MUST NOT abort: the job was already submitted and
   * PAID, so treating a 5xx/404/408/429 or a network/parse hiccup as fatal
   * discards a billed generation that may be one interval away (a 404 in the
   * first seconds just means the job is not visible yet). Only auth failures
   * (401/403) exit immediately — they cannot self-heal within the budget. The
   * global deadline is the single time-based failure exit; the last poll
   * error is carried into its message.
   */
  private async pollVideoTask(
    submitPath: string,
    taskId: string
  ): Promise<Record<string, unknown>> {
    const template = this.metadata.videoPollPath || `${submitPath}/{taskId}`;
    const pollPath = template.replace('{taskId}', encodeURIComponent(taskId));
    // NaN-safe env clamps: a non-numeric env value falls back to the default
    // instead of poisoning Math.max (and every deadline check) with NaN.
    const rawTimeoutMs = Number(process.env.HUB_VIDEO_POLL_TIMEOUT_MS);
    const timeoutMs = Math.max(10_000, Number.isFinite(rawTimeoutMs) ? rawTimeoutMs : 300_000);
    const rawIntervalMs = Number(process.env.HUB_VIDEO_POLL_INTERVAL_MS);
    const intervalMs = Math.max(500, Number.isFinite(rawIntervalMs) ? rawIntervalMs : 3_000);
    const deadline = Date.now() + timeoutMs;
    const terminal = new Set([
      ...VIDEO_TERMINAL_SUCCESS_STATUSES,
      ...VIDEO_TERMINAL_FAILURE_STATUSES,
    ]);

    let lastPayload: Record<string, unknown> = {};
    let lastError: string | undefined;
    for (;;) {
      let payload: Record<string, unknown> | undefined;
      try {
        const response = await fetch(this.buildUrl(pollPath), {
          method: 'GET',
          headers: this.buildRequestHeaders(false),
        });
        if (response.status === 401 || response.status === 403) {
          const body = (await response.text()).slice(0, 300);
          const authError = new Error(
            `${this.getName()} video poll failed: HTTP ${response.status} ${body}`
          ) as Error & { videoPollTerminal?: boolean };
          authError.videoPollTerminal = true;
          throw authError;
        }
        if (!response.ok) {
          lastError = `HTTP ${response.status} ${(await response.text()).slice(0, 300)}`;
        } else {
          payload = (await response.json()) as Record<string, unknown>;
        }
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { videoPollTerminal?: boolean }).videoPollTerminal === true
        ) {
          throw error;
        }
        // Network failure or non-JSON body — tolerate and re-poll.
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (payload) {
        lastPayload = payload;
        // Terminal when the provider says so, or when videos already exist.
        const status = this.extractVideoStatus(lastPayload) ?? '';
        if (this.extractVideoItems(lastPayload).length > 0 || terminal.has(status)) {
          return lastPayload;
        }
      }

      if (Date.now() + intervalMs > deadline) {
        const status = this.extractVideoStatus(lastPayload) ?? '';
        throw new Error(
          `${this.getName()} video task ${taskId} still "${status || 'unknown'}" after ${timeoutMs}ms poll budget${lastError ? ` (last poll error: ${lastError})` : ''}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async imageEdit(model: Model, request: ImageEditRequest): Promise<ImageEditResponse> {
    const normalizedModel = await this.normalizeModelName(model.name || model.id);
    const path = this.metadata.imagesEditsPath || '/images/edits';
    const options = request.options || {};
    const formData = new FormData();

    const imageFileName = this.resolveImageRequestOption(
      options,
      ['image_filename', 'filename', 'fileName'],
      'image.png'
    );
    const imageMimeType = this.resolveImageRequestOption(
      options,
      ['image_mime_type', 'mime_type', 'mimeType'],
      'image/png'
    );
    formData.append(
      'image',
      this.resolveFormDataFile(request.image, imageFileName, imageMimeType)
    );
    formData.append('model', normalizedModel);
    formData.append('prompt', request.prompt);

    if (request.mask) {
      const maskFileName = this.resolveImageRequestOption(
        options,
        ['mask_filename', 'maskFileName'],
        'mask.png'
      );
      const maskMimeType = this.resolveImageRequestOption(
        options,
        ['mask_mime_type', 'maskMimeType'],
        'image/png'
      );
      formData.append(
        'mask',
        this.resolveFormDataFile(request.mask, maskFileName, maskMimeType)
      );
    }

    const requestN = typeof request.n === 'number' ? request.n : undefined;
    const optionsN = typeof options.n === 'number' ? options.n : undefined;
    const n = requestN ?? optionsN;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 1) {
      formData.append('n', String(Math.floor(n)));
    }

    const size =
      typeof request.size === 'string'
        ? request.size
        : typeof options.size === 'string'
          ? options.size
          : undefined;
    if (size) {
      formData.append('size', size);
    }

    const responseFormat =
      typeof request.response_format === 'string'
        ? request.response_format
        : typeof options.response_format === 'string'
          ? options.response_format
          : typeof options.responseFormat === 'string'
            ? options.responseFormat
            : undefined;
    if (responseFormat) {
      formData.append('response_format', responseFormat);
    }

    const response = await this.sendMultipartRequestWithRetry({
      path,
      operation: 'image edit',
      formData,
    });
    const raw = (await response.json()) as {
      data?: Array<{ url?: string; b64_json?: string }>;
    };
    const parsed = await this.parseImageResult(raw, 'image edit');

    return {
      image: parsed.image,
      format: parsed.format,
      raw,
    };
  }

  async imageVariation(
    model: Model,
    request: ImageVariationRequest
  ): Promise<ImageVariationResponse> {
    const normalizedModel = await this.normalizeModelName(model.name || model.id);
    const path = this.metadata.imagesVariationsPath || '/images/variations';
    const options = request.options || {};
    const formData = new FormData();

    const imageFileName = this.resolveImageRequestOption(
      options,
      ['image_filename', 'filename', 'fileName'],
      'image.png'
    );
    const imageMimeType = this.resolveImageRequestOption(
      options,
      ['image_mime_type', 'mime_type', 'mimeType'],
      'image/png'
    );
    formData.append(
      'image',
      this.resolveFormDataFile(request.image, imageFileName, imageMimeType)
    );
    formData.append('model', normalizedModel);

    const requestN = typeof request.n === 'number' ? request.n : undefined;
    const optionsN = typeof options.n === 'number' ? options.n : undefined;
    const n = requestN ?? optionsN;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 1) {
      formData.append('n', String(Math.floor(n)));
    }

    const size =
      typeof request.size === 'string'
        ? request.size
        : typeof options.size === 'string'
          ? options.size
          : undefined;
    if (size) {
      formData.append('size', size);
    }

    const responseFormat =
      typeof request.response_format === 'string'
        ? request.response_format
        : typeof options.response_format === 'string'
          ? options.response_format
          : typeof options.responseFormat === 'string'
            ? options.responseFormat
            : undefined;
    if (responseFormat) {
      formData.append('response_format', responseFormat);
    }

    const response = await this.sendMultipartRequestWithRetry({
      path,
      operation: 'image variation',
      formData,
    });
    const raw = (await response.json()) as {
      data?: Array<{ url?: string; b64_json?: string }>;
    };
    const parsed = await this.parseImageResult(raw, 'image variation');

    return {
      image: parsed.image,
      format: parsed.format,
      raw,
    };
  }

  protected async sendJsonRequestWithRetry(options: {
    path: string;
    operation: string;
    payload: Record<string, unknown>;
    /**
     * Caps the retry count for this request only (0 disables retries).
     * Required for non-idempotent submits — an async PAID video job re-POSTed
     * after an ambiguous failure can start a second billed generation (see
     * videoGenerate, incident 2026-07-17).
     */
    maxRetriesOverride?: number;
  }): Promise<Response> {
    // Route the whole retry sequence through the resilience stack
    // (bulkhead → circuit breaker → adaptive timeout). Wrapping the entire
    // loop (not each attempt) is what makes an OPEN breaker fast-fail:
    // executeThroughBulkhead rejects before the loop starts, so no backoff
    // sleeps run. Returns the (streamable) Response — the body is read by the
    // caller outside the bulkhead slot, so streaming semantics are preserved
    // (only connection establishment holds a slot).
    return this.executeThroughBulkhead(
      () => this.sendJsonRequestWithRetryInner(options),
      options.operation
    );
  }

  private async sendJsonRequestWithRetryInner(options: {
    path: string;
    operation: string;
    payload: Record<string, unknown>;
    maxRetriesOverride?: number;
  }): Promise<Response> {
    const maxRetries = Math.max(0, options.maxRetriesOverride ?? this.config.maxRetries ?? 3);
    const baseDelayMs = Math.max(250, this.config.retryDelay ?? 1000);
    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        const response = await fetch(this.buildUrl(options.path), {
          method: 'POST',
          headers: this.buildRequestHeaders(true),
          body: JSON.stringify(options.payload),
        });

        if (response.ok) {
          return response;
        }

        const errorPayload = await this.parseErrorPayload(response);
        const canRetry =
          attempt < maxRetries &&
          this.isRetryableStatus(response.status) &&
          !this.isTerminalRateLimit(response.status, errorPayload);

        if (!canRetry) {
          const terminalError = new Error(
            `${this.providerName} ${options.operation} failed: HTTP ${response.status} ${errorPayload}`
          ) as HubRequestError;
          terminalError.terminal = true;
          terminalError.status = response.status;
          terminalError.body = errorPayload;
          throw terminalError;
        }

        const retryAfterMs = this.parseRetryAfterMs(response.headers.get('retry-after'));
        const delayMs =
          retryAfterMs !== undefined ? retryAfterMs : Math.min(baseDelayMs * 2 ** attempt, 10_000);

        this.providerLog.warn(
          {
            operation: options.operation,
            status: response.status,
            attempt: attempt + 1,
            maxRetries,
            delayMs,
          },
          'Transient hub request failure; retrying with backoff'
        );

        await this.sleep(delayMs);
        attempt += 1;
      } catch (error) {
        if (
          error instanceof Error &&
          (error as Error & { terminal?: boolean }).terminal === true
        ) {
          throw error;
        }

        if (attempt >= maxRetries) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${this.providerName} ${options.operation} failed: ${message}`);
        }

        const delayMs = Math.min(baseDelayMs * 2 ** attempt, 10_000);
        this.providerLog.warn(
          {
            operation: options.operation,
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          },
          'Hub request failed before response; retrying with backoff'
        );
        await this.sleep(delayMs);
        attempt += 1;
      }
    }

    throw new Error(`${this.providerName} ${options.operation} failed after retries`);
  }

  protected async sendMultipartRequestWithRetry(options: {
    path: string;
    operation: string;
    formData: FormData;
  }): Promise<Response> {
    // See sendJsonRequestWithRetry: the whole retry loop runs through the
    // resilience stack so an OPEN breaker fast-fails without backoff.
    return this.executeThroughBulkhead(
      () => this.sendMultipartRequestWithRetryInner(options),
      options.operation
    );
  }

  private async sendMultipartRequestWithRetryInner(options: {
    path: string;
    operation: string;
    formData: FormData;
  }): Promise<Response> {
    const maxRetries = Math.max(0, this.config.maxRetries ?? 3);
    const baseDelayMs = Math.max(250, this.config.retryDelay ?? 1000);
    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        const response = await fetch(this.buildUrl(options.path), {
          method: 'POST',
          headers: this.buildRequestHeaders(false),
          body: options.formData,
        });

        if (response.ok) {
          return response;
        }

        const errorPayload = await this.parseErrorPayload(response);
        const canRetry =
          attempt < maxRetries &&
          this.isRetryableStatus(response.status) &&
          !this.isTerminalRateLimit(response.status, errorPayload);

        if (!canRetry) {
          const terminalError = new Error(
            `${this.providerName} ${options.operation} failed: HTTP ${response.status} ${errorPayload}`
          ) as HubRequestError;
          terminalError.terminal = true;
          terminalError.status = response.status;
          terminalError.body = errorPayload;
          throw terminalError;
        }

        const retryAfterMs = this.parseRetryAfterMs(response.headers.get('retry-after'));
        const delayMs =
          retryAfterMs !== undefined ? retryAfterMs : Math.min(baseDelayMs * 2 ** attempt, 10_000);

        this.providerLog.warn(
          {
            operation: options.operation,
            status: response.status,
            attempt: attempt + 1,
            maxRetries,
            delayMs,
          },
          'Transient multipart hub request failure; retrying with backoff'
        );

        await this.sleep(delayMs);
        attempt += 1;
      } catch (error) {
        if (
          error instanceof Error &&
          (error as Error & { terminal?: boolean }).terminal === true
        ) {
          throw error;
        }

        if (attempt >= maxRetries) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${this.providerName} ${options.operation} failed: ${message}`);
        }

        const delayMs = Math.min(baseDelayMs * 2 ** attempt, 10_000);
        this.providerLog.warn(
          {
            operation: options.operation,
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          },
          'Multipart hub request failed before response; retrying with backoff'
        );
        await this.sleep(delayMs);
        attempt += 1;
      }
    }

    throw new Error(`${this.providerName} ${options.operation} failed after retries`);
  }

  private shouldFallbackToNextModel(error: unknown): boolean {
    const hubError = error as HubRequestError | undefined;
    const status =
      typeof hubError?.status === 'number' ? hubError.status : undefined;
    const bodyFromHubError = hubError?.body;
    const bodyCandidate =
      typeof bodyFromHubError === 'string'
        ? bodyFromHubError
        : error instanceof Error
          ? error.message
          : String(error ?? '');
    const body = bodyCandidate.toLowerCase();

    if (status === 401 || status === 403 || status === 404) {
      return true;
    }

    return (
      body.includes('incorrect api key') ||
      body.includes('authorization credentials were missing or incorrect') ||
      body.includes('model not found') ||
      body.includes('unknown model') ||
      body.includes('provider') && body.includes('not configured')
    );
  }

  private isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  private isTerminalRateLimit(status: number, payload: string): boolean {
    if (status !== 429) {
      return false;
    }
    const normalized = payload.toLowerCase();
    return (
      normalized.includes('insufficient credit') ||
      normalized.includes('insufficient balance') ||
      normalized.includes('quota exceeded') ||
      normalized.includes('billing') ||
      normalized.includes('daily rate limit exceeded') ||
      (normalized.includes('maximum of') && normalized.includes('per day'))
    );
  }

  private parseRetryAfterMs(retryAfterHeader: string | null): number | undefined {
    if (!retryAfterHeader) {
      return undefined;
    }

    const trimmed = retryAfterHeader.trim();
    if (!trimmed) {
      return undefined;
    }

    const asSeconds = Number(trimmed);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.round(asSeconds * 1000);
    }

    const asDate = Date.parse(trimmed);
    if (!Number.isNaN(asDate)) {
      return Math.max(0, asDate - Date.now());
    }

    return undefined;
  }

  protected buildRequestHeaders(includeJsonContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {};

    if (includeJsonContentType) {
      headers['Content-Type'] = 'application/json';
    }

    const authHeaderName = this.metadata.authHeaderName || 'Authorization';
    const authScheme = this.metadata.authScheme || 'Bearer';
    headers[authHeaderName] = authScheme ? `${authScheme} ${this.apiKey}`.trim() : this.apiKey;

    if (this.metadata.secondaryAuthHeaderName) {
      const scheme = this.metadata.secondaryAuthScheme || authScheme || 'Bearer';
      headers[this.metadata.secondaryAuthHeaderName] = scheme
        ? `${scheme} ${this.apiKey}`.trim()
        : this.apiKey;
    }

    if (this.metadata.extraHeaders) {
      for (const [key, value] of Object.entries(this.metadata.extraHeaders)) {
        if (typeof value === 'string' && value.trim().length > 0) {
          headers[key] = value;
        }
      }
    }

    return headers;
  }

  private buildUrl(path: string): string {
    const normalizedBase = this.baseURL.endsWith('/')
      ? this.baseURL.slice(0, -1)
      : this.baseURL;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  protected async parseErrorPayload(response: Response): Promise<string> {
    // ── Phase 6 Fix 3: Body-reuse guard ───────────────────────────────
    // The previous shape was `try response.json() catch response.text()`,
    // which fails fatally with `Body is unusable: Body has already been
    // read` whenever the error body was not JSON. `response.json()` reads
    // the body internally before parsing — when JSON.parse throws, the
    // body stream is already consumed, so the catch-branch `response.text()`
    // immediately throws "Body is unusable", and the original error is
    // hidden behind a stream-exhaustion exception.
    //
    // Fix: read the body ONCE as text, then try to parse the in-memory
    // string. This preserves the prior contract (JSON.stringify(parsed)
    // when valid, raw text when not) and never re-reads the body stream.
    let raw: string;
    try {
      raw = await response.text();
    } catch {
      return '';
    }
    if (!raw) return '';
    try {
      const data: unknown = JSON.parse(raw);
      return JSON.stringify(data);
    } catch {
      return raw;
    }
  }

  private convertStreamChunk(chunk: Record<string, unknown>, requestedModel: string): ChatResponse {
    const choicesRaw = Array.isArray(chunk.choices) ? chunk.choices : [];

    const choices: ChatChoice[] = choicesRaw.map((choiceRaw, index) => {
      const choice =
        choiceRaw && typeof choiceRaw === 'object'
          ? (choiceRaw as Record<string, unknown>)
          : {};
      const deltaRaw =
        choice.delta && typeof choice.delta === 'object'
          ? (choice.delta as Record<string, unknown>)
          : {};

      const role =
        deltaRaw.role === 'system' ||
        deltaRaw.role === 'user' ||
        deltaRaw.role === 'assistant' ||
        deltaRaw.role === 'function' ||
        deltaRaw.role === 'tool'
          ? deltaRaw.role
          : undefined;

      let contentValue: string | undefined;
      if (typeof deltaRaw.content === 'string') {
        contentValue = deltaRaw.content;
      }

      let toolCalls: ToolCall[] | undefined;
      if (Array.isArray(deltaRaw.tool_calls)) {
        const parsed = deltaRaw.tool_calls
          .map((toolCallRaw) => {
            if (!toolCallRaw || typeof toolCallRaw !== 'object') {
              return null;
            }
            const toolCall = toolCallRaw as Record<string, unknown>;
            const fn =
              toolCall.function && typeof toolCall.function === 'object'
                ? (toolCall.function as Record<string, unknown>)
                : undefined;

            if (
              typeof toolCall.id !== 'string' ||
              toolCall.type !== 'function' ||
              !fn ||
              typeof fn.name !== 'string'
            ) {
              return null;
            }

            return {
              id: toolCall.id,
              type: 'function' as const,
              function: {
                name: fn.name,
                arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
              },
            };
          })
          .filter((item): item is ToolCall => Boolean(item));

        if (parsed.length > 0) {
          toolCalls = parsed;
        }
      }

      const finishReasonCandidate = choice.finish_reason;
      const finishReason =
        finishReasonCandidate === 'stop' ||
        finishReasonCandidate === 'length' ||
        finishReasonCandidate === 'tool_calls' ||
        finishReasonCandidate === 'content_filter'
          ? finishReasonCandidate
          : null;

      return {
        index: typeof choice.index === 'number' ? choice.index : index,
        delta: {
          ...(role ? { role } : {}),
          ...(contentValue !== undefined ? { content: contentValue } : {}),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
        logprobs: null,
      };
    });

    const usageRaw =
      chunk.usage && typeof chunk.usage === 'object'
        ? (chunk.usage as Record<string, unknown>)
        : undefined;

    const promptTokens =
      typeof usageRaw?.prompt_tokens === 'number' ? usageRaw.prompt_tokens : undefined;
    const completionTokens =
      typeof usageRaw?.completion_tokens === 'number' ? usageRaw.completion_tokens : undefined;
    const totalTokens =
      typeof usageRaw?.total_tokens === 'number'
        ? usageRaw.total_tokens
        : promptTokens !== undefined || completionTokens !== undefined
          ? (promptTokens || 0) + (completionTokens || 0)
          : undefined;

    return {
      id: typeof chunk.id === 'string' ? chunk.id : `${this.providerName}-${Date.now()}`,
      object: 'chat.completion.chunk',
      created:
        typeof chunk.created === 'number' ? chunk.created : Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices,
      usage:
        promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined
          ? {
              prompt_tokens: promptTokens || 0,
              completion_tokens: completionTokens || 0,
              total_tokens: totalTokens || 0,
            }
          : undefined,
    };
  }
}
