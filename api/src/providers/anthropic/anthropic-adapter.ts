// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Anthropic Provider Adapter
 * Production-ready implementation for Claude models
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderAdapter,
  type ProviderConfig,
  type HealthCheckResult,
} from '../base/provider-adapter';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  Tool,
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
import { logger } from '@/utils/logger';
import { getModelsByProvider } from '@/services/model-catalog-service';
import { resolveReasoningEffort } from '@/utils/reasoning-effort';
import { estimateContextSize } from '@/core/orchestration/context-size-estimator';

/**
 * Anthropic model definitions with accurate pricing (as of Nov 2024)
 */

/**
 * Anthropic Provider Adapter Implementation
 */
/**
 * Sampling parameters Anthropic may reject on a per-model basis.
 *
 * Newer Claude families deprecate `temperature` (and, on some models, `top_p`)
 * and answer with `400 invalid_request_error: \`temperature\` is deprecated for
 * this model.` The offending field is named verbatim in the message, so the
 * adapter can learn which parameter to drop from the vendor's own response
 * instead of carrying a hardcoded model list (see `learnUnsupportedSamplingParam`).
 */
const GATED_SAMPLING_PARAMS = ['temperature', 'top_p'] as const;
type GatedSamplingParam = (typeof GATED_SAMPLING_PARAMS)[number];

/**
 * Extended thinking (LOTE AZ follow-up, 2026-09): Anthropic's Messages API
 * hard-rejects a `budget_tokens` below this floor with a 400
 * (`invalid_request_error`), regardless of how the caller arrived at a
 * lower number (e.g. an explicit `thinking_budget` below 1,024, which
 * `resolveReasoningEffort()` otherwise honors verbatim).
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 */
const ANTHROPIC_MIN_THINKING_BUDGET_TOKENS = 1024;

/**
 * Headroom (in tokens) reserved for the actual answer when `max_tokens`
 * has to be raised to satisfy Anthropic's "`budget_tokens` must be
 * strictly less than `max_tokens`" constraint — both counters share the
 * same generation ceiling, so merely nudging `max_tokens` to
 * `budget_tokens + 1` would satisfy the API while leaving almost no room
 * for the visible answer.
 */
const ANTHROPIC_THINKING_ANSWER_HEADROOM_TOKENS = 1024;

/**
 * Anthropic's own documented minimum cacheable prompt length, in tokens, per
 * model family+version (LOTE AX, 2026-09).
 *
 * A `cache_control` block below the model's minimum is silently IGNORED by
 * the vendor — no error, the prompt is just processed uncached (verified
 * live against https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 * on 2026-09-06). Marking a too-short prefix cacheable is therefore harmless
 * but pure bloat in the request; this table lets the adapter skip the
 * marker below the real threshold instead of guessing a single number for
 * every model.
 *
 * Keys are `${family}-${version}` after `normalizeModelFamilyKey()` collapses
 * dots to dashes and strips the `anthropic`/`claude` prefix, e.g.
 * `claude-opus-4-8` -> `opus-4-8`, `claude-haiku-4.5` -> `haiku-4-5`.
 */
const MIN_CACHEABLE_TOKENS_BY_MODEL: Readonly<Record<string, number>> = {
  // 512 tokens
  'fable-5-1': 512,
  'mythos-5-1': 512,
  'opus-5': 512,
  'fable-5': 512,
  'mythos-5': 512,
  // 1,024 tokens
  'opus-4-8': 1024,
  'sonnet-5': 1024,
  'sonnet-4-6': 1024,
  'sonnet-4-5': 1024,
  'opus-4-1': 1024,
  'opus-4': 1024,
  'sonnet-4': 1024,
  // 2,048 tokens
  'mythos-preview': 2048,
  'opus-4-7': 2048,
  'haiku-3-5': 2048,
  // 4,096 tokens
  'opus-4-6': 4096,
  'opus-4-5': 4096,
  'haiku-4-5': 4096,
};

/**
 * Conservative fallback for a model id this table doesn't recognize (e.g. a
 * new release ahead of this table, or a pre-4.x Claude generation the current
 * docs page no longer lists). 1,024 is the most common threshold across
 * every currently-documented family, so it under-guesses (rather than
 * over-guesses) how much prefix a cache marker needs to be worth sending.
 */
const DEFAULT_MIN_CACHEABLE_TOKENS = 1024;

/** Matches the family name and its dash-joined version segments, e.g.
 * "claude-opus-4-8" -> ["opus", "4-8"], "claude-sonnet-5" -> ["sonnet", "5"],
 * "claude-mythos-preview" -> ["mythos", "preview"]. */
const MODEL_FAMILY_VERSION_RE = /(opus|sonnet|haiku|fable|mythos)-?(preview|\d+(?:-\d+)*)?/;

/** Normalizes a raw model id into the `${family}-${version}` key used by
 * `MIN_CACHEABLE_TOKENS_BY_MODEL`, e.g. "anthropic/claude-haiku-4.5" ->
 * "haiku-4-5", "claude-opus-4-8" -> "opus-4-8". */
function normalizeModelFamilyKey(modelId: string): string | null {
  const normalized = modelId
    .toLowerCase()
    .replace(/^anthropic[-/]/, '')
    .replace(/\./g, '-');
  const match = normalized.match(MODEL_FAMILY_VERSION_RE);
  if (!match) return null;
  const [, family, version] = match;
  return version ? `${family}-${version}` : family;
}

/**
 * The real, documented Anthropic minimum cacheable prompt length (in tokens)
 * for the given model id, falling back to `DEFAULT_MIN_CACHEABLE_TOKENS` for
 * an unrecognized model.
 */
function getMinimumCacheableTokens(modelId: string): number {
  const key = normalizeModelFamilyKey(modelId);
  if (key && key in MIN_CACHEABLE_TOKENS_BY_MODEL) {
    return MIN_CACHEABLE_TOKENS_BY_MODEL[key]!;
  }
  return DEFAULT_MIN_CACHEABLE_TOKENS;
}

/**
 * A `cache_control` marker as this adapter actually emits it. `ttl: '1h'`
 * requests Anthropic's extended 1-hour cache tier (no `anthropic-beta`
 * header required — this graduated out of beta; verified live against
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching and
 * https://platform.claude.com/docs/en/about-claude/pricing#prompt-caching
 * on 2026-09-08). Omitting `ttl` is the standard 5-minute tier.
 */
