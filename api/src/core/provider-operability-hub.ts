// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider Operability Hub
 *
 * Single source of truth for provider/route operational status.
 * Aggregates signals from:
 *   - CreditMonitorService (balance probes + runtime 402/403)
 *   - ModelPerformanceTracker (sliding-window reliability)
 *   - CentralDiscoveryService (balance enrichment)
 *
 * Why this exists:
 *   These 3 subsystems can DISAGREE — the credit monitor may say "has-credits"
 *   (stale probe) while the performance tracker marks the provider unreliable
 *   (recent 402s). During the C3 pilot, this disagreement caused a pool collapse
 *   that took out 66% of executions.
 *
 *   The hub resolves this by:
 *   1. Prioritizing RUNTIME signals over probe signals (402 in last 5 min > probe from 10 min ago)
 *   2. Keying by EXECUTION provider, not logical provider (aihubmix failing ≠ openai failing)
 *   3. Supporting fast recovery (success resets no_credits immediately)
 *   4. Exposing a unified state that all consumers trust
 *
 * Architecture: Aggregation, not replacement. The 3 subsystems continue to
 * operate independently. The hub reads their state and produces a unified view.
 */

import { logger } from '@/utils/logger';
import {
  buildRouteKey,
  extractModelFamily,
  type OperabilitySnapshot,
  type RouteOperabilityRecord,
  type ProviderKind,
} from './operability/operability-snapshot';

const log = logger.child({ component: 'provider-operability-hub' });

// ─── Types ──────────────────────────────────────────────────────────────

export type OperabilityState =
  | 'healthy'
  | 'degraded'
  | 'recovering'
  | 'no_credits'
  | 'rate_limited'
  | 'auth_failed'
  | 'temporarily_unavailable'
  | 'dead'
  | 'unknown';

export interface ProviderOperabilityRecord {
  providerKey: string;
  operabilityState: OperabilityState;
  operabilityReasonCode: string;
  balanceStatus: 'has_credits' | 'no_credits' | 'unknown';
  healthScore: number;           // 0-1, from performance tracker
  recentSuccessRate: number;     // 0-1, from performance tracker sliding window
  recentErrorRate: number;       // 0-1, inverse of success rate
  lastSuccessAt: number | null;  // timestamp of last successful execution
  lastFailureAt: number | null;  // timestamp of last failed execution
  cooldownUntil: number | null;  // if rate-limited, when to retry
  isNativeProvider: boolean;     // native (openai, anthropic) vs hub (aihubmix, cometapi)
  updatedAt: number;
}

// ─── Runtime State (in-memory, fast) ────────────────────────────────────

interface RuntimeEvent {
  timestamp: number;
  success: boolean;
  errorType?: 'credit' | 'auth' | 'rate_limit' | 'timeout' | 'server' | 'not_found' | 'unknown';
  httpStatus?: number;
}

const RUNTIME_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RUNTIME_RING_MAX = 100;
const RECOVERY_THRESHOLD = 3;  // 3 consecutive successes → recover from degraded
const COOLDOWN_RATE_LIMIT_MS = 60 * 1000; // 60s cooldown after rate limit

// ── Persistence overlay (Camada 1a) ──────────────────────────────────────
// Per-state TTL for the persisted operability overlay. States NOT listed here
// are transient and are NOT persisted (recovering/degraded/rate_limited/
// temporarily_unavailable/unknown) — they must be re-derived from live runtime
// signal. auth_failed/no_credits persist longer (they do not self-correct);
// healthy persists briefly (proven operability EXPIRES and must be re-proven —
// nothing is statically "always up"). All overridable via env.
const PERSIST_TTL_MS: Partial<Record<OperabilityState, number>> = {
  // #4 (2026-07-02): extended bad-state TTLs so the hub does not FORGET a
  // non-operable provider during idle (prod has no clients yet → no traffic to
  // keep it warm → it expired and the next request re-paid the cold cascade).
  // A real success still overrides via runtime precedence. Belt-and-suspenders:
  // the deterministic credential (#2) + funding (#3) gates are the primary fix.
  auth_failed: Number(process.env.OPERABILITY_PERSIST_TTL_AUTH_MS) || 12 * 60 * 60 * 1000,  // 12h
  no_credits: Number(process.env.OPERABILITY_PERSIST_TTL_CREDITS_MS) || 6 * 60 * 60 * 1000, // 6h
  healthy: Number(process.env.OPERABILITY_PERSIST_TTL_HEALTHY_MS) || 30 * 60 * 1000,        // 30m
  // #1 prove-before-admit (2026-07-01): a 404/model-not-found ROUTE is DEAD (the model
  // does not exist at that provider) — a PERMANENT condition. Persist it long so the
  // selector stops re-picking it (the "404 dead-model not gated" cascade). Route-level
  // only; a real success resets it via runtime precedence.
  dead: Number(process.env.OPERABILITY_PERSIST_TTL_DEAD_MS) || 24 * 60 * 60 * 1000,         // 24h
};
const PERSIST_INTERVAL_MS = Number(process.env.OPERABILITY_PERSIST_INTERVAL_MS) || 60 * 1000; // 60s

interface PersistedOverlay {
  state: OperabilityState;
  reasonCode: string;
  isNative: boolean;
  expiresAt: number;
}

