// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.3 — ReconciledOperabilitySnapshot.
 *
 * A point-in-time view of every provider's operability state that
 * combines:
 *   - hub cache (always available)
 *   - live non-billable probe results (when probe was registered)
 * with a fixed priority rule:
 *
 *   live non_billable_probe > hub_cache > metadata_only > unknown
 *
 * The resolver and planner consume this snapshot to make selections
 * that beat stale cache (cached no_credits but live has_credits =>
 * candidate IS eligible).
 *
 * Building a snapshot is purely structural — the heavy work
 * (probing providers) is done by ProviderCreditAuditService. This
 * file just normalizes the audit result into the shape the resolver
 * wants.
 */
import type {
  ProviderCreditAuditResult,
  ProviderProbeResult,
} from './provider-credit-audit-types';

export type ReconciledAuthState = 'auth_ok' | 'auth_failed' | 'unknown';
export type ReconciledCreditState = 'has_credits' | 'no_credits' | 'unknown' | 'stale';
export type ReconciledRateState = 'ok' | 'rate_limited' | 'cooldown' | 'unknown';
export type ReconciledRouteState =
  | 'usable'
  | 'model_not_found'
  | 'unsupported'
  | 'temporarily_unavailable'
  | 'unknown';

export type ReconciledSource =
  | 'non_billable_probe'
  | 'hub_cache'
  | 'metadata_only'
  | 'unknown';

export interface ReconciledProviderState {
  readonly providerId: string;
  readonly authState: ReconciledAuthState;
  readonly creditState: ReconciledCreditState;
  readonly rateState: ReconciledRateState;
  readonly routeState?: ReconciledRouteState;
  readonly source: ReconciledSource;
  readonly observedAt?: string;
  readonly ttlSeconds?: number;
  /** Human-readable warning when the snapshot value disagrees with cache. */
  readonly staleWarning?: string;
  /** True for `cached_no_credits_but_live_has_credits` and
   *  `cached_healthy_but_live_auth_failed`. */
  readonly critical?: boolean;
}

export interface ReconciledOperabilitySnapshot {
  readonly providerStates: Readonly<Record<string, ReconciledProviderState>>;
  readonly observedAt: string;
  readonly source: 'metadata_only' | 'non_billable_probe';
  readonly criticalStaleOperabilityStateCount: number;
  /** True when at least one provider probe was successfully registered
   *  AND ran. False when the audit ran in metadata_only OR no probes
   *  were registered. Blocks Strategy 01C.1 when false (see contract). */
  readonly safeNonBillableProbeAvailable: boolean;
}

// ─── Conversion ────────────────────────────────────────────────────

function mapHubStateToReconciled(
  hubState: string,
  hubBalance?: string,
): { auth: ReconciledAuthState; credit: ReconciledCreditState; rate: ReconciledRateState } {
  let auth: ReconciledAuthState = 'unknown';
  let credit: ReconciledCreditState = 'unknown';
  let rate: ReconciledRateState = 'unknown';

  if (hubState === 'healthy' || hubState === 'degraded' || hubState === 'recovering') auth = 'auth_ok';
  if (hubState === 'auth_failed') auth = 'auth_failed';
  if (hubState === 'no_credits') credit = 'no_credits';
  if (hubBalance === 'has_credits') credit = 'has_credits';
  if (hubBalance === 'no_credits') credit = 'no_credits';
  if (hubState === 'rate_limited') rate = 'rate_limited';
  if (hubState === 'healthy') rate = 'ok';

  return { auth, credit, rate };
}

function mergeLiveOverCache(args: {
  readonly hub: { state: string; balance?: string };
  readonly probe?: ProviderProbeResult;
}): { auth: ReconciledAuthState; credit: ReconciledCreditState; rate: ReconciledRateState; source: ReconciledSource } {
  const fromHub = mapHubStateToReconciled(args.hub.state, args.hub.balance);
  if (!args.probe || args.probe.error) {
    return { ...fromHub, source: args.probe ? 'hub_cache' : 'hub_cache' };
  }
  // Live values win. We map probe live* fields onto the reconciled
  // shape; when the probe doesn't speak to a dimension, fall back.
  const auth: ReconciledAuthState =
    args.probe.liveOperabilityState === 'healthy' || args.probe.liveOperabilityState === 'degraded'
      ? 'auth_ok'
      : args.probe.liveOperabilityState === 'auth_failed'
        ? 'auth_failed'
        : fromHub.auth;
  const credit: ReconciledCreditState =
    args.probe.liveBalanceStatus === 'has_credits'
      ? 'has_credits'
      : args.probe.liveBalanceStatus === 'no_credits'
        ? 'no_credits'
        : args.probe.liveBalanceStatus === 'unknown'
          ? 'unknown'
          : fromHub.credit;
  const rate: ReconciledRateState =
    args.probe.liveRateState ?? (args.probe.liveOperabilityState === 'rate_limited' ? 'rate_limited' : fromHub.rate);

  return { auth, credit, rate, source: 'non_billable_probe' };
}

