// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Base Execution Strategy
 * Abstract class that all strategies must extend
 */

import type {
  ChatRequest,
  ChatMessage,
  ChatResponse,
  ExecutionStrategyName,
  OrchestrationContext,
  OrchestrationResult,
  TaskType,
  Model,
  ModelExecution,
  ModelRole,
  ObserverEvent,
} from '@/types';
import type { ObserverFeed } from './observer/observer-types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { ObserverNarration } from '@/types';
import { safeMetadata } from '@/types/model-metadata.schema';
// Strategy Leader removed — was a no-op pass-through (quality threshold 0.3, length-only heuristic)
import { logger } from '@/utils/logger';
import {
  isObject,
  extractStatusCode,
  extractErrorCodeFromObject,
  getErrorMessage,
} from '@/utils/type-guards';
import { recordModelExecution } from '@/observability/ci-metrics';
import { modelPerformanceTracker } from '@/core/selection/model-performance-tracker';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { buildAilinFallbackPrompt } from './prompts/fallback-prompt';
import { normalizeSystemMessages } from './system-message-normalizer';
import { deriveModelMaxOutputTokens, resolveDynamicMaxTokens } from './dynamic-output-budget';
import { getProviderBandit } from '@/core/learning/provider-bandit';
import { rankRetryCandidates, computeOperabilityRanks } from './retry-candidate-ranking';
import { buildChatExecutionPool } from '@/core/pool/pool-builder';
import { isNonGenerativeModel } from '@/core/pool/non-generative-filter';
import type { PoolResult } from '@/core/pool/pool-types';
import { getExecutionFeedbackCollector } from '@/core/feedback/execution-feedback-collector';
import { normalizeCost } from '@/services/cost-normalization-service';
import { getPromptVariantBandit, isPromptVariantBanditEnabled } from '@/core/learning/prompt-variant-bandit';
import { PROMPT_VARIANTS, PROMPTS, type PromptVariant } from './prompts/sota-system-prompts';

// Module-level cache for credit monitor to avoid repeated dynamic imports in
// hot error path. Returns `null` when the module fails to load (e.g. circular
// import in degraded environments) — callers must handle null. Previous code
// returned `null as unknown as Module` which laundered the failure state past
// the type system and caused crashes downstream. Honest typing instead.
type CreditMonitorModule = typeof import('@/services/credit-monitor-service');
let _creditMonitorModule: CreditMonitorModule | null = null;
let _creditMonitorModulePromise: Promise<CreditMonitorModule | null> | null = null;
async function getCreditMonitorModule(): Promise<CreditMonitorModule | null> {
  if (_creditMonitorModule) return _creditMonitorModule;
  if (!_creditMonitorModulePromise) {
    _creditMonitorModulePromise = import('@/services/credit-monitor-service')
      .then((mod) => {
        _creditMonitorModule = mod;
        return mod;
      })
      .catch(() => {
        _creditMonitorModulePromise = null;
        return null;
      });
  }
  return _creditMonitorModulePromise;
}

/**
 * Strategy metadata
 */
export interface StrategyMetadata {
  id: string;
  name: ExecutionStrategyName;
  displayName: string;
  description: string;
  minModels: number;
  maxModels: number;
  estimatedCostMultiplier: number; // Relative to single model
  estimatedQualityBoost: number; // 0-1, improvement over baseline
  estimatedDurationMultiplier: number; // Relative to single model
  suitableFor: TaskType[];
}

/**
 * Non-chat capabilities that signal a model is NOT suitable for text generation tasks.
 * Models with ONLY these capabilities (and no 'chat' or 'text_generation') are excluded.
 */
const NON_CHAT_CAPABILITIES = new Set([
  'image_generation', 'image_editing', 'image_upscaling',
  'video_generation', 'video_editing',
  'audio_generation', 'text_to_speech', 'speech_to_text',
  'embedding', 'reranking',
  'moderation', 'classification',
]);

/**
 * Default minimum quality threshold for collective strategies.
 * Models below this threshold are excluded from selection.
 * Can be overridden by context.qualityTarget.
 */
const DEFAULT_MIN_QUALITY = 0.4;

/**
 * Model selection for execution
 */
export interface SelectedModel {
  model: Model;
  adapter: ProviderAdapter;
  role: ModelRole;
}

/**
 * Safely extract text content from a ChatResponse (or any response-like object).
 * Handles null/undefined response, empty choices array, array content, etc.
 * Use this EVERYWHERE instead of `response.choices[0]?.message?.content || ''`.
 *
 * Implemented with structural type guards instead of `as any` so each level of
 * the access chain (`choices` → `[0]` → `message` → `content`) is independently
 * validated. If a future ChatResponse variant returns a malformed shape, this
 * function silently returns '' rather than throwing — which is the contract.
 */
export function safeResponseContent(response: unknown): string {
  if (!isObject(response)) return '';
  const choices: unknown = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  // `Array.isArray` on `unknown` narrows to `any[]` for back-compat (TS quirk),
  // so we re-annotate the indexed element as `unknown` to keep the type-guard
  // chain honest. Without this, lint sees `first` as `any` and the downstream
  // `.message`/`.content` access cascades unsafe-* errors.
  const first: unknown = choices[0];
  if (!isObject(first)) return '';
  const message = (first as { message?: unknown }).message;
  if (!isObject(message)) return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isObject(part) && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Extracts the user's query text from a ChatRequest for semantic
 * routing. Concatenates the last user message's content (string or
 * multimodal text parts). Used by Phase 5 semantic retry re-ranking.
 */
function extractQueryText(request: ChatRequest): string {
  const messages = (request.messages ?? []) as ChatMessage[];
  // Last user message is the most informative
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const content = m.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (typeof part === 'string') parts.push(part);
        else if (isObject(part) && typeof (part as { text?: unknown }).text === 'string') {
          parts.push((part as { text: string }).text);
        }
      }
      return parts.join(' ');
    }
  }
  return '';
}

/**
 * Abstract base class for execution strategies
 */
export abstract class BaseStrategy {
  protected log = logger.child({ component: 'strategy' });

  /**
   * Ensure the provider call is always pinned to the concrete model selected by strategy.
   */
  protected withPinnedModel(request: ChatRequest, model: Model): ChatRequest {
    return {
      ...request,
      model: model.id,
    };
  }

  /**
   * Filter context.models to only those eligible for execution in this strategy.
   *
   * ALL strategies should use this instead of raw `context.models`.
   * Applies HARD filters (models that fail are excluded, no fallback to ALL):
   *
   * 1. CAPABILITIES — model must support chat/text_generation (not audio/image-only)
   * 2. QUALITY — model.performance.quality >= threshold (configurable via context.qualityTarget)
   * 3. BUDGET — model cost must be within budget if specified
   * 4. OPERABILITY — excludes models with no-credits balance status
   *
   * Returns sorted by quality descending (best models first).
   */
  protected getEligibleModels(context: OrchestrationContext): Model[] {
    // Quality threshold: at least DEFAULT_MIN_QUALITY, and at least 70% of the target.
    const qualityThreshold = Math.max(DEFAULT_MIN_QUALITY, (context.qualityTarget ?? 0) * 0.7);
    const requiredCaps = context.requiredCapabilities ?? [];
    const maxCost = context.maxCost;

    // Use PoolBuilder for structured, auditable filtering pipeline. Top-level
    // import (no `require`) — pool-builder doesn't import base-strategy back,
    // so there's no circular-dep risk and we get full type safety on PoolResult.
    try {
      const poolResult: PoolResult = buildChatExecutionPool(
        context.models,
        qualityThreshold,
        maxCost,
        requiredCaps,
      );

      // Log pool reduction for observability
      if (poolResult.stages.length > 0) {
        this.log.debug({
          strategy: this.getMetadata().name,
          summary: poolResult.summary,
          poolSize: poolResult.poolSize,
          selfHosted: poolResult.selfHostedAvailable,
          providers: poolResult.providerDiversity,
        }, 'Pool built via PoolBuilder');
      }

      return poolResult.models;
    } catch {
      // Fallback to inline filtering if PoolBuilder throws (defensive)
      return this.getEligibleModelsFallback(context, qualityThreshold, requiredCaps, maxCost);
    }
  }

  /**
   * Fallback eligible model filtering (used when PoolBuilder is not available).
   * This is the original inline implementation preserved for backward compatibility.
   */
  private getEligibleModelsFallback(
    context: OrchestrationContext,
    qualityThreshold: number,
    requiredCaps: string[],
    maxCost: number | undefined,
  ): Model[] {
    const eligible = context.models.filter((model) => {
      const caps = model.capabilities ?? [];
      const hasChatCapability = caps.includes('chat') || caps.includes('text_generation');
      if (!hasChatCapability) return false;

      const hasOnlyNonChat = caps.length > 0 && caps.every(
        (c) => NON_CHAT_CAPABILITIES.has(c) || c === 'streaming'
      );
      if (hasOnlyNonChat) return false;

      // Robust non-generative exclusion (corrupt capability tags) — keep
      // rerankers/embeddings/decoding-method/audio/search out of chat pools.
      if (isNonGenerativeModel(model)) return false;

      if (requiredCaps.length > 0) {
        const hasAll = requiredCaps.every((rc) => (caps as readonly string[]).includes(rc));
        if (!hasAll) return false;
      }

      const quality = model.performance?.quality ?? 0;
      if (quality < qualityThreshold) {
        if (quality === 0 && qualityThreshold < 0.6) {
          // pass — will be sorted to bottom
        } else {
          return false;
        }
      }

      if (maxCost && maxCost > 0) {
        const estimatedCost = (Number(model.inputCostPer1k) + Number(model.outputCostPer1k)) * 2;
        if (estimatedCost > maxCost) return false;
      }

      if (model.balanceStatus === 'no-credits') return false;
      if (model.status !== 'active') return false;

      return true;
    });

    const SOURCE_PRIORITY: Record<string, number> = { native_api: 0, cloud_hub: 1, router: 2, aggregator: 3 };
    return eligible.sort((a, b) => {
      const qa = a.performance?.quality ?? 0;
      const qb = b.performance?.quality ?? 0;
      if (qa !== qb) return qb - qa;
      const srcA = SOURCE_PRIORITY[safeMetadata(a.metadata).sourceType ?? ''] ?? 9;
      const srcB = SOURCE_PRIORITY[safeMetadata(b.metadata).sourceType ?? ''] ?? 9;
      if (srcA !== srcB) return srcA - srcB;
      const costA = Number(a.inputCostPer1k) + Number(a.outputCostPer1k);
      const costB = Number(b.inputCostPer1k) + Number(b.outputCostPer1k);
      return costA - costB;
    });
  }

  /**
   * Get strategy metadata
   */
  abstract getMetadata(): StrategyMetadata;

  /**
   * Execute the strategy
   */
  abstract execute(
    request: ChatRequest,
    context: OrchestrationContext
  ): Promise<OrchestrationResult>;

  /**
   * Returns true if this strategy supports hybrid streaming.
   * Phase 1: multi-model parallel execution yields SSE progress events.
   * Phase 2: synthesis LLM call yields real token-by-token chunks.
   */
  supportsStreaming(): boolean {
    return false;
  }

  /**
   * Hybrid streaming execution.
   * Yields SSE progress events during multi-model phase, then streams synthesis tokens.
   * Strategies that support streaming must override this method.
   */
  // eslint-disable-next-line require-yield
  async *executeStream(
    _request: ChatRequest,
    _context: OrchestrationContext
  ): AsyncGenerator<ChatResponse, void, unknown> {
    throw new Error(`Strategy ${this.getMetadata().name} does not support streaming`);
  }

