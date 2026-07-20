// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderDiscoveryService — first version (Phase 1).
 *
 * Goal: produce a `ProviderDiscoverySnapshot` that explains, for every
 * configured provider, whether it's available, what its health state is,
 * and which models can be enumerated. Discovery failures NEVER cascade —
 * a probe failure on provider X must not affect provider Y.
 *
 * Phase 1 scope:
 *   - Configurable list of providers (operator passes them in).
 *   - Per-provider probe via the resolved `ProviderProbeStrategy`.
 *   - Updates the `ProviderHealthRegistry` with the outcome.
 *   - Emits `CandidateTrace` for every stage (configured →
 *     credential_validated → endpoint_validated → models_listed →
 *     operational_pool).
 *   - Bounded concurrency via simple semaphore (no external pool lib).
 *   - Per-provider timeout via AbortController.
 *
 * Out of scope for Phase 1 (intentional):
 *   - Real listModels HTTP calls — this version uses callbacks injected
 *     by adapters. Wiring per-adapter probe IO is a follow-up step that
 *     touches every adapter; doing it here would balloon the change.
 *   - LISTEN/NOTIFY refresh on catalog change — periodic refresh only.
 *   - Redis pub/sub propagation of the snapshot — process-local only.
 */

import { logger } from '@/utils/logger';
import { narrowAs } from '@/utils/type-guards';
import {
  type DiscoveryConfidence,
  type DiscoveredModel,
  type ProviderDiscoveryResult,
  type ProviderDiscoverySnapshot,
  type ProviderErrorClass,
  type ProviderHealthState,
  type ProviderProbeStrategy,
} from './types';
import { resolveProbeStrategy } from './probe-strategy';
import { getProviderHealthRegistry } from './provider-health-registry';
import { getProviderOperabilityHub } from '../provider-operability-hub';
import { emitCandidateTrace } from './candidate-trace';
import {
  METRIC_NAMES,
  incrementCounter,
  observeHistogram,
} from './metrics';

const log = logger.child({ component: 'provider-discovery-service' });

// ─── Config types ──────────────────────────────────────────────────────────

export interface ConfiguredProvider {
  providerId: string;
  /** From the catalog row; used to resolve default probe strategy. */
  integrationClass?: string;
  /** Env var that should hold the API key. */
  apiKeyEnvVar?: string;
  /** Probe strategy override. */
  probeStrategy?: ProviderProbeStrategy;
}

/**
 * Adapter-side probe callbacks. Each is optional — if missing, the
 * corresponding probe is treated as `not_supported` and contributes
 * `partially_verified` to the discovery confidence.
 *
 * The discovery service does NOT make HTTP calls itself — it delegates to
 * these callbacks. This keeps adapter-specific knowledge (auth schemes,
 * billing endpoints, error shapes) in the adapter layer.
 */
export interface ProviderProbeCallbacks {
  /**
   * Validates that the credential is well-formed AND accepted by the
   * provider. May call the provider's auth endpoint or `/v1/models`.
   * Throw on failure with a meaningful message.
   */
  probeCredential?(input: {
    providerId: string;
    apiKey: string | undefined;
    timeoutMs: number;
  }): Promise<{ ok: boolean; reason?: string; errorClass?: ProviderErrorClass }>;

  /**
   * Probes the provider's billing/balance API. Only called when the
   * strategy declares a credit probe surface.
   */
  probeCredit?(input: {
    providerId: string;
    apiKey: string;
    timeoutMs: number;
  }): Promise<{
    status: 'has_credits' | 'exhausted' | 'unknown';
    balanceUsd?: number;
    reason?: string;
  }>;

  /**
   * Lists models known to the provider. Only called when the strategy
   * supports model enumeration.
   */
  listModels?(input: {
    providerId: string;
    apiKey: string;
    timeoutMs: number;
  }): Promise<readonly DiscoveredModel[]>;
}

export interface DiscoveryConfig {
  /** Default per-provider probe timeout. */
  perProviderTimeoutMs?: number;
  /** Max concurrent probes. */
  concurrency?: number;
  /** TTL of the snapshot in ms (default 5 min). */
  snapshotTtlMs?: number;
  /** Adapter-supplied probes. Keyed by providerId. */
  probeCallbacks?: Record<string, ProviderProbeCallbacks>;
}

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_CONCURRENCY = 16;
const DEFAULT_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

// ─── Implementation ───────────────────────────────────────────────────────

class ProviderDiscoveryService {
  private latestSnapshot: ProviderDiscoverySnapshot | null = null;