/**
 * Set of providers that are "native" (have their own API key, not routed via hub).
 *
 * Phase 6 Fix 5 (2026-04-30): added 'aws-bedrock' (canonical per
 * provider-kind.ts NATIVE_PROVIDERS / consolidation-matrix.ts /
 * aws-bedrock-model-fetcher.ts). 'bedrock' kept for transitional
 * read-compatibility with the 125 legacy DB rows that still carry
 * provider_id='bedrock' pending operator-bound DB migration.
 */
const NATIVE_PROVIDERS = new Set([
  'openai', 'anthropic', 'google', 'deepseek', 'xai', 'mistral',
  'cohere', 'nvidia', 'meta', 'amazon', 'aws-bedrock', 'bedrock', 'vertex-ai',
]);

/**
 * Self-hosted / local providers — excluded from primary pool.
 *
 * ## Why this set is NOT a duplicate of the catalog
 *
 * This is a classification predicate used to SKIP balance checks, SKIP
 * external-credit monitoring, and EXCLUDE these providers from the
 * primary-pool selection algorithms. It's a cross-cutting policy,
 * independent of the catalog's `integrationClass` field (which answers
 * "how do we talk to this provider", not "does it need credit management").
 *
 * Entries here span two groups:
 *   - OAI-compatible self-hosted (ollama, local-llama, local-kobold,
 *     local-embeddings) — these ALSO have catalog rows with
 *     `integrationClass: 'self-hosted-oai-compat'`. Coherence with the
 *     catalog is checked by
 *     `__tests__/provider-operability-hub.self-hosted.test.ts`.
 *   - Specialty self-hosted (local-ocr, local-docling, local-piper,
 *     local-nllb) — these are intentionally NOT in the catalog because
 *     the catalog's `integrationClass` enum doesn't yet cover their
 *     non-OAI shapes (OCR, PDF-to-JSON, TTS, translation). See the
 *     "5 specialty self-hosted" block in provider-registry.ts for the
 *     documented permanent exception.
 *
 * Reviewed as permanent cross-cutting pattern on 2026-04-22.
 */
const SELF_HOSTED_PROVIDERS = new Set([
  'self-hosted',
  // OAI-compatible self-hosted (also catalog-registered with
  // integrationClass: 'self-hosted-oai-compat' or 'self-hosted-native').
  'ollama', 'local-llama', 'local-kobold', 'local-embeddings',
  'vllm', 'lm-studio', 'xinference', 'triton',
  // Specialty self-hosted (intentionally NOT in catalog — their shapes
  // don't fit the catalog's integrationClass enum today). Documented
  // permanent exception; see provider-registry.ts "5 specialty non-OAI"
  // block.
  'local-ocr', 'local-docling', 'local-piper', 'local-nllb',
]);

/**
 * Returns a defensive copy of the SELF_HOSTED_PROVIDERS classification set.
 * Exposed for coherence tests that cross-check this set against the catalog
 * without importing the module-private constant. Defensive-copy is critical:
 * the Set is a module-level mutable singleton and callers must not mutate it.
 */
export function getSelfHostedProvidersForTesting(): ReadonlySet<string> {
  return new Set(SELF_HOSTED_PROVIDERS);
}

// ─── Hub Singleton ──────────────────────────────────────────────────────

/** Hub providers (route requests through other providers' models) */
const HUB_PROVIDERS = new Set([
  'aihubmix', 'openrouter', 'orqai', 'edenai', 'heliconeai', 'cometapi',
]);

class ProviderOperabilityHubImpl {
  private readonly runtimeEvents = new Map<string, RuntimeEvent[]>();
  private readonly manualOverrides = new Map<string, { state: OperabilityState; until: number }>();
  private snapshotVersion = 0;

