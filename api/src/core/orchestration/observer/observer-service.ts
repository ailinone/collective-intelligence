// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Observer/Narrator Service (v3 — Cloud Fallback + Real-Time SSE Streaming)
 *
 * Manages a reasoning model that narrates collective intelligence
 * strategy execution in real-time. The Observer:
 *
 * 1. Receives events from strategies (phase_start, model_response, round_complete, etc.)
 * 2. Calls a reasoning model to generate narration
 * 3. Queues narrations for real-time delivery via SSE chunks
 *
 * v3 Design: Ollama-first with cloud fallback via provider adapters.
 * - Primary: local Ollama (fast, free, no API cost)
 * - Fallback: any cloud model resolvable via ProviderRegistry
 * - Configured via OBSERVER_CLOUD_MODEL (single primary) and
 *   OBSERVER_CLOUD_MODEL_FALLBACKS (comma-separated list). No hardcoded
 *   default model IDs (SOTA dynamic-discovery policy, 2026-04-27).
 *
 * Queue-based with drain/flush for real-time SSE streaming.
 * - emit() fires narration generation and enqueues results
 * - drainReadyNarrations() returns completed narrations (non-blocking)
 * - flushPending() waits for in-flight narrations with timeout
 * - Strategies call drainObserverChunks() between phases to yield SSE chunks
 *
 * Fallback chain: Ollama -> Cloud model -> no-op (graceful degradation).
 */

import { logger } from '@/utils/logger';
import type { ObserverEvent, ObserverNarration, ChatRequest, ChatResponse } from '@/types';
import type { ObserverConfig, ObserverFeed } from './observer-types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { OBSERVER_PROMPTS } from './observer-prompts';

const log = logger.child({ component: 'observer-service' });

/**
 * Optional cloud-model candidates for the observer's fallback chain.
 *
 * SOTA policy (2026-04-27): the observer does NOT ship a hardcoded list of
 * model IDs. Operators who want a multi-tier cloud fallback set
 * OBSERVER_CLOUD_MODEL_FALLBACKS as a comma-separated list (most-preferred
 * first). The pre-existing OBSERVER_CLOUD_MODEL env var still selects a
 * single primary model; both can be combined.
 *
 * Empty default: when neither env var is set, the observer is Ollama-only
 * and degrades to no-op if Ollama is unreachable. That is the honest
 * representation of "this deployment has not declared cloud narration".
 */