  /**
   * Runs discovery for the given list of providers. Returns the snapshot
   * and stores it as `currentSnapshot()` for subsequent reads.
   */
  async runDiscovery(
    providers: readonly ConfiguredProvider[],
    config: DiscoveryConfig = {},
  ): Promise<ProviderDiscoverySnapshot> {
    const startedAt = Date.now();
    const timeoutMs = config.perProviderTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const concurrency = Math.max(1, config.concurrency ?? DEFAULT_CONCURRENCY);
    const ttlMs = config.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    const validUntil = new Date(startedAt + ttlMs).toISOString();
    const callbacks = config.probeCallbacks ?? {};

    // Configured trace + counter
    for (const p of providers) {
      incrementCounter(METRIC_NAMES.PROVIDER_CONFIGURED_TOTAL, { providerId: p.providerId });
      emitCandidateTrace({
        providerId: p.providerId,
        stage: 'configured',
        included: true,
      });
    }

    // Bounded-concurrency executor (Promise.all with semaphore)
    const results = await runWithConcurrency(
      providers,
      concurrency,
      (provider) =>
        this.probeProvider(
          provider,
          callbacks[provider.providerId],
          timeoutMs,
          validUntil,
        ),
    );

    const durationMs = Date.now() - startedAt;
    const map = new Map<string, ProviderDiscoveryResult>();
    let totalAvailable = 0;
    let totalUnavailable = 0;

    for (const r of results) {
      map.set(r.providerId, r);
      if (r.status === 'available') totalAvailable++;
      else totalUnavailable++;

      incrementCounter(METRIC_NAMES.PROVIDER_DISCOVERED_TOTAL, {
        providerId: r.providerId,
        status: r.status,
      });

      if (r.status === 'unavailable') {
        incrementCounter(METRIC_NAMES.PROVIDER_CONFIGURED_BUT_NOT_DISCOVERED_TOTAL, {
          providerId: r.providerId,
          reason: r.reason ?? r.healthState,
        });
      }
    }

    const snapshot: ProviderDiscoverySnapshot = {
      generatedAt: new Date(startedAt).toISOString(),
      durationMs,
      totalConfigured: providers.length,
      totalAvailable,
      totalUnavailable,
      results: map,
    };

    observeHistogram(METRIC_NAMES.PROVIDER_DISCOVERY_DURATION_MS, durationMs, {});
    log.info(
      {
        durationMs,
        totalConfigured: providers.length,
        totalAvailable,
        totalUnavailable,
      },
      'Discovery snapshot produced',
    );

    this.latestSnapshot = snapshot;
    return snapshot;
  }

  currentSnapshot(): ProviderDiscoverySnapshot | null {
    return this.latestSnapshot;
  }

  // ─── Per-provider probe orchestration ────────────────────────────────

  private async probeProvider(
    provider: ConfiguredProvider,
    callbacks: ProviderProbeCallbacks | undefined,
    timeoutMs: number,
    validUntil: string,
  ): Promise<ProviderDiscoveryResult> {
    const t0 = Date.now();
    const strategy = provider.probeStrategy
      ?? resolveProbeStrategy({
        providerId: provider.providerId,
        integrationClass: provider.integrationClass,
      });
    const registry = getProviderHealthRegistry();

    // ─── 1. Credential check ────────────────────────────────────────
    const apiKey = provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] : undefined;
    const credentialMissing = provider.apiKeyEnvVar !== undefined
      && (apiKey === undefined || apiKey === '');

    if (credentialMissing) {
      const result = this.buildUnavailable(provider, validUntil, t0, {
        healthState: 'auth_failed',
        reason: `missing env var: ${provider.apiKeyEnvVar}`,
        errorClass: 'auth_failed',
        confidence: 'verified',
      });
      registry.recordProbe({
        key: { providerId: provider.providerId },
        state: 'auth_failed',
        reason: result.reason,
        errorClass: 'auth_failed',
      });
      emitCandidateTrace({
        providerId: provider.providerId,
        stage: 'credential_validated',
        included: false,
        reason: result.reason,
        healthState: 'auth_failed',
        latencyMs: Date.now() - t0,
      });
      return result;
    }

    emitCandidateTrace({
      providerId: provider.providerId,
      stage: 'credential_validated',
      included: true,
      reason: 'env_present',
    });

