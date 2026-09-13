// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Google Gemini Provider Adapter
 * Implements ProviderAdapter for Google's Gemini models
 */

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import {
  ProviderAdapter,
  type HealthCheckResult,
  type RealtimeTransportSupport,
} from '../base/provider-adapter';
import { MODERATION_ANALYZER_SYSTEM_PROMPT } from '../base/moderation-prompt';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderConfig,
  Provider,
  Model,
  Tool,
  ToolCall,
} from '@/types';
import type {
  AudioTTSRequest,
  AudioTTSResponse,
  AudioSTTRequest,
  AudioSTTResponse,
  ModerationRequest,
  ModerationResponse,
  ImageGenRequest,
  ImageGenResponse,
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  VideoGenRequest,
  VideoGenResponse,
} from '@/types/model-client';
import { logger } from '@/utils/logger';
import { getModelsByProvider } from '@/services/model-catalog-service';
import { getErrorMessage } from '@/utils/type-guards';
import { classifyGoogleCredentialShape } from '@/core/operability/provider-failure-classification';
import { resolveReasoningEffort } from '@/utils/reasoning-effort';
import { recordProviderPromptCacheUsage } from '@/observability/ci-metrics';
import { randomUUID } from 'crypto';

/**
 * Google Gemini Adapter
 * Supports: Gemini 1.5 Pro, Gemini 1.5 Flash, Gemini 1.0 Pro
 */
export class GoogleAdapter extends ProviderAdapter {
  private client: GoogleGenerativeAI;
  // Scale-to-100k Phase 2 (issue #152): one SDK client per pooled account
  // (GOOGLE_API_KEY_POOL), or just [this.client] with none configured. See
  // the OpenAI adapter for the original reference implementation.
  private clientPool: GoogleGenerativeAI[];
  private providerLog = logger.child({ provider: 'google' });

  /**
   * The Gemini Live API is a WebSocket to `BidiGenerateContent` on
   * generativelanguage.googleapis.com: a `setup` message opens the session,
   * then `realtimeInput` carries audio up and `serverContent` carries audio
   * and text down. The bridge implementation is
   * `providers/google/google-live-client.ts`.
   */
  override getRealtimeTransport(): RealtimeTransportSupport {
    return {
      kind: 'google-live-ws',
      evidenceUrl: 'https://ai.google.dev/gemini-api/docs/live',
    };
  }

  constructor(config: ProviderConfig) {
    super('google', 'Google AI (Gemini)', config);
    const pooledKeys = this.getAllApiKeys();
    this.clientPool =
      pooledKeys.length > 0
        ? pooledKeys.map((key) => new GoogleGenerativeAI(key))
        : [new GoogleGenerativeAI(config.apiKey)];
    this.client = this.clientPool[0]!;
    // Credential TYPE check (Workstream F, 2026-08-17): the Generative
    // Language API expects an AI Studio key (`AIza...`) sent as x-goog-api-key.
    // If the secret slot holds a DIFFERENT credential type (OAuth access
    // token / service-account JSON / JWT), every call 401s with
    // ACCESS_TOKEN_TYPE_UNSUPPORTED — observed live 47+ times on 2026-08-17.
    // Detect the mismatch at construction and quarantine the provider
    // immediately (boot-time auth_failed), instead of re-paying the 401 on
    // every request. Logs the SHAPE only — never the value.
    this.validateCredentialShape(pooledKeys.length > 0 ? pooledKeys : [config.apiKey]);
  }

  /**
   * Classify the stored credential shapes (never the values). A non-
   * `api_key` shape is a secret-slot TYPE mismatch: quarantine via the
   * operability hub so the cascade stops trying this provider until the
   * secret holds the right credential type.
   */
  private validateCredentialShape(keys: string[]): void {
    const badShapes = new Set<string>();
    for (const key of keys) {
      const shape = classifyGoogleCredentialShape(key);
      if (shape !== 'api_key') badShapes.add(shape);
    }
    if (badShapes.size === 0) return;
    const shapes = [...badShapes].join(',');
    this.providerLog.error(
      { credentialShapes: shapes, expected: 'api_key (AIza...)' },
      'GOOGLE_API_KEY secret holds the wrong credential TYPE — Generative Language API expects an AI Studio key; got ' +
        shapes +
        '. Update the google-key secret in Secret Manager to an AI Studio API key.'
    );
    // Quarantine at boot: hub classifyError maps this message to auth.
    import('@/core/provider-operability-hub')
      .then(({ getProviderOperabilityHub }) => {
        getProviderOperabilityHub().recordExecution(
          'google',
          false,
          401,
          `credential_type_mismatch: stored credential shape [${shapes}] is not an api_key — ACCESS_TOKEN_TYPE_UNSUPPORTED expected`
        );
      })
      .catch(() => {
        /* hub unavailable at construction time — runtime 401s will still quarantine */
      });
  }

  /** Round-robins across clientPool when GOOGLE_API_KEY_POOL is configured. */
  private getRequestClient(): GoogleGenerativeAI {
    if (this.clientPool.length <= 1) return this.client;
    return this.clientPool[this.nextPoolIndex(this.clientPool.length)]!;
  }