type EphemeralCacheControl = { type: 'ephemeral'; ttl?: '1h' };

/**
 * Extended-TTL kill-switch (mismatch fix, 2026-09; see
 * `session-affinity-service.ts`'s idle-TTL comment for the bug this closes).
 *
 * The 1-hour tier is NOT a free upgrade over the standard 5-minute one —
 * per Anthropic's own pricing page, a cache WRITE costs 2x the base input
 * price at the 1-hour tier vs 1.25x at 5 minutes, while a cache READ costs
 * the same 0.1x either way. Anthropic's own guidance: "caching pays off
 * after one cache read for the 5-minute duration ... or after two cache
 * reads for the 1-hour duration." Paying the 2x premium on a request that
 * never gets a second read is a pure loss vs. not caching at all.
 *
 * This adapter only ever requests `ttl: '1h'` once `hasConversationHistory()`
 * is already true (see the call sites in `chatCompletion`/
 * `chatCompletionStream`) — i.e. only for a request that has already
 * demonstrated it is turn 2+ of a real multi-turn exchange, where at least
 * one more read is all but guaranteed. Default ON reflects that this gate
 * already excludes the case where the premium would be a loss; the env var
 * remains a kill-switch for operators if real traffic proves otherwise.
 */
function isExtendedCacheTtlEnabled(): boolean {
  return process.env.ANTHROPIC_EXTENDED_CACHE_TTL_ENABLED !== 'false';
}

export class AnthropicAdapter extends ProviderAdapter {
  /**
   * Per-model set of sampling parameters Anthropic has rejected at runtime.
   *
   * WHY this exists: `temperature` is materialised with a schema default of 1 on
   * the public chat route, so it reaches this adapter on essentially every
   * request even when the caller never set it. A model that deprecates the field
   * therefore fails 100% of the time, and five consecutive failures open the
   * *provider-wide* `anthropic-api` circuit breaker — taking every Claude model
   * offline and silently rerouting Claude traffic to another vendor with
   * `degraded: false`. Learning the rejection and retrying without the field
   * keeps the failure invisible to the breaker.
   *
   * Static so the knowledge is shared across adapter instances (one per pooled
   * account) and survives re-registration within the process.
   */
  private static readonly unsupportedSamplingParams = new Map<string, Set<GatedSamplingParam>>();

  private client: Anthropic;
  // Scale-to-100k Phase 2 (issue #152): one SDK client per pooled account
  // (ANTHROPIC_API_KEY_POOL), or just [this.client] with none configured.
  // See the OpenAI adapter for the original reference implementation.
  private clientPool: Anthropic[];
  private providerLog = logger.child({ provider: 'anthropic' });

  constructor(config: ProviderConfig) {
    super('anthropic', 'Anthropic', config);
    this.validateConfig();

    const buildClient = (apiKey: string) =>
      new Anthropic({
        apiKey,
        baseURL: config.baseUrl,
        timeout: config.timeout || 60000,
        maxRetries: 0, // We handle retries ourselves
      });

    const pooledKeys = this.getAllApiKeys();
    this.clientPool =
      pooledKeys.length > 0 ? pooledKeys.map(buildClient) : [buildClient(config.apiKey)];
    this.client = this.clientPool[0]!;
  }

  /** Round-robins across clientPool when ANTHROPIC_API_KEY_POOL is configured. */
  private getRequestClient(): Anthropic {
    if (this.clientPool.length <= 1) return this.client;
    return this.clientPool[this.nextPoolIndex(this.clientPool.length)]!;
  }

  /**
   * Estimate the size (in tokens) of the system+tools prefix that would be
   * marked `cache_control:ephemeral` (LOTE AX, 2026-09). Reuses the repo's
   * shared `estimateContextSize` — restricted to just the system messages
   * and `tools`, since those are the only blocks this adapter marks
   * cacheable (see `convertMessages()`/`convertTools()`).
   */
  private estimateCacheablePrefixTokens(messages: ChatMessage[], tools?: Tool[]): number {
    const systemMessages = messages.filter((m) => m.role === 'system');
    return estimateContextSize({ messages: systemMessages, tools } as ChatRequest);
  }

  /**
   * True once this request already carries at least one prior `assistant`
   * turn — i.e. this is turn 2+ of a stateless multi-turn exchange, not a
   * fresh/first-turn call. Cheap, local, and available without any
   * cross-service plumbing into session-affinity-service.ts: by the time a
   * SECOND request for the same conversation reaches this adapter, turn 1
   * has already completed and is present in `messages`, which is exactly
   * the point past which a second (and third, and...) cache READ is likely
   * — the condition `isExtendedCacheTtlEnabled()`'s doc comment relies on.
   * See the `cacheControl` construction in `chatCompletion`/
   * `chatCompletionStream` for how this gates the 1-hour cache tier.
   */
  private hasConversationHistory(messages: ChatMessage[]): boolean {
    return messages.some((m) => m.role === 'assistant');
  }

  /**
   * Single source of truth for this request's `cache_control` marker —
   * combines the LOTE AX minimum-cacheable-size gate with the 1-hour-tier
   * gate above. Shared by `chatCompletion()` and `chatCompletionStream()`
   * so the two paths can never drift from each other.
   */
  private buildCacheControl(
    messages: ChatMessage[],
    tools: Tool[] | undefined,
    normalizedModel: string
  ): EphemeralCacheControl | false {
    const cacheEligible =
      this.estimateCacheablePrefixTokens(messages, tools) >=
      getMinimumCacheableTokens(normalizedModel);
    if (!cacheEligible) return false;

    const useExtendedTtl = isExtendedCacheTtlEnabled() && this.hasConversationHistory(messages);
    return useExtendedTtl ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
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
    return Math.ceil(promptChars / 4) + (request.max_tokens || 4096);
  }

  /**
   * Get provider information
   */
  async getProvider(): Promise<Provider> {
    const models = await this.getModels();
    const health = await this.healthCheck();

    return {
      id: 'anthropic',
      name: 'anthropic',
      displayName: 'Anthropic',
      status: health.healthy ? 'active' : 'disabled',
      health: {
        status: health.healthy ? 'healthy' : 'degraded',
        lastCheck: health.checkedAt,
        latency: health.latency,
        errorRate: health.healthy ? 0 : 1,
      },
      models,
    };
  }