  // Persisted overlay (Camada 1a): last-known state per flat provider key,
  // loaded from the DB on boot (hydrateFromStore) and consulted by
  // getProviderState ONLY when there is no fresh runtime event. Runtime always
  // wins; expired entries are ignored. Flushed back periodically by
  // startPersistence(). This is what stops the hub from resetting to "0 healthy
  // providers" on every restart — without introducing any static model.
  private readonly persistedOverlay = new Map<string, PersistedOverlay>();
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  // Catalog bootstrap floor (2026-05-11 spec, implemented 2026-07-03): keys seeded
  // at boot so the hub's known universe is non-empty before any runtime traffic.
  // A bootstrapped key is KNOWN but its state stays derived from runtime signals —
  // bootstrap never creates events, so getProviderState() reports 'unknown' until
  // real observations arrive (runtime events always win). Not persisted: re-seeded
  // from the catalog on every boot.
  private readonly bootstrappedProviders = new Map<string, { source: string; addedAt: number }>();

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Get the unified operability state for a provider.
   *
   * This is the ONLY function consumers should call to determine if a
   * provider is usable. It aggregates:
   *   1. Runtime events from this process (most recent, highest priority)
   *   2. Credit monitor state (periodic probes)
   *   3. Performance tracker state (sliding window reliability)
   *   4. Manual overrides (admin/debug)
   */
  getProviderState(providerKey: string): ProviderOperabilityRecord {
    const key = providerKey.toLowerCase();
    const now = Date.now();

    // Manual override takes precedence (admin can force a state)
    const override = this.manualOverrides.get(key);
    if (override && override.until > now) {
      return this.buildRecord(key, override.state, 'manual_override', now);
    }

    // Get runtime events (last 10 min)
    const events = this.getRecentEvents(key);

    // Determine state from runtime events
    if (events.length === 0) {
      // Persistence overlay (Camada 1a): with no fresh runtime signal, fall back
      // to the last-known persisted state (e.g. right after a restart) instead
      // of forgetting to 'unknown'. Runtime events always take precedence (this
      // branch only runs when there are none); expired overlay entries fall
      // through to 'unknown' so proven operability must be re-proven.
      const overlay = this.persistedOverlay.get(key);
      if (overlay && overlay.expiresAt > now) {
        return this.buildRecord(key, overlay.state, `persisted_${overlay.reasonCode}`, now);
      }
      return this.buildRecord(key, 'unknown', 'no_runtime_data', now);
    }

    // Check for rate limiting cooldown
    const lastRateLimit = events.filter((e: RuntimeEvent) => e.errorType === 'rate_limit').pop();
    if (lastRateLimit && lastRateLimit.timestamp + COOLDOWN_RATE_LIMIT_MS > now) {
      return this.buildRecord(key, 'rate_limited', 'recent_429', now, lastRateLimit.timestamp + COOLDOWN_RATE_LIMIT_MS);
    }

    // Check for credit exhaustion (most recent credit-related event)
    const lastCreditEvent = events.filter((e: RuntimeEvent) => e.errorType === 'credit').pop();
    const lastSuccess = events.filter((e: RuntimeEvent) => e.success).pop();

    // If last credit error is MORE RECENT than last success → no_credits
    if (lastCreditEvent && (!lastSuccess || lastCreditEvent.timestamp > lastSuccess.timestamp)) {
      return this.buildRecord(key, 'no_credits', 'runtime_credit_error', now);
    }

    // Check for auth failure
    const lastAuthEvent = events.filter((e: RuntimeEvent) => e.errorType === 'auth').pop();
    if (lastAuthEvent && (!lastSuccess || lastAuthEvent.timestamp > lastSuccess.timestamp)) {
      return this.buildRecord(key, 'auth_failed', 'runtime_auth_error', now);
    }

    // #1 prove-before-admit: DEAD route (404/model-not-found) — permanent condition,
    // gate it until a real success proves the model came back (runtime precedence).
    // ROUTE-level only (key has ':'): one dead model must NOT kill the whole provider.
    const lastNotFound = events.filter((e: RuntimeEvent) => e.errorType === 'not_found').pop();
    if (lastNotFound && key.includes(':') && (!lastSuccess || lastNotFound.timestamp > lastSuccess.timestamp)) {
      return this.buildRecord(key, 'dead', 'model_not_found', now);
    }

    // Calculate recent success rate
    const recentEvents = events.filter((e: RuntimeEvent) => e.timestamp > now - RUNTIME_WINDOW_MS);
    const successCount = recentEvents.filter((e: RuntimeEvent) => e.success).length;
    const failureCount = recentEvents.filter((e: RuntimeEvent) => !e.success).length;
    const total = recentEvents.length;
    const successRate = total > 0 ? successCount / total : 0;

    // Recovering: had failures but recent successes streak
    const last3 = events.slice(-RECOVERY_THRESHOLD);
    const last3AllSuccess = last3.length >= RECOVERY_THRESHOLD && last3.every((e: RuntimeEvent) => e.success);
    if (failureCount > 0 && last3AllSuccess) {
      return this.buildRecord(key, 'recovering', 'recent_recovery_streak', now);
    }

    // Degraded: >40% failure rate with enough samples
    if (total >= 3 && successRate < 0.6) {
      return this.buildRecord(key, 'degraded', `high_failure_rate_${(successRate * 100).toFixed(0)}pct`, now);
    }

    // Temporarily unavailable: recent server errors
    const lastServerError = events.filter((e: RuntimeEvent) => e.errorType === 'server').pop();
    if (lastServerError && (!lastSuccess || lastServerError.timestamp > lastSuccess.timestamp)) {
      return this.buildRecord(key, 'temporarily_unavailable', 'server_error', now);
    }

    // Healthy
    return this.buildRecord(key, 'healthy', 'operational', now);
  }

  /**
   * Record a runtime execution result (flat key — backward compat).
   *
   * Called by base-strategy.ts after every model execution attempt.
   * The providerKey MUST be the EXECUTION provider (adapter.getName()),
   * NOT the logical provider from model metadata.
   *
   * For route-level precision (hub vs native isolation), prefer
   * `recordRouteExecution()` which also records against the composite route.
   */
  recordExecution(providerKey: string, success: boolean, httpStatus?: number, errorMessage?: string): void {
    this.recordEvent(providerKey.toLowerCase(), success, httpStatus, errorMessage);
  }

  /**
   * Record a credential/credit PROBE verdict (proactive operability, Camada 1b).
   *
   * Translates a discovery probe result into a synthetic runtime event so the
   * hub's DERIVED state reflects PROVEN operability — not just organic traffic.
   * This is the bridge that lets discovery probes (which historically only fed
   * ProviderHealthRegistry) also populate this hub, so the hub (and the persisted
   * overlay, Camada 1a) know a provider is healthy/auth_failed/no_credits BEFORE
   * any user request hits it. Dynamic by construction — the verdict comes from a
   * live probe, never a static list. A probe event carries the same weight as an
   * execution event, so real runtime signal still overrides it on the next call.
   */
  recordProbeResult(
    providerKey: string,
    state: 'healthy' | 'auth_failed' | 'insufficient_credit' | 'unknown',
    reason?: string,
  ): void {
    const key = providerKey.toLowerCase();
    switch (state) {
      case 'healthy': {
        // A discovery PROBE 'healthy' is WEAKER than a real execution success —
        // it does NOT prove inference credits (an out-of-credit provider still
        // passes an env-key / model-list probe). So it must NOT clear a
        // runtime-observed no_credits/auth_failed; only a real execution success
        // (recordExecution / recordRouteExecution) may. Otherwise the periodic
        // ~5-min discovery sweep re-heals every provider that failed 402/403 and
        // the selector keeps re-picking dead routes (the observed bug: 68/71
        // stamped healthy despite runtime failures).
        const current = this.getProviderState(key).operabilityState;
        if (current === 'no_credits' || current === 'auth_failed') {
          break;
        }
        this.recordEvent(key, true, 200);
        break;
      }
      case 'auth_failed':
        this.recordEvent(key, false, 401, reason ?? 'probe: auth_failed');
        break;
      case 'insufficient_credit':
        this.recordEvent(key, false, 402, reason ?? 'probe: insufficient credit/balance');
        break;
      case 'unknown':
        // No signal — do not record, so an inconclusive probe never masks real
        // runtime state (or a previously-persisted overlay).
        break;
    }
  }