function readObserverCloudFallbackCandidates(): string[] {
  const raw = (process.env.OBSERVER_CLOUD_MODEL_FALLBACKS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Backend type for narration generation. */
type NarrationBackend =
  | { type: 'ollama'; baseUrl: string; modelId: string }
  | { type: 'cloud'; adapter: ProviderAdapter; modelId: string };

// ── Shared, cached, self-healing narration-backend resolver ──────────────────
// SOTA: resolve the backend (probe the local sidecar / cloud fallback) ONCE and
// serve the result INSTANTLY to every per-request ObserverService, revalidating
// in the background (stale-while-revalidate) and self-healing on a runtime
// failure. Before this, EVERY request re-probed the sidecar (~1-3s added to the
// FIRST narration) and a single transient probe blip made that one request's
// observer inactive (the observed `obs=0`). Keyed by the resolved config so an
// operator env change re-resolves; the sidecar model is still DISCOVERED, never
// a hardcoded default (HARD RULE preserved).
interface CachedObserverBackend {
  backend: NarrationBackend | null;
  key: string;
  resolvedAt: number;
}
let _obsBackendCache: CachedObserverBackend | null = null;
let _obsBackendInflight: Promise<NarrationBackend | null> | null = null;

function observerBackendKey(config: ObserverConfig): string {
  const ollamaUrl = config.baseUrl || process.env.OLLAMA_URL || '';
  const model = (process.env.OBSERVER_MODEL || '').trim() || config.modelId || '';
  const cloud = config.cloudModel || process.env.OBSERVER_CLOUD_MODEL || '';
  return `${ollamaUrl}|${model}|${cloud}`;
}

function observerBackendTtlMs(): number {
  return Number(process.env.OBSERVER_BACKEND_TTL_MS) || 5 * 60 * 1000; // 5min
}

/**
 * TTL for a cached NULL backend (sidecar unreachable / no discoverable model).
 * MUCH shorter than the good-backend TTL: a `trustNull` invalidation (a runtime
 * narration failure) caches null as-fresh, and without a short null-TTL the
 * narrator would stay blind for the full 5min after a transient sidecar blip
 * (e.g. an 8s sidecar restart). A short null-TTL re-probes aggressively so the
 * observer self-heals within seconds once the sidecar is back. Operator-tunable.
 */
function observerBackendNullTtlMs(): number {
  return Number(process.env.OBSERVER_BACKEND_NULL_TTL_MS) || 20 * 1000; // 20s
}

/**
 * Signal a runtime narration failure: re-probe the sidecar in the BACKGROUND and
 * TRUST the verdict (a real failure means the last-good backend may be dead, so
 * this pass caches null if the probe fails — unlike the proactive TTL refresh,
 * which keeps last-good on a transient blip). Non-blocking: requests keep serving
 * the stale-good backend until the re-probe settles, so no request pays a cold
 * probe. If the sidecar is actually healthy, it stays cached.
 */
export function invalidateObserverBackend(): void {
  const cache = _obsBackendCache;
  if (!cache) return;
  void refreshObserverBackend({ enabled: true }, cache.key, /* trustNull */ true);
}

/**
 * Test-only: hard-reset the shared backend cache so each test resolves fresh (the
 * cache is a process singleton and would otherwise leak a resolved backend across
 * tests). Not for production use.
 */
export function __resetObserverBackendCacheForTests(): void {
  _obsBackendCache = null;
  _obsBackendInflight = null;
}

/** Probe the sidecar AND discover its loaded model in one round-trip. */
async function probeOllamaModel(baseUrl: string): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}/models`, { method: 'GET', signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const id = body.data?.find((m) => typeof m.id === 'string' && m.id.length > 0)?.id;
    return id ?? null;
  } catch {
    return null; // unreachable / timeout / bad JSON
  }
}

/** Resolve the backend: local sidecar (dynamic model) → cloud fallback → null. */
async function doResolveObserverBackend(config: ObserverConfig): Promise<NarrationBackend | null> {
  const ollamaUrl = config.baseUrl || process.env.OLLAMA_URL || '';
  if (ollamaUrl) {
    const discovered = await probeOllamaModel(ollamaUrl);
    if (discovered) {
      const envOverride = (process.env.OBSERVER_MODEL || '').trim() || undefined;
      const modelId = envOverride || config.modelId || discovered;
      log.info(
        { model: modelId, discovered, override: envOverride ?? config.modelId ?? null, baseUrl: ollamaUrl },
        'Observer backend resolved (local Ollama, model resolved dynamically)',
      );
      return { type: 'ollama', baseUrl: ollamaUrl, modelId };
    }
    log.debug({ baseUrl: ollamaUrl }, 'Ollama has no discoverable model, trying cloud fallback');
  }

  const cloudModelId = config.cloudModel || process.env.OBSERVER_CLOUD_MODEL || undefined;
  const candidates = cloudModelId
    ? [cloudModelId, ...readObserverCloudFallbackCandidates()]
    : readObserverCloudFallbackCandidates();
  // Short-circuit: with no cloud candidates configured (the default Ollama-only
  // deployment), do NOT import/spin up the heavy ProviderRegistry — there is nothing
  // to resolve, so importing it only adds latency (and, when the sidecar has no model,
  // stalls backend resolution behind a multi-second registry load). Return null now.
  if (candidates.length === 0) return null;
  try {
    const { getProviderRegistry } = await import('@/providers/provider-registry.js');
    const registry = getProviderRegistry();
    for (const candidateId of candidates) {
      try {
        const found = await registry.findModelCached(candidateId);
        if (found) {
          log.info(
            { model: candidateId, provider: found.adapter.getName() },
            'Observer backend resolved (cloud fallback)',
          );
          return { type: 'cloud', adapter: found.adapter, modelId: candidateId };
        }
      } catch {
        // Model not found or registry error — try next candidate
      }
    }
  } catch (err) {
    log.debug(
      { error: err instanceof Error ? err.message : String(err) },
      'ProviderRegistry not available for observer cloud fallback',
    );
  }
  return null;
}

/**
 * Refresh the cache (coalesced). By default keeps last-known-good on a transient
 * null (a proactive TTL refresh must not let one probe blip blind the narrator);
 * with `trustNull` a fresh null is cached as-is (used after a runtime failure, to
 * let a genuinely-dead sidecar converge to inactive).
 */
function refreshObserverBackend(
  config: ObserverConfig,
  key: string,
  trustNull = false,
): Promise<NarrationBackend | null> {
  if (_obsBackendInflight) return _obsBackendInflight;
  _obsBackendInflight = doResolveObserverBackend(config)
    .then((resolved) => {
      const prevGood = _obsBackendCache && _obsBackendCache.key === key ? _obsBackendCache.backend : null;
      const backend = trustNull ? resolved : (resolved ?? prevGood);
      _obsBackendCache = { backend, key, resolvedAt: Date.now() };
      return backend;
    })
    .catch(() => (_obsBackendCache ? _obsBackendCache.backend : null))
    .finally(() => {
      _obsBackendInflight = null;
    });
  return _obsBackendInflight;
}

/** Serve the shared backend: fresh cache instantly; stale → serve + refresh in bg. */
async function resolveObserverBackendShared(config: ObserverConfig): Promise<NarrationBackend | null> {
  const key = observerBackendKey(config);
  const cache = _obsBackendCache;
  if (cache && cache.key === key) {
    // A cached NULL revalidates on a short TTL so a transient sidecar blip self-heals
    // in seconds; a cached GOOD backend uses the long TTL to avoid re-probing every
    // request. Without this split, a `trustNull` invalidation blinds the narrator for
    // the full backend TTL even after the sidecar comes back moments later.
    const ttl = cache.backend === null ? observerBackendNullTtlMs() : observerBackendTtlMs();
    if (Date.now() - cache.resolvedAt < ttl) {
      return cache.backend; // fresh — instant, no probe
    }
    void refreshObserverBackend(config, key); // stale → revalidate in background
    return cache.backend; // serve stale immediately (stale-while-revalidate)
  }
  return refreshObserverBackend(config, key); // cold / key changed → resolve now (coalesced)
}

export class ObserverService implements ObserverFeed {
  private config: ObserverConfig;
  private allNarrations: ObserverNarration[] = [];
  private narrationQueue: ObserverNarration[] = [];
  private pendingPromises: Promise<void>[] = [];
  private active = false;
  private language: string;
  private strategyName: string;
  private backend: NarrationBackend | null = null;
  private initPromise: Promise<void> | null = null;
  // Claimed synchronously by the first narration to start, so exactly ONE uses the
  // fast opening model (see OBSERVER_FAST_MODEL in generateNarration).
  private firstNarrationClaimed = false;

  constructor(
    config: ObserverConfig,
    strategyName: string,
  ) {
    this.config = config;
    this.strategyName = strategyName;
    this.language = config.language || '';

    if (!config.enabled) {
      log.debug('Observer disabled for this request');
      return;
    }

    // Mark active optimistically — emit() will await backend resolution
    // and deactivate if no backend is found. This allows isActive() to
    // return true synchronously so the orchestration engine wires us in.
    this.active = true;

    // Start async backend resolution (non-blocking).
    // The first emit() will await this if needed.
    this.initPromise = this.resolveBackend();
  }

  /**
   * Resolve the narration backend via the SHARED, cached resolver — resolved once
   * and served instantly to every per-request instance (stale-while-revalidate +
   * self-heal). See the module-level resolver above. No per-request probe.
   */
  private async resolveBackend(): Promise<void> {
    const backend = await resolveObserverBackendShared(this.config);
    this.backend = backend;
    this.active = backend !== null;
    if (!backend) {
      log.warn(
        { strategy: this.strategyName },
        'Observer enabled but no backend available — degrading to no-op',
      );
    }
  }

  /**
   * Pre-warm the SHARED backend cache at boot so the FIRST real request pays no
   * probe latency (and never hits a cold-probe transient `obs=0`). Fire-and-forget;
   * uses the same config key real requests do, so its result is reused.
   */
  static async prewarmBackend(): Promise<void> {
    await resolveObserverBackendShared({ enabled: true });
  }

  /**
   * Ensure backend resolution is complete before first narration.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  /** Get ALL narrations generated so far (for final metadata). */
  getNarrations(): ObserverNarration[] {
    return [...this.allNarrations];
  }

  /**
   * Drain narrations that are ready (already generated).
   * Returns and removes them from the queue. Non-blocking.
   */
  drainReadyNarrations(): ObserverNarration[] {
    const ready = [...this.narrationQueue];
    this.narrationQueue = [];
    return ready;
  }

  /**
   * Wait for all in-flight narration promises to complete (with timeout).
   * Call this between strategy phases to ensure narrations are ready for drain.
   */
  async flushPending(timeoutMs: number = 3000): Promise<void> {
    if (this.pendingPromises.length === 0) return;

    await Promise.race([
      Promise.allSettled(this.pendingPromises),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
    this.pendingPromises = [];
  }

  /**
   * Emit an event for the observer to narrate.
   * Non-blocking: fires the narration request and enqueues the result.
   * Errors are logged but never propagated.
   */
  emit(event: ObserverEvent): void {
    if (!this.config.enabled) return;

    const promise = (async () => {
      // Wait for backend resolution on first emit
      await this.ensureInitialized();
      if (!this.active || !this.backend) return;

      const result = await this.generateNarration(event);
      if (result) {
        this.narrationQueue.push(result);
        this.allNarrations.push(result);
      }
    })().catch(err => {
      log.warn(
        { event: event.type, error: err instanceof Error ? err.message : String(err) },
        'Observer narration failed (non-critical)',
      );
    });

    this.pendingPromises.push(promise);
  }

  /**
   * Generate a narration for an event.
   * Routes to the resolved backend (Ollama or cloud adapter).
   */
  private async generateNarration(event: ObserverEvent): Promise<ObserverNarration | undefined> {
    if (!this.backend) return undefined;

    const start = Date.now();

    try {
      const systemPrompt = OBSERVER_PROMPTS.system(this.strategyName);

      // Claim the first-narration slot SYNCHRONOUSLY so exactly ONE narration takes the
      // "brief opening" fast path even under concurrent emits.
      const isFirst = !this.firstNarrationClaimed;
      if (isFirst) this.firstNarrationClaimed = true;

      const userPrompt = OBSERVER_PROMPTS.eventPrompt(
        {
          type: event.type,
          summary: event.summary,
          models: event.models,
          round: event.round,
          totalRounds: event.totalRounds,
          reasoning: event.reasoning,
        },
        this.language,
        isFirst, // brief opening line — appears faster, still complete
      );

      const maxTokens = this.config.maxNarrationTokens || 200;

      // First-narration acceleration — make the OPENING appear sooner WITHOUT harming
      // language or truncating mid-sentence:
      //  • DEFAULT (safe, on): ask the QUALITY model for a single short opening sentence
      //    (brevity by INSTRUCTION, see eventPrompt `brief`) and size the budget to that
      //    sentence (OBSERVER_FIRST_MAX_TOKENS ?? 80). SAME model → same correct-language
      //    mirroring; the model finishes the thought inside the budget instead of being
      //    cut off. (The old 64-token blind cap truncated normal-length openings.)
      //  • OPT-IN (OBSERVER_FAST_MODEL, e.g. qwen2.5:1.5b): also swap to a smaller model
      //    for the first narration. Faster, BUT smaller models mirror non-English
      //    languages POORLY — measured: 1.5b/3b narrate a pt-BR request in English — so
      //    it is OFF by default and only appropriate for English-only deployments.
      const fastModel = (process.env.OBSERVER_FAST_MODEL || '').trim();
      const fastModelId =
        isFirst && fastModel && this.backend.type === 'ollama' ? fastModel : undefined;
      const firstMaxTokens = Number(process.env.OBSERVER_FIRST_MAX_TOKENS) || 80;
      const effMaxTokens = isFirst ? Math.min(maxTokens, firstMaxTokens) : maxTokens;

      let content: string;
      if (this.backend.type === 'ollama') {
        content = await this.callOllama(this.backend, systemPrompt, userPrompt, effMaxTokens, fastModelId);
      } else {
        content = await this.callCloudAdapter(this.backend, systemPrompt, userPrompt, effMaxTokens);
      }

      if (!content) return undefined;

      // Extract reasoning and narration from response
      const reasoningMatch = content.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);
      const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
      const reasoning = reasoningMatch?.[1]?.trim() || thinkMatch?.[1]?.trim();
      const narration = content
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();

      if (!narration) return undefined;

      const result: ObserverNarration = {
        event,
        narration,
        reasoning,
        durationMs: Date.now() - start,
      };

      log.debug(
        {
          event: event.type,
          backend: this.backend.type,
          durationMs: result.durationMs,
          narrationLength: narration.length,
        },
        'Observer narration generated',
      );

      return result;
    } catch (err) {
      log.debug(
        { event: event.type, backend: this.backend.type, error: err instanceof Error ? err.message : String(err) },
        'Observer narration generation failed',
      );
      // Self-heal: nudge a background re-probe of the shared backend. The probe is
      // a lightweight GET /models, so a merely-slow model (call timed out) re-probes
      // healthy and stays cached, while a genuinely-dead sidecar converges to
      // inactive. Non-blocking; coalesced.
      invalidateObserverBackend();
      return undefined;
    }
  }

  /**
   * Call local Ollama via direct fetch (fast path, no provider overhead).
   */
  private async callOllama(
    backend: Extract<NarrationBackend, { type: 'ollama' }>,
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
    modelIdOverride?: string,
  ): Promise<string> {
    const response = await fetch(`${backend.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelIdOverride || backend.modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: false,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      log.debug({ status: response.status }, 'Ollama observer returned non-OK');
      return '';
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Call a cloud model via the ProviderRegistry adapter.
   * Uses a tight timeout — narrations are metadata, not primary responses.
   */
  private async callCloudAdapter(
    backend: Extract<NarrationBackend, { type: 'cloud' }>,
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
  ): Promise<string> {
    const request: ChatRequest = {
      model: backend.modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
      stream: false,
    };

    // Wrap in a timeout — cloud calls should not delay the main response
    const timeoutPromise = new Promise<ChatResponse>((_, reject) =>
      setTimeout(() => reject(new Error('Observer cloud call timed out')), 15000),
    );

    const response = await Promise.race([
      backend.adapter.chatCompletion(request),
      timeoutPromise,
    ]);

    const content = response.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  }

  /**
   * Extract a short sample of the USER's own text so the narrator can MIRROR the
   * user's language — works for ANY language, with no fixed language list. Prefers
   * the LAST user message (the language can switch mid-conversation). Returns ''
   * when there is no usable user text (empty / multimodal-only), which the prompt
   * handles as "reply in the same language the user wrote in".
   */
  static extractUserSample(messages: Array<{ role: string; content: string | unknown }>): string {
    let sample = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string' && m.content.trim().length > 0) {
        sample = m.content;
        break;
      }
      // Multimodal / OpenAI content-parts shape: content is an array of
      // { type: 'text', text } (and possibly image parts). Concatenate the text
      // parts so a pt-BR question sent as parts still yields a language sample.
      if (Array.isArray(m.content)) {
        const text = (m.content as Array<unknown>)
          .map((p) =>
            p && typeof p === 'object' &&
            (p as { type?: unknown }).type === 'text' &&
            typeof (p as { text?: unknown }).text === 'string'
              ? (p as { text: string }).text
              : '',
          )
          .join(' ')
          .trim();
        if (text.length > 0) {
          sample = text;
          break;
        }
      }
    }
    return sample;
  }
}