  /**
   * Get available models
   */
  async getModels(): Promise<Model[]> {
    const models = await getModelsByProvider('anthropic');

    if (!models.length) {
      logger.warn('No models registered in catalog for Anthropic');
    }

    return models;
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
      throw new Error('No Anthropic models available - check provider configuration');
    }

    // Filter available models
    const availableModels = models.filter(
      (m) =>
        m.status === 'active' &&
        (m.capabilities?.includes('chat') || m.capabilities?.includes('text_generation'))
    );

    if (availableModels.length === 0) {
      throw new Error('No available Anthropic models with chat capability');
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
   * Sampling params already known to be rejected by this model.
   */
  private rejectedSamplingParams(modelId: string): ReadonlySet<GatedSamplingParam> {
    return AnthropicAdapter.unsupportedSamplingParams.get(modelId) ?? new Set();
  }

  /**
   * Inspect an Anthropic error and, if it names a gated sampling parameter as
   * unsupported/deprecated for the model, remember that pairing.
   *
   * Returns the parameter that was rejected, or `null` when the error is
   * something else (auth, rate limit, overload) that must propagate untouched.
   */
  private learnUnsupportedSamplingParam(
    modelId: string,
    error: unknown
  ): GatedSamplingParam | null {
    // Only 400-class invalid_request errors describe an unusable parameter.
    // Anything else (401/429/5xx) is a genuine failure the breaker should see.
    const status = (error as { status?: number } | null)?.status;
    if (status !== 400) return null;

    const message = this.extractErrorMessage(error).toLowerCase();
    // Vendor wording has varied ("is deprecated for this model",
    // "unsupported parameter", "not supported"), so match on the intent rather
    // than an exact sentence.
    const indicatesUnusableParam =
      message.includes('deprecated') ||
      message.includes('unsupported') ||
      message.includes('not supported') ||
      message.includes('incompatible');
    if (!indicatesUnusableParam) return null;

    const offender = GATED_SAMPLING_PARAMS.find((p) => message.includes(p));
    if (!offender) return null;

    const existing = AnthropicAdapter.unsupportedSamplingParams.get(modelId);
    if (existing) existing.add(offender);
    else AnthropicAdapter.unsupportedSamplingParams.set(modelId, new Set([offender]));

    this.providerLog.warn(
      { model: modelId, parameter: offender },
      'Anthropic rejected a sampling parameter for this model; dropping it and retrying. ' +
        'Subsequent requests for this model will omit it.'
    );
    return offender;
  }

  /**
   * Best-effort extraction of the human-readable message from an Anthropic SDK
   * error, whose shape varies between SDK versions and raw HTTP failures.
   */
  private extractErrorMessage(error: unknown): string {
    if (!error) return '';
    if (typeof error === 'string') return error;
    const e = error as { message?: unknown; error?: { message?: unknown; error?: { message?: unknown } } };
    const candidates = [e.message, e.error?.message, e.error?.error?.message];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  /**
   * Issue a `messages.create` call, transparently retrying once without a
   * sampling parameter the model turns out to reject.
   *
   * The retry happens *inside* the caller's `withRetry` callback so a recoverable
   * parameter mismatch never counts as a provider failure, and therefore never
   * contributes to opening the shared `anthropic-api` circuit breaker.
   */
  private async createMessageWithParamFallback<T>(
    modelId: string,
    buildParams: (omit: ReadonlySet<GatedSamplingParam>) => Anthropic.MessageCreateParams,
    requestOptions?: { signal?: AbortSignal }
  ): Promise<T> {
    const known = this.rejectedSamplingParams(modelId);
    const client = this.getRequestClient();
    try {
      return (await client.messages.create(buildParams(known), requestOptions)) as T;
    } catch (error: unknown) {
      const offender = this.learnUnsupportedSamplingParam(modelId, error);
      if (!offender) throw error;
      const retryOmit = new Set(known);
      retryOmit.add(offender);
      return (await client.messages.create(buildParams(retryOmit), requestOptions)) as T;
    }
  }

  /**
   * Whether `modelId` belongs to a Claude generation that supports the
   * Messages API's native extended-thinking field
   * (`thinking: {type: 'enabled', budget_tokens}`).
   *
   * Real vendor constraint, not a repo-wide heuristic: extended thinking
   * shipped with Claude 3.7 Sonnet and carries through the entire Claude
   * 4.x+ generation; Claude 3.5 and earlier reject the `thinking` field
   * outright with a 400.
   *
   * Deliberately does NOT reuse the existing `scoreModelFreshness`
   * generation parser (`@/core/experiment/model-freshness`), even though it
   * covers the same "extract this Claude's version number" ground: it was
   * built for same-family freshness RANKING, and its
   * `(?:opus|sonnet|haiku|instant)-(\d+)(?!\d)` bare-major fallback
   * mis-parses the date-suffixed id shape Anthropic actually issues for the
   * whole 3.x line (`claude-3-5-sonnet-20241022`, `claude-3-opus-
   * 20240229`) — the 8-digit release date right after the family word gets
   * read as the version itself (score 20241022), which would make Claude
   * 3.5 look newer than 4.x and wrongly qualify it here. Anthropic's real
   * version tokens are always 1-2 digits, so this parser requires that
   * explicitly instead — still fully dynamic (structural id parsing, zero
   * hardcoded model ids), just narrower than the freshness scorer's regex.
   */
  private supportsExtendedThinking(modelId: string): boolean {
    // Fold both id shapes onto one: version digits are always adjacent to
    // each other, 1-2 digits apiece, regardless of whether the family word
    // (opus/sonnet/haiku) precedes them (Claude 4.x+: "claude-opus-4-1")
    // or follows them (Claude 3.x: "claude-3-5-sonnet-20241022") — and a
    // release date or build tag never sits between the two version tokens.
    // Dots are folded to dashes first (`claude-haiku-4.5` -> `claude-
    // haiku-4-5`) since Anthropic uses both separators across ids.
    const normalized = modelId.toLowerCase().replace(/^anthropic[-/]/, '').replace(/\./g, '-');

    const majorMinor = normalized.match(/(?:^|-)(\d{1,2})-(\d{1,2})(?:-|$)/);
    if (majorMinor) {
      const major = Number(majorMinor[1]);
      const minor = Number(majorMinor[2]);
      if (major >= 4) return true;
      return major === 3 && minor >= 7;
    }

    // No minor version at all (e.g. "claude-3-opus-20240229", a bare
    // "claude-4-sonnet") — a single short digit group standing alone.
    const bareMajor = normalized.match(/(?:^|-)(\d{1,2})(?:-|$)/);
    if (!bareMajor) return false;
    return Number(bareMajor[1]) >= 4;
  }

  /**
   * Resolve the effective `max_tokens` and extended-thinking config for a
   * request, per the canonical `resolveReasoningEffort()` (LOTE AZ,
   * `@/utils/reasoning-effort`) reconciling `reasoning_effort` /
   * `thinking_budget` / `ailin_constraints.enable_reasoning` into one
   * budget — applying Anthropic's real Messages API constraints on top:
   *
   *   - `thinking` is attached ONLY when the resolved model actually
   *     supports it (see `supportsExtendedThinking`); every other model
   *     keeps behaving exactly as before this change (temperature/top_p
   *     flow through unchanged).
   *   - `budget_tokens` has a hard floor of 1,024 — an explicit
   *     `thinking_budget` below that (which the resolver otherwise honors
   *     verbatim) would reach the API and 400.
   *   - `budget_tokens` MUST be strictly less than `max_tokens`.
   *     `max_tokens` is raised to make room — never the caller's own
   *     value lowered — and only when it isn't already comfortably above
   *     the budget, leaving real headroom for the visible answer rather
   *     than clipping it to the bare minimum that satisfies the API.
   */
  private resolveThinkingConfig(
    request: ChatRequest,
    normalizedModel: string
  ): { thinking?: Anthropic.ThinkingConfigParam; maxTokens: number } {
    const requestedMaxTokens = request.max_tokens || 4096;
    const { thinkingBudget } = resolveReasoningEffort(request);

    if (thinkingBudget === undefined || !this.supportsExtendedThinking(normalizedModel)) {
      return { maxTokens: requestedMaxTokens };
    }

    const budgetTokens = Math.max(thinkingBudget, ANTHROPIC_MIN_THINKING_BUDGET_TOKENS);
    const maxTokens =
      budgetTokens >= requestedMaxTokens
        ? budgetTokens + ANTHROPIC_THINKING_ANSWER_HEADROOM_TOKENS
        : requestedMaxTokens;

    return { thinking: { type: 'enabled', budget_tokens: budgetTokens }, maxTokens };
  }

  /**
   * Chat completion (non-streaming)
   */
  async chatCompletion(
    request: ChatRequest,
    options?: { signal?: AbortSignal }
  ): Promise<ChatResponse> {
    const startTime = Date.now();

    try {
      this.providerLog.debug(
        { request: this.sanitizeRequest(request) },
        'Sending chat completion request'
      );

      const modelToUse = request.model || (await this.getDefaultModel());
      if (!modelToUse) {
        throw new Error('Model is required for chat completion');
      }
      const normalizedModel = await this.normalizeModelName(modelToUse);
      // LOTE AX, 2026-09: gate cache_control on this model's real documented
      // minimum cacheable prefix length (see MIN_CACHEABLE_TOKENS_BY_MODEL);
      // mismatch fix, 2026-09: also picks the 1-hour vs 5-minute TTL (see
      // `buildCacheControl()`/`isExtendedCacheTtlEnabled()`).
      const cacheControl = this.buildCacheControl(request.messages, request.tools, normalizedModel);
      const { system, messages } = this.convertMessages(
        request.messages,
        normalizedModel,
        cacheControl
      );
      const { thinking, maxTokens } = this.resolveThinkingConfig(request, normalizedModel);

      const buildParams = (omit: ReadonlySet<GatedSamplingParam>): Anthropic.MessageCreateParams => {
        const params: Anthropic.MessageCreateParams = {
          model: normalizedModel,
          max_tokens: maxTokens,
          system,
          messages,
          stream: false,
        };
        if (thinking) {
          // Extended thinking (LOTE AZ follow-up): Anthropic rejects
          // `temperature`/`top_p` outright once `thinking` is set — omit
          // both rather than let the vendor 400 (see resolveThinkingConfig).
          params.thinking = thinking;
        } else {
          // Omit rather than send `undefined`: models that deprecate a sampling
          // parameter reject its mere presence.
          if (!omit.has('temperature') && typeof request.temperature === 'number') {
            params.temperature = request.temperature;
          }
          if (!omit.has('top_p') && typeof request.top_p === 'number') {
            params.top_p = request.top_p;
          }
        }
        // Add tools if provided (Anthropic SDK supports tools in MessageCreateParams)
        if (request.tools && request.tools.length > 0) {
          params.tools = this.convertTools(request.tools, cacheControl);
          const toolChoice = this.convertToolChoice(request.tool_choice);
          if (toolChoice) {
            params.tool_choice = toolChoice;
          }
        }
        return params;
      };

      const response = await this.withRetry(
        async () =>
          this.createMessageWithParamFallback<Anthropic.Message>(normalizedModel, buildParams, {
            signal: options?.signal,
          }),
        'chat completion',
        this.estimateTokenCost(request),
        options?.signal
      );

      const duration = Date.now() - startTime;

      this.providerLog.debug(
        {
          model: response.model,
          usage: response.usage,
          duration,
          stopReason: response.stop_reason,
        },
        'Chat completion successful'
      );

      return this.convertResponse(response, modelToUse);
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      this.providerLog.error(
        {
          error: this.sanitizeError(error),
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
      const normalizedModel = await this.normalizeModelName(modelToUse);
      // LOTE AX, 2026-09: gate cache_control on this model's real documented
      // minimum cacheable prefix length (see MIN_CACHEABLE_TOKENS_BY_MODEL);
      // mismatch fix, 2026-09: also picks the 1-hour vs 5-minute TTL (see
      // `buildCacheControl()`/`isExtendedCacheTtlEnabled()`).
      const cacheControl = this.buildCacheControl(request.messages, request.tools, normalizedModel);
      const { system, messages } = this.convertMessages(
        request.messages,
        normalizedModel,
        cacheControl
      );
      const { thinking, maxTokens } = this.resolveThinkingConfig(request, normalizedModel);

      const buildParams = (omit: ReadonlySet<GatedSamplingParam>): Anthropic.MessageCreateParams => {
        const params: Anthropic.MessageCreateParams = {
          model: normalizedModel,
          max_tokens: maxTokens,
          system,
          messages,
          stream: true,
        };
        if (thinking) {
          // Extended thinking (LOTE AZ follow-up): Anthropic rejects
          // `temperature`/`top_p` outright once `thinking` is set — omit
          // both rather than let the vendor 400 (see resolveThinkingConfig).
          params.thinking = thinking;
        } else {
          // Omit rather than send `undefined`: models that deprecate a sampling
          // parameter reject its mere presence.
          if (!omit.has('temperature') && typeof request.temperature === 'number') {
            params.temperature = request.temperature;
          }
          if (!omit.has('top_p') && typeof request.top_p === 'number') {
            params.top_p = request.top_p;
          }
        }
        // Add tools if provided (Anthropic SDK supports tools in MessageCreateParams)
        if (request.tools && request.tools.length > 0) {
          params.tools = this.convertTools(request.tools, cacheControl);
          const toolChoice = this.convertToolChoice(request.tool_choice);
          if (toolChoice) {
            params.tool_choice = toolChoice;
          }
        }
        return params;
      };

      const stream = await this.withRetry(
        async () =>
          this.createMessageWithParamFallback<
            AsyncIterable<Anthropic.RawMessageStreamEvent>
          >(normalizedModel, buildParams),
        'streaming chat completion',
        this.estimateTokenCost(request)
      );

      let firstChunk = true;

      // Anthropic's streaming wire protocol announces a tool_use block's
      // `id`/`name` once, in `content_block_start`, then streams its
      // arguments incrementally as `input_json_delta.partial_json` chunks
      // keyed by that block's `index` — there is no repeated id/name on
      // continuation chunks. That `index` is Anthropic's own content-block
      // position (text blocks share the same counter), so it is NOT
      // suitable as the OpenAI-style `ToolCall.index` a client uses to key
      // concurrent tool-call accumulation. We remap it here to a dense,
      // zero-based sequence covering only tool_use blocks, and remember
      // each block's id/name so every continuation chunk can carry them
      // forward — mirroring the OpenAI-compatible incremental tool_calls
      // contract that every client already parses.
      const toolCallByBlockIndex = new Map<number, { toolCallIndex: number; id: string; name: string }>();
      let nextToolCallIndex = 0;

      // Extended thinking (LOTE AZ follow-up): a `thinking` content block
      // has no counterpart in the shared `ChatResponse.delta` shape, so it
      // is surfaced as synthetic `<think>...</think>` text wrapped around
      // its `thinking_delta` fragments — the SAME convention DeepSeek-R1
      // and QwQ's own native inline tags already use, which the shared
      // reasoning-extraction pipeline (see `base-strategy.ts`'s
      // `extractReasoning` and `convertResponse` below) already parses.
      // Track which block indices are `thinking` blocks purely to know
      // when `content_block_stop` should close that synthetic tag.
      const thinkingBlockIndices = new Set<number>();

      for await (const event of stream) {
        if (firstChunk) {
          const duration = Date.now() - startTime;
          this.providerLog.debug({ duration }, 'First chunk received');
          firstChunk = false;
        }

        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            const toolCallIndex = nextToolCallIndex++;
            toolCallByBlockIndex.set(event.index, {
              toolCallIndex,
              id: block.id,
              name: block.name,
            });
            yield this.buildStreamChunk(modelToUse, {
              tool_calls: [
                {
                  id: block.id,
                  type: 'function',
                  function: { name: block.name, arguments: '' },
                  index: toolCallIndex,
                },
              ],
            });
          } else if (block.type === 'thinking') {
            thinkingBlockIndices.add(event.index);
            yield this.buildStreamChunk(modelToUse, { content: '<think>' });
          }
          // `redacted_thinking` blocks carry only opaque encrypted `data`
          // (no `thinking_delta` follows) — nothing to surface, and since
          // its index is never added to `thinkingBlockIndices` the
          // `content_block_stop` handler below correctly emits no closing
          // tag for it either.
          continue;
        }

        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield this.convertStreamChunk(event, modelToUse);
          } else if (event.delta.type === 'thinking_delta') {
            yield this.buildStreamChunk(modelToUse, { content: event.delta.thinking });
          } else if (event.delta.type === 'input_json_delta') {
            const tracked = toolCallByBlockIndex.get(event.index);
            if (tracked) {
              yield this.buildStreamChunk(modelToUse, {
                tool_calls: [
                  {
                    id: tracked.id,
                    type: 'function',
                    // Forward the raw fragment (not an accumulated total) so
                    // a caller doing the standard OpenAI-client-style
                    // `arguments += delta` reconstruction gets the right result.
                    function: { name: tracked.name, arguments: event.delta.partial_json },
                    index: tracked.toolCallIndex,
                  },
                ],
              });
            }
          }
          // `signature_delta` carries only the thinking block's opaque
          // verification signature — no visible content to forward.
          continue;
        }

        if (event.type === 'content_block_stop') {
          if (thinkingBlockIndices.has(event.index)) {
            yield this.buildStreamChunk(modelToUse, { content: '</think>\n\n' });
          }
          continue;
        }

        if (event.type === 'message_delta' && event.delta.stop_reason) {
          yield this.buildStreamChunk(modelToUse, {}, this.mapStopReason(event.delta.stop_reason));
        }
      }

      const totalDuration = Date.now() - startTime;
      this.providerLog.debug({ duration: totalDuration }, 'Streaming completed');
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      this.providerLog.error(
        {
          error: this.sanitizeError(error),
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
   * Note: Anthropic doesn't support embeddings natively
   */
  async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error('Anthropic does not support embeddings. Use OpenAI or Google for embeddings.');
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      // Simple health check using a minimal request
      await this.client.messages.create({
        model: await this.getDefaultModel(), // Use dynamic default model
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      });

      const latency = Date.now() - startTime;

      this.providerLog.debug({ latency }, 'Health check passed');

      return {
        healthy: true,
        latency,
        checkedAt: new Date(),
      };
    } catch (error: unknown) {
      const latency = Date.now() - startTime;

      this.providerLog.error(
        {
          error: this.sanitizeError(error),
          latency,
        },
        'Health check failed'
      );

      return {
        healthy: false,
        latency,
        error: this.sanitizeError(error),
        checkedAt: new Date(),
      };
    }
  }

  /**
   * Calculate cost
   */
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
      return modelMap.get(modelId.toLowerCase())!.replace(/^anthropic[-_]/, '');
    }

    // Try fuzzy match (remove dashes, underscores, dots)
    const normalized = modelId.toLowerCase().replace(/[-_.]/g, '');
    for (const [key, value] of modelMap.entries()) {
      if (key.replace(/[-_.]/g, '') === normalized) {
        return value.replace(/^anthropic[-_]/, '');
      }
    }

    // Try partial match (e.g., "claude3" matches "claude-3-5-sonnet")
    // Prefer longer/more specific matches (e.g., "sonnet" should match "claude-3-5-sonnet" over "claude-3-sonnet")
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
      return partialMatches[0].value.replace(/^anthropic[-_]/, '');
    }