/**
 * Build a ReconciledOperabilitySnapshot from a ProviderCreditAuditResult.
 *
 * The audit already classifies each provider AND (in
 * non_billable_probe mode) carries the probe result + reconciliation
 * verdict. This converter just reshapes for the resolver.
 */
export function buildReconciledSnapshot(
  audit: ProviderCreditAuditResult,
): ReconciledOperabilitySnapshot {
  const providerStates: Record<string, ReconciledProviderState> = {};
  let probesActuallyRan = false;

  for (const r of audit.providerResults) {
    const merged = mergeLiveOverCache({
      hub: { state: 'unknown' }, // hub state already condensed into r.classification
      probe: r.probeResult,
    });
    if (r.probeResult && !r.probeResult.error) probesActuallyRan = true;

    // Map the audit's `classification` back onto reconciled states.
    // CRITICAL: classification reflects hub_cache view; live probe wins
    // when present. So we only fall back to classification when probe
    // did NOT report (probe absent OR probe errored).
    let authFromAudit: ReconciledAuthState = merged.auth;
    let creditFromAudit: ReconciledCreditState = merged.credit;
    let rateFromAudit: ReconciledRateState = merged.rate;
    const probeAvailable = r.probeResult && !r.probeResult.error;
    if (!probeAvailable) {
      if (r.classification === 'auth_failed' || r.classification === 'no_credential_configured') {
        authFromAudit = 'auth_failed';
      }
      if (r.classification === 'no_credits') creditFromAudit = 'no_credits';
      if (r.classification === 'usable') {
        creditFromAudit = creditFromAudit === 'unknown' ? 'has_credits' : creditFromAudit;
      }
      if (r.classification === 'rate_limited') rateFromAudit = 'rate_limited';
    }

    // Source preference: probe data when present, else metadata_only
    // (audit ran in metadata_only OR probe not supported for this provider).
    let source: ReconciledSource;
    if (r.probeResult && !r.probeResult.error) source = 'non_billable_probe';
    else if (audit.mode === 'metadata_only') source = 'metadata_only';
    else source = 'hub_cache';

    providerStates[r.providerId] = {
      providerId: r.providerId,
      authState: authFromAudit,
      creditState: creditFromAudit,
      rateState: rateFromAudit,
      source,
      observedAt: new Date(r.observedAt).toISOString(),
      staleWarning:
        r.reconciliation && r.reconciliation.verdict !== 'aligned' && r.reconciliation.verdict !== 'provider_probe_not_supported'
          ? r.reconciliation.verdict
          : undefined,
      critical: r.reconciliation?.isCriticalStale === true,
    };
  }

  return {
    providerStates,
    observedAt: new Date(audit.observedAt).toISOString(),
    source: audit.mode === 'non_billable_probe' ? 'non_billable_probe' : 'metadata_only',
    criticalStaleOperabilityStateCount: audit.criticalStaleOperabilityStateCount,
    safeNonBillableProbeAvailable: probesActuallyRan,
  };
}

/**
 * Apply a ReconciledOperabilitySnapshot to a ModelCandidate. The
 * snapshot's live state OVERRIDES the candidate's cached flags when
 * disagreement exists. Returns a new candidate (immutable input).
 */
export function applySnapshotToCandidate<T extends {
  providerId: string;
  providerHealthy: boolean;
  hasCredits: boolean;
  rateLimited: boolean;
}>(
  candidate: T,
  snapshot: ReconciledOperabilitySnapshot,
): T & { reconciliation?: ReconciledProviderState } {
  const state = snapshot.providerStates[candidate.providerId];
  if (!state) return { ...candidate, reconciliation: undefined };
  return {
    ...candidate,
    providerHealthy: state.authState === 'auth_ok',
    hasCredits: state.creditState === 'has_credits',
    rateLimited: state.rateState === 'rate_limited' || state.rateState === 'cooldown',
    reconciliation: state,
  };
}