  /**
   * Record a runtime execution with route-level granularity.
   *
   * For hub providers (aihubmix, cometapi, openrouter, etc.), this creates
   * a composite route key like "aihubmix:openai" so that:
   *   - A failure on aihubmix→openai does NOT degrade aihubmix→anthropic
   *   - A failure on aihubmix→openai does NOT degrade native openai
   *
   * For native providers, the route key equals the provider key.
   *
   * @param executionProvider - The adapter that ran the call (adapter.getName())
   * @param modelId - The model ID (e.g., "openai/gpt-4o-mini-search-preview")
   * @param success - Whether the call succeeded
   * @param httpStatus - HTTP status code (if available)
   * @param errorMessage - Error message (if failed)
   */
  recordRouteExecution(
    executionProvider: string,
    modelId: string,
    success: boolean,
    httpStatus?: number,
    errorMessage?: string,
  ): void {
    const ep = executionProvider.toLowerCase();

    // Always record against the flat execution provider key (backward compat)
    this.recordEvent(ep, success, httpStatus, errorMessage);

    // For hub/aggregator providers, also record against the composite route key
    if (!this.isNativeProvider(ep) && !this.isSelfHostedProvider(ep)) {
      const modelFamily = extractModelFamily(modelId);
      if (modelFamily) {
        const routeKey = buildRouteKey(ep, modelFamily);
        if (routeKey !== ep) {
          this.recordEvent(routeKey, success, httpStatus, errorMessage);
        }
      }
    }
  }

  /**
   * Check if a specific route is usable (route-level precision).
   * Falls back to provider-level check if no route data exists.
   */
  isRouteUsable(executionProvider: string, modelId: string): boolean {
    const ep = executionProvider.toLowerCase();
    const modelFamily = extractModelFamily(modelId);
    const routeKey = buildRouteKey(ep, modelFamily);

    // Check route-specific state first
    const routeEvents = this.runtimeEvents.get(routeKey);
    if (routeEvents && routeEvents.length > 0) {
      return this.isProviderUsable(routeKey);
    }
    // Fall back to provider-level state
    return this.isProviderUsable(ep);
  }

  /**
   * Get the operability state for a specific route.
   */
  getRouteState(executionProvider: string, modelId: string): ProviderOperabilityRecord {
    const ep = executionProvider.toLowerCase();
    const modelFamily = extractModelFamily(modelId);
    const routeKey = buildRouteKey(ep, modelFamily);

    // Check route-specific state first
    const routeEvents = this.runtimeEvents.get(routeKey);
    if (routeEvents && routeEvents.length > 0) {
      return this.getProviderState(routeKey);
    }
    // Fall back to provider-level state
    return this.getProviderState(ep);
  }

  /**
   * Is a route HOT — proven serving RIGHT NOW (a success within the hot window
   * AND no fresher failure)? Used by selection/retry to PREFER already-warm
   * routes so HF serverless backends (featherless/etc.) are not cold-loaded on
   * the hot path — the core of HF determinism. Reuses the route record's
   * lastSuccessAt/lastFailureAt — no new storage. Window via
   * OPERABILITY_HOT_ROUTE_TTL_MS (default 5min, ~the provider keep-warm window).
   */
  isRouteHot(
    executionProvider: string,
    modelId: string,
    maxAgeMs: number = Number(process.env.OPERABILITY_HOT_ROUTE_TTL_MS) || 300_000,
  ): boolean {
    const rec = this.getRouteState(executionProvider, modelId);
    if (rec.lastSuccessAt == null) return false;
    if (rec.lastSuccessAt <= Date.now() - maxAgeMs) return false;
    if (rec.lastFailureAt != null && rec.lastFailureAt > rec.lastSuccessAt) return false;
    return true;
  }