  /**
   * Build an SSE progress chunk (zero-token, metadata-only).
   * Used by strategies to report multi-model phase progress to the client.
   */
  protected progressChunk(message: string, step: number, total: number): ChatResponse {
    // Progress chunks are synthetic SSE events — they don't carry full AilinMetadata.
    // The cast via unknown is intentional: progress events are consumed by the SSE
    // layer and never stored, so they don't need to satisfy the full schema.
    return {
      id: `prog-${step}-${Date.now()}`,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: this.getMetadata().name,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant' as const, content: '' },
          finish_reason: null,
          logprobs: null,
        },
      ],
      ailin_metadata: { type: 'progress', message, step, total },
    } as ChatResponse;
  }

  /**
   * Stream a final synthesis/aggregation response with provider fallback.
   *
   * Collective strategies end by streaming the final answer from a single
   * synthesizer. A bare `adapter.chatCompletionStream(...)` THROWS when that
   * provider fails (the runtime provider cascade — 401/402/403/404), which kills
   * the entire SSE stream: the client gets "Collective strategy stream failed"
   * with zero useful output even though the rounds succeeded. This helper makes
   * the synthesis resilient:
   *  - tries each candidate synthesizer in order;
   *  - if a provider throws BEFORE any content is emitted, it transparently
   *    falls back to the next candidate (no tokens were sent, so the swap is
   *    invisible to the client);
   *  - if it throws AFTER content started, it stops (a mid-stream synthesizer
   *    swap would splice two different answers) but keeps the partial output;
   *  - if ALL candidates fail before producing content, it emits ONE degraded
   *    chunk from `fallbackContent()` instead of throwing — so the collective
   *    always returns something usable and the caller's final observer/narration
   *    drain still runs.
   */
  /**
   * Cap the SYNTHESIS request's max_tokens — ONLY if the operator opts in via
   * COLLECTIVE_SYNTHESIS_MAX_TOKENS. Honor an explicit client max_tokens
   * unconditionally (the user chose the length). Otherwise, leave max_tokens
   * unset so the provider applies its own native default/max — no synthetic
   * numeric ceiling is sent (an arbitrarily high literal, e.g. millions, would
   * be REJECTED by most providers with a 400 as exceeding the model's real
   * output limit; they don't clamp it for you).
   *
   * HISTORY (2026, pre-latency-audit): this cap was originally added at a
   * FIXED default of 1024 because open-ended collective-synthesis questions
   * had produced 10-13k-char answers dominating wall-clock (~84-88s at
   * ~34 tok/s effective) — a real, previously-observed regression. Removing
   * the fixed default (2026-07-11, operator decision) reintroduces that same
   * risk for synthesis calls that omit max_tokens. If that wall-clock
   * regression resurfaces, set COLLECTIVE_SYNTHESIS_MAX_TOKENS in the
   * deployment env (no code change needed) rather than hardcoding a cap here
   * again.
   */
  protected capSynthesisRequest(request: ChatRequest): ChatRequest {
    if (Number(request.max_tokens) > 0) return request;
    // Optional operator latency bound. With NONE set, leave max_tokens unset so
    // the per-model derivation at the synthesis call site applies the synthesizer
    // model's own capability — never a static 1024 that clips the collective's
    // final answer (a frontier single would not be clipped, so this was a
    // structural handicap for the collective on the streaming path).
    const envCap = Number(process.env.COLLECTIVE_SYNTHESIS_MAX_TOKENS);
    if (Number.isFinite(envCap) && envCap > 0) return { ...request, max_tokens: envCap };
    return request;
  }

  protected async *streamSynthesisWithFallback(
    request: ChatRequest,
    candidates: Array<{ adapter: ProviderAdapter; model: Model }>,
    fallbackContent: () => string,
    opts?: {
      firstChunkTimeoutMs?: number;
      idleTimeoutMs?: number;
      throwOnTotalFailure?: boolean;
      /**
       * Skip the COLLECTIVE_SYNTHESIS_MAX_TOKENS cap. Collective synthesis is a
       * "summarize N model outputs" call that's naturally bounded; a plain
       * single-model chat request has no such assumption and should NEVER be
       * silently truncated to a synthesis-sized cap just because it's reusing
       * this streaming helper.
       */
      skipSynthesisCap?: boolean;
    },
  ): AsyncGenerator<ChatResponse, void, unknown> {
    request = opts?.skipSynthesisCap ? request : this.capSynthesisRequest(request);
    // A working synthesizer emits its first token within a few seconds; a
    // failing/hanging provider often never does (and can block for the provider's
    // own long timeout). Bound the wait for the FIRST chunk so the fallback chain
    // fast-fails through bad synthesizers instead of stalling on each one. No
    // bound after the first chunk — the stream then flows freely.
    // FAIL-FAST (2026-07-11): default lowered 20000ms -> 6000ms, matching the
    // single/auto streaming path in chat-routes.ts — same reasoning: a healthy
    // synthesizer's TTFB is sub-2s in practice, so 6s comfortably avoids
    // false-positive aborts while cutting the worst-case stall more than 3x.
    const firstChunkTimeoutMs = opts?.firstChunkTimeoutMs ?? 6000;
    let started = false;
    const failures: string[] = [];
    for (const cand of candidates) {
      // Frontier-parity: honor an explicit synthesis max_tokens, else request
      // THIS synthesizer model's own output capability (dynamic, per-model).
      const pinnedSynth = this.withPinnedModel(request, cand.model);
      const synthMaxTokens = resolveDynamicMaxTokens(pinnedSynth.max_tokens, cand.model);
      const synthRequest = synthMaxTokens !== undefined
        ? { ...pinnedSynth, max_tokens: synthMaxTokens }
        : pinnedSynth;
      const iterator = cand.adapter
        .chatCompletionStream(synthRequest)[Symbol.asyncIterator]();
      try {
        // Race the FIRST chunk against a deadline.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`first-chunk timeout after ${firstChunkTimeoutMs}ms`)),
            firstChunkTimeoutMs,
          );
        });
        let first: IteratorResult<ChatResponse>;
        try {
          first = await Promise.race([iterator.next(), deadline]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (!first.done) {
          if (first.value !== undefined) {
            started = true;
            yield first.value;
          }
          // First chunk arrived — stream the remainder under a per-chunk IDLE
          // deadline. Some providers (esp. HuggingFace serverless) send the full
          // answer then STALL the SSE open (never emit `done`, never close the
          // socket). Without an inter-chunk bound, `iterator.next()` blocks
          // forever → the whole collective SSE hangs until the CLIENT aborts
          // (observed: full answer streamed, then a ~90s hang to the 130s client
          // timeout). If no new chunk arrives within the idle window, treat the
          // stream as complete and close it (the answer is already delivered).
          const idleTimeoutMs = opts?.idleTimeoutMs ?? Number(process.env.SYNTHESIS_STREAM_IDLE_MS ?? 15000);
          while (true) {
            let idleTimer: ReturnType<typeof setTimeout> | undefined;
            let idledOut = false;
            const idleDeadline = new Promise<IteratorResult<ChatResponse, undefined>>((resolve) => {
              idleTimer = setTimeout(() => {
                idledOut = true;
                // done:true → the iterator "return" variant. Typing TReturn as
                // `undefined` makes `value` concretely undefined (not the default
                // `any` slot), so there is no double-cast AND no unsafe assignment.
                // The value is unused anyway (idledOut is checked before it is read).
                resolve({ done: true, value: undefined });
              }, idleTimeoutMs);
            });
            let next: IteratorResult<ChatResponse>;
            try {
              next = await Promise.race([iterator.next(), idleDeadline]);
            } finally {
              if (idleTimer) clearTimeout(idleTimer);
            }
            if (idledOut) {
              this.log.warn(
                { provider: cand.adapter.getName(), model: cand.model.id, idleTimeoutMs },
                'Synthesis stream idle past deadline — closing straggling provider stream',
              );
              // Best-effort, NON-blocking close of the stalled upstream stream.
              try {
                const ret = iterator.return?.(undefined);
                if (ret && typeof (ret as Promise<unknown>).then === 'function') {
                  (ret as Promise<unknown>).catch(() => { /* ignore */ });
                }
              } catch { /* ignore */ }
              break;
            }
            if (next.done) break;
            if (next.value !== undefined) {
              started = true;
              yield next.value;
            }
          }
        }
        return; // synthesizer streamed to completion
      } catch (err) {
        const msg = getErrorMessage(err);
        failures.push(`${cand.adapter.getName()}(${cand.model.id}): ${msg}`);
        // Best-effort, NON-blocking: signal the underlying stream to close so a
        // timed-out/hung request doesn't leak its connection while we move to the
        // next candidate. We must NOT await it — a generator suspended on a
        // never-resolving read would make return() hang too.
        try {
          const ret = iterator.return?.(undefined);
          if (ret && typeof (ret as Promise<unknown>).then === 'function') {
            (ret as Promise<unknown>).catch(() => { /* ignore */ });
          }
        } catch { /* ignore */ }
        if (started) {
          this.log.warn(
            { provider: cand.adapter.getName(), model: cand.model.id, error: msg },
            'Synthesis stream failed AFTER first chunk — keeping partial output',
          );
          return;
        }
        this.log.warn(
          { provider: cand.adapter.getName(), model: cand.model.id, error: msg },
          'Synthesis stream failed/timed out before first chunk — falling back to next synthesizer',
        );
      }
    }

    // Every candidate failed before producing content.
    if (opts?.throwOnTotalFailure) {
      // Callers with NO prior partial content to degrade to (e.g. a plain
      // single-model request — there's no "other perspective" to fall back
      // on) want the same contract as the non-streaming path: throw, so the
      // caller's SSE error handler reports a real failure instead of silently
      // emitting an empty "success" chunk.
      this.log.error(
        { attempts: candidates.length, failures },
        'All candidates failed — throwing (throwOnTotalFailure)',
      );
      throw new Error(
        failures.length > 0
          ? `All ${candidates.length} candidates failed: ${failures.join('; ')}`
          : `All ${candidates.length} candidates failed`,
      );
    }

    // Degrade gracefully instead of throwing so the collective stream never hard-errors.
    let content: string;
    try {
      content = fallbackContent();
    } catch {
      content = '';
    }
    this.log.error(
      { attempts: candidates.length, failures },
      'All synthesizers failed — emitting degraded synthesis (no provider produced output)',
    );
    yield {
      id: `synthesis-degraded-${Date.now()}`,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: candidates[0]?.model?.name ?? this.getMetadata().name,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant' as const, content },
          finish_reason: 'stop' as const,
          logprobs: null,
        },
      ],
    } as ChatResponse;
  }

  /**
   * Calculate estimated cost for this strategy
   */
  calculateEstimatedCost(
    models: Model[],
    estimatedInputTokens: number,
    estimatedOutputTokens: number
  ): number {
    let totalCost = 0;

    for (const model of models) {
      const inputRate = Math.max(0, Number(model.inputCostPer1k) || 0);
      const outputRate = Math.max(0, Number(model.outputCostPer1k) || 0);
      totalCost += (estimatedInputTokens / 1000) * inputRate
                 + (estimatedOutputTokens / 1000) * outputRate;
    }

    return Math.max(0, totalCost);
  }

  /**
   * Check if strategy is suitable for the request
   */
  isSuitable(request: ChatRequest, context: OrchestrationContext): boolean {
    const metadata = this.getMetadata();

    // Check if task type is suitable
    if (!metadata.suitableFor.includes(context.taskType)) {
      return false;
    }

    // Check if we have enough ELIGIBLE models (filtered by capabilities/quality/budget)
    const availableModels = this.getEligibleModels(context).length;
    if (availableModels < metadata.minModels) {
      return false;
    }

    // Check budget if specified
    if (context.budget) {
      const estimatedCost = this.calculateEstimatedCost(
        context.models.slice(0, metadata.maxModels),
        context.contextSize,
        1000 // Assume 1k output tokens for estimation
      );

      if (estimatedCost > context.budget) {
        return false;
      }
    }

    return true;
  }

  /**
   * Score this strategy for the given request
   * Higher score = better fit
   */
  scoreForRequest(request: ChatRequest, context: OrchestrationContext): number {
    if (!this.isSuitable(request, context)) {
      return 0;
    }

    const metadata = this.getMetadata();
    let score = 0.5; // Base score

    // Boost score if task type is highly suitable
    if (metadata.suitableFor[0] === context.taskType) {
      score += 0.2;
    }

    // Consider quality target
    if (context.qualityTarget) {
      const qualityFit = Math.min(1, metadata.estimatedQualityBoost / context.qualityTarget);
      score += qualityFit * 0.3;
    }

    // Consider budget constraints
    if (context.budget) {
      const estimatedCost = this.calculateEstimatedCost(
        context.models.slice(0, metadata.maxModels),
        context.contextSize,
        1000
      );
      const budgetUtilization = estimatedCost / context.budget;

      // Prefer strategies that use budget efficiently (not too much, not too little)
      if (budgetUtilization > 0.5 && budgetUtilization < 0.9) {
        score += 0.2;
      }
    }

    return Math.min(1, score);
  }

  /**
   * Create model execution record
   */
  protected createModelExecution(
    model: Model,
    adapter: ProviderAdapter,
    role: ModelRole,
    request: ChatRequest,
    response: ChatResponse,
    cost: number,
    durationMs: number,
    success: boolean = true,
    error?: string
  ): ModelExecution {
    const execution: ModelExecution = {
      modelId: model.id,
      modelName: model.name,
      role,
      request,
      response,
      cost: Math.max(0, cost) || 0,
      durationMs,
      success,
      error,
    };

    // L7+L11: Fan out execution result to feedback loop and event store (fire-and-forget).
    // `getExecutionFeedbackCollector` is now imported at module scope (top-level
    // import) — `request.requestId` and `model.uid` are runtime augmentations
    // not captured in the formal types, so we narrow with a single structural
    // cast (NOT `as unknown as` — the source already overlaps structurally).
    try {
      // Estimate quality from response content length (heuristic — judge score comes later via experiment runner)
      const responseContent = safeResponseContent(response);
      const estimatedQuality = success
        ? Math.min(1, Math.max(0.1, responseContent.length / 3000)) // 3000+ chars ≈ 1.0
        : 0;
      const requestRequestId = (request as { requestId?: string }).requestId;
      const modelUid = (model as { uid?: string }).uid;
      getExecutionFeedbackCollector().record({
        requestId: requestRequestId ?? `exec-${Date.now()}`,
        modelId: model.id,
        modelUid,
        providerId: model.provider ?? adapter.getName(),
        equivalenceGroup: safeMetadata(model.metadata).equivalenceGroup,
        success,
        latencyMs: durationMs,
        costUsd: execution.cost,
        qualityScore: estimatedQuality,
        errorType: error ? 'execution_error' : undefined,
        timestamp: new Date(),
        // F4-INT: bridge variant/slot metadata from execution to feedback collector
        // so the PromptVariantBandit receives reward signals. Without this, the
        // bandit's update() never fires because promptVariantId is never passed.
        promptVariantId: execution.promptVariantId,
        promptKey: execution.promptKey,
        promptSlotHash: execution.promptSlotHash,
      });
    } catch {
      // Feedback collector not available — non-critical (L13: graceful degradation)
    }

    return execution;
  }

  /**
   * Validate that assistant output is actually usable for end-user consumption.
   * Tool-only outputs are considered usable because downstream tooling may resolve them.
   */
  protected hasUsableAssistantResponse(response: ChatResponse): boolean {
    const choice = response.choices?.[0];
    if (!choice || !choice.message) {
      return false;
    }

    const message = choice.message as {
      content?: unknown;
      tool_calls?: unknown;
      function_call?: unknown;
    };

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return true;
    }

    if (message.function_call) {
      return true;
    }

    const content = message.content;
    if (typeof content === 'string') {
      return content.trim().length > 0;
    }

    if (Array.isArray(content)) {
      return content.some((item) => {
        if (typeof item === 'string') {
          return item.trim().length > 0;
        }
        if (item && typeof item === 'object' && 'text' in item) {
          const textValue = (item as { text?: unknown }).text;
          return typeof textValue === 'string' && textValue.trim().length > 0;
        }
        return false;
      });
    }

    return false;
  }

  /**
   * Execute a single model call with error handling
   */
  protected async executeModel(
    adapter: ProviderAdapter,
    model: Model,
    request: ChatRequest,
    role: ModelRole = 'primary'
  ): Promise<ModelExecution> {
    const tracer = trace.getTracer('ci-orchestration');
    return tracer.startActiveSpan(
      `model.execute ${model.name}`,
      { attributes: { 'model.id': model.id, 'model.provider': model.provider ?? adapter.getName(), 'model.role': role, 'strategy.name': this.getMetadata().name } },
      async (span) => {
    const startTime = Date.now();
    const pinnedBase = this.withPinnedModel(request, model);
    // Collapse multiple system messages (strategy prompt + peer-review + client
    // system) into one, so every provider adapter receives the SAME complete
    // instruction set — Anthropic (first-only) and Google (last-only) otherwise
    // silently dropped part of it. No-op for 0/1 system messages.
    const normalizedMessages = normalizeSystemMessages(pinnedBase.messages);
    const normalizedBase = normalizedMessages === pinnedBase.messages
      ? pinnedBase
      : { ...pinnedBase, messages: normalizedMessages };
    // Frontier-parity output ceiling: when the caller set no max_tokens, request
    // THIS model's own declared output capability (dynamic, per-model) so a
    // frontier model emits its full length and is never clipped to a provider's
    // stingy default — and never over-asks beyond what the model supports. This
    // is the single chokepoint every voter, single arm, and merge-synthesis
    // (synthesizeMerged) flows through. No static number.
    const derivedMaxTokens = Number(normalizedBase.max_tokens) > 0
      ? undefined
      : deriveModelMaxOutputTokens(model);
    const pinnedRequest = derivedMaxTokens
      ? { ...normalizedBase, max_tokens: derivedMaxTokens }
      : normalizedBase;

    // Phase 1 control plane: near-zero skip BEFORE any HTTP call.
    // Prevents the "60s waste against known-bad provider" pattern observed
    // in production. The decision is O(1) in-memory and adds <1ms p99.
    const providerName = adapter.getName();
    try {
      const { shouldSkipNearZero, emitCandidateTrace } = await import('@/core/operability');
      const skip = shouldSkipNearZero({ providerId: providerName, modelId: model.id });
      if (skip.skip) {
        emitCandidateTrace({
          providerId: providerName,
          modelId: model.id,
          modelFamily: model.provider,
          stage: 'skipped',
          included: false,
          reason: typeof skip.reason === 'string' ? skip.reason : 'health_filtered',
          healthState: typeof skip.reason === 'string' ? undefined : skip.reason,
          latencyMs: 0,
        });
        const skipDurationMs = Date.now() - startTime;
        this.log.warn(
          {
            provider: providerName,
            model: model.name,
            role,
            reason: skip.reason,
            nextProbeAfter: skip.nextProbeAfter,
            durationMs: skipDurationMs,
          },
          'Skipping known-bad provider/model (near-zero skip)',
        );
        span.setAttribute('model.skipped', true);
        span.setAttribute('model.skip_reason', String(skip.reason ?? 'unknown'));
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        // Build a "skipped" execution record with no cost/no tokens. The
        // caller's cross-provider retry path will pick the next candidate.
        return this.createModelExecution(
          model,
          adapter,
          role,
          pinnedRequest,
          {
            id: `skip-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model.name,
            choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop', logprobs: null }],
          } as ChatResponse,
          0,
          skipDurationMs,
          false,
          `skipped: ${skip.reason ?? 'known-bad'}`,
        );
      }
    } catch {
      // Operability module unavailable — fall through to normal path.
    }

    try {
      this.log.debug(
        {
          provider: adapter.getName(),
          model: model.name,
          role,
        },
        'Executing model'
      );

      const response = await adapter.chatCompletion(pinnedRequest);
      const durationMs = Date.now() - startTime;

      // Calculate actual cost (raw, as reported by the adapter's pricing).
      const rawCost = adapter.calculateCost(
        model,
        response.usage?.prompt_tokens || 0,
        response.usage?.completion_tokens || 0
      );

      // TIER 1 (2026-06-11): run the LIVE cost normalizer on the per-execution
      // path. A $0-reporting hub adapter (e.g. aihubmix) that burns tokens
      // would otherwise report cost=0, understating C3 collective cost. The
      // normalizer returns the raw cost when it's already positive (high
      // confidence), genuinely 0 for self-hosted, and a token×pricing estimate
      // when a cloud hub reports $0 with tokens>0. We attribute to the EXECUTION
      // provider (adapter.getName()) — the same attribution rule as the metrics
      // below — and feed the catalog pricing (Model.inputCostPer1k/outputCostPer1k)
      // so the estimate prefers DB pricing before family/fallback rates.
      // Never throws / never NaN: on any failure we fall back to rawCost.
      let cost = rawCost;
      let costSource: string | undefined;
      try {
        const record = normalizeCost(
          rawCost,
          (adapter.getName() || model.provider || '').toLowerCase(),
          model.id,
          response.usage?.prompt_tokens,
          response.usage?.completion_tokens,
          model.inputCostPer1k,
          model.outputCostPer1k,
        );
        const normalized = record.normalizedCostUsd;
        // Use the normalized value only when it is a finite number. A `null`
        // normalized cost means "missing" (no tokens, no pricing) → keep raw.
        if (typeof normalized === 'number' && Number.isFinite(normalized)) {
          cost = normalized;
        }
        costSource = record.costSource;
      } catch {
        // Normalization failed — fall back to the raw provider cost. Never throw.
        cost = rawCost;
      }

      const usableResponse = this.hasUsableAssistantResponse(response);
      if (!usableResponse) {
        const durationMs = Date.now() - startTime;
        const error = 'Provider returned empty assistant response';
        this.log.warn(
          {
            provider: adapter.getName(),
            model: model.name,
            role,
            durationMs,
          },
          error
        );
        // D1 fix (2026-06-11): poison the provider_model health registry for an
        // empty (HTTP 200, no content) response. Previously this early-return
        // bypassed ALL failure-bookkeeping (the catch block below), so an
        // empty-returning gateway was never marked unhealthy and got re-selected
        // every request. Now it is classified (EMPTY_RESPONSE_KEYWORDS →
        // provider_model + shouldSkipNearZero) and recorded, exactly like a
        // thrown failure, so `shouldSkipNearZero` defers it on the next pick.
        try {
          const { classifyProviderError, getProviderHealthRegistry, emitCandidateTrace } =
            await import('@/core/operability');
          const classification = classifyProviderError(new Error(error));
          const failedProvider = (adapter.getName() || model.provider || '').toLowerCase();
          if (classification.scope !== 'request' && classification.scope !== 'endpoint') {
            const key = classification.scope === 'provider_model'
              ? { providerId: failedProvider, modelId: model.id }
              : { providerId: failedProvider };
            getProviderHealthRegistry().recordExecution({
              key,
              success: false,
              classification,
              latencyMs: durationMs,
            });
            emitCandidateTrace({
              providerId: failedProvider,
              modelId: model.id,
              modelFamily: model.provider,
              stage: 'failed',
              included: false,
              reason: classification.errorClass,
              healthState: classification.healthState,
              latencyMs: durationMs,
            });
          }
        } catch { /* operability module not available */ }
        return this.createModelExecution(
          model,
          adapter,
          role,
          pinnedRequest,
          response,
          cost,
          durationMs,
          false,
          error
        );
      }

      this.log.debug(
        {
          provider: adapter.getName(),
          model: model.name,
          role,
          durationMs,
          cost,
          usage: response.usage,
        },
        'Model execution successful'
      );

      // Record per-model Prometheus metrics + rolling performance tracker
      recordModelExecution({
        modelId: model.id,
        // Attribute to the EXECUTION provider (the adapter that actually ran the call),
      // not the logical provider from model metadata. When a hub (e.g. aihubmix) runs
      // an openai/gpt-4o model and fails, the failure must be counted against the hub
      // — not against native openai — otherwise native providers get penalized for
      // failures they didn't cause, eventually collapsing the candidate pool.
      provider: adapter.getName(),
        taskType: 'unknown', // refined by strategies that have context
        durationMs,
        costUsd: cost,
        success: true,
      });
      modelPerformanceTracker.record({
        modelId: model.id,
        // Attribute to the EXECUTION provider (the adapter that actually ran the call),
      // not the logical provider from model metadata. When a hub (e.g. aihubmix) runs
      // an openai/gpt-4o model and fails, the failure must be counted against the hub
      // — not against native openai — otherwise native providers get penalized for
      // failures they didn't cause, eventually collapsing the candidate pool.
      provider: adapter.getName(),
        qualityScore: 0.8, // Refined by quality scorer after execution
        latencyMs: durationMs,
        success: true,
        costUsd: cost,
      });

      // Record execution success in unified operability hub (route-level precision)
      try {
        const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
        getProviderOperabilityHub().recordRouteExecution(adapter.getName(), model.id, true);
      } catch { /* non-critical */ }

      // Phase 1 control plane: record granular success in the new health
      // registry. Provider-level + model-level entries are both refreshed
      // — a successful (aihubmix, claude-haiku-4-5) call refreshes the
      // model entry, but does NOT refresh (aihubmix, gpt-4o-mini) — that
      // tuple keeps its own health state.
      try {
        const { getProviderHealthRegistry, emitCandidateTrace } = await import('@/core/operability');
        const registry = getProviderHealthRegistry();
        registry.recordExecution({
          key: { providerId: adapter.getName(), modelId: model.id },
          success: true,
          latencyMs: durationMs,
        });
        registry.recordExecution({
          key: { providerId: adapter.getName() },
          success: true,
          latencyMs: durationMs,
        });
        emitCandidateTrace({
          providerId: adapter.getName(),
          modelId: model.id,
          stage: 'succeeded',
          included: true,
          latencyMs: durationMs,
          healthState: 'healthy',
        });
      } catch { /* operability module not available */ }

      span.setAttribute('model.duration_ms', durationMs);
      span.setAttribute('model.cost_usd', cost);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();

      const execution = this.createModelExecution(
        model,
        adapter,
        role,
        pinnedRequest,
        response,
        cost,
        durationMs,
        true
      );
      // Preserve the raw provider-reported cost + normalization provenance so the
      // token×pricing estimate (when cost was normalized up from $0) is auditable.
      execution.rawCost = rawCost;
      if (costSource) execution.costSource = costSource;
      return execution;
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMessage = getErrorMessage(error);
      
      // Extract detailed error information for better debugging
      let errorDetails: Record<string, unknown> = { message: errorMessage };
      if (isObject(error)) {
        const statusCode = extractStatusCode(error);
        if (statusCode !== undefined) {
          errorDetails.statusCode = statusCode;
        }
        
        const code = extractErrorCodeFromObject(error);
        if (code !== undefined) {
          errorDetails.code = code;
        }
        
        if ('provider' in error && typeof error.provider === 'string') {
          errorDetails.provider = error.provider;
        }
        
        // Try to extract nested error message if available
        if ('error' in error) {
          const nestedError = error.error;
          if (isObject(nestedError) && 'message' in nestedError && typeof nestedError.message === 'string') {
            errorDetails.nestedMessage = nestedError.message;
          }
        }
      }
      if (error instanceof Error && error.stack) {
        errorDetails.stack = error.stack;
      }

      this.log.error(
        {
          provider: adapter.getName(),
          model: model.name,
          role,
          durationMs,
          error: errorMessage,
          errorDetails,
        },
        'Model execution failed'
      );

      // Detect payment/auth failures (402/403/404) and mark provider as no-credits
      // This closes the feedback loop: runtime failures update balance status for future selections
      const errMsg = errorMessage.toLowerCase();
      const httpStatusMatch = errorMessage.match(/HTTP\s+(\d{3})/);
      const detectedStatus = (errorDetails.statusCode as number | undefined)
        || (httpStatusMatch ? parseInt(httpStatusMatch[1], 10) : undefined);
      const isPaymentFailure = detectedStatus === 402 || detectedStatus === 403 || detectedStatus === 404;
      const isBalanceError = isPaymentFailure && (
        detectedStatus === 402 ||
        errMsg.includes('insufficient') || errMsg.includes('balance') ||
        errMsg.includes('quota') || errMsg.includes('subscription') ||
        errMsg.includes('credit') || errMsg.includes('funds') ||
        errMsg.includes('model not found')
      );
      // D2 fix (2026-06-11): an invalid-key (401) or forbidden (403) gateway must
      // trigger the SAME cross-provider retry as a balance error (retry the same
      // model on a DIFFERENT provider) — previously the retry was gated only on
      // isBalanceError, so 401-gateways gave up without trying anthropic/openai-direct.
      // It must NOT be mislabeled "no-credits": the markProviderNoCredits/governor
      // calls below stay gated on isBalanceError; only the retry fires for auth too.
      const isAuthFailure = detectedStatus === 401 || detectedStatus === 403;
      // Phase 1 control plane: classify the error + update health registry.
      // This runs alongside (not replacing) the legacy isBalanceError path
      // so the existing CreditGovernor + CentralDiscoveryService pipelines
      // remain wired. The new registry is granular by (providerId, modelId)
      // and powers shouldSkipNearZero on the next request.
      const failedProviderForHealth = (adapter.getName() || model.provider || '').toLowerCase();
      try {
        const { classifyProviderError, getProviderHealthRegistry, emitCandidateTrace } = await import('@/core/operability');
        const classification = classifyProviderError(error);
        const registry = getProviderHealthRegistry();
        // Use classification.scope to decide granularity:
        //   - 'provider_model' → key by (providerId, modelId) — only that
        //     tuple is poisoned. Other models on the same provider keep
        //     their health.
        //   - 'account' or 'provider' → key by (providerId) — all models
        //     for this provider share the fate.
        //   - 'request' → don't update registry (request-scoped error).
        if (classification.scope !== 'request' && classification.scope !== 'endpoint') {
          const key = classification.scope === 'provider_model'
            ? { providerId: failedProviderForHealth, modelId: model.id }
            : { providerId: failedProviderForHealth };
          registry.recordExecution({
            key,
            success: false,
            classification,
            latencyMs: durationMs,
          });
          emitCandidateTrace({
            providerId: failedProviderForHealth,
            modelId: model.id,
            modelFamily: model.provider,
            stage: 'failed',
            included: false,
            reason: classification.errorClass,
            healthState: classification.healthState,
            latencyMs: durationMs,
          });
        }
      } catch { /* operability module not available */ }

      if (isBalanceError || isAuthFailure) {
        // CRITICAL: attribute the no-credits status to the EXECUTION provider
        // (the adapter that actually made the HTTP call), NOT the logical
        // provider from the model catalog.
        //
        // Example bug this fixes: aihubmix executing `openai/gpt-4o-mini-search`
        // fails with HTTP 402 because aihubmix's account is empty. The OLD code
        // would call markProviderNoCredits("openai") — poisoning the native
        // openai entry even though native openai has its own credit. The next
        // call that needs gpt-5.4 would then SKIP native openai in cross-
        // provider retry and only try hubs (which are the ones actually broken).
        //
        // Fix: adapter.getName() is the ACTUAL failed provider. model.provider
        // is kept only as a last-resort fallback (e.g. when adapter is null).
        const providerName = (adapter.getName() || model.provider || '').toLowerCase();
        // D2: only mark no-credits for genuine balance errors — a 401/403 is an
        // auth failure, not an empty wallet, so we skip the no-credits marking
        // for it (but still run the cross-provider retry below).
        if (isBalanceError && providerName) {
          try {
            const { getCentralModelDiscoveryService } = await import('@/services/central-model-discovery-service');
            const discovery = await getCentralModelDiscoveryService();
            if (discovery && typeof discovery.markProviderNoCredits === 'function') {
              discovery.markProviderNoCredits(providerName);
              this.log.warn({ provider: providerName, detectedStatus }, 'Provider marked as no-credits after runtime failure');
            }
          } catch { /* non-critical */ }

          // Also mark route as exhausted in CreditGovernor (route-level precision)
          try {
            const { getCreditGovernor } = await import('@/core/budget/credit-governor');
            getCreditGovernor().markRouteExhausted(providerName, model.id, `HTTP ${detectedStatus}: ${errMsg.substring(0, 200)}`);
          } catch { /* non-critical — governor may not be initialized yet */ }
        }

        // AUTO-RETRY: Try same model via alternative provider (cross-provider fallback)
        // Priority: native_api first, then cloud_hub, then router/aggregator.
        // Uses metadata.sourceType and sourcePriority — no hardcoded provider lists.
        try {
          const { getAllEntriesForModel } = await import('@/services/model-catalog-service');
          const allEntries = await getAllEntriesForModel(model.id);
          const failedProviderLower = providerName;

          // L3+L4: Filter by circuit breaker state + credit status
          // Then sort: native_api first → cloud_hub → router
          let creditMonitorNoCredits: ReadonlySet<string> = new Set();
          try {
            const mod = await getCreditMonitorModule();
            if (mod) creditMonitorNoCredits = mod.getCreditMonitorService().getNoCreditsProviders();
          } catch { /* credit monitor not available */ }

          // L5 Thompson Sampling: rank providers within each source-type tier by
          // their learned reliability for this model. The bandit's `selectProvider`
          // returns providers sorted by sampled Beta score; we use that ordering
          // to break ties WITHIN a tier without overriding the structural
          // preference (native_api > cloud_hub > router > aggregator).
          //
          // Why tier first, bandit second: native APIs have no markup and full
          // feature parity — that's a structural correctness signal the bandit
          // doesn't see. We let the bandit choose between *equally-good*
          // structural options (e.g., two native providers offering the same
          // model), not between native and aggregator.
          const filteredCandidates = allEntries.filter(m => {
            const p = (m.provider || '').toLowerCase();
            if (p === failedProviderLower) return false;
            if (m.balanceStatus === 'no-credits') return false;
            if (creditMonitorNoCredits.has(p)) return false;
            return true;
          });

          // Compute bandit ranking once for all candidate providers.
          const banditRanking = getProviderBandit().selectProvider(
            model.id, // equivalenceGroup falls back to modelId until L2 is wired
            filteredCandidates.map(m => (m.provider || '').toLowerCase()),
            [failedProviderLower],
          );
          const banditScoreByProvider = new Map<string, number>();
          for (const r of banditRanking.rankedProviders) {
            banditScoreByProvider.set(r.providerId.toLowerCase(), r.sampledScore);
          }

          // Determinism (2026-06-29): rank proven-bad routes (phala 401 /
          // aihubmix 403 / cold) to the back and hot routes to the front BEFORE
          // tier/bandit — so this cross-provider retry stops trying dead variants
          // first (the gpt-oss-20b→phala→aihubmix case) and prefers warm HF routes.
          const { getProviderOperabilityHub: getHubForRetryRank } = await import(
            '@/core/provider-operability-hub'
          );
          const operabilityRanks = computeOperabilityRanks(
            filteredCandidates,
            model.id,
            getHubForRetryRank(),
          );
          let candidates = rankRetryCandidates(
            filteredCandidates,
            banditScoreByProvider,
            operabilityRanks,
          );

          // Phase 5 (feature-flagged): semantic-aware candidate reordering.
          // When OPERABILITY_SEMANTIC_RETRY=true AND the SemanticIndex has
          // been populated by the embedding pipeline, use the operational
          // pool's semantic resolver to re-rank the cross-provider retry
          // candidates by similarity to the user query. This produces a
          // health-aware + semantically-informed order that the legacy
          // rankRetryCandidates can't because it operates only on
          // sourceType priority + bandit. Falls back to the legacy order
          // if the resolver returns empty (pool not populated yet).
          if (process.env.OPERABILITY_SEMANTIC_RETRY === 'true') {
            try {
              const op = await import('@/core/operability');
              const queryText = extractQueryText(request);
              if (!queryText) {
                op.incrementCounter(op.METRIC_NAMES.SEMANTIC_RETRY_FALLBACK_TOTAL, { reason: 'empty_query' });
              } else {
                const ranked = await op.resolveSemanticCandidates({
                  query: queryText,
                  k: filteredCandidates.length,
                  filter: { modelFamily: model.provider, modelId: model.id },
                });
                if (ranked.length > 0) {
                  // Re-order `candidates` to match semantic order.
                  // Candidates not in the semantic ranking append at the end.
                  const semanticOrder = new Map<string, number>();
                  for (let i = 0; i < ranked.length; i++) {
                    const r = ranked[i];
                    semanticOrder.set(`${r.candidate.providerId}::${r.candidate.modelId}`, i);
                  }
                  candidates = [...candidates].sort((a, b) => {
                    const ka = `${(a.provider || '').toLowerCase()}::${a.id}`;
                    const kb = `${(b.provider || '').toLowerCase()}::${b.id}`;
                    const ia = semanticOrder.get(ka) ?? Number.POSITIVE_INFINITY;
                    const ib = semanticOrder.get(kb) ?? Number.POSITIVE_INFINITY;
                    return ia - ib;
                  });
                  op.incrementCounter(op.METRIC_NAMES.SEMANTIC_RETRY_USED_TOTAL, { result: 'reordered' });
                  this.log.debug(
                    { model: model.id, semanticHits: ranked.length, totalCandidates: candidates.length },
                    'Cross-provider retry: re-ordered by semantic match',
                  );
                } else {
                  op.incrementCounter(op.METRIC_NAMES.SEMANTIC_RETRY_FALLBACK_TOTAL, { reason: 'no_ranked_results' });
                }
              }
            } catch (err) {
              try {
                const op = await import('@/core/operability');
                op.incrementCounter(op.METRIC_NAMES.SEMANTIC_RETRY_FALLBACK_TOTAL, { reason: 'resolver_error' });
              } catch { /* ignore — operability not loaded */ }
              this.log.debug(
                { err: String(err) },
                'Semantic retry re-ordering failed — falling back to legacy ranking',
              );
            }
          }

          // Lazy-load operability for the cross-provider retry filter.
          // shouldSkipNearZero is O(1); we call it once per candidate and
          // skip without HTTP for known-bad. This is the change that
          // eliminates the 47-60s waste pattern observed in production.
          let skipNearZeroFn: undefined | ((k: { providerId: string; modelId?: string }) => { skip: boolean; reason?: string | unknown }) = undefined;
          let emitTraceFn: undefined | ((input: unknown) => void) = undefined;
          try {
            const op = await import('@/core/operability');
            skipNearZeroFn = (k) => op.shouldSkipNearZero(k);
            // Cast to satisfy TS; emitCandidateTrace returns CandidateTrace, we discard.
            emitTraceFn = (input) => { void op.emitCandidateTrace(input as Parameters<typeof op.emitCandidateTrace>[0]); };
          } catch { /* operability not loaded yet */ }

          for (const altModel of candidates) {
            const altProvider = (altModel.provider || '').toLowerCase();
            const altSourceType = safeMetadata(altModel.metadata).sourceType ?? 'unknown';

            // Phase 1: skip known-bad alternative providers without HTTP.
            if (skipNearZeroFn) {
              const skipDecision = skipNearZeroFn({ providerId: altProvider, modelId: altModel.id });
              if (skipDecision.skip) {
                if (emitTraceFn) {
                  emitTraceFn({
                    providerId: altProvider,
                    modelId: altModel.id,
                    stage: 'skipped',
                    included: false,
                    reason: typeof skipDecision.reason === 'string' ? skipDecision.reason : 'health_filtered',
                  });
                }
                this.log.debug(
                  { model: model.id, retryProvider: altProvider, reason: skipDecision.reason },
                  'Cross-provider retry: skipping known-bad candidate (near-zero skip)',
                );
                continue;
              }
            }

            // Get adapter for alternative provider via provider registry (no context needed)
            let altAdapter: ProviderAdapter | null = null;
            try {
              const { getProviderRegistry } = await import('@/providers/provider-registry');
              const registry = getProviderRegistry();
              const resolved = registry.resolveAdapterForModel(altModel);
              altAdapter = resolved.adapter;
            } catch {
              // Try via getAdapterForModel as fallback
              if (this.getAdapterForModel) {
                try { altAdapter = await this.getAdapterForModel(altModel, {} as OrchestrationContext); } catch { /* skip */ }
              }
            }
            if (!altAdapter) continue;

            this.log.info(
              { model: model.id, failedProvider: failedProviderLower, retryProvider: altProvider, sourceType: altSourceType },
              'Balance error — retrying same model via alternative provider'
            );

            // Recursive call with the alternative model+adapter (depth=1 to prevent infinite recursion)
            const retryPinnedRequest = { ...request, model: altModel.id };
            const retryStart = Date.now();
            try {
              const retryResponse = await altAdapter.chatCompletion(retryPinnedRequest);
              const retryDuration = Date.now() - retryStart;
              const retryContent = safeResponseContent(retryResponse);
              if (retryContent.length > 0) {
                this.log.info(
                  { model: model.id, provider: altProvider, durationMs: retryDuration },
                  'Cross-provider retry succeeded'
                );
                span.setAttribute('model.retry_provider', altProvider);
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                // Estimate cost from response usage if available — narrow
                // structurally to extract the optional usage block instead of
                // casting through `any` (which would cascade unsafe-* errors).
                const retryUsage = isObject(retryResponse)
                  ? (retryResponse as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
                  : undefined;
                const promptTokens = typeof retryUsage?.prompt_tokens === 'number' ? retryUsage.prompt_tokens : 0;
                const completionTokens = typeof retryUsage?.completion_tokens === 'number' ? retryUsage.completion_tokens : 0;
                const retryRawCost = retryUsage
                  ? (promptTokens * Number(altModel.inputCostPer1k) / 1000 +
                     completionTokens * Number(altModel.outputCostPer1k) / 1000)
                  : 0;
                // TIER 1: normalize the retry cost too (same shared path) so a
                // $0-reporting alt-provider with tokens>0 still yields cost>0.
                let retryCost = retryRawCost;
                let retryCostSource: string | undefined;
                try {
                  const retryRecord = normalizeCost(
                    retryRawCost,
                    altProvider,
                    altModel.id,
                    promptTokens || undefined,
                    completionTokens || undefined,
                    altModel.inputCostPer1k,
                    altModel.outputCostPer1k,
                  );
                  if (typeof retryRecord.normalizedCostUsd === 'number' && Number.isFinite(retryRecord.normalizedCostUsd)) {
                    retryCost = retryRecord.normalizedCostUsd;
                  }
                  retryCostSource = retryRecord.costSource;
                } catch {
                  retryCost = retryRawCost;
                }
                const retryExecution = this.createModelExecution(altModel, altAdapter, role, retryPinnedRequest, retryResponse, retryCost, retryDuration, true);
                retryExecution.rawCost = retryRawCost;
                if (retryCostSource) retryExecution.costSource = retryCostSource;
                return retryExecution;
              }
            } catch (retryErr) {
              this.log.warn(
                { model: model.id, provider: altProvider, error: String(retryErr) },
                'Cross-provider retry also failed'
              );
            }
          }
        } catch { /* getAllEntriesForModel not available or failed */ }
      }

      // Create error response
      const errorResponse: ChatResponse = {
        id: `error-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model.name,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
            },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
      };

      // Record failure metric
      recordModelExecution({
        modelId: model.id,
        // Attribute to the EXECUTION provider (the adapter that actually ran the call),
      // not the logical provider from model metadata. When a hub (e.g. aihubmix) runs
      // an openai/gpt-4o model and fails, the failure must be counted against the hub
      // — not against native openai — otherwise native providers get penalized for
      // failures they didn't cause, eventually collapsing the candidate pool.
      provider: adapter.getName(),
        taskType: 'unknown',
        durationMs,
        costUsd: 0,
        success: false,
      });
      modelPerformanceTracker.record({
        modelId: model.id,
        // Attribute to the EXECUTION provider (the adapter that actually ran the call),
      // not the logical provider from model metadata. When a hub (e.g. aihubmix) runs
      // an openai/gpt-4o model and fails, the failure must be counted against the hub
      // — not against native openai — otherwise native providers get penalized for
      // failures they didn't cause, eventually collapsing the candidate pool.
      provider: adapter.getName(),
        qualityScore: 0,
        latencyMs: durationMs,
        success: false,
        costUsd: 0,
      });

      // Record execution failure in unified operability hub (route-level precision)
      try {
        const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
        const httpStatusMatch2 = errorMessage.match(/HTTP\s+(\d{3})/);
        const httpStatus2 = httpStatusMatch2 ? parseInt(httpStatusMatch2[1], 10) : undefined;
        getProviderOperabilityHub().recordRouteExecution(adapter.getName(), model.id, false, httpStatus2, errorMessage);
        // #1 prove-before-admit: a 404 / model_not_found means THIS exact model
        // is a dead catalog entry — flag it so the selector stops re-picking it
        // (the hub is keyed per-family and cannot gate a single dead model).
        const { getDeadModelRegistry, isModelNotFound } = await import('@/core/operability/dead-model-registry.js');
        if (isModelNotFound(httpStatus2, errorMessage)) {
          getDeadModelRegistry().markDead(model.id, `status=${httpStatus2 ?? 'msg'}`);
        }
      } catch { /* non-critical */ }

      span.setAttribute('model.duration_ms', durationMs);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
      span.end();

      return this.createModelExecution(
        model,
        adapter,
        role,
        pinnedRequest,
        errorResponse,
        0,
        durationMs,
        false,
        error instanceof Error ? error.message : String(error)
      );
    }
    }); // end tracer.startActiveSpan
  }

  /**
   * Execute a model call with automatic fallback to alternate models from context.
   * If the primary model fails (provider error, 402, 404, etc.), tries the next
   * available models in context until one succeeds or all fail.
   */
  protected async executeModelWithRetry(
    adapter: ProviderAdapter,
    model: Model,
    request: ChatRequest,
    role: ModelRole,
    context: OrchestrationContext,
    maxRetries: number = 4,
  ): Promise<ModelExecution> {
    // In a COLLECTIVE strategy each attempt is bounded so the retry loop
    // (up to maxRetries+1 attempts) cannot ride the adapter's 60s×3 timeout per
    // attempt and blow the whole request past the client budget. Single-model
    // strategies keep the generous unbounded call (a long-form answer may need it).
    const isCollective = (this.getMetadata().minModels ?? 1) > 1;
    const runAttempt = (a: ProviderAdapter, m: Model, r: ModelRole): Promise<ModelExecution> =>
      isCollective
        ? this.boundModelExecution(() => this.executeModel(a, m, request, r), { adapter: a, model: m, request, role: r })
        : this.executeModel(a, m, request, r);

    const execution = await runAttempt(adapter, model, role);
    if (execution.success) return execution;

    // Primary failed — try fallback models from context.
    // Prefer models from different providers with known credits and good quality.
    const failedProvider = (model.provider || '').toLowerCase();
    const triedIds = new Set([model.id]);
    const fallbackCandidates = (context.models || []).filter(m => {
      if (triedIds.has(m.id)) return false;
      // Skip same provider (likely same failure — 402/403 is provider-wide)
      if ((m.provider || '').toLowerCase() === failedProvider) return false;
      // Skip providers already known to have no credits
      if (m.balanceStatus === 'no-credits') return false;
      // Only chat-capable models
      const caps = m.capabilities || [];
      if (caps.length > 0 && !caps.some((c: string) => c === 'chat' || c === 'chat_completion' || c === 'text-generation' || c === 'text_generation')) return false;
      // Prefer models with known quality > 0
      return true;
    }).sort((a, b) => {
      // Sort: quality desc → native providers first
      const qa = a.performance?.quality ?? 0;
      const qb = b.performance?.quality ?? 0;
      if (qa !== qb) return qb - qa;
      const SRC_PRI: Record<string, number> = { native_api: 0, cloud_hub: 1, router: 2, aggregator: 3 };
      const srcA = SRC_PRI[safeMetadata(a.metadata).sourceType ?? ''] ?? 9;
      const srcB = SRC_PRI[safeMetadata(b.metadata).sourceType ?? ''] ?? 9;
      return srcA - srcB;
    });

    for (let i = 0; i < Math.min(maxRetries, fallbackCandidates.length); i++) {
      const fallback = fallbackCandidates[i];
      const fallbackAdapter = this.getAdapterForModel
        ? await this.getAdapterForModel(fallback, context)
        : null;
      if (!fallbackAdapter) continue;

      this.log.warn(
        { failedModel: model.name, fallbackModel: fallback.name, fallbackProvider: fallback.provider, attempt: i + 1 },
        'Primary model failed, trying fallback'
      );

      const retryExecution = await runAttempt(fallbackAdapter, fallback, role);
      if (retryExecution.success) return retryExecution;
      triedIds.add(fallback.id);
    }

    // All retries failed — return the original failure
    return execution;
  }

  // executeWithLeader removed — was a no-op pass-through.
  // Strategies now call executeModel() directly.

  /**
   * Execute multiple models in parallel
   */
  /**
   * Default per-call deadline for a model execution inside a COLLECTIVE strategy.
   * Bounds tail latency: a single slow provider (e.g. a HuggingFace serverless
   * cold-start riding the adapter's 60s timeout × 3 retries ≈ 180s) would
   * otherwise blow the whole round past the client budget and force an abort.
   * This is a TIMEOUT, not a model choice — model selection stays fully dynamic.
   * Tunable via env (COLLECTIVE_MODEL_TIMEOUT_MS / PARALLEL_MODEL_TIMEOUT_MS),
   * no hardcoded model.
   */
  protected collectiveModelTimeoutMs(): number {
    return Number(
      process.env.COLLECTIVE_MODEL_TIMEOUT_MS ?? process.env.PARALLEL_MODEL_TIMEOUT_MS ?? 25000,
    );
  }

  /**
   * Run a single model-execution thunk under a hard per-call deadline. On timeout
   * the straggler is dropped (the underlying call keeps running but no longer
   * blocks the strategy) and a FAILED (empty) ModelExecution is returned, so the
   * degraded-synthesis / merge fallback can proceed with whatever responded in
   * time. Works for both plain executeModel() and executeModelWithReasoning().
   */
  protected async boundModelExecution(
    fn: () => Promise<ModelExecution>,
    ctx: { adapter: ProviderAdapter; model: Model; request: ChatRequest; role: ModelRole },
    timeoutMs: number = this.collectiveModelTimeoutMs(),
  ): Promise<ModelExecution> {
    const startTime = Date.now();
    const failedExecution = (reason: string, prefix: string): ModelExecution =>
      this.createModelExecution(
        ctx.model,
        ctx.adapter,
        ctx.role,
        ctx.request,
        {
          id: `${prefix}-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: ctx.model.name,
          choices: [
            { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop', logprobs: null },
          ],
        } as ChatResponse,
        0,
        Date.now() - startTime,
        false,
        reason,
      );

    // Guarantee the underlying call never rejects, so a late rejection (after the timeout has
    // already won the race) cannot surface as an unhandled promise rejection.
    const exec = fn().catch((err) => failedExecution(`error: ${getErrorMessage(err)}`, 'error'));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<ModelExecution>((resolve) => {
      timer = setTimeout(() => {
        this.log.warn(
          { provider: ctx.adapter.getName(), model: ctx.model.name, role: ctx.role, timeoutMs },
          'Model exceeded per-call timeout — dropping straggler',
        );
        resolve(failedExecution(`per-model timeout (${timeoutMs}ms)`, 'timeout'));
      }, timeoutMs);
    });

    return Promise.race([exec, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  protected async executeModelsInParallel(
    executions: Array<{
      adapter: ProviderAdapter;
      model: Model;
      request: ChatRequest;
      role: ModelRole;
    }>
  ): Promise<ModelExecution[]> {
    // C3 latency fix (2026-06-11): per-model timeout so the collective fan-out is never held hostage
    // by the single slowest model. Prod measured a `parallel` request at ~43s because Promise.all
    // waited for the slowest of N models (~37.5s of inference). Each model now gets a per-model
    // budget; a straggler resolves to a FAILED (empty) ModelExecution instead of blocking the whole
    // result, and the downstream merge/quality stage falls back to the models that responded in time.
    const perModelTimeoutMs = Number(process.env.PARALLEL_MODEL_TIMEOUT_MS ?? 25000);
    this.log.debug(
      { count: executions.length, perModelTimeoutMs },
      'Executing models in parallel (per-model timeout)'
    );

    return Promise.all(
      executions.map(({ adapter, model, request, role }) =>
        this.boundModelExecution(
          () => this.executeModel(adapter, model, request, role),
          { adapter, model, request, role },
          perModelTimeoutMs,
        ),
      ),
    );
  }

  /**
   * Merge multiple responses into one
   * Simple implementation: use the best response
   */
  protected mergeResponses(executions: ModelExecution[], requestedModel: string): ChatResponse {
    // Filter successful executions
    const successful = executions.filter((e) => e.success);

    if (successful.length === 0) {
      throw new Error('All model executions failed');
    }

    // For now, use the first successful response; advanced voting/merging strategies are handled in higher-level strategies.
    const best = successful[0];

    return {
      ...best.response,
      model: requestedModel, // Use requested model for abstraction
    };
  }

  /**
   * Collective MERGE synthesizer (2026-06-30). Combines several candidate
   * responses into a SINGLE answer that is better than any individual one —
   * the mechanism that lets the collective EXCEED (not merely tie) the best
   * model. Used by formerly "pick-the-winner" strategies (competitive,
   * massive-parallel) so selection becomes synthesis. Fully dynamic: the
   * synthesizer model is chosen by the caller (no static pin). Returns the
   * merged execution, or null when no usable candidate / no adapter (caller
   * falls back to its prior behaviour so a strategy never hard-fails on this).
   */
  protected async synthesizeMerged(
    candidates: ModelExecution[],
    originalRequest: ChatRequest,
    context: OrchestrationContext,
    synthesizer: Model,
  ): Promise<ModelExecution | null> {
    if (!this.getAdapterForModel) return null;
    const usable = candidates.filter(
      (c) => c.success && this.hasUsableAssistantResponse(c.response),
    );
    if (usable.length === 0) return null;
    // A single usable candidate cannot be "merged" — return it unchanged.
    if (usable.length === 1) return usable[0];

    const lastUser = originalRequest.messages[originalRequest.messages.length - 1]?.content ?? '';
    const responsesText = usable
      .map((e, i) => `### Expert response ${i + 1} (from ${e.modelName}):\n${safeResponseContent(e.response)}`)
      .join('\n\n');

    const mergeRequest: ChatRequest = {
      ...originalRequest,
      model: synthesizer.id,
      messages: [
        { role: 'system', content: PROMPTS.collectiveSynthesizer },
        {
          role: 'user',
          content:
            `Original request:\n${typeof lastUser === 'string' ? lastUser : JSON.stringify(lastUser)}\n\n` +
            `Here are ${usable.length} independent expert responses. MERGE them into one superior answer ` +
            `per your instructions (combine complementary strengths, reconcile, fill gaps, stay correct):\n\n${responsesText}`,
        },
      ],
    };

    try {
      const adapter = await this.getAdapterForModel(synthesizer, context);
      if (!adapter) return null;
      const merged = await this.executeModel(adapter, synthesizer, mergeRequest, 'arbitrator');
      return merged.success && this.hasUsableAssistantResponse(merged.response) ? merged : null;
    } catch {
      return null;
    }
  }

  /**
   * Calculate quality score for a response
   * Returns 0-1 score
   */
  protected calculateQualityScore(execution: ModelExecution): number {
    if (!execution.success || !this.hasUsableAssistantResponse(execution.response)) {
      return 0;
    }

    // Basic quality heuristics
    let score = 0.7; // Base score for successful execution

    const contentStr = safeResponseContent(execution.response);

    // Boost score for longer, more detailed responses
    if (contentStr.length > 500) score += 0.1;
    if (contentStr.length > 1000) score += 0.1;

    // Boost score for structured responses (code blocks, lists, etc.)
    if (contentStr.includes('```') || contentStr.match(/^\d+\./m)) score += 0.1;

    return Math.min(1, score);
  }

  /**
   * Get adapter for model (injected by orchestration engine)
   * This method is dynamically injected and should be used instead of direct provider registry access
   */
  /**
   * Enhance request with Social Facilitation prompt.
   * Informs the model that its response will be peer-reviewed, which empirically
   * improves performance on well-practiced tasks. Call this in collective strategies
   * before sending requests to individual models.
   */
  protected withPeerReviewPrompt(request: ChatRequest): ChatRequest {
    if (process.env.DISABLE_FACILITATION_PROMPT === 'true') return request;
    const facilitationMsg: ChatMessage = {
      role: 'system',
      content: 'Note: Your response will be reviewed and evaluated by expert peers. Provide your most thorough, accurate, and well-reasoned work.',
    };
    return {
      ...request,
      messages: [facilitationMsg, ...request.messages],
    };
  }

  /**
   * Measure disagreement between multiple responses (Mirkin Identity).
   * Returns a 0-1 score where 0 = full agreement, 1 = maximum disagreement.
   * Used to decide whether to escalate (add more models) or accept consensus.
   *
   * Uses Jaccard distance on word sets as a lightweight proxy for semantic distance.
   * Not perfect, but fast and does not require an API call.
   */
  protected measureDisagreement(responses: string[]): number {
    if (responses.length < 2) return 0;

    const tokenize = (text: string): Set<string> =>
      new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));

    const sets = responses.map(tokenize);
    let totalDistance = 0;
    let pairs = 0;

    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const intersection = new Set([...sets[i]].filter(w => sets[j].has(w)));
        const union = new Set([...sets[i], ...sets[j]]);
        const jaccard = union.size > 0 ? intersection.size / union.size : 0;
        totalDistance += 1 - jaccard; // Jaccard distance = 1 - similarity
        pairs++;
      }
    }

    return pairs > 0 ? totalDistance / pairs : 0;
  }

  // ── Observer / Narrator Helpers ──────────────────

  /**
   * Get the observer feed from context (injected by OrchestrationEngine).
   * Returns no-op feed if observer is not active.
   */
  protected getObserverFeed(context: OrchestrationContext): ObserverFeed {
    // OrchestrationEngine attaches `observerFeed` at runtime onto the context;
    // it isn't part of the formal `OrchestrationContext` type. Single
    // structural cast (NOT `as unknown as`) is safe here — both sides are
    // object types and the optional field is the only thing we touch.
    const feed = (context as { observerFeed?: ObserverFeed }).observerFeed;
    return feed ?? { emit: () => {}, getNarrations: () => [], isActive: () => false, drainReadyNarrations: () => [], flushPending: async () => {} };
  }

  /**
   * Emit an observer event. Non-blocking — fire-and-forget.
   * Safe to call even when observer is disabled (no-op).
   */
  protected emitObserverEvent(context: OrchestrationContext, event: Omit<ObserverEvent, 'timestamp' | 'strategy'>): void {
    const feed = this.getObserverFeed(context);
    feed.emit({
      ...event,
      timestamp: Date.now(),
      strategy: this.getMetadata().name,
    });
  }

  /**
   * Build an SSE chunk for an observer narration.
   * Same structure as progressChunk() but with type: 'observer'.
   * Client distinguishes by checking ailin_metadata.type.
   */
  protected observerChunk(narration: ObserverNarration): ChatResponse {
    return {
      id: `obs-${Date.now()}`,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: 'observer',
      choices: [{
        index: 0,
        delta: { role: 'assistant' as const, content: '' },
        finish_reason: null,
        logprobs: null,
      }],
      ailin_metadata: {
        type: 'observer',
        event: narration.event.type,
        narration: narration.narration,
        reasoning: narration.reasoning,
        observer_duration_ms: narration.durationMs,
      },
    } as ChatResponse;
  }

  /**
   * Drain observer narrations and return as SSE-ready chunks.
   * Waits briefly for in-flight narrations, then drains whatever is ready.
   * Call this between strategy phases in executeStream() to yield observer chunks.
   *
   * @param context Orchestration context (contains observer feed)
   * @param waitMs Max time to wait for pending narrations (default: 2s)
   * @returns Array of ChatResponse chunks ready to yield via SSE
   */
  protected async drainObserverChunks(
    context: OrchestrationContext,
    waitMs: number = 2000,
  ): Promise<ChatResponse[]> {
    const feed = this.getObserverFeed(context);
    if (!feed.isActive()) return [];

    // Wait for in-flight narrations (with timeout)
    await feed.flushPending(waitMs);

    // Drain whatever is ready
    const ready = feed.drainReadyNarrations();
    return ready.map(n => this.observerChunk(n));
  }

  /**
   * Yield observer narrations AS THEY BECOME READY while `work` is in flight, then
   * return work's result. Fixes the "long phase runs in silence, then a burst of
   * narration at the boundary" problem: drainObserverChunks() only runs BETWEEN
   * phases, so a narration that finishes generating mid-phase (the ~7-9s local
   * narrator latency) was not delivered until the NEXT boundary — after the whole
   * ~25s phase (measured: 27s of client silence during the debate opening round).
   * Wrapping a long phase await with `const x = yield* this.drainWhile(context, p)`
   * polls the ready queue on a short tick and streams each narration the moment it
   * lands, so the client sees CONTINUOUS narration DURING the phase.
   *
   * Universal — works for any collective phase. Degrades to a plain await (zero
   * overhead, no polling) when the observer is inactive.
   */
  protected async *drainWhile<T>(
    context: OrchestrationContext,
    work: Promise<T>,
    pollMs: number = 500,
  ): AsyncGenerator<ChatResponse, T, unknown> {
    const feed = this.getObserverFeed(context);
    if (!feed.isActive()) {
      return await work;
    }

    let settled = false;
    let value: T | undefined;
    let failure: { error: unknown } | null = null;
    // Never let the tracked promise reject out of the race — capture the outcome
    // and re-surface it after the drain loop so a phase error still propagates.
    const tracked = work.then(
      (v) => {
        settled = true;
        value = v;
      },
      (e) => {
        settled = true;
        failure = { error: e };
      },
    );

    while (!settled) {
      for (const n of feed.drainReadyNarrations()) {
        yield this.observerChunk(n);
      }
      // Wake on whichever comes first: the work settling or the next poll tick.
      await Promise.race([tracked, new Promise<void>((resolve) => setTimeout(resolve, pollMs))]);
    }

    // Flush anything that landed in the final window.
    for (const n of feed.drainReadyNarrations()) {
      yield this.observerChunk(n);
    }

    if (failure) throw (failure as { error: unknown }).error;
    return value as T;
  }

  // ── Reasoning / Chain-of-Thought Helpers ──────────────────

  /**
   * Check if reasoning is enabled for this request.
   */
  protected isReasoningEnabled(request: ChatRequest): boolean {
    return request.ailin_constraints?.enable_reasoning === true;
  }

  /**
   * Wrap a system prompt with explicit chain-of-thought instructions.
   * For models WITHOUT native thinking: adds directive to use <reasoning> tags.
   * For models WITH native thinking (DeepSeek-R1, QwQ): returns prompt unchanged
   * (native thinking is activated via thinking_budget in executeModelWithReasoning).
   */
  protected withReasoningPrompt(systemPrompt: string, request: ChatRequest, model?: Model): string {
    if (!this.isReasoningEnabled(request)) return systemPrompt;

    // If model has native thinking capability, DON'T inject prompt —
    // the model will use its own <think> protocol when thinking_budget is set
    if (model && this.hasNativeThinking(model)) return systemPrompt;

    const reasoningDirective =
      '\n\n## Reasoning Protocol\n' +
      'Before your final answer, show your complete reasoning inside <reasoning>...</reasoning> tags.\n' +
      'Think step by step:\n' +
      '1. Identify the key aspects of the question\n' +
      '2. Consider multiple approaches or perspectives\n' +
      '3. Evaluate trade-offs and potential issues\n' +
      '4. Formulate your conclusion based on this analysis\n\n' +
      'Write BOTH the <reasoning> content AND your final answer in the SAME language as the ' +
      "user's most recent message — mirror it exactly, do not translate. Put the reasoning " +
      'inside <reasoning>...</reasoning>, then write your final answer directly after (no labels or brackets).';

    return systemPrompt + reasoningDirective;
  }

  /**
   * Check if a model has native extended thinking capability (DeepSeek-R1, QwQ, etc.).
   * These models generate <think> blocks internally without prompt injection.
   */
  protected hasNativeThinking(model: Model): boolean {
    const capabilities = (model as { capabilities?: string[] }).capabilities;
    if (Array.isArray(capabilities) && capabilities.includes('thinking_mode')) return true;
    // Heuristic: model name contains thinking indicators
    const name = (model.name || model.id || '').toLowerCase();
    return /deepseek-r1|qwq|thinking|reasoner/.test(name);
  }

  /**
   * Extract reasoning from a model response.
   * Supports <reasoning>...</reasoning> and <think>...</think> (DeepSeek-R1/QwQ native format).
   * Returns { reasoning, cleanContent } where cleanContent has reasoning tags stripped.
   */
  protected extractReasoning(content: string): { reasoning: string | undefined; cleanContent: string } {
    // Try <reasoning> tags first (our protocol)
    const reasoningMatch = content.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);
    if (reasoningMatch) {
      const reasoning = reasoningMatch[1].trim();
      const cleanContent = content.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').trim();
      return { reasoning, cleanContent };
    }

    // Try <think> tags (DeepSeek-R1 / QwQ native format)
    const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
      const reasoning = thinkMatch[1].trim();
      const cleanContent = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      return { reasoning, cleanContent };
    }

    return { reasoning: undefined, cleanContent: content };
  }

  /**
   * Execute a model and capture reasoning if enabled.
   * Wraps executeModel() with reasoning extraction.
   */
  protected async executeModelWithReasoning(
    adapter: ProviderAdapter,
    model: Model,
    request: ChatRequest,
    role: ModelRole = 'primary',
  ): Promise<ModelExecution> {
    let reqForExecution = request;

    if (this.hasNativeThinking(model)) {
      // Native thinking models: activate via thinking_budget
      reqForExecution = { ...request, thinking_budget: request.thinking_budget || 2000 };
    } else {
      // Non-native models: inject reasoning prompt into system message
      const messages = [...request.messages];
      const systemIdx = messages.findIndex(m => m.role === 'system');
      if (systemIdx >= 0) {
        const sysContent = typeof messages[systemIdx].content === 'string' ? messages[systemIdx].content : '';
        messages[systemIdx] = { ...messages[systemIdx], content: this.withReasoningPrompt(sysContent, request, model) };
      } else {
        // No system message — prepend the observable Ailin¹ fallback (R4) rather
        // than a generic "helpful assistant" string so the degradation is visible
        // in logs and downstream models still know they are running under Ailin¹.
        messages.unshift({
          role: 'system',
          content: this.withReasoningPrompt(
            buildAilinFallbackPrompt('base-strategy.reasoning-no-system-msg'),
            request,
            model,
          ),
        });
      }
      reqForExecution = { ...request, messages };
    }

    const execution = await this.executeModel(adapter, model, reqForExecution, role);

    if (this.isReasoningEnabled(request) && execution.success) {
      const content = safeResponseContent(execution.response);
      if (content) {
        const { reasoning, cleanContent } = this.extractReasoning(content);
        if (reasoning) {
          execution.reasoning = reasoning;
          execution.reasoningTokens = Math.ceil(reasoning.split(/\s+/).length * 1.3); // Approximate token count
          // Replace response content with clean version (no reasoning tags)
          if (execution.response?.choices?.[0]?.message) {
            execution.response.choices[0].message.content = cleanContent;
          }
        }
      }
    }

    return execution;
  }

  /**
   * Format reasoning traces from multiple model executions for the synthesizer.
   * The synthesizer can use this to understand HOW each participant arrived at their answer.
   */
  protected formatReasoningForSynthesizer(executions: ModelExecution[]): string {
    const traces = executions.filter(e => e.reasoning);
    if (traces.length === 0) return '';

    const formatted = traces.map(e =>
      `### ${e.modelName} (${e.role}) — Reasoning:\n${e.reasoning}`
    ).join('\n\n');

    return '\n\n## Participant Reasoning Traces\n' +
      'The following shows how each participant reasoned before answering. ' +
      'Use this to identify the STRONGEST logical chains, detect flawed reasoning, ' +
      'and synthesize a response that combines the best reasoning from all participants.\n\n' +
      formatted;
  }

  // ── Tool Execution Loop ──────────────────

  /**
   * Execute a model with automatic tool execution loop.
   * If the model returns tool_calls, executes them and re-sends results until
   * the model produces a final response (finish_reason != 'tool_calls').
   *
   * This enables strategies to use tools (web_search, code execution, file ops, etc.)
   * without each strategy needing its own tool execution logic.
   *
   * @param maxToolIterations Maximum tool call → response cycles (default: 5)
   */
  protected async executeModelWithTools(
    adapter: ProviderAdapter,
    model: Model,
    request: ChatRequest,
    role: ModelRole = 'primary',
    maxToolIterations: number = 5,
  ): Promise<ModelExecution> {
    let currentRequest = request;
    let totalCost = 0;
    let totalDuration = 0;
    let lastExecution: ModelExecution | null = null;

    for (let iteration = 0; iteration < maxToolIterations; iteration++) {
      const execution = await this.executeModel(adapter, model, currentRequest, role);
      totalCost += execution.cost;
      totalDuration += execution.durationMs;
      lastExecution = execution;

      if (!execution.success) return execution;

      const finishReason = execution.response?.choices?.[0]?.finish_reason;
      const toolCalls = execution.response?.choices?.[0]?.message?.tool_calls;

      // If no tool calls, we're done
      if (finishReason !== 'tool_calls' || !toolCalls?.length) {
        execution.cost = totalCost;
        execution.durationMs = totalDuration;
        return execution;
      }

      // Execute tool calls and build messages with results
      const toolResultMessages: ChatMessage[] = [];
      for (const toolCall of toolCalls) {
        try {
          // Dynamic import to avoid circular dependency
          const { executeToolForStrategy } = await import('@/services/strategy-tool-executor');
          const result = await executeToolForStrategy(toolCall, logger);
          toolResultMessages.push({
            role: 'tool',
            content: result.output || result.error || 'No output',
            tool_call_id: toolCall.id,
          });
        } catch (err) {
          toolResultMessages.push({
            role: 'tool',
            content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
            tool_call_id: toolCall.id,
          });
        }
      }

      // Re-send with tool results appended to conversation
      currentRequest = {
        ...currentRequest,
        messages: [
          ...currentRequest.messages,
          // Include the assistant's tool call message
          {
            role: 'assistant' as const,
            content: '',
            tool_calls: toolCalls,
          },
          // Include tool results
          ...toolResultMessages,
        ],
      };
    }

    // Max iterations reached, return last execution
    if (lastExecution) {
      lastExecution.cost = totalCost;
      lastExecution.durationMs = totalDuration;
      return lastExecution;
    }
    throw new Error('executeModelWithTools: no execution produced');
  }

  // ── Self-Critique Loop ──────────────────

  /**
   * Self-improving loop: the SAME model generates, critiques itself, and repairs.
   * Unlike critique-repair (which uses 2 different models), this is intra-model self-improvement.
   *
   * Flow: generate → self-evaluate (quality score + issues) → self-repair → re-evaluate → ...
   * Stops on: quality target met | plateau detected | max iterations
   */
  protected async selfCritiqueLoop(
    adapter: ProviderAdapter,
    model: Model,
    request: ChatRequest,
    role: ModelRole = 'primary',
    qualityTarget: number = 0.85,
    maxIterations: number = 3,
  ): Promise<ModelExecution> {
    // Step 1: Initial generation
    const initialExec = await this.executeModel(adapter, model, request, role);
    if (!initialExec.success) return initialExec;

    const initialContent = initialExec.response?.choices?.[0]?.message?.content;
    if (typeof initialContent !== 'string') return initialExec;

    // `currentExec`/`currentContent` = the candidate under evaluation this
    // iteration. `bestExec`/`bestScore` = the highest-scoring candidate that
    // has actually been EVALUATED so far — this is what gets returned. A
    // repair step's output is only ever a candidate for the NEXT iteration's
    // evaluation; it must not become the return value until it has itself
    // been scored, otherwise an unvalidated repair (e.g. the model producing
    // confused meta-commentary about "reviewing a previous response" instead
    // of an actual repaired answer) silently overwrites a good answer.
    let currentExec = initialExec;
    let currentContent = initialContent;
    let bestExec = initialExec;
    let bestScore = 0;
    const scoreHistory: number[] = [];
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');

    for (let i = 0; i < maxIterations; i++) {
      // Step 2: Self-evaluate (same model)
      const evalReq: ChatRequest = {
        ...request,
        messages: [
          { role: 'system', content: 'Review YOUR OWN previous response. Be brutally honest. Rate quality 0.0-1.0. List specific issues.\n\nOutput JSON: {"quality_score": 0.85, "issues": [{"severity": "MAJOR", "description": "..."}]}' },
          { role: 'user', content: `ORIGINAL REQUEST:\n${originalQ}\n\nYOUR RESPONSE:\n${currentContent}` },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 500,
        temperature: 0.1,
      };
      const evalExec = await this.executeModel(adapter, model, evalReq, 'self-critic');

      let score = 0.5;
      let issues: Array<{ severity: string; description: string }> = [];
      try {
        const evalContent = evalExec.response?.choices?.[0]?.message?.content;
        if (typeof evalContent === 'string') {
          // JSON.parse returns `unknown` (since TS 5.x via lib changes) so we
          // narrow each field structurally instead of trusting the parsed
          // value's shape. Anything not matching the expected types falls back
          // to the defaults already declared above.
          const parsed: unknown = JSON.parse(evalContent);
          if (isObject(parsed)) {
            const qualityScore = (parsed as { quality_score?: unknown }).quality_score;
            if (typeof qualityScore === 'number') {
              score = qualityScore;
            }
            const parsedIssues = (parsed as { issues?: unknown }).issues;
            if (Array.isArray(parsedIssues)) {
              issues = parsedIssues.filter(
                (entry): entry is { severity: string; description: string } =>
                  isObject(entry) &&
                  typeof (entry as { severity?: unknown }).severity === 'string' &&
                  typeof (entry as { description?: unknown }).description === 'string',
              );
            }
          }
        }
      } catch { /* parse failure, keep defaults */ }

      scoreHistory.push(score);
      if (score > bestScore) { bestScore = score; bestExec = currentExec; }

      // Check stopping criteria
      if (score >= qualityTarget) break;
      if (issues.filter(i => i.severity === 'CRITICAL' || i.severity === 'MAJOR').length === 0) break;
      if (scoreHistory.length >= 2 && Math.abs(scoreHistory[scoreHistory.length - 1] - scoreHistory[scoreHistory.length - 2]) < 0.05) break;

      // Step 3: Self-repair (same model)
      const issuesText = issues.map((iss, idx) => `${idx + 1}. [${iss.severity}] ${iss.description}`).join('\n');
      const repairReq: ChatRequest = {
        ...request,
        messages: [
          { role: 'system', content: 'Fix these specific issues in YOUR previous response. Keep what works, fix what was flagged. Output the COMPLETE improved version.' },
          { role: 'user', content: `ORIGINAL REQUEST:\n${originalQ}\n\nYOUR PREVIOUS RESPONSE:\n${currentContent}\n\nISSUES TO FIX:\n${issuesText}` },
        ],
      };
      const repairExec = await this.executeModel(adapter, model, repairReq, 'self-repairer');
      if (repairExec.success) {
        const repaired = repairExec.response?.choices?.[0]?.message?.content;
        if (typeof repaired === 'string' && repaired.trim()) {
          // Becomes next iteration's evaluation candidate — NOT bestExec.
          // If maxIterations is reached right after this, the repair is
          // never scored and is correctly discarded in favor of bestExec.
          currentExec = repairExec;
          currentContent = repaired;
        }
      }
    }

    // Annotate with self-critique metadata
    bestExec.reasoning = `Self-critique: ${scoreHistory.length} iterations, scores: [${scoreHistory.map(s => s.toFixed(2)).join(', ')}], final: ${bestScore.toFixed(2)}`;
    return bestExec;
  }

  // ── Memory Integration ──────────────────

  /**
   * Enrich a request with relevant memories from previous interactions.
   * Searches for memories related to the user's query and prepends them as context.
   * Call this at the START of execute() for memory-aware strategies.
   */
  async enrichWithMemories(
    request: ChatRequest,
    context: OrchestrationContext,
  ): Promise<ChatRequest> {
    // LAT-3: the orchestration engine already ran the memory search and
    // prepended the memory block for this request — a second per-strategy
    // retrieval would duplicate the embedding + pgvector round-trip AND the
    // injected prompt context.
    if (context.memoryEnriched) return request;
    try {
      const userContent = request.messages
        .filter(m => m.role === 'user')
        .map(m => typeof m.content === 'string' ? m.content : '')
        .join(' ');

      if (!userContent || userContent.length < 10) return request;

      const memories = await this.searchMemories(context, userContent, 3);
      if (memories.length === 0) return request;

      const memoryContext = memories
        .map(m => `[${m.type}] ${m.content}`)
        .join('\n');

      // Prepend memories as system context
      return {
        ...request,
        messages: [
          {
            role: 'system' as const,
            content: `Relevant context from previous interactions:\n${memoryContext}\n\nUse this context if relevant to the current request.`,
          },
          ...request.messages,
        ],
      };
    } catch {
      return request; // Memory failure is non-fatal
    }
  }

  /**
   * Record execution results as memory for future retrieval.
   * Stores high-quality responses, reasoning traces, and strategy outcomes.
   * Call this at the END of execute() for memory-aware strategies.
   */
  async recordExecution(
    context: OrchestrationContext,
    result: OrchestrationResult,
  ): Promise<void> {
    try {
      const content = result.finalResponse?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length < 50) return;

      // Only store high-quality results
      const quality = result.qualityScore ?? 0;
      if (quality < 0.7) return;

      const userQuery = (result.modelsUsed?.[0]?.request?.messages || [])
        .filter(m => m.role === 'user')
        .map(m => typeof m.content === 'string' ? m.content : '')
        .join(' ')
        .substring(0, 200);

      await this.storeMemory(
        context,
        `Q: ${userQuery}\nA: ${content.substring(0, 500)}`,
        'episodic',
        {
          strategy: result.strategyUsed,
          qualityScore: quality,
          models: result.modelsUsed?.map(e => e.modelName).slice(0, 5),
          costUsd: result.totalCost,
        },
      );

      // Store reasoning traces as procedural memory (HOW to solve)
      const traces = (result.metadata as Record<string, unknown>)?.reasoning_traces;
      if (Array.isArray(traces) && traces.length > 0) {
        const bestTrace = (traces as Array<{ reasoning?: string }>)
          .filter(t => t.reasoning)
          .sort((a, b) => (b.reasoning?.length || 0) - (a.reasoning?.length || 0))[0];

        if (bestTrace?.reasoning) {
          await this.storeMemory(
            context,
            `Reasoning approach for: ${userQuery}\n${bestTrace.reasoning.substring(0, 500)}`,
            'procedural',
            { strategy: result.strategyUsed },
          );
        }
      }
    } catch {
      // Memory storage failure is non-fatal
    }
  }

  /**
   * Store a memory from strategy execution (episodic: interaction results, semantic: learned facts).
   * Connects strategies to the SemanticMemoryStore for cross-request knowledge.
   */
  protected async storeMemory(
    context: OrchestrationContext,
    content: string,
    type: 'episodic' | 'semantic' | 'procedural' = 'episodic',
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const { getSemanticMemoryStore } = await import('@/core/memory/semantic-memory-store');
      const store = getSemanticMemoryStore();
      await store.store({
        organizationId: context.organizationId || 'default',
        userId: context.userId,
        type,
        content,
        metadata: { ...metadata, strategy: this.getMetadata().name, requestId: context.requestId },
        importance: 0.7,
      });
    } catch {
      // Memory storage failure is non-fatal
    }
  }

  /**
   * Search memories relevant to the current request.
   * Returns matching memories that can be injected as context.
   */
  protected async searchMemories(
    context: OrchestrationContext,
    query: string,
    limit: number = 5,
  ): Promise<Array<{ content: string; similarity: number; type: string }>> {
    try {
      const { getSemanticMemoryStore } = await import('@/core/memory/semantic-memory-store');
      const store = getSemanticMemoryStore();
      const results = await store.search({
        organizationId: context.organizationId || 'default',
        query,
        limit,
        minSimilarity: 0.7,
      });
      return results.map(r => ({
        content: r.entry.content,
        similarity: r.similarity,
        type: r.entry.type,
      }));
    } catch {
      return [];
    }
  }

  protected getAdapterForModel?(model: Model, context: OrchestrationContext): Promise<ProviderAdapter | null>;

  /**
   * Get a sibling strategy by name.
   * Injected by OrchestrationEngine so that meta-strategies (adaptive, war-room)
   * can delegate to concrete strategies without circular imports.
   */
  protected getSiblingStrategy?(name: string): BaseStrategy | undefined;

  /**
   * Select a prompt variant via the LinUCB bandit (if enabled and variants exist).
   * Returns null when the feature flag is off, no variants are registered, or
   * the bandit module is unavailable. Strategies should fall back to the
   * canonical prompt when this returns null.
   */
  protected selectPromptVariant(
    promptKey: string,
    context: OrchestrationContext,
  ): PromptVariant | null {
    // PROMPT_VARIANTS, getPromptVariantBandit, isPromptVariantBanditEnabled
    // are now imported at module scope. No more `require()` — TypeScript can
    // see the full surface and narrow correctly.
    try {
      if (!isPromptVariantBanditEnabled()) return null;

      const variants = PROMPT_VARIANTS?.[promptKey];
      if (!variants?.length) return null;

      const bandit = getPromptVariantBandit();
      const result = bandit.selectVariant(promptKey, variants, {
        taskType: context.taskType ?? 'general',
        complexity: context.triage?.complexity ?? 'medium',
        promptLength: 'medium',
      });
      return result?.variant ?? null;
    } catch {
      return null;
    }
  }
}