  /** Rough token-cost estimate fed into the TPM budget check (issue #152). */
  private estimateTokenCost(request: ChatRequest): number {
    const promptChars = request.messages.reduce((sum, message) => {
      const content =
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content ?? '');
      return sum + content.length;
    }, 0);
    return Math.ceil(promptChars / 4) + (request.max_tokens || 2048);
  }

  /**
   * Get API key for external use (e.g., Live API)
   */
  getApiKey(): string {
    return this.config.apiKey;
  }

  /**
   * Get provider name
   */
  getName(): string {
    return 'google';
  }

  /**
   * Get provider information
   */
  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();

    const models = await this.getModels();

    return {
      id: 'google',
      name: 'google',
      displayName: 'Google AI (Gemini)',
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
   * Get available models
   */
  async getModels(): Promise<Model[]> {
    const models = await getModelsByProvider('google');

    if (!models.length) {
      logger.warn('No models registered in catalog for Google');
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
      throw new Error('No Google models available - check provider configuration');
    }

    // Filter available models
    const availableModels = models.filter(
      (m) =>
        m.status === 'active' &&
        (m.capabilities?.includes('chat') || m.capabilities?.includes('text_generation'))
    );

    if (availableModels.length === 0) {
      throw new Error('No available Google models with chat capability');
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

  /**
   * Normalize model name using dynamic discovery
   */
  async normalizeModelName(modelId: string): Promise<string> {
    // If no model specified, use dynamic default
    if (!modelId) {
      return await this.getDefaultModel();
    }

    const models = await this.getModels();
    const modelMap = new Map<string, string>();
    for (const model of models) {
      const key = model.id.toLowerCase();
      modelMap.set(key, model.id);
      // Also index keys without google provider prefix, e.g. google/gemini-2.5 -> gemini-2.5
      modelMap.set(key.replace(/^google[\/:_-]/, ''), model.id);
    }

    const normalizedInput = modelId
      .trim()
      .toLowerCase()
      .replace(/^google[\/:_-]/, '');

    // Try exact match first
    if (modelMap.has(normalizedInput)) {
      return modelMap.get(normalizedInput)!.replace(/^google[\/:_-]/, '');
    }

    // Try fuzzy match (remove slashes, dashes, underscores, dots)
    const normalized = normalizedInput.replace(/[\/\-_.]/g, '');
    for (const [key, value] of modelMap.entries()) {
      if (key.replace(/[\/\-_.]/g, '') === normalized) {
        return value.replace(/^google[\/:_-]/, '');
      }
    }

    // Try partial match (e.g., "gemini" matches "gemini-1.5-flash")
    // Prefer longer/more specific matches
    const partialMatches: Array<{ key: string; value: string; specificity: number }> = [];

    for (const [key, value] of modelMap.entries()) {
      const keyNormalized = key.replace(/[\/\-_.]/g, '');
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
      return partialMatches[0].value.replace(/^google[\/:_-]/, '');
    }

    // Return as-is if no match (let provider handle it or fail gracefully)
    logger.warn(
      { modelId, availableModels: Array.from(modelMap.keys()) },
      'Model not found in available models'
    );
    return normalizedInput;
  }

  /**
   * Check if model is a realtime model that requires special handling
   */
  private isRealtimeModel(model: string): boolean {
    const normalized = model.toLowerCase();
    const realtimeModels = [
      'gemini-2.5-flash-native-audio-preview-09-2025',
      'gemini-native-audio',
      'gemini-realtime',
    ];

    return realtimeModels.some((realtimeModel) => normalized.includes(realtimeModel));
  }

  /**
   * Check if a model natively supports Gemini's `thinkingConfig` knob.
   *
   * Gemini 2.5 is the first generation with a documented `thinkingBudget`
   * contract (Pro, Flash, and Flash-Lite); 1.x and non-thinking 2.0 models
   * reject the field outright. Matched the same way `isRealtimeModel()`
   * above matches model families: a substring allowlist against the
   * normalized model name, so `gemini-2.5-flash-lite` and dated aliases
   * (e.g. `gemini-2.5-pro-002`) match via their `gemini-2.5-*` prefix.
   */
  private isThinkingCapableModel(model: string): boolean {
    const normalized = model.toLowerCase();
    const thinkingModelPrefixes = ['gemini-2.5-pro', 'gemini-2.5-flash'];

    return thinkingModelPrefixes.some((prefix) => normalized.includes(prefix));
  }

  /**
   * Real per-model `thinkingBudget` token range (Google AI "Thinking" guide
   * and the 2.5 Pro / Flash / Flash-Lite model cards). The Gemini API
   * rejects an out-of-range value with a 400 instead of clamping it
   * server-side, so the resolved budget is clamped here before being sent:
   *   - 2.5 Pro: thinking cannot be fully disabled — the documented range is
   *     128-32768 (no 0).
   *   - 2.5 Flash / Flash-Lite: 0-24576, where 0 explicitly disables
   *     thinking.
   * (Gemini also documents `-1` as a sentinel for "dynamic thinking" on
   * both families, but that is a distinct opt-in this adapter does not
   * synthesize on its own — it only forwards the resolved, concrete
   * per-tier budget from `resolveReasoningEffort()`.)
   */
  private getThinkingBudgetRange(model: string): { min: number; max: number } {
    const normalized = model.toLowerCase();
    if (normalized.includes('gemini-2.5-pro')) return { min: 128, max: 32768 };
    return { min: 0, max: 24576 }; // gemini-2.5-flash / gemini-2.5-flash-lite
  }

  /**
   * Build the `generationConfig.thinkingConfig` block for a Gemini request,
   * or `undefined` when the model doesn't support it or nothing on the
   * request asked for reasoning. Goes through the foundation's
   * `resolveReasoningEffort()` (LOTE AZ, `@/utils/reasoning-effort`) rather
   * than reading `thinking_budget`/`reasoning_effort` ad hoc, so this stays
   * reconciled with every other consumer of those fields.
   *
   * `includeThoughts` defaults to `false`: nothing downstream of this
   * adapter (response conversion, streaming chunk parsing) understands a
   * Gemini `thought` part, so surfacing thought summaries would currently
   * just leak raw thinking text into the answer content unlabeled.
   */
  private buildThinkingConfig(
    request: ChatRequest,
    modelName: string
  ): { thinkingBudget: number; includeThoughts: boolean } | undefined {
    if (!this.isThinkingCapableModel(modelName)) return undefined;

    const { thinkingBudget } = resolveReasoningEffort(request);
    if (thinkingBudget === undefined) return undefined;

    const { min, max } = this.getThinkingBudgetRange(modelName);
    const clampedBudget = Math.min(Math.max(thinkingBudget, min), max);

    return { thinkingBudget: clampedBudget, includeThoughts: false };
  }

  /**
   * Chat completion (non-streaming)
   */
  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const startTime = Date.now();

    try {
      // Check if this is a realtime model
      if (request.model && this.isRealtimeModel(request.model)) {
        this.providerLog.warn(
          { model: request.model },
          'Realtime model detected. Note: Gemini realtime models may require special API handling. Using standard chat completion API.'
        );
        // For now, we'll use the standard API, but log a warning
        // Future: Implement dedicated realtime handling similar to OpenAI
      }

      this.providerLog.debug(
        { request: this.sanitizeRequest(request) },
        'Sending chat completion request'
      );

      const modelToUse = request.model || (await this.getDefaultModel());
      if (!modelToUse) {
        throw new Error('Model is required for chat completion');
      }
      const modelName = await this.normalizeModelName(modelToUse);

      // Convert messages to Gemini format
      const { systemInstruction, contents } = this.convertMessages(request.messages);
      const modelConfig =
        systemInstruction && systemInstruction.trim().length > 0
          ? ({ model: modelName, systemInstruction } as unknown)
          : ({ model: modelName } as unknown);
      const model = this.getRequestClient().getGenerativeModel(
        modelConfig as Parameters<GoogleGenerativeAI['getGenerativeModel']>[0]
      );

      // Generate content - convert contents to proper type
      const geminiContents = contents.map((content) => ({
        role: content.role,
        parts: content.parts.map((part) => {
          if ('text' in part && part.text !== undefined) {
            return { text: part.text };
          }
          if ('inlineData' in part && part.inlineData !== undefined) {
            return { inlineData: part.inlineData };
          }
          if ('fileData' in part && part.fileData !== undefined) {
            return { fileData: part.fileData };
          }
          return { text: '' };
        }),
      }));

      // Create request object with proper typing
      const thinkingConfig = this.buildThinkingConfig(request, modelName);
      const hasTools = Boolean(request.tools && request.tools.length > 0);
      const toolConfig = hasTools ? this.convertToolChoiceToGemini(request.tool_choice) : undefined;
      const generateRequest = {
        contents: geminiContents,
        generationConfig: {
          temperature: request.temperature,
          topP: request.top_p,
          maxOutputTokens: request.max_tokens || 2048,
          stopSequences: request.stop
            ? Array.isArray(request.stop)
              ? request.stop
              : [request.stop]
            : undefined,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
        ],
        ...(hasTools
          ? {
              tools: this.convertToolsToGemini(request.tools!),
              ...(toolConfig ? { toolConfig } : {}),
            }
          : {}),
      };

      // Type assertion needed due to SDK type mismatch - the structure is correct
      // Route through the resilience stack (bulkhead → breaker → timeout) so a
      // Gemini outage fast-fails and is isolated per-provider.
      const result = await this.executeThroughBulkhead(
        () => model.generateContent(generateRequest as Parameters<typeof model.generateContent>[0]),
        'chat completion',
        this.estimateTokenCost(request)
      );

      const duration = Date.now() - startTime;

      this.providerLog.debug(
        {
          model: modelName,
          duration,
        },
        'Chat completion successful'
      );

      return this.convertResponse(
        result as {
          response: {
            candidates: Array<{
              content: { parts: Array<{ text?: string }> };
              finishReason?: string;
            }>;
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              totalTokenCount?: number;
            };
          };
        },
        request.model || modelName
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.providerLog.error(
        {
          error: getErrorMessage(error),
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

      const modelToUse = request.model || (await this.getDefaultModel());
      if (!modelToUse) {
        throw new Error('Model is required for chat completion');
      }
      const modelName = await this.normalizeModelName(modelToUse);

      const { systemInstruction, contents } = this.convertMessages(request.messages);
      const modelConfig =
        systemInstruction && systemInstruction.trim().length > 0
          ? ({ model: modelName, systemInstruction } as unknown)
          : ({ model: modelName } as unknown);
      const model = this.getRequestClient().getGenerativeModel(
        modelConfig as Parameters<GoogleGenerativeAI['getGenerativeModel']>[0]
      );

      // Convert contents to proper type
      const geminiContents = contents.map((content) => ({
        role: content.role,
        parts: content.parts.map((part) => {
          if ('text' in part && part.text !== undefined) {
            return { text: part.text };
          }
          if ('inlineData' in part && part.inlineData !== undefined) {
            return { inlineData: part.inlineData };
          }
          if ('fileData' in part && part.fileData !== undefined) {
            return { fileData: part.fileData };
          }
          return { text: '' };
        }),
      }));

      // Create request object with proper typing
      const thinkingConfig = this.buildThinkingConfig(request, modelName);
      const hasTools = Boolean(request.tools && request.tools.length > 0);
      const toolConfig = hasTools ? this.convertToolChoiceToGemini(request.tool_choice) : undefined;
      const generateRequest = {
        contents: geminiContents,
        generationConfig: {
          temperature: request.temperature,
          topP: request.top_p,
          maxOutputTokens: request.max_tokens || 2048,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
        ],
        // Previously omitted entirely for streaming (finding #2 of the
        // streaming-tool-calling audit) — function calling was unreachable
        // on this path regardless of what the model supported.
        ...(hasTools
          ? {
              tools: this.convertToolsToGemini(request.tools!),
              ...(toolConfig ? { toolConfig } : {}),
            }
          : {}),
      };

      // Type assertion needed due to SDK type mismatch - the structure is correct
      // Only connection establishment runs through the resilience stack; the
      // stream read loop below stays outside the bulkhead slot so streaming
      // semantics are preserved (the slot is not held for the stream lifetime).
      const result = await this.executeThroughBulkhead(
        () =>
          model.generateContentStream(
            generateRequest as Parameters<typeof model.generateContentStream>[0]
          ),
        'chat completion stream',
        this.estimateTokenCost(request)
      );

      let firstChunk = true;
      // Gemini's own `finishReason` has no distinct value for "the model
      // called a function" — it reports STOP either way. Track whether any
      // chunk carried a function-call part so the terminal chunk's
      // `finish_reason` can be corrected to 'tool_calls', matching the
      // OpenAI-compatible contract every client expects.
      let sawFunctionCall = false;
      // Gemini doesn't provide a stable per-call index of its own; each
      // function-call part encountered across the whole stream gets the
      // next sequential index.
      let nextToolCallIndex = 0;

      for await (const chunk of result.stream) {
        if (firstChunk) {
          const duration = Date.now() - startTime;
          this.providerLog.debug({ duration }, 'First chunk received');
          firstChunk = false;
        }

        const converted = this.convertStreamChunk(chunk, modelName, nextToolCallIndex);
        const toolCalls = converted.choices[0]?.delta?.tool_calls;
        if (toolCalls && toolCalls.length > 0) {
          sawFunctionCall = true;
          nextToolCallIndex += toolCalls.length;
        }
        if (sawFunctionCall && converted.choices[0] && converted.choices[0].finish_reason !== null) {
          converted.choices[0].finish_reason = 'tool_calls';
        }
        yield converted;
      }

      const totalDuration = Date.now() - startTime;
      this.providerLog.debug({ duration: totalDuration }, 'Streaming completed');
    } catch (error) {
      const duration = Date.now() - startTime;
      this.providerLog.error(
        {
          error: getErrorMessage(error),
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
   */
  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const startTime = Date.now();

    try {
      const model = this.getRequestClient().getGenerativeModel({ model: 'embedding-001' });

      const inputs = Array.isArray(request.input) ? request.input : [request.input];

      // Wrap the whole batch in one bulkhead slot (rather than one per input)
      // so a single embeddings request cannot exhaust the provider's pool.
      const embeddings = await this.executeThroughBulkhead(
        () =>
          Promise.all(
            inputs.map(async (text, index) => {
              const result = await model.embedContent(text);
              return {
                object: 'embedding' as const,
                embedding: result.embedding.values,
                index,
              };
            })
          ),
        'embeddings'
      );

      const duration = Date.now() - startTime;
      this.providerLog.debug({ duration, count: embeddings.length }, 'Embeddings generated');

      return {
        object: 'list',
        data: embeddings,
        model: 'embedding-001',
        usage: {
          prompt_tokens: inputs.join('').length / 4, // Rough estimate
          completion_tokens: 0,
          total_tokens: inputs.join('').length / 4,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.providerLog.error(
        {
          error: getErrorMessage(error),
          duration,
        },
        'Embeddings generation failed'
      );
      throw this.convertError(error);
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      // Simple health check with fastest model
      const model = this.client.getGenerativeModel({ model: await this.getDefaultModel() });

      await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: {
          maxOutputTokens: 10,
        },
      });

      const latency = Date.now() - startTime;

      this.providerLog.debug({ latency }, 'Health check passed');

      return {
        healthy: true,
        latency,
        checkedAt: new Date(),
      };
    } catch (error) {
      const latency = Date.now() - startTime;

      this.providerLog.error(
        {
          error: getErrorMessage(error),
          latency,
        },
        'Health check failed'
      );

      return {
        healthy: false,
        latency,
        error: getErrorMessage(error),
        checkedAt: new Date(),
      };
    }
  }

  /**
   * Calculate cost for request
   */
  calculateCost(
    model: { inputCostPer1k?: number | string; outputCostPer1k?: number | string },
    inputTokens: number,
    outputTokens: number
  ): number {
    const inputRate = Math.max(0, Number(model.inputCostPer1k) || 0);
    const outputRate = Math.max(0, Number(model.outputCostPer1k) || 0);
    const cost = (inputTokens / 1000) * inputRate + (outputTokens / 1000) * outputRate;
    return Math.max(0, cost);
  }

  /**
   * Convert our OpenAI-style `tools` (function definitions) to Gemini's
   * `tools: [{ functionDeclarations: [...] }]` shape. Gemini groups every
   * function declaration under a single tool entry rather than one entry
   * per function.
   *
   * Shared by both the non-streaming and streaming request builders — prior
   * to this fix, NEITHER path forwarded `tools` to Gemini at all, so
   * function calling was completely unreachable for this provider
   * regardless of streaming.
   */
  private convertToolsToGemini(
    tools: Tool[]
  ): Array<{
    functionDeclarations: Array<{ name: string; description?: string; parameters?: unknown }>;
  }> {
    const functionDeclarations = tools
      .filter((tool) => tool.type === 'function' && tool.function)
      .map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }));

    return functionDeclarations.length > 0 ? [{ functionDeclarations }] : [];
  }

  /**
   * Map the canonical OpenAI-shaped `tool_choice` onto Gemini's native
   * `toolConfig.functionCallingConfig` shape — verbatim per
   * https://ai.google.dev/api/generate-content#FunctionCallingConfig:
   * `mode` is `AUTO` (model decides, the default), `ANY` (must call a
   * function), or `NONE` (must not call a function); `allowedFunctionNames`
   * narrows `ANY` to a specific subset of the declared functions.
   *
   * OpenAI's `'required'` maps to `ANY`, not `AUTO` — "must call some tool"
   * and "may call a tool" are different constraints, and collapsing them
   * would silently downgrade a caller's explicit request exactly like the
   * bug this fix addresses. `ChatRequest['tool_choice']` doesn't carry a
   * `'required'` literal in its type today, but a real OpenAI-compatible
   * caller can still send the string at runtime, so it's handled
   * defensively here rather than only through the type.
   *
   * Only called when `tools` is non-empty (see both request builders below)
   * — a `toolConfig` with no declared functions has nothing to constrain.
   */
  private convertToolChoiceToGemini(
    toolChoice: ChatRequest['tool_choice'] | 'required'
  ): { functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] } } | undefined {
    if (toolChoice === undefined) return undefined;
    if (toolChoice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
    if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
    if (toolChoice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      return {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.function.name] },
      };
    }
    return undefined;
  }

  /**
   * Extract `functionCall` parts from a Gemini content-parts array and
   * convert them to OpenAI-compatible `ToolCall`s. Gemini never assigns an
   * id to a function call, so one is synthesized here (stable for the
   * lifetime of this single response/chunk, which is all a caller needs to
   * correlate a call with its eventual `tool` role result).
   */
  private extractGoogleFunctionCalls(
    parts: Array<{ functionCall?: { name?: unknown; args?: unknown } }> | undefined,
    startIndex: number
  ): ToolCall[] {
    if (!Array.isArray(parts)) return [];

    const toolCalls: ToolCall[] = [];
    let index = startIndex;
    for (const part of parts) {
      const functionCall = part?.functionCall;
      if (!functionCall || typeof functionCall.name !== 'string') continue;
      toolCalls.push({
        id: `call_${randomUUID()}`,
        type: 'function',
        function: {
          name: functionCall.name,
          arguments: JSON.stringify(functionCall.args ?? {}),
        },
        index: index++,
      });
    }
    return toolCalls;
  }

  /**
   * Convert messages to Gemini format
   */
  private convertMessages(messages: ChatMessage[]): {
    systemInstruction?: string;
    contents: Array<{
      role: 'user' | 'model';
      parts: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
        fileData?: { fileUri: string; mimeType: string };
      }>;
    }>;
  } {
    let systemInstruction: string | undefined;
    const contents: Array<{
      role: 'user' | 'model';
      parts: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
        fileData?: { fileUri: string; mimeType: string };
      }>;
    }> = [];

    for (const message of messages) {
      // Extract system message
      if (message.role === 'system') {
        systemInstruction =
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        continue;
      }

      // Convert user/assistant messages
      const role = message.role === 'assistant' ? 'model' : 'user';

      // Handle text content
      if (typeof message.content === 'string') {
        contents.push({
          role,
          parts: [{ text: message.content }],
        });
      } else if (Array.isArray(message.content)) {
        // Handle multimodal content (text + images)
        const parts: Array<{
          text?: string;
          inlineData?: { mimeType: string; data: string };
          fileData?: { fileUri: string; mimeType: string };
        }> = [];

        for (const item of message.content) {
          if (item.type === 'text') {
            parts.push({ text: item.text });
          } else if (item.type === 'image_url') {
            // Convert base64 or URL to inline data
            const imageUrl = item.image_url.url;
            if (imageUrl.startsWith('data:')) {
              const [header, data] = imageUrl.split(',');
              const mimeType = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
              parts.push({
                inlineData: {
                  mimeType,
                  data,
                },
              });
            } else {
              // URL-based image
              parts.push({
                fileData: {
                  fileUri: imageUrl,
                  mimeType: 'image/jpeg',
                },
              });
            }
          }
        }

        contents.push({ role, parts });
      }
    }

    return { systemInstruction, contents };
  }

  /**
   * Convert Gemini response to our format
   */
  private convertResponse(
    result: { response: { candidates?: unknown; usageMetadata?: unknown; text?: () => string } },
    requestedModel: string
  ): ChatResponse {
    const response = result.response || {};
    const candidates = Array.isArray(response.candidates)
      ? (response.candidates as Array<Record<string, unknown>>)
      : [];
    const candidate = candidates[0];
    const content = this.extractGoogleResponseText(candidate, response.text);

    if (!candidate && content.trim().length === 0) {
      throw new Error('Invalid response format from Google API: missing candidates and text');
    }

    // Type guard for finishReason
    const finishReason =
      candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as { finishReason?: unknown }).finishReason === 'string'
        ? ((candidate as { finishReason: string }).finishReason as string)
        : undefined;

    // Type guard for usageMetadata
    const usageMetadata =
      response.usageMetadata && typeof response.usageMetadata === 'object'
        ? (response.usageMetadata as {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            totalTokenCount?: number;
            cachedContentTokenCount?: number;
          })
        : undefined;

    // Prompt caching (ADR-025 follow-up, 2026-09): Gemini's implicit context
    // caching is enabled by default (no request-side field to set) for
    // Gemini 2.5+ models — confirmed live against
    // ai.google.dev/gemini-api/docs/caching 2026-09-08. The SDK's own
    // `UsageMetadata.cachedContentTokenCount` (verified in
    // @google/generative-ai's type definitions) reports how many of this
    // response's prompt tokens were served from cache; Gemini only reports
    // the hit count directly, so the miss count is derived the same way the
    // xAI/Moonshot adapters do (`promptTokenCount - cachedContentTokenCount`).
    // Streaming responses are NOT covered here — `convertStreamChunk` below
    // does not surface `usageMetadata` at all today, a pre-existing gap
    // unrelated to caching (Gemini's own streaming usage reporting was never
    // wired up for any field, not just this one).
    if (usageMetadata && typeof usageMetadata.cachedContentTokenCount === 'number') {
      recordProviderPromptCacheUsage({
        provider: 'google',
        hitTokens: usageMetadata.cachedContentTokenCount,
        missTokens:
          typeof usageMetadata.promptTokenCount === 'number'
            ? Math.max(0, usageMetadata.promptTokenCount - usageMetadata.cachedContentTokenCount)
            : undefined,
      });
    }

    // Gemini's `finishReason` has no distinct value for "the model called a
    // function" (it reports STOP either way), so a non-empty tool_calls
    // array overrides the mapped finish_reason to 'tool_calls' — mirroring
    // how every other adapter reports a tool-calling turn.
    const candidateParts =
      candidate && typeof candidate === 'object'
        ? ((candidate as { content?: { parts?: unknown } }).content?.parts as
            | Array<{ text?: string; functionCall?: { name?: unknown; args?: unknown } }>
            | undefined)
        : undefined;
    const toolCalls = this.extractGoogleFunctionCalls(candidateParts, 0);

    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length > 0
            ? 'tool_calls'
            : finishReason
              ? this.mapFinishReason(finishReason)
              : null,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens:
          usageMetadata && typeof usageMetadata.promptTokenCount === 'number'
            ? usageMetadata.promptTokenCount
            : 0,
        completion_tokens:
          usageMetadata && typeof usageMetadata.candidatesTokenCount === 'number'
            ? usageMetadata.candidatesTokenCount
            : 0,
        total_tokens:
          usageMetadata && typeof usageMetadata.totalTokenCount === 'number'
            ? usageMetadata.totalTokenCount
            : usageMetadata &&
                typeof usageMetadata.promptTokenCount === 'number' &&
                typeof usageMetadata.candidatesTokenCount === 'number'
              ? usageMetadata.promptTokenCount + usageMetadata.candidatesTokenCount
              : 0,
      },
    };
  }

  private extractGoogleResponseText(
    candidate: Record<string, unknown> | undefined,
    fallbackText?: (() => string) | unknown
  ): string {
    let text = '';

    if (candidate && typeof candidate === 'object') {
      const candidateContent = (candidate as { content?: unknown }).content;

      if (typeof candidateContent === 'string') {
        text = candidateContent;
      } else if (candidateContent && typeof candidateContent === 'object') {
        const contentObject = candidateContent as { parts?: unknown; text?: unknown };

        if (Array.isArray(contentObject.parts)) {
          text = contentObject.parts
            .map((part) => this.extractGoogleContentPartText(part))
            .join('');
        } else if (contentObject.parts && typeof contentObject.parts === 'object') {
          text = this.extractGoogleContentPartText(contentObject.parts);
        } else if (typeof contentObject.text === 'string') {
          text = contentObject.text;
        }
      }
    }

    if (text.trim().length === 0 && typeof fallbackText === 'function') {
      try {
        const fallbackResult = (fallbackText as () => unknown)();
        if (typeof fallbackResult === 'string') {
          text = fallbackResult;
        }
      } catch {
        // Ignore fallback parsing errors and return what we have.
      }
    }

    return text;
  }

  private extractGoogleContentPartText(part: unknown): string {
    if (!part || typeof part !== 'object') {
      return '';
    }

    const typedPart = part as { text?: unknown };
    return typeof typedPart.text === 'string' ? typedPart.text : '';
  }

  /**
   * Convert streaming chunk to our format
   *
   * @param toolCallStartIndex the next OpenAI-style tool-call `index` to
   * assign if this chunk carries function-call parts (see the accumulator
   * in `chatCompletionStream` — Gemini doesn't provide a stable index of
   * its own).
   */
  private convertStreamChunk(
    chunk:
      | { text?: () => string }
      | {
          candidates?: Array<{
            content?: {
              parts?: Array<{ text?: string; functionCall?: { name?: unknown; args?: unknown } }>;
            };
            finishReason?: string;
          }>;
        },
    requestedModel: string,
    toolCallStartIndex = 0
  ): ChatResponse {
    // Handle different chunk formats
    let content = '';
    let parts:
      | Array<{ text?: string; functionCall?: { name?: unknown; args?: unknown } }>
      | undefined;
    let finishReason: string | undefined;

    if ('candidates' in chunk && Array.isArray(chunk.candidates) && chunk.candidates[0]) {
      parts = chunk.candidates[0].content?.parts;
      finishReason = chunk.candidates[0].finishReason;
      if (parts) {
        content = parts.map((p) => p.text || '').join('');
      }
    } else if ('text' in chunk && typeof chunk.text === 'function') {
      content = chunk.text();
    }

    // Gemini returns a function call's arguments complete within one part —
    // unlike Anthropic there is no incremental JSON-fragment streaming to
    // reassemble, so a single delta chunk carries the whole `arguments`
    // string.
    const toolCalls = this.extractGoogleFunctionCalls(parts, toolCallStartIndex);

    const delta: Partial<ChatMessage> = toolCalls.length > 0 ? { tool_calls: toolCalls } : { content };

    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason ? this.mapFinishReason(finishReason) : null,
          logprobs: null,
        },
      ],
    };
  }

  /**
   * Map Gemini finish reason to OpenAI format
   */
  private mapFinishReason(
    finishReason: string | undefined
  ): 'stop' | 'length' | 'content_filter' | null {
    const mapping: Record<string, 'stop' | 'length' | 'content_filter'> = {
      STOP: 'stop',
      MAX_TOKENS: 'length',
      SAFETY: 'content_filter',
      RECITATION: 'content_filter',
    };

    return mapping[finishReason || 'STOP'] || 'stop';
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

  /**
   * Convert error to standard format
   */
  private convertError(error: unknown): Error {
    if (error instanceof Error) {
      const message = `Google API Error: ${error.message}`;
      const newError = new Error(message);
      // Add error properties using Object.assign to avoid type assertions
      Object.assign(newError, {
        statusCode: 500,
        code: 'google_error',
      });
      return newError;
    }

    return new Error(`Unknown error: ${String(error)}`);
  }

  private parseDataUriMedia(input: string): { mimeType: string; data: string } | null {
    const match = input.match(/^data:([^;]+);base64,(.+)$/i);
    if (!match || !match[1] || !match[2]) {
      return null;
    }
    return {
      mimeType: match[1].trim(),
      data: match[2].replace(/\s+/g, ''),
    };
  }

  private isLikelyUrl(input: string): boolean {
    return /^https?:\/\//i.test(input);
  }

  private async resolveInlineMedia(
    media: string | undefined,
    defaultMimeType: string
  ): Promise<{ mimeType: string; data: string } | undefined> {
    if (!media || media.trim().length === 0) {
      return undefined;
    }

    const value = media.trim();
    const parsedDataUri = this.parseDataUriMedia(value);
    if (parsedDataUri) {
      return parsedDataUri;
    }

    if (this.isLikelyUrl(value)) {
      const response = await fetch(value, {
        method: 'GET',
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch media URL (${response.status})`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType =
        response.headers.get('content-type')?.split(';')[0]?.trim() || defaultMimeType;
      return {
        mimeType,
        data: buffer.toString('base64'),
      };
    }

    return {
      mimeType: defaultMimeType,
      data: value.replace(/\s+/g, ''),
    };
  }

  private async pollLongRunningOperation(
    operationName: string,
    apiKey: string,
    timeoutMs = 360_000,
    intervalMs = 5_000
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const cleanOperationName = operationName.replace(/^\/+/, '');
    const operationUrl = `https://generativelanguage.googleapis.com/v1beta/${cleanOperationName}?key=${apiKey}`;

    while (Date.now() - startedAt < timeoutMs) {
      const response = await fetch(operationUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Google video operation poll failed (${response.status}): ${errorText.slice(0, 500)}`
        );
      }

      const operation = (await response.json()) as Record<string, unknown>;
      const done = operation.done === true;

      if (done) {
        return operation;
      }

      await this.sleep(intervalMs);
    }

    throw new Error(`Google video operation timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  /**
   * Text-to-Speech (TTS) - REAL IMPLEMENTATION
   * Converts text to audio using Google Cloud Text-to-Speech API
   *
   * Note: Google Gemini does NOT have dedicated TTS, but Google Cloud has Text-to-Speech API
   * Uses REST API directly for TTS
   */
  async textToSpeech(model: Model, request: AudioTTSRequest): Promise<AudioTTSResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug(
        { model: model.name, textLength: request.text.length, voice: request.voice },
        'Starting TTS request via Google Cloud TTS'
      );

      // Google Cloud Text-to-Speech API endpoint
      const apiKey = this.config.apiKey;
      const ttsUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;

      // Map OpenAI voice names to Google TTS voice names
      const voiceMapping: Record<
        string,
        { languageCode: string; name: string; ssmlGender: string }
      > = {
        alloy: { languageCode: 'en-US', name: 'en-US-Neural2-F', ssmlGender: 'FEMALE' },
        echo: { languageCode: 'en-US', name: 'en-US-Neural2-D', ssmlGender: 'MALE' },
        fable: { languageCode: 'en-GB', name: 'en-GB-Neural2-B', ssmlGender: 'MALE' },
        onyx: { languageCode: 'en-US', name: 'en-US-Neural2-J', ssmlGender: 'MALE' },
        nova: { languageCode: 'en-US', name: 'en-US-Neural2-C', ssmlGender: 'FEMALE' },
        shimmer: { languageCode: 'en-US', name: 'en-US-Neural2-E', ssmlGender: 'FEMALE' },
      };

      const voiceConfig = voiceMapping[request.voice || 'alloy'] || voiceMapping['alloy'];

      // Map format
      const audioEncodingMap: Record<string, string> = {
        mp3: 'MP3',
        wav: 'LINEAR16',
        opus: 'OGG_OPUS',
        aac: 'MP3', // Google TTS doesn't support AAC directly, use MP3
        flac: 'FLAC',
        pcm: 'LINEAR16',
      };

      const audioEncoding = audioEncodingMap[request.format || 'mp3'] || 'MP3';

      // Call Google Cloud Text-to-Speech API
      const response = await fetch(ttsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: { text: request.text },
          voice: {
            languageCode: voiceConfig.languageCode,
            name: voiceConfig.name,
            ssmlGender: voiceConfig.ssmlGender,
          },
          audioConfig: {
            audioEncoding: audioEncoding,
            speakingRate: request.options?.speed || 1.0,
            pitch: 0,
            volumeGainDb: 0,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = (await response.json()) as {
          error?: string;
          message?: string;
          [key: string]: unknown;
        };
        throw new Error(`Google TTS API error: ${response.status} - ${JSON.stringify(errorBody)}`);
      }

      const result = (await response.json()) as { audioContent?: string; [key: string]: unknown };
      const audioContent = result.audioContent;

      if (!audioContent) {
        throw new Error('Google TTS API returned no audio content');
      }

      // Decode base64 audio content
      const audioBuffer = Buffer.from(audioContent, 'base64');

      const latency = Date.now() - startTime;

      this.providerLog.info(
        {
          model: model.name,
          latency,
          audioSize: audioBuffer.length,
          format: request.format || 'mp3',
        },
        'TTS request completed'
      );

      return {
        audio: audioBuffer,
        format: request.format || 'mp3',
        raw: { size: audioBuffer.length, latency },
      };
    } catch (error: unknown) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.providerLog.error(
        {
          model: model.name,
          latency,
          error: errorMessage,
        },
        'TTS request failed'
      );

      throw this.convertError(error);
    }
  }

  /**
   * Speech-to-Text (STT) - REAL IMPLEMENTATION
   * Transcribes audio using Gemini's audio understanding capability
   *
   * Note: Google Gemini does NOT have dedicated TTS - it uses generateContent with audio input
   * Uses REST API directly for file upload since SDK doesn't have fileManager
   */
  async speechToText(model: Model, request: AudioSTTRequest): Promise<AudioSTTResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug(
        { model: model.name, audioSize: request.audio.length },
        'Starting STT request via Gemini'
      );

      // Step 1: Upload audio file to Gemini Files API using REST API
      // The @google/generative-ai SDK doesn't have fileManager, so we use REST API directly
      const geminiApiKey = this.config.apiKey;
      const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${geminiApiKey}`;

      // Create FormData for multipart upload
      const formData = new FormData();
      const audioBlob = new Blob([new Uint8Array(request.audio)], { type: 'audio/mpeg' });
      formData.append('file', audioBlob, `stt-${Date.now()}.mp3`);
      formData.append(
        'metadata',
        JSON.stringify({
          display_name: `stt-${Date.now()}.mp3`,
        })
      );

      // Upload file using resumable upload protocol
      // First, initiate upload
      const initResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': request.audio.length.toString(),
          'X-Goog-Upload-Header-Content-Type': 'audio/mpeg',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file: {
            display_name: `stt-${Date.now()}.mp3`,
          },
        }),
      });

      if (!initResponse.ok) {
        throw new Error(`File upload initiation failed: ${initResponse.statusText}`);
      }

      const uploadUrlFromHeader = initResponse.headers.get('x-goog-upload-url');
      if (!uploadUrlFromHeader) {
        throw new Error('No upload URL received from Gemini API');
      }

      // Upload file content
      const uploadResponse = await fetch(uploadUrlFromHeader, {
        method: 'PUT',
        headers: {
          'Content-Length': request.audio.length.toString(),
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize',
          'Content-Type': 'audio/mpeg',
        },
        body: new Uint8Array(request.audio),
      });

      if (!uploadResponse.ok) {
        throw new Error(`File upload failed: ${uploadResponse.statusText}`);
      }

      const uploadResult = (await uploadResponse.json()) as {
        file?: { uri?: string };
        [key: string]: unknown;
      };
      const fileUri = uploadResult.file?.uri;

      if (!fileUri) {
        throw new Error('No file URI received from upload');
      }

      this.providerLog.debug({ fileUri }, 'Audio file uploaded to Gemini');

      // Step 2: Generate content with audio file. The SDK call is gone (we
      // hit the REST endpoint directly below since the SDK doesn't support
      // fileData on this generation path); leaving the construction call
      // commented out so the wiring is visible if/when SDK fileData lands.
      // const geminiModel = this.client.getGenerativeModel({ model: model.name });

      const prompt = request.options?.prompt
        ? `${request.options.prompt}\n\nGenerate a transcript of the speech.`
        : 'Generate a transcript of the speech.';

      // Use REST API directly since SDK doesn't support fileData properly
      const geminiApiKeyForGenerate = this.config.apiKey;
      const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent?key=${geminiApiKeyForGenerate}`;

      const generateResponse = await fetch(generateUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  fileData: {
                    mimeType: 'audio/mpeg',
                    fileUri: fileUri,
                  },
                },
                { text: prompt },
              ],
            },
          ],
        }),
      });

      if (!generateResponse.ok) {
        const errorBody = await generateResponse.json();
        throw new Error(
          `Gemini generateContent failed: ${generateResponse.statusText} - ${JSON.stringify(errorBody)}`
        );
      }

      const generateResult = (await generateResponse.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              [key: string]: unknown;
            }>;
            [key: string]: unknown;
          };
          [key: string]: unknown;
        }>;
        response?: unknown;
        [key: string]: unknown;
      };
      const result = {
        response: {
          text: () => generateResult.candidates?.[0]?.content?.parts?.[0]?.text || '',
        },
      };

      const transcription = result.response.text();
      const latency = Date.now() - startTime;

      this.providerLog.info(
        {
          model: model.name,
          latency,
          transcriptionLength: transcription.length,
        },
        'STT request completed via Gemini'
      );

      return {
        text: transcription,
        raw: {
          ...result.response,
          latency,
          fileUri,
        },
      };
    } catch (error: unknown) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.providerLog.error(
        {
          model: model.name,
          latency,
          error: errorMessage,
        },
        'STT request failed'
      );

      throw new Error(`Google Gemini STT failed: ${errorMessage}`);
    }
  }

  /**
   * Image Generation - REAL IMPLEMENTATION
   * Generates images using Google Imagen API
   * Supports both Imagen models (imagen-4.0-generate-001) and Gemini image models (gemini-2.5-flash-image)
   */
  async imageGenerate(model: Model, request: ImageGenRequest): Promise<ImageGenResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug(
        { model: model.name, promptLength: request.prompt.length, size: request.size },
        'Starting image generation request via Google Imagen'
      );

      const apiKey = this.config.apiKey;

      // Check if model is Imagen or Gemini image model
      const isImagenModel = model.name.includes('imagen');

      let imageBuffer: Buffer;
      let format = 'png';

      if (isImagenModel) {
        // Use Imagen API endpoint: /v1beta/models/{model}:predict
        const imagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:predict?key=${apiKey}`;

        const imagenResponse = await fetch(imagenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            instances: [
              {
                prompt: request.prompt,
              },
            ],
            parameters: {
              sampleCount: (request.options?.n as number) || 1,
              imageSize: request.size === '1024x1024' ? '1K' : '1K',
              aspectRatio: request.size?.includes('1024x1792')
                ? '9:16'
                : request.size?.includes('1792x1024')
                  ? '16:9'
                  : '1:1',
            },
          }),
        });

        if (!imagenResponse.ok) {
          const errorText = await imagenResponse.text();
          throw new Error(`Imagen API failed: ${imagenResponse.statusText} - ${errorText}`);
        }

        const imagenResult = (await imagenResponse.json()) as {
          generatedImages?: Array<{
            bytesBase64Encoded?: string;
            [key: string]: unknown;
          }>;
          [key: string]: unknown;
        };

        if (!imagenResult.generatedImages || imagenResult.generatedImages.length === 0) {
          throw new Error('No images generated by Imagen API');
        }

        // Take first image
        const firstImage = imagenResult.generatedImages[0];
        const imageData = firstImage?.image as
          { imageBytes?: string; [key: string]: unknown } | undefined;
        if (!imageData?.imageBytes) {
          throw new Error('Imagen API returned invalid image data');
        }
        imageBuffer = Buffer.from(imageData.imageBytes, 'base64');
      } else {
        // Use Gemini image model via generateContent with responseModalities: ["IMAGE"]
        // Models like gemini-2.5-flash-image support image generation.
        // SDK builder unused for now (REST path below) — kept commented for
        // visibility into the planned SDK migration:
        //   const geminiModel = this.client.getGenerativeModel({ model: model.name });

        // Use REST API directly for image generation since SDK doesn't support responseModalities
        const apiKey = this.config.apiKey;
        const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent?key=${apiKey}`;

        const generateResponse = await fetch(generateUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
            generationConfig: {
              // Note: responseModalities may not be supported in all models
              // For now, we'll try without it and handle the response
            },
          }),
        });

        if (!generateResponse.ok) {
          const errorBody = await generateResponse.json();
          throw new Error(
            `Gemini image generation failed: ${generateResponse.statusText} - ${JSON.stringify(errorBody)}`
          );
        }

        const generateResult = (await generateResponse.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                inlineData?: {
                  data?: string;
                  mimeType?: string;
                };
              }>;
            };
          }>;
          [key: string]: unknown;
        };
        const result = {
          response: generateResult,
        };

        const response = result.response;

        // Extract image from response parts
        let imageData: string | null = null;
        for (const candidate of response.candidates || []) {
          for (const part of candidate.content?.parts || []) {
            if (part.inlineData) {
              imageData = part.inlineData.data || null;
              format = part.inlineData.mimeType?.includes('jpeg') ? 'jpg' : 'png';
              break;
            }
          }
          if (imageData) break;
        }

        if (!imageData) {
          throw new Error('No image data in Gemini response');
        }

        imageBuffer = Buffer.from(imageData, 'base64');
      }

      const latency = Date.now() - startTime;

      this.providerLog.info(
        {
          model: model.name,
          latency,
          imageSize: imageBuffer.length,
          format,
        },
        'Image generation completed via Google'
      );

      return {
        image: imageBuffer,
        format,
        raw: {
          model: model.name,
          latency,
          isImagenModel,
        },
      };
    } catch (error: unknown) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.providerLog.error(
        {
          model: model.name,
          latency,
          error: errorMessage,
        },
        'Image generation failed'
      );

      throw new Error(`Google Imagen image generation failed: ${errorMessage}`);
    }
  }

  /**
   * Video Generation - REAL IMPLEMENTATION
   * Uses Google Gemini/Veo long-running prediction endpoint.
   */
  async videoGenerate(model: Model, request: VideoGenRequest): Promise<VideoGenResponse> {
    const startTime = Date.now();

    try {
      const normalizedModel = await this.normalizeModelName(model.name || model.id);
      const apiKey = this.config.apiKey;
      const operationUrl = `https://generativelanguage.googleapis.com/v1beta/models/${normalizedModel}:predictLongRunning?key=${apiKey}`;
      const options = request.options || {};

      const startImageInline = await this.resolveInlineMedia(
        request.startImage || request.image,
        'image/png'
      );
      const endImageInline = await this.resolveInlineMedia(request.endImage, 'image/png');
      const sourceVideoInline = await this.resolveInlineMedia(request.video, 'video/mp4');

      if (request.audio) {
        this.providerLog.warn(
          { model: normalizedModel },
          'Audio-conditioned video generation requested, but Google Veo adapter currently ignores audio input'
        );
      }

      const instance: Record<string, unknown> = {
        prompt: request.prompt,
      };
      if (startImageInline) {
        instance.image = startImageInline;
      }
      if (sourceVideoInline) {
        instance.video = sourceVideoInline;
      }

      const parameters: Record<string, unknown> = {};
      if (typeof request.aspectRatio === 'string' && request.aspectRatio.trim().length > 0) {
        parameters.aspectRatio = request.aspectRatio.trim();
      }
      if (endImageInline) {
        parameters.lastFrame = endImageInline;
      }
      if (typeof request.duration === 'number' && Number.isFinite(request.duration)) {
        // LOTE AS (2026-09-06) research pass: a blanket [1,120]s window
        // applied to every Veo variant alike. This is a DELIBERATE
        // documented fallback, not an oversight — the LOTE AS per-provider
        // research pass (byteplus/zai/venice/runwayml/siliconflow) did not
        // cover Google/Veo, and no real per-model Veo duration cap was found
        // in that research. Per the project's no-fabrication rule, this stays
        // a generic clamp until a future pass finds real per-variant caps in
        // Google's own docs — inventing per-model numbers here would be
        // worse than an honest generic ceiling.
        parameters.durationSeconds = Math.max(1, Math.min(120, Math.floor(request.duration)));
      }
      if ('n' in options && typeof options.n === 'number' && Number.isFinite(options.n)) {
        parameters.numberOfVideos = Math.max(1, Math.min(8, Math.floor(options.n)));
      }
      if ('resolution' in options && typeof options.resolution === 'string') {
        parameters.resolution = options.resolution;
      }
      if ('generateAudio' in options && typeof options.generateAudio === 'boolean') {
        parameters.generateAudio = options.generateAudio;
      }

      const requestBody: Record<string, unknown> = {
        instances: [instance],
      };
      if (Object.keys(parameters).length > 0) {
        requestBody.parameters = parameters;
      }

      const operationStart = await this.withRetry(async () => {
        const response = await fetch(operationUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(120_000),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Google video generation start failed (${response.status}): ${errorText.slice(0, 800)}`
          );
        }

        return (await response.json()) as Record<string, unknown>;
      }, 'video generation start');

      const operationNameRaw = operationStart.name;
      const operationName =
        typeof operationNameRaw === 'string' && operationNameRaw.trim().length > 0
          ? operationNameRaw.trim()
          : '';
      if (!operationName) {
        throw new Error('Google video generation did not return an operation name');
      }

      const completedOperation = await this.pollLongRunningOperation(operationName, apiKey);
      const operationError =
        completedOperation.error && typeof completedOperation.error === 'object'
          ? (completedOperation.error as Record<string, unknown>)
          : undefined;
      if (operationError) {
        const errorMessage =
          typeof operationError.message === 'string'
            ? operationError.message
            : JSON.stringify(operationError);
        throw new Error(`Google video generation failed: ${errorMessage}`);
      }

      const responsePayload =
        completedOperation.response && typeof completedOperation.response === 'object'
          ? (completedOperation.response as Record<string, unknown>)
          : {};
      const generateVideoResponse =
        responsePayload.generateVideoResponse &&
        typeof responsePayload.generateVideoResponse === 'object'
          ? (responsePayload.generateVideoResponse as Record<string, unknown>)
          : responsePayload;
      const generatedSamples = Array.isArray(generateVideoResponse.generatedSamples)
        ? (generateVideoResponse.generatedSamples as Array<Record<string, unknown>>)
        : [];

      const responseFormat =
        'response_format' in options && options.response_format === 'b64_json' ? 'b64_json' : 'url';

      const videos: Array<{ id?: string; url?: string; b64_json?: string }> = [];
      for (let index = 0; index < generatedSamples.length; index += 1) {
        const sample = generatedSamples[index];
        if (!sample || typeof sample !== 'object') continue;
        const videoField =
          sample.video && typeof sample.video === 'object'
            ? (sample.video as Record<string, unknown>)
            : {};
        const uri = typeof videoField.uri === 'string' ? videoField.uri : undefined;
        if (!uri) continue;

        if (responseFormat === 'b64_json') {
          try {
            const blobResponse = await fetch(uri, {
              method: 'GET',
              headers: {
                'x-goog-api-key': apiKey,
              },
              signal: AbortSignal.timeout(120_000),
            });
            if (!blobResponse.ok) {
              throw new Error(`Google media fetch failed (${blobResponse.status})`);
            }
            const data = Buffer.from(await blobResponse.arrayBuffer()).toString('base64');
            videos.push({ id: `video-${index + 1}`, b64_json: data });
          } catch {
            videos.push({ id: `video-${index + 1}`, url: uri });
          }
        } else {
          videos.push({ id: `video-${index + 1}`, url: uri });
        }
      }

      if (videos.length === 0) {
        throw new Error('Google video generation completed without generated video samples');
      }

      const durationMs = Date.now() - startTime;
      this.providerLog.info(
        {
          model: normalizedModel,
          durationMs,
          videosGenerated: videos.length,
        },
        'Google video generation completed'
      );

      return {
        video: videos,
        format: 'mp4',
        raw: completedOperation,
      };
    } catch (error: unknown) {
      this.providerLog.error(
        {
          model: model.name,
          durationMs: Date.now() - startTime,
          error: getErrorMessage(error),
        },
        'Google video generation failed'
      );

      throw this.convertError(error);
    }
  }

  async webSearch(
    model: Model,
    request: { query: string; maxResults?: number; options?: Record<string, unknown> }
  ): Promise<{ text: string; raw: unknown }> {
    const normalizedModel = await this.normalizeModelName(model.name || model.id);
    const apiKey = this.config.apiKey;
    const maxResults =
      typeof request.maxResults === 'number' ? Math.max(1, Math.floor(request.maxResults)) : 5;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${normalizedModel}:generateContent?key=${apiKey}`;

    const response = await this.withRetry(async () => {
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text:
                    'Use Google Search grounding to answer the query and return strict JSON: ' +
                    '{"answer":"string","results":[{"title":"string","url":"string","content":"string","score":0.0}],"images":["url"]}. ' +
                    `Limit to approximately ${maxResults} results. Query: ${request.query}`,
                },
              ],
            },
          ],
          tools: [{ googleSearch: {} }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1500,
          },
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!upstream.ok) {
        const errorBody = await upstream.text();
        const error = new Error(
          `Google web search failed (${upstream.status}): ${errorBody.slice(0, 800)}`
        ) as Error & { status?: number };
        error.status = upstream.status;
        throw error;
      }

      return upstream;
    }, 'google web search');

    const rawResponse = (await response.json()) as {
      candidates?: unknown;
      [key: string]: unknown;
    };

    const candidates = Array.isArray(rawResponse.candidates)
      ? (rawResponse.candidates as Array<Record<string, unknown>>)
      : [];
    const text = this.extractGoogleResponseText(candidates[0], undefined);
    const parsed = this.parseStructuredSearchOutput(text);

    return {
      text: parsed.answer || text,
      raw: {
        ...parsed,
        providerResponse: rawResponse,
      },
    };
  }

  /**
   * Content Moderation
   * Google Gemini does not have a dedicated moderation API
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
      this.providerLog.warn(
        { error: errorMessage },
        'Moderation analysis failed, returning safe defaults'
      );

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
        raw: { error: errorMessage, provider: 'google', note: 'Fallback moderation response' },
      };
    }
  }

  /**
   * Image Edit
   * Google Gemini/Imagen does not have image editing via API
   */
  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error(
      'Google Gemini image editing is not yet implemented. Google Imagen does not provide image editing via API. Use OpenAI DALL-E for image editing.'
    );
  }

  /**
   * Image Variation
   * Google Gemini/Imagen does not have image variation via API
   */
  async imageVariation(
    _model: Model,
    _request: ImageVariationRequest
  ): Promise<ImageVariationResponse> {
    throw new Error(
      'Google Gemini image variation is not yet implemented. Google Imagen does not provide image variation via API. Use OpenAI DALL-E for image variations.'
    );
  }

  /**
   * Sanitize request for logging
   */
  private sanitizeRequest(request: ChatRequest): {
    model: string;
    messageCount: number;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    toolCount: number;
  } {
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