    // Return as-is if no match (let provider handle it or fail gracefully)
    logger.warn(
      { modelId, availableModels: Array.from(modelMap.keys()) },
      'Model not found in available models'
    );
    return modelId;
  }

  /**
   * Parse a base64 data URL (`data:image/<type>;base64,<data>`) into an
   * Anthropic image content block. Shared by the `image_url` and (LOTE AT)
   * `video_frame` content-part branches of `convertMessages` — both carry
   * the same `{ url, detail? }` shape.
   */
  private dataUrlToAnthropicImageBlock(url: string): {
    type: 'image';
    source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string };
  } {
    const match = url.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
      // If it's a URL, we need to fetch it (Anthropic requires base64)
      throw new Error('Image URLs must be base64 encoded for Anthropic');
    }
    const imageType = match[1].toLowerCase();
    let mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    if (imageType === 'png') {
      mediaType = 'image/png';
    } else if (imageType === 'jpeg' || imageType === 'jpg') {
      mediaType = 'image/jpeg';
    } else if (imageType === 'gif') {
      mediaType = 'image/gif';
    } else if (imageType === 'webp') {
      mediaType = 'image/webp';
    } else {
      // Default to jpeg for unknown types
      mediaType = 'image/jpeg';
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: match[2] },
    };
  }

  /**
   * Convert our messages to Anthropic format
   */
  private convertMessages(
    messages: ChatMessage[],
    model: string,
    cacheControl: EphemeralCacheControl | false = false
  ): {
    system?: Anthropic.MessageCreateParams['system'];
    messages: Anthropic.MessageParam[];
  } {
    // Extract system messages (Anthropic takes a single top-level `system`
    // block, which can itself be an ARRAY of content blocks). Multiple
    // system messages are concatenated IN ORDER with a blank-line separator
    // — mirroring `normalizeSystemMessages` — so none is silently dropped
    // (audit finding F-02).
    //
    // LOTE AZ, 2026-09 (cache-invalidation fix): the stable, originally-
    // authored system messages are split into their OWN content block from
    // any synthetic compaction-summary message(s) `context-compaction-
    // service.ts` appends once a long conversation crosses the compaction
    // threshold (flagged via `ChatMessage.isCompactionSummary` — see that
    // file's `compact()`). Before this split, EVERY system-role message —
    // original prompt AND freshly-regenerated summary alike — was flattened
    // into one indivisible text block carrying `cache_control`. Anthropic
    // caches (and invalidates) a `cache_control` block as one atomic unit,
    // so appending the summary's turn-to-turn-changing bytes to that same
    // block invalidated the ENTIRE cached prefix on every request from the
    // moment compaction first triggered — precisely the long, expensive
    // conversations where caching matters most.
    //
    // The summary block is deliberately left WITHOUT its own `cache_control`
    // rather than given a second breakpoint: `compact()` recomputes it from
    // scratch (a fresh LLM summarization call over a growing `head`) on
    // every request where compaction re-triggers, so its text is not stable
    // turn-to-turn the way the original system prompt is — a second
    // breakpoint on ever-changing content would just spend one of
    // Anthropic's small per-request breakpoint budget for no hit rate.
    const systemMessages = messages.filter((m) => m.role === 'system');
    const stableSystemParts = systemMessages
      .filter((m) => !m.isCompactionSummary)
      .map((m) => this.normalizeSystemContent(m.content))
      .filter((text): text is string => Boolean(text));
    const summarySystemParts = systemMessages
      .filter((m) => m.isCompactionSummary)
      .map((m) => this.normalizeSystemContent(m.content))
      .filter((text): text is string => Boolean(text));
    // Prompt caching (LOTE AW, 2026-09): `system` must be a content-BLOCK
    // array, not a bare string, to carry `cache_control` — a plain string
    // structurally cannot. This only pays off once session affinity (see
    // orchestration-engine.ts's buildContext()) keeps a conversation pinned
    // to the same model turn-to-turn — Anthropic's cache lineage is keyed to
    // an identical prefix served to the SAME model, so without a stable pin
    // this marker alone accomplishes nothing (every turn would start a fresh
    // cache regardless). No `anthropic-beta` header is required for
    // `cache_control` itself.
    //
    // LOTE AX, 2026-09: the stable block's marker is only added when
    // `cacheControl` is truthy — the caller has already checked the
    // system+tools prefix against this model's real documented minimum
    // cacheable length (`getMinimumCacheableTokens`/
    // `estimateCacheablePrefixTokens`). Below that minimum Anthropic ignores
    // the marker anyway, so omitting it here avoids sending a pointless
    // block. The summary block never gets a marker regardless of
    // `cacheControl` — see the LOTE AZ comment above. `cacheControl` may
    // additionally carry `ttl: '1h'` — see `buildCacheControl()` and
    // `isExtendedCacheTtlEnabled()`'s doc comment for when/why.
    const systemBlocks: Array<{
      type: 'text';
      text: string;
      cache_control?: EphemeralCacheControl;
    }> = [];
    if (stableSystemParts.length > 0) {
      systemBlocks.push({
        type: 'text',
        text: stableSystemParts.join('\n\n'),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      });
    }
    if (summarySystemParts.length > 0) {
      systemBlocks.push({
        type: 'text',
        text: summarySystemParts.join('\n\n'),
        // Deliberately uncached — see comment above.
      });
    }
    const system: Anthropic.MessageCreateParams['system'] =
      systemBlocks.length > 0 ? systemBlocks : undefined;
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    const requiresStructuredContent = this.requiresStructuredContent(model);

    const anthropicMessages: Anthropic.MessageParam[] = conversationMessages.map((msg) => {
      // Handle array content (multimodal)
      if (Array.isArray(msg.content)) {
        return {
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content.map((item) => {
            if (item.type === 'text') {
              return { type: 'text', text: item.text };
            } else if (item.type === 'image_url') {
              return this.dataUrlToAnthropicImageBlock(item.image_url.url);
            } else if (item.type === 'video_frame') {
              // LOTE AT — additive content part (sampled video frame). Same
              // base64-data-URL shape as `image_url`; Anthropic has no
              // frame/timestamp concept, so it goes in as a plain image.
              return this.dataUrlToAnthropicImageBlock(item.image_url.url);
            } else if (item.type === 'audio_transcript') {
              // LOTE AT — additive content part. No audio-native block in
              // the Anthropic Messages API; the transcript IS text.
              return { type: 'text', text: item.text };
            }
            return item;
          }),
        };
      }

      // Handle string content
      const textContent = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');

      return {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: requiresStructuredContent
          ? [
              {
                type: 'text',
                text: textContent,
              },
            ]
          : textContent,
      };
    });

    return {
      system,
      messages: anthropicMessages,
    };
  }

  private normalizeSystemContent(content: ChatMessage['content'] | undefined): string | undefined {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }
          if (item && typeof item === 'object' && 'type' in item && item.type === 'text') {
            const textItem = item as { type: 'text'; text?: string };
            return textItem.text ?? '';
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }

    return undefined;
  }

  private requiresStructuredContent(model: string): boolean {
    const normalized = model.toLowerCase();
    const structuredModels = [
      'claude-3-5',
      'claude-3.5',
      'claude-3-sonnet',
      'claude-3-opus',
      'claude-3-haiku',
    ];

    return structuredModels.some((name) => normalized.includes(name));
  }

  /**
   * Convert tools to Anthropic format.
   *
   * Prompt caching (LOTE AW, 2026-09): Anthropic's cache-breakpoint
   * semantics cache everything UP TO a marked block, in the fixed
   * tools -> system -> messages order — so only the LAST tool definition
   * needs `cache_control`; marking every tool would be redundant, not more
   * effective. See `convertMessages()`'s doc comment for why this only pays
   * off once session affinity keeps a conversation pinned to one model.
   *
   * LOTE AX, 2026-09: `cacheControl` gates the marker the same way
   * `convertMessages()` gates the system block — the caller has already
   * checked the system+tools prefix against this model's real documented
   * minimum cacheable length, and may additionally set `ttl: '1h'` (see
   * `buildCacheControl()`).
   */
  private convertTools(
    tools: Tool[],
    cacheControl: EphemeralCacheControl | false = false
  ): Anthropic.ToolUnion[] {
    return tools.map((tool, index) => {
      if (tool.type !== 'function' || !tool.function) {
        throw new Error('Invalid tool format: expected function tool');
      }
      const block: Anthropic.Tool = {
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters as Anthropic.Tool.InputSchema,
      };
      if (cacheControl && index === tools.length - 1) {
        block.cache_control = cacheControl;
      }
      return block;
    });
  }

  /**
   * Map the canonical OpenAI-shaped `tool_choice` onto the Messages API's own
   * `tool_choice` field. Anthropic's four modes — verbatim from
   * https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forcing-tool-use —
   * are `{type:'auto'}` (model decides, the default when tools are present),
   * `{type:'any'}` (must call SOME tool), `{type:'tool', name}` (must call
   * THIS tool), and `{type:'none'}` (must not call any tool).
   *
   * The load-bearing mapping decision: OpenAI's `'required'` is NOT the same
   * as Anthropic's `'auto'` — it means "call a tool, don't just answer in
   * prose", which is Anthropic's `'any'`. Silently mapping it to `'auto'`
   * would reproduce the exact silent-downgrade bug this fix closes, just one
   * level deeper. `ChatRequest['tool_choice']` doesn't carry a `'required'`
   * literal in its type today, but a real OpenAI-compatible caller (an
   * agentic coding tool, for instance) can still send the string at runtime
   * — handled defensively here rather than only through the type.
   *
   * Only called when `tools` is non-empty (see the two `buildParams`
   * closures above): Anthropic rejects `tool_choice` outright when no tools
   * are provided, so there is nothing to gate here — the caller already did.
   */
  private convertToolChoice(
    toolChoice: ChatRequest['tool_choice'] | 'required'
  ): Anthropic.MessageCreateParams['tool_choice'] | undefined {
    if (toolChoice === undefined) return undefined;
    if (toolChoice === 'none') return { type: 'none' };
    if (toolChoice === 'auto') return { type: 'auto' };
    if (toolChoice === 'required') return { type: 'any' };
    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      return { type: 'tool', name: toolChoice.function.name };
    }
    return undefined;
  }

  /**
   * Convert Anthropic response to our format
   */
  private convertResponse(response: Anthropic.Message, requestedModel: string): ChatResponse {
    // Type guards for content blocks
    function isTextBlock(block: unknown): block is Anthropic.TextBlock {
      return (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        (block as { type: unknown }).type === 'text' &&
        'text' in block &&
        typeof (block as { text: unknown }).text === 'string'
      );
    }

    // Type guard for tool use blocks
    // Anthropic SDK doesn't export ToolUseBlock, so we use a custom type guard
    type ToolUseBlockType = {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

    function isToolUseBlock(block: unknown): block is ToolUseBlockType {
      return (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        typeof (block as { type: unknown }).type === 'string' &&
        (block as { type: string }).type === 'tool_use' &&
        'id' in block &&
        typeof (block as { id: unknown }).id === 'string' &&
        'name' in block &&
        typeof (block as { name: unknown }).name === 'string' &&
        'input' in block &&
        typeof (block as { input: unknown }).input === 'object' &&
        (block as { input: unknown }).input !== null
      );
    }

    // Type guard for extended-thinking blocks (LOTE AZ follow-up).
    function isThinkingBlock(block: unknown): block is Anthropic.ThinkingBlock {
      return (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        (block as { type: unknown }).type === 'thinking' &&
        'thinking' in block &&
        typeof (block as { thinking: unknown }).thinking === 'string'
      );
    }

    // Extract text content
    const textContent = response.content.find(isTextBlock);
    // Extended thinking (LOTE AZ follow-up): surface Claude's own thinking
    // block the same way DeepSeek-R1/QwQ's native inline `<think>` tags
    // already flow through this pipeline (see `base-strategy.ts`'s
    // `extractReasoning`), so existing reasoning-capture logic works
    // unchanged regardless of which vendor produced the reasoning. A
    // `redacted_thinking` block (opaque encrypted content) is deliberately
    // NOT matched here — there is no real text to surface for it.
    const thinkingBlock = response.content.find(isThinkingBlock);
    const answerText = textContent?.text || '';
    const content = thinkingBlock ? `<think>${thinkingBlock.thinking}</think>\n\n${answerText}` : answerText;

    // Extract tool uses with type guard
    const toolUses: Array<{
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];
    for (const block of response.content) {
      if (isToolUseBlock(block)) {
        // Type guard ensures block is ToolUseBlockType, so we can safely access properties
        const toolUseBlock = block as ToolUseBlockType;
        toolUses.push({
          type: 'tool_use',
          id: toolUseBlock.id,
          name: toolUseBlock.name,
          input: toolUseBlock.input,
        });
      }
    }

    return {
      id: response.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            tool_calls:
              toolUses.length > 0
                ? toolUses.map(
                    (tu, index) =>
                      ({
                        id: tu.id,
                        type: 'function' as const,
                        function: {
                          name: tu.name,
                          arguments: JSON.stringify(tu.input),
                        },
                        index,
                      }) satisfies ToolCall
                  )
                : undefined,
          },
          finish_reason: response.stop_reason ? this.mapStopReason(response.stop_reason) : null,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  /**
   * Convert streaming chunk to our format
   */
  private convertStreamChunk(
    event: Anthropic.ContentBlockDeltaEvent & { delta?: { text?: string } },
    requestedModel: string
  ): ChatResponse {
    return this.buildStreamChunk(requestedModel, { content: event.delta.text });
  }

  /**
   * Build an OpenAI-compatible `chat.completion.chunk` from a partial delta
   * (text, tool_calls, or both) and an optional terminal `finish_reason`.
   * Shared by the text and tool-call branches of the streaming loop so every
   * chunk this adapter emits has the same shape a client already expects.
   */
  private buildStreamChunk(
    requestedModel: string,
    delta: Partial<ChatMessage>,
    finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null = null
  ): ChatResponse {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
          logprobs: null,
        },
      ],
    };
  }

  /**
   * Map Anthropic stop reason to OpenAI format
   */
  private mapStopReason(
    stopReason: string | null
  ): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
    if (!stopReason) {
      return null;
    }
    const mapping: Record<string, 'stop' | 'length' | 'tool_calls'> = {
      end_turn: 'stop',
      max_tokens: 'length',
      stop_sequence: 'stop',
      tool_use: 'tool_calls',
    };
    return mapping[stopReason] || 'stop';
  }

  /**
   * Convert Anthropic error to our format
   */
  private convertError(error: unknown): Error {
    // Check if it's an APIError (duck typing for better compatibility with mocks)
    function isAPIError(
      err: unknown
    ): err is { message?: string; status?: number; type?: string; name?: string } {
      if (typeof err !== 'object' || err === null) {
        return false;
      }
      // Safely extract properties without type assertions
      let hasStatus = false;
      let hasName = false;
      let hasConstructorName = false;

      if (typeof err === 'object' && err !== null) {
        const statusDescriptor = Object.getOwnPropertyDescriptor(err, 'status');
        hasStatus = statusDescriptor !== undefined;

        const nameDescriptor = Object.getOwnPropertyDescriptor(err, 'name');
        if (nameDescriptor && typeof nameDescriptor.value === 'string') {
          hasName = nameDescriptor.value === 'APIError';
        }

        const constructorDescriptor = Object.getOwnPropertyDescriptor(err, 'constructor');
        if (
          constructorDescriptor &&
          constructorDescriptor.value &&
          typeof constructorDescriptor.value === 'object'
        ) {
          const constructorNameDescriptor = Object.getOwnPropertyDescriptor(
            constructorDescriptor.value,
            'name'
          );
          if (constructorNameDescriptor && typeof constructorNameDescriptor.value === 'string') {
            hasConstructorName = constructorNameDescriptor.value === 'APIError';
          }
        }
      }
      return hasStatus && (hasName || hasConstructorName);
    }

    if (isAPIError(error)) {
      const message = `Anthropic API Error: ${error.message || 'Unknown error'}`;
      const newError = new Error(message);
      // Add error properties using Object.assign to avoid type assertions
      Object.assign(newError, {
        statusCode: error.status,
        code: error.type || 'anthropic_error',
      });
      return newError;
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error(`Unknown error: ${String(error)}`);
  }

  /**
   * Content Moderation
   * Anthropic Claude does not have a dedicated moderation API
   * Content safety is handled via safety settings in messages API
   */
  async moderate(_model: Model, _request: ModerationRequest): Promise<ModerationResponse> {
    // Anthropic handles content safety via safety settings in the messages API
    // There is no separate moderation endpoint like OpenAI
    throw new Error(
      'Anthropic Claude moderation is not yet implemented. Anthropic handles content safety via safety settings in the messages API, not a separate moderation endpoint. Use OpenAI moderation or implement Anthropic safety settings integration.'
    );
  }

  /**
   * Image Edit
   * Anthropic Claude does not have image editing capability
   */
  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error(
      'Anthropic Claude image editing is not yet implemented. Anthropic Claude does not provide image editing capabilities. Use OpenAI DALL-E for image editing.'
    );
  }

  /**
   * Image Variation
   * Anthropic Claude does not have image variation capability
   */
  async imageVariation(
    _model: Model,
    _request: ImageVariationRequest
  ): Promise<ImageVariationResponse> {
    throw new Error(
      'Anthropic Claude image variation is not yet implemented. Anthropic Claude does not provide image variation capabilities. Use OpenAI DALL-E for image variations.'
    );
  }

  /**
   * Sanitize request for logging (remove sensitive data)
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
