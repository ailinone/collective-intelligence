// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderCreditAuditService — Strategy 01C.0.1 Part B.
 *
 * Inspects every configured provider's operability state and reports a
 * structured breakdown. The current implementation supports
 * `metadata_only` mode (read-only, hub-cache + registry). The
 * `non_billable_probe` and `minimal_billable_probe` modes throw with
 * an explicit error message — those require provider-specific
 * non-billable endpoints (list-models / balance / health) and per-run
 * authorization, which is out of scope for this turn.
 *
 * Dependencies are injected so tests can run without a real hub or DB.
 */
import { logger } from '@/utils/logger';
import { reconcileProviderState, type ProviderProbeRegistry } from './provider-probe-registry';
import type {
  ProviderCreditAuditInput,
  ProviderCreditAuditProviderResult,
  ProviderCreditAuditResult,
  StaleOperabilityState,
} from './provider-credit-audit-types';

const log = logger.child({ component: 'provider-credit-audit-service' });

/** Slim hub view — just the fields the audit needs. */
export interface OperabilityHubView {
  /** Summary keyed by operability state -> provider ids. */
  getSummary(): Readonly<Record<string, readonly string[]>>;
  getProviderState(providerKey: string): {
    readonly operabilityState: string;
    readonly balanceStatus?: string;
    readonly healthScore?: number;
    readonly lastSuccessAt?: number;
  };
  /** All known provider ids. */
  listKnownProviders(): readonly string[];
}

/** Slim catalog view — just the model counts per provider. */
export interface CatalogView {
  /** Number of active models registered for `providerId`. */
  countActiveModelsForProvider(providerId: string): Promise<number>;
  /** Number of active models with chat capability for `providerId`. */
  countUsableModelsForProvider(providerId: string): Promise<number>;
}

export interface ProviderMetadataView {
  /** Whether a credential / API key is configured for this provider. */
  hasCredential(providerId: string): boolean;
  /** Whether this provider is a hub / aggregator (forwards to others). */
  isAggregator(providerId: string): boolean;
  /** Whether this provider is a router (load-balances across upstreams). */
  isRouter(providerId: string): boolean;
  /** Whether this provider runs locally (ollama, xinference, etc.). */
  isLocal(providerId: string): boolean;
}

export interface ProviderCreditAuditDeps {
  readonly hub: OperabilityHubView;
  readonly catalog: CatalogView;
  readonly metadata: ProviderMetadataView;
  /** Strategy 01C.0.2 — non-billable probe registry. Optional. When
   *  absent OR no probes registered, `non_billable_probe` returns
   *  `provider_probe_not_supported` for every provider. */
  readonly probeRegistry?: ProviderProbeRegistry;
}

const HEALTHY_STATES: ReadonlySet<string> = new Set([
  'healthy',
  'degraded',
  'recovering',
]);

function classifyFromHub(operabilityState: string, hasCredential: boolean): ProviderCreditAuditProviderResult['classification'] {
  if (!hasCredential) return 'no_credential_configured';
  if (operabilityState === 'no_credits') return 'no_credits';
  if (operabilityState === 'auth_failed') return 'auth_failed';
  if (operabilityState === 'rate_limited') return 'rate_limited';
  if (operabilityState === 'temporarily_unavailable') return 'temporarily_unavailable';
  if (operabilityState === 'permanently_unavailable') return 'permanently_unavailable';
  if (operabilityState === 'unknown') return 'unknown';
  if (HEALTHY_STATES.has(operabilityState)) return 'usable';
  return 'unknown';
}

export class ProviderCreditAuditService {
  constructor(private readonly deps: ProviderCreditAuditDeps) {}

