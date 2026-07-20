// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.1 — ProviderCreditAudit types.
 *
 * The audit service inspects the operability state of every registered
 * provider and reports a breakdown. Three modes:
 *
 *   - `metadata_only`           — read-only; uses the
 *                                 ProviderOperabilityHub cache plus
 *                                 catalog/registry metadata. Zero
 *                                 provider HTTP.
 *   - `non_billable_probe`      — additionally calls non-billable
 *                                 endpoints (list-models / health /
 *                                 balance) where the provider exposes
 *                                 them. Zero generation tokens. NOT
 *                                 implemented in this turn — interface
 *                                 only.
 *   - `minimal_billable_probe`  — single 1-token chat call per provider
 *                                 with an explicit total budget. NOT
 *                                 implemented in this turn — interface
 *                                 only. Requires per-run authorization.
 */

export type ProviderCreditAuditMode =
  | 'metadata_only'
  | 'non_billable_probe'
  | 'minimal_billable_probe';

export interface ProviderCreditAuditInput {
  readonly mode: ProviderCreditAuditMode;
  /** Hard cap on total spend during this audit. Audit MUST refuse to
   *  run a mode that could exceed this. */
  readonly maxTotalCostUsd: number;
  /** Limit the number of providers inspected. Useful for partial probes. */
  readonly maxProviders?: number;
  /** Include aggregators (provider IDs flagged as aggregator/router). */
  readonly includeAggregators: boolean;
  /** Include router-style providers. */
  readonly includeRouters: boolean;
  /** Include local / self-hosted (ollama, xinference, etc.). */
  readonly includeLocal: boolean;
}

export type ProviderAuditClassification =
  | 'usable'
  | 'no_credits'
  | 'auth_failed'
  | 'rate_limited'
  | 'temporarily_unavailable'
  | 'permanently_unavailable'
  | 'unknown'
  | 'no_credential_configured'
  | 'no_models_visible'
  | 'no_probe_supported';

/**
 * Strategy 01C.0.2 — non-billable probe classification.
 *
 * - `probeEndpointType` describes the KIND of endpoint that would be
 *   exercised in `non_billable_probe` mode. None of these endpoints
 *   may generate tokens or charge per request.
 * - `probeBillableRisk` declares the safety class. `'none'` means the
 *   endpoint is well-known to not charge (provider list-models,
 *   health, balance). `'unknown'` blocks the probe — the audit will
 *   NOT call an endpoint of unknown billing class.
 */
export type ProbeEndpointType =
  | 'models'
  | 'balance'
  | 'account'
  | 'health'
  | 'metadata'
  | 'unknown';

export type ProbeBillableRisk = 'none' | 'unknown' | 'billable';

export interface ProviderProbeMetadata {
  readonly probeSupported: boolean;
  readonly probeEndpointType: ProbeEndpointType;
  readonly probeBillableRisk: ProbeBillableRisk;
}

export interface ProviderProbeResult {
  readonly providerId: string;
  readonly endpointType: ProbeEndpointType;
  readonly billableRisk: ProbeBillableRisk;
  /** Operability state inferred from the probe response. */
  readonly liveOperabilityState: string;
  /** Credit state inferred (when the probe reveals it). */
  readonly liveBalanceStatus?: 'has_credits' | 'no_credits' | 'unknown';
  readonly liveRateState?: 'ok' | 'rate_limited' | 'cooldown' | 'unknown';
  readonly observedAt: number;
  readonly latencyMs: number;
  readonly error?: string;
}

/**
 * Strategy 01C.0.2 — reconciliation between cached (hub) and live
 * (non-billable probe) state. Each divergence has a classification
 * so operators can spot critical ones.
 */
export type ReconciliationVerdict =
  | 'aligned'
  | 'cached_no_credits_but_live_has_credits'
  | 'cached_has_credits_but_live_no_credits'
  | 'cached_unknown_but_live_has_credits'
  | 'cached_healthy_but_live_auth_failed'
  | 'cached_rate_limited_but_live_ok'
  | 'provider_probe_not_supported'
  | 'provider_probe_error';

export interface ProviderReconciliation {
  readonly providerId: string;
  readonly cachedState: string;
  readonly liveState?: string;
  readonly verdict: ReconciliationVerdict;
  readonly isCriticalStale: boolean;
  readonly notes?: readonly string[];
}

export interface ProviderCreditAuditProviderResult {
  readonly providerId: string;
  readonly classification: ProviderAuditClassification;
  readonly modelsVisible: number;
  readonly modelsUsable: number;
  readonly isLocal: boolean;
  readonly isAggregator: boolean;
  readonly observedAt: number;
  readonly source: 'hub_cache' | 'live_non_billable' | 'live_billable';
  readonly notes?: readonly string[];
  /** Strategy 01C.0.2 — probe metadata + result (when probed). */
  readonly probe?: ProviderProbeMetadata;
  readonly probeResult?: ProviderProbeResult;
  readonly reconciliation?: ProviderReconciliation;
}

export interface StaleOperabilityState {
  readonly providerId: string;
  readonly cachedState: string;
  readonly probedState: string;
  readonly reason: string;
  /** Strategy 01C.0.2 — true when divergence is the "high-risk"
   *  kind (cached no_credits but live has_credits) that operators
   *  must escalate. */
  readonly isCritical: boolean;
}

export interface ProviderCreditAuditResult {
  readonly mode: ProviderCreditAuditMode;
  readonly observedAt: number;
  readonly providersInspected: number;
  readonly providersConfigured: number;
  readonly providersWithCredential: number;
  readonly providersUsable: number;
  readonly providersNoCredits: number;
  readonly providersAuthFailed: number;
  readonly providersRateLimited: number;
  readonly providersTemporarilyUnavailable: number;
  readonly providersUnknown: number;
  readonly routesUsable: number;
  readonly modelsUsable: number;
  readonly localProvidersConsidered: number;
  readonly aggregatorsConsidered: number;
  readonly routersConsidered: number;
  readonly staleOperabilityStates: readonly StaleOperabilityState[];
  /** Strategy 01C.0.2 — count of staleOperabilityStates with isCritical=true. */
  readonly criticalStaleOperabilityStateCount: number;
  readonly providerResults: readonly ProviderCreditAuditProviderResult[];
  readonly notes: readonly string[];
}