  /**
   * Generate a serializable snapshot of all known operability state.
   *
   * The snapshot includes route-level granularity for hub providers.
   * Used by: CreditGovernor, PoolBuilder, PreDispatchValidator, analytics.
   */
  getSnapshot(): OperabilitySnapshot {
    const now = Date.now();
    const routes: Record<string, RouteOperabilityRecord> = {};
    const summary: Record<OperabilityState, number> = {
      healthy: 0, degraded: 0, recovering: 0, no_credits: 0,
      rate_limited: 0, auth_failed: 0, temporarily_unavailable: 0, dead: 0, unknown: 0,
    };
    const externalSummary: Record<OperabilityState, number> = { ...summary };

    for (const key of this.runtimeEvents.keys()) {
      const record = this.getProviderState(key);
      const providerKind = this.classifyProviderKind(key);
      const { executionProvider, modelFamily } = this.parseRouteKeyInternal(key);

      const routeRecord: RouteOperabilityRecord = {
        ...record,
        routeKey: key,
        executionProvider,
        modelFamily,
        providerKind,
        parentHub: providerKind === 'hub' || providerKind === 'aggregator' || providerKind === 'router'
          ? executionProvider
          : null,
      };

      routes[key] = routeRecord;
      summary[record.operabilityState]++;

      if (providerKind !== 'self_hosted') {
        externalSummary[record.operabilityState]++;
      }
    }

    const usableStates: OperabilityState[] = ['healthy', 'recovering', 'degraded', 'unknown'];
    const externalEligibleCount = usableStates.reduce((sum, s) => sum + (externalSummary[s] || 0), 0);
    const totalExternal = Object.values(externalSummary).reduce((a, b) => a + b, 0);

    return {
      version: ++this.snapshotVersion,
      createdAt: new Date(now).toISOString(),
      routes,
      summary,
      externalSummary,
      externalEligibleCount,
      allExternalExhausted: totalExternal > 0 && externalEligibleCount === 0,
    };
  }

  private recordEvent(key: string, success: boolean, httpStatus?: number, errorMessage?: string): void {
    const event: RuntimeEvent = {
      timestamp: Date.now(),
      success,
      httpStatus,
    };

    if (!success) {
      // Classify on ANY failure, not only message-bearing ones: classifyError is
      // status-aware (it takes httpStatus), so a bare 403 (Cloudflare IP-ban with
      // no body) must still resolve to 'auth' and stick — the `&& errorMessage`
      // guard silently dropped status-only failures back to 'unknown', letting the
      // selector keep re-picking a banned route. classifyError defaults to
      // 'unknown' when neither status nor message carries a signal, so this is safe.
      event.errorType = this.classifyError(httpStatus, errorMessage);
    }

    let ring = this.runtimeEvents.get(key);
    if (!ring) {
      ring = [];
      this.runtimeEvents.set(key, ring);
    }
    ring.push(event);

    // Trim old events
    const cutoff = Date.now() - RUNTIME_WINDOW_MS;
    while (ring.length > 0 && ring[0].timestamp < cutoff) ring.shift();
    if (ring.length > RUNTIME_RING_MAX) ring.splice(0, ring.length - RUNTIME_RING_MAX);

    // WRITE-THROUGH durable-failure persist (2026-06-29): no_credits/auth_failed are
    // PROVIDER-WIDE, slow-to-self-correct conditions (billing/invalid key). The 10-min
    // runtime window ages the event out before the periodic persist timer captures it,
    // so after the window (or a restart) the hub FORGETS an unfunded/invalid provider
    // and the judge/selector re-pick it — wasting the first cascade attempt on every
    // cold start (measured: the dynamic judge kept re-trying anthropic 400 no_credits).
    // Persist these immediately (provider-level keys only; route keys are derived) so
    // they survive the window AND restarts. A later REAL success overrides via runtime
    // precedence + the next healthy persist, so a re-funded provider still recovers.
    if (
      !success &&
      !key.includes(':') &&
      (event.errorType === 'credit' || event.errorType === 'auth')
    ) {
      const state: OperabilityState = event.errorType === 'credit' ? 'no_credits' : 'auth_failed';
      void this.persistDurableState(key, state, `runtime_${event.errorType}_error`);
    }

    // #1 prove-before-admit: persist DEAD routes (404/model-not-found) so a dead model
    // is not re-selected after the runtime window / restart. ROUTE-level only (key has
    // ':') — the provider itself is fine; only this specific model route is dead.
    if (!success && event.errorType === 'not_found' && key.includes(':')) {
      void this.persistDurableState(key, 'dead', 'runtime_model_not_found');
    }
  }

  /**
   * Immediately persist a durable provider-wide failure (no_credits/auth_failed) to
   * BOTH the in-memory overlay (instant effect once the runtime event ages out) and
   * the DB snapshot (survives restart), using the same per-state TTL as the periodic
   * persister. Fire-and-forget from recordEvent; never throws.
   */
  private async persistDurableState(
    key: string,
    state: OperabilityState,
    reasonCode: string,
  ): Promise<void> {
    const ttl = PERSIST_TTL_MS[state];
    if (!ttl) return;
    const now = Date.now();
    const expiresAtMs = now + ttl;
    const isNative = this.isNativeProvider(key);
    // In-memory first so it takes effect even if the DB write fails.
    this.persistedOverlay.set(key, { state, reasonCode, isNative, expiresAt: expiresAtMs });
    try {
      const { prisma } = await import('@/database/client.js');
      const data = {
        state,
        reasonCode,
        isNative,
        observedAt: new Date(now),
        expiresAt: new Date(expiresAtMs),
      };
      await prisma.providerOperabilitySnapshot.upsert({
        where: { providerKey: key },
        create: { providerKey: key, ...data },
        update: data,
      });
    } catch (err) {
      log.warn({ err: String(err), key, state }, 'durable-failure write-through persist failed');
    }
  }

  /**
   * Get all providers in a specific state.
   */
  getProvidersByState(state: OperabilityState): string[] {
    const result: string[] = [];
    for (const key of this.runtimeEvents.keys()) {
      if (this.getProviderState(key).operabilityState === state) {
        result.push(key);
      }
    }
    return result;
  }