/**
 * Create a no-op observer feed for when the observer is disabled.
 * Implements the full interface but does nothing — zero overhead.
 */
export function createNoOpObserverFeed(): ObserverFeed {
  return {
    emit: () => {},
    getNarrations: () => [],
    isActive: () => false,
    drainReadyNarrations: () => [],
    flushPending: async () => {},
  };
}

/**
 * Build the off-channel SSE chunk that carries a single observer narration
 * (`ailin_metadata.type='observer'`, empty `delta.content` so naive OpenAI
 * clients ignore it). Shared by BaseStrategy.observerChunk() and the engine's
 * universal narration interleaver so both emit an identical wire shape.
 */
export function buildObserverChunk(narration: ObserverNarration): ChatResponse {
  return {
    id: `obs-${Date.now()}`,
    object: 'chat.completion.chunk' as const,
    created: Math.floor(Date.now() / 1000),
    model: 'observer',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant' as const, content: '' },
        finish_reason: null,
        logprobs: null,
      },
    ],
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
 * Build an ON-CHANNEL narration chunk: same narration text, but placed in
 * `delta.content` so a naive OpenAI client sees it as the first visible tokens of
 * the response (killing the ~30-52s silence before the collective's synthesis).
 * Opt-in only (see the engine's inline-narration gate) because it puts a process
 * preamble INSIDE the answer message — desirable for an interactive UI, surprising
 * for a programmatic caller that expects a clean answer. Carries
 * `ailin_metadata.type='observer_inline'` so the ailin client can recognize it and
 * NOT render it a second time in its side narration panel. A trailing blank line
 * separates the preamble from the synthesis that streams after it.
 */
export function buildInlineNarrationChunk(narration: ObserverNarration): ChatResponse {
  return {
    id: `obs-inline-${Date.now()}`,
    object: 'chat.completion.chunk' as const,
    created: Math.floor(Date.now() / 1000),
    model: 'observer',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant' as const, content: `${narration.narration}\n\n` },
        finish_reason: null,
        logprobs: null,
      },
    ],
    ailin_metadata: {
      type: 'observer_inline',
      event: narration.event.type,
      narration: narration.narration,
      observer_duration_ms: narration.durationMs,
    },
  } as ChatResponse;
}
