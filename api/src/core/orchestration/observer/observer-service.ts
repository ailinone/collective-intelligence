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
 *
 * Token-level streaming (2026-09 follow-up to PR #473's zero-latency opening
 * template — Idea 2, deferred in that PR's body). Once a narration call
 * starts, `generateNarration()` requests `stream: true` from the resolved
 * backend and pushes each incremental token straight onto `narrationQueue`
 * as a `partial: true` fragment (all fragments for one call share a
 * `narrationId`) — the existing 400ms/500ms poll loops in
 * `interleaveNarration()` (orchestration-engine.ts) and `drainWhile()`
 * (base-strategy.ts) already drain this queue continuously, so fragments
 * reach the client as SSE chunks progressively instead of arriving as one
 * lump only once the whole call finishes. The 4-9s floor before the FIRST
 * fragment of a milestone's narration is unchanged — this only makes what
 * streams after that floor feel continuous. If the resolved backend does not
 * actually stream anything (a non-streaming sidecar/proxy, or a backend that
 * silently ignores `stream: true`), `emit()` detects that no fragment was
 * produced and falls back to queuing the single complete narration exactly
 * as before this feature existed — so a non-streaming deployment sees
 * unchanged behavior, never a missing narration.
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
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
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
        {
          model: modelId,
          discovered,
          override: envOverride ?? config.modelId ?? null,
          baseUrl: ollamaUrl,
        },
        'Observer backend resolved (local Ollama, model resolved dynamically)'
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
            'Observer backend resolved (cloud fallback)'
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
      'ProviderRegistry not available for observer cloud fallback'
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
  trustNull = false
): Promise<NarrationBackend | null> {
  if (_obsBackendInflight) return _obsBackendInflight;
  _obsBackendInflight = doResolveObserverBackend(config)
    .then((resolved) => {
      const prevGood =
        _obsBackendCache && _obsBackendCache.key === key ? _obsBackendCache.backend : null;
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
async function resolveObserverBackendShared(
  config: ObserverConfig
): Promise<NarrationBackend | null> {
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
  // Monotonic counter for narrationId (token-streaming correlation) — see
  // generateNarration(). A plain incrementing counter is sufficient (no
  // crypto/uuid dependency needed): it only has to be unique WITHIN this
  // ObserverService instance's lifetime (one per request).
  private narrationSeq = 0;

  constructor(config: ObserverConfig, strategyName: string) {
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
        'Observer enabled but no backend available — degrading to no-op'
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
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
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

      const generated = await this.generateNarration(event);
      if (!generated) return;
      const { result, streamed } = generated;
      // getNarrations() (-> result.metadata.observer_narrations) ALWAYS gets
      // the complete, final narration — unchanged regardless of whether the
      // text arrived as one lump or as streamed fragments.
      this.allNarrations.push(result);
      if (!streamed) {
        // Legacy single-lump delivery: the backend produced no fragments
        // during generation (non-streaming backend/mock, or a backend that
        // silently ignored `stream: true`) — queue the complete narration as
        // ONE chunk, exactly as before token-level streaming existed.
        this.narrationQueue.push(result);
      }
      // When streamed === true, every fragment was already pushed onto
      // narrationQueue as it arrived (see generateNarration()'s onDelta) —
      // nothing left to enqueue here; re-queuing the assembled `result` too
      // would re-deliver the whole narration a second time as a redundant
      // final lump.
    })().catch((err) => {
      log.warn(
        { event: event.type, error: err instanceof Error ? err.message : String(err) },
        'Observer narration failed (non-critical)'
      );
    });

    this.pendingPromises.push(promise);
  }

  /**
   * Enqueue an already-written narration synchronously — zero LLM/network
   * latency. See `ObserverFeed.emitImmediate`'s doc for why this exists
   * (the deterministic opening line must land at t≈0, before the async
   * `emit()` path's backend resolution + model call have even started).
   * Deliberately does NOT touch `this.backend`/`ensureInitialized()` and
   * pushes no promise onto `pendingPromises` — there is nothing to await.
   */
  emitImmediate(event: ObserverEvent, narrationText: string): void {
    if (!this.config.enabled) return;
    const narration: ObserverNarration = { event, narration: narrationText, durationMs: 0 };
    this.narrationQueue.push(narration);
    this.allNarrations.push(narration);
  }

  /**
   * Generate a narration for an event.
   * Routes to the resolved backend (Ollama or cloud adapter).
   *
   * Returns both the FINAL assembled `ObserverNarration` (used for
   * `allNarrations`/`getNarrations()` — unchanged shape and content, always
   * the complete text) and `streamed`, telling the caller (`emit()`) whether
   * any token-level fragment was already pushed onto `narrationQueue` while
   * this call was in flight — see `onDelta` below. When `streamed` is false
   * the caller queues `result` itself, preserving the pre-streaming
   * single-lump behavior for backends that don't actually stream.
   */
  private async generateNarration(
    event: ObserverEvent
  ): Promise<{ result: ObserverNarration; streamed: boolean } | undefined> {
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
        isFirst // brief opening line — appears faster, still complete
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

      // Token-level streaming (2026-09): each fragment the backend produces is
      // pushed onto narrationQueue IMMEDIATELY as a `partial: true` narration
      // sharing this call's narrationId — the existing poll-based drain loops
      // (interleaveNarration()/drainWhile()) pick these up on their next tick
      // (400ms/500ms) and deliver them to the client as they arrive, instead
      // of the whole narration landing as one chunk only once `content` below
      // is fully assembled. NOTE: the <reasoning>/<think> tag strip below runs
      // on the FULLY ASSEMBLED text, so a thinking-model's tag content can
      // appear transiently in the raw fragment stream before it is known to
      // strip it — an accepted tradeoff of true token streaming (the same
      // trade every token-streaming LLM API makes).
      const narrationId = `${this.strategyName}-${event.type}-${start}-${++this.narrationSeq}`;
      let streamedAnyDelta = false;
      const onDelta = (delta: string): void => {
        if (!delta) return;
        streamedAnyDelta = true;
        this.narrationQueue.push({
          event,
          narration: delta,
          durationMs: Date.now() - start,
          partial: true,
          narrationId,
        });
      };

      let content: string;
      if (this.backend.type === 'ollama') {
        content = await this.callOllama(
          this.backend,
          systemPrompt,
          userPrompt,
          effMaxTokens,
          fastModelId,
          onDelta
        );
      } else {
        content = await this.callCloudAdapter(
          this.backend,
          systemPrompt,
          userPrompt,
          effMaxTokens,
          onDelta
        );
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
        narrationId,
      };

      log.debug(
        {
          event: event.type,
          backend: this.backend.type,
          durationMs: result.durationMs,
          narrationLength: narration.length,
          streamed: streamedAnyDelta,
        },
        'Observer narration generated'
      );

      return { result, streamed: streamedAnyDelta };
    } catch (err) {
      log.debug(
        {
          event: event.type,
          backend: this.backend.type,
          error: err instanceof Error ? err.message : String(err),
        },
        'Observer narration generation failed'
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
   *
   * Requests `stream: true` (Ollama's OpenAI-compatible endpoint supports the
   * same SSE `data: {...}` shape every ProviderAdapter's chatCompletionStream
   * already parses — see openai-compatible-hub-adapter.ts). When the response
   * carries a readable body, tokens are decoded and handed to `onDelta` as
   * they arrive via `consumeSSEStream()`. When it doesn't (a non-streaming
   * sidecar/proxy in front of Ollama, or a test double that returns a plain
   * JSON envelope), falls back to the original single-shot `.json()` read —
   * and deliberately does NOT invoke `onDelta` at all, so
   * `generateNarration()`'s `streamedAnyDelta` stays false and `emit()`
   * queues the single complete narration exactly as it did before token-level
   * streaming existed (see emit()'s doc). Calling `onDelta` here too would
   * make a non-streaming response indistinguishable from a genuinely streamed
   * one, and the final narration would never get queued as a lump.
   */
  private async callOllama(
    backend: Extract<NarrationBackend, { type: 'ollama' }>,
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
    modelIdOverride?: string,
    onDelta?: (delta: string) => void
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
        stream: true,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      log.debug({ status: response.status }, 'Ollama observer returned non-OK');
      return '';
    }

    if (response.body) {
      return this.consumeSSEStream(response.body, onDelta);
    }

    // Fallback: whole-response JSON (non-streaming backend, or a mock that
    // returns a plain envelope regardless of the requested `stream` value).
    // Intentionally does NOT call `onDelta` — see this method's doc comment.
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Read an OpenAI-compatible SSE body (`data: {...}\n\n`, terminated by
   * `data: [DONE]`) and deliver each token's delta to `onDelta` as it decodes,
   * returning the fully assembled text. Mirrors the parsing every
   * ProviderAdapter already does in its own `chatCompletionStream` (see
   * openai-compatible-hub-adapter.ts) — duplicated here (not imported)
   * because the Observer talks to Ollama directly via `fetch`, never through
   * a ProviderAdapter instance.
   */
  private async consumeSSEStream(
    body: ReadableStream<Uint8Array>,
    onDelta?: (delta: string) => void
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line === 'data: [DONE]') continue;
          if (!line.startsWith('data: ')) continue;

          try {
            const payload = JSON.parse(line.slice(6)) as {
              choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
            };
            // Prefer the streaming `delta.content` shape; fall back to
            // `message.content` for a server that sends whole-message JSON
            // objects over an SSE transport instead of true deltas.
            const delta =
              payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              content += delta;
              onDelta?.(delta);
            }
          } catch {
            continue; // malformed/partial line — skip, keep reading
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return content;
  }

  /**
   * Call a cloud model via the ProviderRegistry adapter.
   * Uses a tight timeout — narrations are metadata, not primary responses.
   *
   * Streams via the adapter's own `chatCompletionStream()` (every
   * ProviderAdapter implements it) so tokens reach `onDelta` progressively,
   * exactly like the Ollama path above.
   */
  private async callCloudAdapter(
    backend: Extract<NarrationBackend, { type: 'cloud' }>,
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
    onDelta?: (delta: string) => void
  ): Promise<string> {
    const request: ChatRequest = {
      model: backend.modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
      stream: true,
    };

    let content = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Wrap in a timeout — cloud calls should not delay the main response
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Observer cloud call timed out')), 15000);
    });

    const streamLoop = (async () => {
      for await (const chunk of backend.adapter.chatCompletionStream(request)) {
        const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          content += delta;
          onDelta?.(delta);
        }
      }
    })();

    try {
      await Promise.race([streamLoop, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    return content;
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
            p &&
            typeof p === 'object' &&
            (p as { type?: unknown }).type === 'text' &&
            typeof (p as { text?: unknown }).text === 'string'
              ? (p as { text: string }).text
              : ''
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
    emitImmediate: () => {},
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
      ...(narration.partial ? { partial: true as const } : {}),
      ...(narration.narrationId ? { narration_id: narration.narrationId } : {}),
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