  /**
   * Check if a provider is usable for execution.
   * Returns true for: healthy, recovering, degraded, unknown
   * Returns false for: no_credits, rate_limited, auth_failed, temporarily_unavailable
   */
  isProviderUsable(providerKey: string): boolean {
    const state = this.getProviderState(providerKey).operabilityState;
    return state === 'healthy' || state === 'recovering' || state === 'degraded' || state === 'unknown';
  }

  /**
   * Check if a provider is native (has own API key) vs hub/aggregator.
   */
  isNativeProvider(providerKey: string): boolean {
    return NATIVE_PROVIDERS.has(providerKey.toLowerCase());
  }

  /**
   * Check if a provider is self-hosted/local.
   */
  isSelfHostedProvider(providerKey: string): boolean {
    const key = providerKey.toLowerCase();
    return SELF_HOSTED_PROVIDERS.has(key) || key.startsWith('local-') || key.includes('local');
  }

  /**
   * Force a provider into a specific state (admin/debug use).
   * Auto-expires after ttlMs.
   */
  setManualOverride(providerKey: string, state: OperabilityState, ttlMs: number = 300_000): void {
    this.manualOverrides.set(providerKey.toLowerCase(), {
      state,
      until: Date.now() + ttlMs,
    });
    log.warn({ provider: providerKey, state, ttlMs }, 'Manual operability override set');
  }

  /**
   * Seed catalog providers into the hub's known universe (boot-time floor).
   *
   * Why: the hub used to be empty at boot (it only tracked runtime events), so
   * pre-dispatch validators saw an empty summary and mis-classified it as
   * "no_eligible_providers" — a permanent verdict that blocked every C3
   * execution before any provider call (2026-05-11).
   *
   * Bootstrap is a FLOOR, not an observation: seeded keys appear in
   * `getSummary().unknown` but their state derivation is untouched — runtime
   * events, probes, and the persisted overlay always win. Idempotent and
   * case-insensitive (keys are lower-cased like everywhere else in the hub).
   */
  bootstrapKnownProviders(
    providerIds: readonly string[],
    source: string,
  ): { added: number; alreadyKnown: number; total: number } {
    const now = Date.now();
    let added = 0;
    let alreadyKnown = 0;
    for (const id of providerIds) {
      const key = id.toLowerCase();
      if (this.isKnownKey(key, now)) {
        alreadyKnown += 1;
        continue;
      }
      this.bootstrappedProviders.set(key, { source, addedAt: now });
      added += 1;
    }
    return { added, alreadyKnown, total: this.getKnownProviderCount() };
  }

  /** Size of the hub's known universe (runtime events ∪ bootstrap ∪ active overrides). */
  getKnownProviderCount(): number {
    return this.knownKeys().size;
  }

  private isKnownKey(key: string, now: number = Date.now()): boolean {
    if (this.bootstrappedProviders.has(key)) return true;
    if (this.runtimeEvents.has(key)) return true;
    const override = this.manualOverrides.get(key);
    return !!override && override.until > now;
  }

  private knownKeys(): Set<string> {
    const now = Date.now();
    const keys = new Set<string>(this.runtimeEvents.keys());
    for (const key of this.bootstrappedProviders.keys()) keys.add(key);
    for (const [key, override] of this.manualOverrides.entries()) {
      if (override.until > now) keys.add(key);
    }
    return keys;
  }

  /**
   * Get a summary of all known provider states.
   * Useful for dashboards and pre-dispatch validation.
   *
   * Covers the full known universe: runtime-event keys, catalog-bootstrapped
   * keys (reported under their derived state — 'unknown' until proven), and
   * active manual overrides.
   */
  getSummary(): Record<OperabilityState, string[]> {
    const summary: Record<OperabilityState, string[]> = {
      healthy: [],
      degraded: [],
      recovering: [],
      no_credits: [],
      rate_limited: [],
      auth_failed: [],
      temporarily_unavailable: [],
      dead: [],
      unknown: [],
    };
    for (const key of this.knownKeys()) {
      const state = this.getProviderState(key).operabilityState;
      summary[state].push(key);
    }
    return summary;
  }

  /**
   * Map of every provider/route key the hub currently knows about → the
   * signal source(s) that made it known plus when it became known. A key is
   * "known" if it was catalog-bootstrapped, has runtime events recorded,
   * and/or has an active manual override.
   *
   * Audit scripts use `Object.keys(getKnownProviderSources())` to enumerate
   * the hub's live universe (vs. the catalog's static universe). `source` is
   * a short, stable provenance string (composed with '+' when multiple
   * signals apply) so a caller can reason about WHY a key is known without a
   * second hub call; `addedAt` is the earliest known-since timestamp.
   */
  getKnownProviderSources(): Record<string, { source: string; addedAt: number }> {
    const now = Date.now();
    const sources: Record<string, { source: string; addedAt: number }> = {};

    for (const [key, entry] of this.bootstrappedProviders.entries()) {
      sources[key] = { source: entry.source, addedAt: entry.addedAt };
    }

    for (const [key, events] of this.runtimeEvents.entries()) {
      const firstSeen = events[0]?.timestamp ?? now;
      sources[key] = sources[key]
        ? {
            source: `${sources[key].source}+runtime_events`,
            addedAt: Math.min(sources[key].addedAt, firstSeen),
          }
        : { source: 'runtime_events', addedAt: firstSeen };
    }

    for (const [key, override] of this.manualOverrides.entries()) {
      if (override.until <= now) continue; // expired overrides are not "known"
      sources[key] = sources[key]
        ? { source: `${sources[key].source}+manual_override`, addedAt: sources[key].addedAt }
        : { source: 'manual_override', addedAt: now };
    }

    return sources;
  }