    // Optional active credential probe (calls provider's auth endpoint)
    if (strategy.credentialProbe !== 'env_only' && strategy.credentialProbe !== 'not_supported' && callbacks?.probeCredential) {
      try {
        const credResult = await withTimeout(
          callbacks.probeCredential({ providerId: provider.providerId, apiKey, timeoutMs }),
          timeoutMs,
          'credential probe timed out',
        );
        if (!credResult.ok) {
          const result = this.buildUnavailable(provider, validUntil, t0, {
            healthState: 'auth_failed',
            reason: credResult.reason ?? 'credential probe failed',
            errorClass: credResult.errorClass ?? 'auth_failed',
            confidence: 'verified',
          });
          registry.recordProbe({
            key: { providerId: provider.providerId },
            state: 'auth_failed',
            reason: result.reason,
            errorClass: 'auth_failed',
          });
          // Camada 1b: bridge the probe verdict into the operability hub too, so
          // the hub (and its persisted overlay) reflect PROVEN operability — not
          // just organic runtime traffic. Dynamic verdict, never a static list.
          getProviderOperabilityHub().recordProbeResult(provider.providerId, 'auth_failed', result.reason);
          emitCandidateTrace({
            providerId: provider.providerId,
            stage: 'credential_validated',
            included: false,
            reason: result.reason,
            healthState: 'auth_failed',
            latencyMs: Date.now() - t0,
          });
          return result;
        }
      } catch (err) {
        // Treat probe-internal errors as partially_verified — adapter
        // misbehavior shouldn't permanently disable the provider.
        log.warn(
          { providerId: provider.providerId, err: String(err) },
          'Credential probe threw; treating as partially_verified',
        );
      }
    }

    // ─── 2. Credit check ────────────────────────────────────────────
    let creditOk = true;
    let creditReason: string | undefined;
    if (strategy.creditProbe !== 'not_supported' && callbacks?.probeCredit && apiKey) {
      try {
        const creditResult = await withTimeout(
          callbacks.probeCredit({ providerId: provider.providerId, apiKey, timeoutMs }),
          timeoutMs,
          'credit probe timed out',
        );
        if (creditResult.status === 'exhausted') {
          creditOk = false;
          creditReason = creditResult.reason ?? `exhausted (balance: ${creditResult.balanceUsd ?? 'unknown'})`;
        }
        incrementCounter(METRIC_NAMES.PROVIDER_CREDIT_STATUS_TOTAL, {
          providerId: provider.providerId,
          status: creditResult.status,
        });
      } catch (err) {
        log.warn(
          { providerId: provider.providerId, err: String(err) },
          'Credit probe threw; treating as unknown credit status',
        );
        incrementCounter(METRIC_NAMES.PROVIDER_CREDIT_STATUS_TOTAL, {
          providerId: provider.providerId,
          status: 'probe_error',
        });
      }
    }

    if (!creditOk) {
      const result = this.buildUnavailable(provider, validUntil, t0, {
        healthState: 'insufficient_credit',
        reason: creditReason ?? 'insufficient credit',
        errorClass: 'insufficient_credit',
        confidence: 'verified',
      });
      registry.recordProbe({
        key: { providerId: provider.providerId },
        state: 'insufficient_credit',
        reason: result.reason,
        errorClass: 'insufficient_credit',
      });
      // Camada 1b: bridge into the operability hub (see auth_failed case).
      getProviderOperabilityHub().recordProbeResult(provider.providerId, 'insufficient_credit', result.reason);
      emitCandidateTrace({
        providerId: provider.providerId,
        stage: 'credit_validated',
        included: false,
        reason: result.reason,
        healthState: 'insufficient_credit',
        latencyMs: Date.now() - t0,
      });
      return result;
    }

    emitCandidateTrace({
      providerId: provider.providerId,
      stage: 'credit_validated',
      included: true,
      reason: strategy.creditProbe === 'not_supported' ? 'probe_not_supported' : 'has_credits',
    });

    // ─── 3. Endpoint / models enumeration ───────────────────────────
    let models: readonly DiscoveredModel[] = [];
    let endpointVerified = false;
    if (strategy.modelProbe === 'list_models' && callbacks?.listModels && apiKey) {
      try {
        models = await withTimeout(
          callbacks.listModels({ providerId: provider.providerId, apiKey, timeoutMs }),
          timeoutMs,
          'listModels timed out',
        );
        endpointVerified = true;
        emitCandidateTrace({
          providerId: provider.providerId,
          stage: 'models_listed',
          included: true,
          reason: `count=${models.length}`,
          latencyMs: Date.now() - t0,
        });
      } catch (err) {
        log.warn(
          { providerId: provider.providerId, err: String(err) },
          'listModels probe failed; treating as partially_verified',
        );
        emitCandidateTrace({
          providerId: provider.providerId,
          stage: 'models_listed',
          included: false,
          reason: `probe_error: ${String(err).slice(0, 120)}`,
          latencyMs: Date.now() - t0,
        });
      }
    }

    // ─── 4. Determine confidence ────────────────────────────────────
    const confidence = computeConfidence({
      strategy,
      credentialChecked: !credentialMissing,
      creditChecked: strategy.creditProbe !== 'not_supported' && !!callbacks?.probeCredit,
      endpointVerified,
    });