  async run(input: ProviderCreditAuditInput): Promise<ProviderCreditAuditResult> {
    if (input.mode === 'minimal_billable_probe') {
      throw new Error(
        'minimal_billable_probe is not implemented in this turn — requires per-run authorization and a billable budget guard.',
      );
    }
    // Strategy 01C.0.2 — non_billable_probe path is now supported via
    // the ProviderProbeRegistry. Providers without a registered probe
    // get classified `provider_probe_not_supported` (NOT called).

    // ── metadata_only ──────────────────────────────────────────────
    const observedAt = Date.now();
    const allProviders = this.deps.hub.listKnownProviders();
    const cap =
      typeof input.maxProviders === 'number' && input.maxProviders > 0
        ? Math.min(input.maxProviders, allProviders.length)
        : allProviders.length;
    const providers = allProviders.slice(0, cap);

    const results: ProviderCreditAuditProviderResult[] = [];
    const buckets = {
      usable: 0,
      noCredits: 0,
      authFailed: 0,
      rateLimited: 0,
      temporarilyUnavailable: 0,
      unknown: 0,
    };
    let providersConfigured = 0;
    let providersWithCredential = 0;
    let modelsUsable = 0;
    let routesUsable = 0;
    let localCount = 0;
    let aggregatorCount = 0;
    let routerCount = 0;

    for (const providerId of providers) {
      const isLocal = this.deps.metadata.isLocal(providerId);
      const isAggregator = this.deps.metadata.isAggregator(providerId);
      const isRouter = this.deps.metadata.isRouter(providerId);
      if (!input.includeLocal && isLocal) continue;
      if (!input.includeAggregators && isAggregator) continue;
      if (!input.includeRouters && isRouter) continue;

      providersConfigured++;
      const hasCredential = this.deps.metadata.hasCredential(providerId);
      if (hasCredential) providersWithCredential++;
      if (isLocal) localCount++;
      if (isAggregator) aggregatorCount++;
      if (isRouter) routerCount++;

      const state = this.deps.hub.getProviderState(providerId);
      const classification = classifyFromHub(state.operabilityState, hasCredential);
      const modelsVisible = await this.deps.catalog
        .countActiveModelsForProvider(providerId)
        .catch(() => 0);
      const usable = await this.deps.catalog
        .countUsableModelsForProvider(providerId)
        .catch(() => 0);

      const notes: string[] = [];
      if (state.lastSuccessAt && observedAt - state.lastSuccessAt > 24 * 60 * 60 * 1000) {
        notes.push('last_success_over_24h');
      }
      if (classification === 'usable' && usable === 0) {
        notes.push('classification_says_usable_but_no_models_visible');
      }

      // Strategy 01C.0.2 — non_billable_probe path. Optional probe;
      // skipped when no registry, no probe registered, or mode is
      // metadata_only.
      const probeMeta = this.deps.probeRegistry?.getMetadata(providerId);
      let probeResult: import('./provider-credit-audit-types').ProviderProbeResult | undefined;
      let reconciliation: import('./provider-credit-audit-types').ProviderReconciliation | undefined;
      if (input.mode === 'non_billable_probe' && probeMeta?.probeSupported && probeMeta.probeBillableRisk === 'none') {
        probeResult = await this.deps.probeRegistry!.run(providerId, 5000);
        reconciliation = reconcileProviderState({
          providerId,
          cachedOperabilityState: state.operabilityState,
          cachedBalanceStatus: state.balanceStatus,
          probe: probeResult,
        });
        if (reconciliation.isCriticalStale) {
          notes.push(`critical_stale:${reconciliation.verdict}`);
        }
      } else if (input.mode === 'non_billable_probe') {
        reconciliation = {
          providerId,
          cachedState: state.operabilityState,
          verdict: 'provider_probe_not_supported',
          isCriticalStale: false,
        };
      }

      // Strategy 01C.0.3 — probe-driven classification override.
      // When a successful non-billable probe ran, its live state
      // TRUMPS the hub's cached classification (which is `unknown`
      // when the hub hasn't observed events for this provider). This
      // is the same priority rule the reconciler uses.
      let liveClassification: typeof classification = classification;
      if (probeResult && !probeResult.error) {
        if (probeResult.liveOperabilityState === 'auth_failed') {
          liveClassification = 'auth_failed';
        } else if (probeResult.liveOperabilityState === 'rate_limited') {
          liveClassification = 'rate_limited';
        } else if (probeResult.liveBalanceStatus === 'no_credits') {
          liveClassification = 'no_credits';
        } else if (
          probeResult.liveOperabilityState === 'healthy' &&
          probeResult.liveBalanceStatus === 'has_credits'
        ) {
          liveClassification = 'usable';
        } else if (probeResult.liveOperabilityState === 'healthy') {
          // Live says healthy but credit status unknown (e.g., list-models
          // returned 200 + empty list). Keep as `unknown` unless catalog
          // proves usable.
          liveClassification = 'unknown';
        }
      }

      const finalClassification =
        liveClassification === 'usable' && usable === 0 ? 'no_models_visible' : liveClassification;
      results.push({
        providerId,
        classification: finalClassification,
        modelsVisible,
        modelsUsable: usable,
        isLocal,
        isAggregator,
        observedAt,
        source: probeResult ? 'live_non_billable' : 'hub_cache',
        notes: notes.length > 0 ? notes : undefined,
        probe: probeMeta,
        probeResult,
        reconciliation,
      });

      // Buckets use the LIVE classification (cache-derived only when no
      // probe ran). For `usable` we still require modelsUsable > 0 to
      // avoid counting providers with empty catalogs.
      if (liveClassification === 'usable' && usable > 0) {
        buckets.usable++;
        modelsUsable += usable;
        routesUsable += modelsVisible;
      } else if (liveClassification === 'usable' && usable === 0) {
        // Provider is live-healthy but catalog has 0 chat models
        // visible. Count as usable for "credit available" but NOT
        // for model count (operator must run discovery first).
        buckets.usable++;
      } else if (liveClassification === 'no_credits') {
        buckets.noCredits++;
      } else if (liveClassification === 'auth_failed') {
        buckets.authFailed++;
      } else if (liveClassification === 'rate_limited') {
        buckets.rateLimited++;
      } else if (liveClassification === 'temporarily_unavailable') {
        buckets.temporarilyUnavailable++;
      } else {
        buckets.unknown++;
      }
    }

    // Strategy 01C.0.2 — collect divergences from the reconciler. In
    // metadata_only mode this stays empty (no probe ran).
    const staleOperabilityStates: StaleOperabilityState[] = [];
    for (const r of results) {
      if (!r.reconciliation) continue;
      if (r.reconciliation.verdict === 'aligned') continue;
      if (r.reconciliation.verdict === 'provider_probe_not_supported') continue;
      staleOperabilityStates.push({
        providerId: r.providerId,
        cachedState: r.reconciliation.cachedState,
        probedState: r.reconciliation.liveState ?? 'unknown',
        reason: r.reconciliation.verdict,
        isCritical: r.reconciliation.isCriticalStale,
      });
    }
    const criticalStaleOperabilityStateCount = staleOperabilityStates.filter((s) => s.isCritical).length;

    log.info(
      {
        mode: input.mode,
        providersInspected: results.length,
        buckets,
        modelsUsable,
      },
      'provider credit audit complete',
    );

    return {
      mode: input.mode,
      observedAt,
      providersInspected: results.length,
      providersConfigured,
      providersWithCredential,
      providersUsable: buckets.usable,
      providersNoCredits: buckets.noCredits,
      providersAuthFailed: buckets.authFailed,
      providersRateLimited: buckets.rateLimited,
      providersTemporarilyUnavailable: buckets.temporarilyUnavailable,
      providersUnknown: buckets.unknown,
      routesUsable,
      modelsUsable,
      localProvidersConsidered: localCount,
      aggregatorsConsidered: aggregatorCount,
      routersConsidered: routerCount,
      staleOperabilityStates,
      criticalStaleOperabilityStateCount,
      providerResults: results,
      notes:
        input.mode === 'metadata_only'
          ? [
              'metadata_only_mode_no_live_probe',
              'staleOperabilityStates_requires_non_billable_probe_mode',
            ]
          : ['non_billable_probe_mode', 'probes_run_for_supported_providers_only'],
    };
  }
}