  // ── Persistence (Camada 1a) ─────────────────────────────────────────

  /**
   * Rehydrate the persisted operability overlay from the DB. Call ONCE on boot
   * (before serving traffic) so a freshly-restarted process remembers the last
   * known provider states instead of reporting everything as 'unknown' / "0
   * healthy providers". Only non-expired rows are loaded. Never throws — a
   * cold/unavailable DB just yields an empty overlay (today's behaviour).
   */
  async hydrateFromStore(): Promise<{ loaded: number }> {
    try {
      const { prisma } = await import('@/database/client.js');
      const now = Date.now();
      const rows = await prisma.providerOperabilitySnapshot.findMany({
        where: { expiresAt: { gt: new Date(now) } },
      });
      let loaded = 0;
      for (const row of rows) {
        this.persistedOverlay.set(row.providerKey, {
          state: row.state as OperabilityState,
          // Collapse any accumulated 'persisted_' display prefix from older
          // corrupted rows back to the clean reason on boot.
          reasonCode: row.reasonCode.replace(/^(?:persisted_)+/, ''),
          isNative: row.isNative,
          expiresAt: row.expiresAt.getTime(),
        });
        loaded++;
      }
      log.info({ loaded }, 'Operability overlay hydrated from store');
      return { loaded };
    } catch (err) {
      log.warn({ err: String(err) }, 'Operability overlay hydrate failed (continuing cold)');
      return { loaded: 0 };
    }
  }

  /**
   * Persist the current DERIVED state of every known flat provider key whose
   * state is persistable (see PERSIST_TTL_MS). Transient states are skipped.
   * Upserts with a per-state TTL and keeps the in-memory overlay coherent.
   * Never throws.
   */
  async persistToStore(): Promise<{ persisted: number }> {
    try {
      const { prisma } = await import('@/database/client.js');
      const now = Date.now();
      let persisted = 0;
      for (const key of this.runtimeEvents.keys()) {
        if (key.includes(':')) continue; // composite route keys are provider-level-derived; snapshot is per-provider
        const record = this.getProviderState(key);
        const ttl = PERSIST_TTL_MS[record.operabilityState];
        if (!ttl) continue; // transient state → not persisted
        const expiresAtMs = now + ttl;
        // reasonCode carries a read-time 'persisted_' DISPLAY prefix when it came
        // from the overlay branch of getProviderState. Strip it before writing so
        // it never re-accumulates (was growing 'persisted_persisted_..._error'
        // unbounded on every 60s persist cycle). Idempotent — also self-heals
        // already-corrupted rows on the next persist tick.
        const rawReason = record.operabilityReasonCode.replace(/^(?:persisted_)+/, '');
        const data = {
          state: record.operabilityState,
          reasonCode: rawReason,
          isNative: record.isNativeProvider,
          observedAt: new Date(now),
          expiresAt: new Date(expiresAtMs),
        };
        await prisma.providerOperabilitySnapshot.upsert({
          where: { providerKey: key },
          create: { providerKey: key, ...data },
          update: data,
        });
        this.persistedOverlay.set(key, {
          state: record.operabilityState,
          reasonCode: rawReason,
          isNative: record.isNativeProvider,
          expiresAt: expiresAtMs,
        });
        persisted++;
      }
      return { persisted };
    } catch (err) {
      log.warn({ err: String(err) }, 'Operability overlay persist failed');
      return { persisted: 0 };
    }
  }

  /**
   * Start periodic persistence of the operability overlay. Idempotent. The
   * timer is unref'd so it never keeps the process alive on its own.
   */
  startPersistence(intervalMs: number = PERSIST_INTERVAL_MS): void {
    if (this.persistTimer) return;
    this.persistTimer = setInterval(() => { void this.persistToStore(); }, intervalMs);
    if (typeof this.persistTimer.unref === 'function') this.persistTimer.unref();
    log.info({ intervalMs }, 'Operability overlay persistence started');
  }

  /** Stop periodic persistence (shutdown / tests). */
  stopPersistence(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
  }

  /**
   * Test-only: seed the persisted overlay without a DB round-trip, mirroring
   * the pattern of getSelfHostedProvidersForTesting. Lets unit tests exercise
   * the getProviderState overlay branch deterministically.
   */
  setPersistedOverlayForTesting(
    providerKey: string,
    state: OperabilityState,
    reasonCode: string,
    expiresAt: number,
  ): void {
    const key = providerKey.toLowerCase();
    this.persistedOverlay.set(key, {
      state,
      reasonCode,
      isNative: NATIVE_PROVIDERS.has(key),
      expiresAt,
    });
  }

  // ── Private ─────────────────────────────────────────────────────────

  private getRecentEvents(key: string): RuntimeEvent[] {
    const ring = this.runtimeEvents.get(key);
    if (!ring) return [];
    const cutoff = Date.now() - RUNTIME_WINDOW_MS;
    return ring.filter(e => e.timestamp >= cutoff);
  }

