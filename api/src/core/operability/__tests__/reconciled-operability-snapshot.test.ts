// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.3 — ReconciledOperabilitySnapshot tests.
 *
 * Pins the priority rule:
 *   live non_billable_probe > hub_cache > metadata_only > unknown
 *
 * And the `applySnapshotToCandidate` mutation: when the snapshot
 * says live no_credits, the candidate's `hasCredits` flips to false
 * even when its cached value said true.
 */
import { describe, it, expect } from 'vitest';
import {
  applySnapshotToCandidate,
  buildReconciledSnapshot,
  type ReconciledOperabilitySnapshot,
} from '../reconciled-operability-snapshot';
import type { ProviderCreditAuditResult, ProviderProbeResult } from '../provider-credit-audit-types';

function buildAudit(provider: {
  id: string;
  classification: ProviderCreditAuditResult['providerResults'][number]['classification'];
  probe?: ProviderProbeResult;
  reconciliationVerdict?: import('../provider-credit-audit-types').ReconciliationVerdict;
  reconciliationCritical?: boolean;
}, mode: 'metadata_only' | 'non_billable_probe'): ProviderCreditAuditResult {
  return {
    mode,
    observedAt: Date.now(),
    providersInspected: 1,
    providersConfigured: 1,
    providersWithCredential: 1,
    providersUsable: provider.classification === 'usable' ? 1 : 0,
    providersNoCredits: provider.classification === 'no_credits' ? 1 : 0,
    providersAuthFailed: provider.classification === 'auth_failed' ? 1 : 0,
    providersRateLimited: provider.classification === 'rate_limited' ? 1 : 0,
    providersTemporarilyUnavailable: 0,
    providersUnknown: provider.classification === 'unknown' ? 1 : 0,
    routesUsable: 0,
    modelsUsable: 0,
    localProvidersConsidered: 0,
    aggregatorsConsidered: 0,
    routersConsidered: 0,
    staleOperabilityStates: [],
    criticalStaleOperabilityStateCount: provider.reconciliationCritical ? 1 : 0,
    providerResults: [
      {
        providerId: provider.id,
        classification: provider.classification,
        modelsVisible: 1,
        modelsUsable: 1,
        isLocal: false,
        isAggregator: false,
        observedAt: Date.now(),
        source: provider.probe ? 'live_non_billable' : 'hub_cache',
        probe: { probeSupported: !!provider.probe, probeEndpointType: 'balance', probeBillableRisk: 'none' },
        probeResult: provider.probe,
        reconciliation: provider.reconciliationVerdict
          ? {
              providerId: provider.id,
              cachedState: 'unknown',
              liveState: provider.probe?.liveOperabilityState,
              verdict: provider.reconciliationVerdict,
              isCriticalStale: provider.reconciliationCritical === true,
            }
          : undefined,
      },
    ],
    notes: [],
  };
}

describe('buildReconciledSnapshot', () => {
  it('metadata_only audit → snapshot source = metadata_only, safeNonBillableProbeAvailable = false', () => {
    const audit = buildAudit({ id: 'p-a', classification: 'usable' }, 'metadata_only');
    const snap = buildReconciledSnapshot(audit);
    expect(snap.source).toBe('metadata_only');
    expect(snap.safeNonBillableProbeAvailable).toBe(false);
  });

  it('non_billable_probe with successful probe → safeNonBillableProbeAvailable = true', () => {
    const audit = buildAudit(
      {
        id: 'p-live',
        classification: 'no_credits',
        probe: {
          providerId: 'p-live',
          endpointType: 'balance',
          billableRisk: 'none',
          liveOperabilityState: 'healthy',
          liveBalanceStatus: 'has_credits',
          observedAt: Date.now(),
          latencyMs: 10,
        },
        reconciliationVerdict: 'cached_no_credits_but_live_has_credits',
        reconciliationCritical: true,
      },
      'non_billable_probe',
    );
    const snap = buildReconciledSnapshot(audit);
    expect(snap.source).toBe('non_billable_probe');
    expect(snap.safeNonBillableProbeAvailable).toBe(true);
    expect(snap.criticalStaleOperabilityStateCount).toBe(1);
    expect(snap.providerStates['p-live'].critical).toBe(true);
    expect(snap.providerStates['p-live'].creditState).toBe('has_credits'); // live wins
  });

  it('probe error → source falls back to hub_cache', () => {
    const audit = buildAudit(
      {
        id: 'p-err',
        classification: 'unknown',
        probe: {
          providerId: 'p-err',
          endpointType: 'health',
          billableRisk: 'none',
          liveOperabilityState: 'unknown',
          observedAt: Date.now(),
          latencyMs: 1,
          error: 'timeout',
        },
        reconciliationVerdict: 'provider_probe_error',
      },
      'non_billable_probe',
    );
    const snap = buildReconciledSnapshot(audit);
    expect(snap.providerStates['p-err'].source).toBe('hub_cache');
  });
});

describe('applySnapshotToCandidate', () => {
  const baseCandidate = {
    providerId: 'p-x',
    providerHealthy: true,
    hasCredits: true,
    rateLimited: false,
  };
  const makeSnapshot = (state: { auth?: string; credit?: string; rate?: string }): ReconciledOperabilitySnapshot => ({
    observedAt: '2026-05-13T00:00:00.000Z',
    source: 'non_billable_probe',
    criticalStaleOperabilityStateCount: 0,
    safeNonBillableProbeAvailable: true,
    providerStates: {
      'p-x': {
        providerId: 'p-x',
        authState: (state.auth ?? 'auth_ok') as 'auth_ok',
        creditState: (state.credit ?? 'has_credits') as 'has_credits',
        rateState: (state.rate ?? 'ok') as 'ok',
        source: 'non_billable_probe',
      },
    },
  });

  it('live has_credits + cached no_credits → candidate.hasCredits=true (live wins)', () => {
    const cached = { ...baseCandidate, hasCredits: false };
    const snap = makeSnapshot({ credit: 'has_credits' });
    const out = applySnapshotToCandidate(cached, snap);
    expect(out.hasCredits).toBe(true);
  });

  it('live no_credits + cached has_credits → candidate.hasCredits=false (live wins)', () => {
    const cached = { ...baseCandidate, hasCredits: true };
    const snap = makeSnapshot({ credit: 'no_credits' });
    const out = applySnapshotToCandidate(cached, snap);
    expect(out.hasCredits).toBe(false);
  });

  it('live auth_failed → candidate.providerHealthy=false', () => {
    const snap = makeSnapshot({ auth: 'auth_failed' });
    const out = applySnapshotToCandidate(baseCandidate, snap);
    expect(out.providerHealthy).toBe(false);
  });

  it('live rate_limited → candidate.rateLimited=true', () => {
    const snap = makeSnapshot({ rate: 'rate_limited' });
    const out = applySnapshotToCandidate(baseCandidate, snap);
    expect(out.rateLimited).toBe(true);
  });

  it('provider not in snapshot → candidate flags untouched', () => {
    const cached = { ...baseCandidate, providerId: 'p-unknown' };
    const snap = makeSnapshot({});
    const out = applySnapshotToCandidate(cached, snap);
    expect(out.providerHealthy).toBe(cached.providerHealthy);
    expect(out.hasCredits).toBe(cached.hasCredits);
    expect(out.reconciliation).toBeUndefined();
  });
});