    const probeLatencyMs = Date.now() - t0;
    const result: ProviderDiscoveryResult = {
      providerId: provider.providerId,
      status: 'available',
      healthState: 'healthy',
      reason: undefined,
      errorClass: undefined,
      discoveryConfidence: confidence,
      models,
      includeInOperationalPool: true,
      discoveredAt: new Date().toISOString(),
      validUntil,
      probeLatencyMs,
    };

    registry.recordProbe({
      key: { providerId: provider.providerId },
      state: 'healthy',
      latencyMs: probeLatencyMs,
    });
    // Camada 1b: bridge into the operability hub. PROVE-then-advertise: only
    // assert 'healthy' when the probe produced POSITIVE proof THIS tick — an
    // authenticated model list actually succeeded (endpointVerified). An
    // env-var-only pass (credential present but credits/endpoint never verified)
    // records 'unknown' — a documented no-op — so the provider stays a
    // usable-but-unproven candidate and a real runtime 402/403/500 is NOT
    // overwritten by an optimistic synthetic success. (The hub additionally
    // refuses to let even a proven-reachable probe clear a runtime no_credits/
    // auth_failed — see recordProbeResult — since listing models does not prove
    // inference credits.)
    getProviderOperabilityHub().recordProbeResult(
      provider.providerId,
      endpointVerified ? 'healthy' : 'unknown',
    );

    emitCandidateTrace({
      providerId: provider.providerId,
      stage: 'operational_pool',
      included: true,
      reason: confidence,
      healthState: 'healthy',
      latencyMs: probeLatencyMs,
    });

    return result;
  }

  private buildUnavailable(
    provider: ConfiguredProvider,
    validUntil: string,
    startedAtMs: number,
    input: {
      healthState: ProviderHealthState;
      reason: string;
      errorClass: ProviderErrorClass;
      confidence: DiscoveryConfidence;
    },
  ): ProviderDiscoveryResult {
    return {
      providerId: provider.providerId,
      status: 'unavailable',
      healthState: input.healthState,
      reason: input.reason,
      errorClass: input.errorClass,
      discoveryConfidence: input.confidence,
      models: [],
      includeInOperationalPool: false,
      discoveredAt: new Date().toISOString(),
      validUntil,
      probeLatencyMs: Date.now() - startedAtMs,
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function computeConfidence(input: {
  strategy: ProviderProbeStrategy;
  credentialChecked: boolean;
  creditChecked: boolean;
  endpointVerified: boolean;
}): DiscoveryConfidence {
  const { credentialChecked, creditChecked, endpointVerified } = input;

  if (credentialChecked && creditChecked && endpointVerified) return 'verified';
  if (credentialChecked && (creditChecked || endpointVerified)) return 'partially_verified';
  if (credentialChecked) return 'inferred';
  return 'unknown';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  const runners: Promise<void>[] = [];

  const runOne = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = await worker(items[i]);
      } catch (err) {
        // Worker errors should not propagate — they should produce
        // ProviderDiscoveryResult.status='unavailable'. If we land here,
        // something inside probeProvider threw; treat as unavailable.
        const failureRecord = {
          providerId: (items[i] as { providerId?: string }).providerId ?? 'unknown',
          status: 'unavailable',
          healthState: 'unknown',
          reason: `discovery_internal_error: ${String(err).slice(0, 120)}`,
          errorClass: 'unknown_error',
          discoveryConfidence: 'unknown',
          models: [],
          includeInOperationalPool: false,
          discoveredAt: new Date().toISOString(),
          validUntil: new Date().toISOString(),
          probeLatencyMs: 0,
        };
        // The generic worker pool can't know R = ProviderDiscoveryResult;
        // this synthetic failure record matches that shape (the only R used
        // here). narrowAs<> is the sanctioned escape hatch for this.
        results[i] = narrowAs<R>(failureRecord);
      }
    }
  };

  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    runners.push(runOne());
  }
  await Promise.all(runners);
  return results;
}

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: ProviderDiscoveryService | null = null;

export function getProviderDiscoveryService(): ProviderDiscoveryService {
  if (!instance) {
    instance = new ProviderDiscoveryService();
  }
  return instance;
}

export function resetProviderDiscoveryServiceForTesting(): void {
  instance = null;
}

/**
 * Convenience wrapper matching the prompt's signature.
 */
export async function runProviderDiscovery(
  providers: readonly ConfiguredProvider[],
  config?: DiscoveryConfig,
): Promise<ProviderDiscoverySnapshot> {
  return getProviderDiscoveryService().runDiscovery(providers, config);
}

export type { ProviderDiscoveryService };