  private classifyError(httpStatus?: number, errorMessage?: string): RuntimeEvent['errorType'] {
    const msg = (errorMessage || '').toLowerCase();

    // Credit/balance errors. Two paths:
    //  (a) 402/403 with any credit-ish wording (the classic signal), OR
    //  (b) an UNAMBIGUOUS credit-balance message on ANY status — critical because
    //      Anthropic returns HTTP 400 with "Your credit balance is too low" (NOT
    //      402/403), so a status-only gate misclassified it as 'unknown' → the
    //      provider was never marked no_credits → the judge/selector re-picked it on
    //      every cold start, wasting the first cascade attempt (2026-06-29).
    const creditWords =
      msg.includes('insufficient') || msg.includes('balance') || msg.includes('quota') ||
      msg.includes('credit') || msg.includes('funds') || msg.includes('subscription') ||
      msg.includes('payment') || msg.includes('top up') || msg.includes('recharge');
    const unambiguousCredit =
      msg.includes('credit balance') || msg.includes('balance is too low') ||
      msg.includes('insufficient') || msg.includes('out of credit') ||
      msg.includes('top up') || msg.includes('recharge') || msg.includes('billing');
    if (((httpStatus === 402 || httpStatus === 403) && creditWords) || unambiguousCredit) {
      return 'credit';
    }

    // Auth / forbidden errors. Note: some providers (e.g. Google Generative AI)
    // signal an invalid key as API_KEY_INVALID / "API key not valid" rather than
    // 401 — and the Google adapter further normalizes its status to 500 — so we
    // match these message variants regardless of status.
    //
    // A non-credit 403 is a FORBIDDEN/ban (e.g. routeway returned a Cloudflare
    // "error 1006 — the owner has banned your IP address" HTML page). Before, a
    // credit-less 403 fell through to 'unknown', so a hard IP ban did NOT stick —
    // it only degraded the route after ≥3 failures while the selector kept
    // re-picking the banned route on every request. Classifying it as 'auth'
    // (sticky, 12h TTL, self-heals on a real success) gates it after the FIRST
    // ban. Credit-403s were already caught above; this is the forbidden path.
    if (httpStatus === 401 || httpStatus === 403 || msg.includes('unauthorized') ||
        msg.includes('forbidden') || msg.includes('access denied') || msg.includes('banned') ||
        msg.includes('invalid api key') ||
        msg.includes('api key not valid') || msg.includes('api_key_invalid') || msg.includes('invalid_api_key') ||
        msg.includes('api key invalid') || msg.includes('api key expired') ||
        msg.includes('authentication') || msg.includes('not configured')) {
      return 'auth';
    }

    // Rate limiting
    if (httpStatus === 429 || msg.includes('rate limit') || msg.includes('rate_limit') ||
        msg.includes('too many requests')) {
      return 'rate_limit';
    }

    // Server errors
    if (httpStatus && httpStatus >= 500) {
      return 'server';
    }

    // Timeout
    if (msg.includes('timeout') || msg.includes('aborted') || msg.includes('etimedout')) {
      return 'timeout';
    }

    // Dead model/route: a 404 (or explicit model-not-found wording) means the model
    // does not exist at this provider — PERMANENT, not transient. Gate it so the
    // selector stops re-picking a dead route (the "404 dead-model not gated" cascade).
    if (httpStatus === 404 || msg.includes('model_not_found') || msg.includes('model not found') ||
        msg.includes('no such model') || msg.includes('model does not exist') ||
        msg.includes('does not exist') || msg.includes('unknown model')) {
      return 'not_found';
    }

    return 'unknown';
  }

  private classifyProviderKind(key: string): ProviderKind {
    // Route keys like "aihubmix:openai" → extract the execution provider part
    const ep = key.includes(':') ? key.split(':')[0] : key;
    if (SELF_HOSTED_PROVIDERS.has(ep) || ep.startsWith('local-') || ep.includes('local')) {
      return 'self_hosted';
    }
    if (NATIVE_PROVIDERS.has(ep)) return 'native';
    if (HUB_PROVIDERS.has(ep)) return 'hub';
    // Unknown → treat as aggregator (conservative)
    return 'aggregator';
  }

  private parseRouteKeyInternal(key: string): { executionProvider: string; modelFamily: string | null } {
    const parts = key.split(':');
    if (parts.length === 1) {
      return { executionProvider: parts[0], modelFamily: null };
    }
    return { executionProvider: parts[0], modelFamily: parts[1] };
  }

  private buildRecord(
    key: string,
    state: OperabilityState,
    reasonCode: string,
    now: number,
    cooldownUntil?: number,
  ): ProviderOperabilityRecord {
    const events = this.getRecentEvents(key);
    const successEvents = events.filter(e => e.success);
    const failureEvents = events.filter(e => !e.success);
    const total = events.length;

    return {
      providerKey: key,
      operabilityState: state,
      operabilityReasonCode: reasonCode,
      balanceStatus: state === 'no_credits' ? 'no_credits'
        : (successEvents.length > 0 ? 'has_credits' : 'unknown'),
      healthScore: total > 0 ? successEvents.length / total : 0.5,
      recentSuccessRate: total > 0 ? successEvents.length / total : 0,
      recentErrorRate: total > 0 ? failureEvents.length / total : 0,
      lastSuccessAt: successEvents.length > 0 ? successEvents[successEvents.length - 1].timestamp : null,
      lastFailureAt: failureEvents.length > 0 ? failureEvents[failureEvents.length - 1].timestamp : null,
      cooldownUntil: cooldownUntil ?? null,
      isNativeProvider: NATIVE_PROVIDERS.has(key),
      updatedAt: now,
    };
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: ProviderOperabilityHubImpl | null = null;

export function getProviderOperabilityHub(): ProviderOperabilityHubImpl {
  if (!instance) {
    instance = new ProviderOperabilityHubImpl();
  }
  return instance;
}

export type ProviderOperabilityHub = ProviderOperabilityHubImpl;
