// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.2 Part C — non_billable_probe mode tests.
 *
 * Pins:
 *  - non_billable_probe runs only when a probe is registered with
 *    billableRisk='none'
 *  - Providers without a registered probe → reconciliation.verdict =
 *    'provider_probe_not_supported' (NEVER called)
 *  - cached_no_credits_but_live_has_credits is detected and marked
 *    isCritical=true
 *  - Probe errors don't crash the audit (verdict='provider_probe_error')
 *  - Registering a probe with billableRisk != 'none' throws
 */
import { describe, it, expect, vi } from 'vitest';
import { ProviderCreditAuditService } from '../provider-credit-audit-service';
import { ProviderProbeRegistry, reconcileProviderState } from '../provider-probe-registry';
import type {
  CatalogView,
  OperabilityHubView,
  ProviderMetadataView,
} from '../provider-credit-audit-service';
import type { ProviderProbeResult } from '../provider-credit-audit-types';

function fakeHub(states: Record<string, { state: string; balance?: string }>): OperabilityHubView {
  return {
    getSummary: () => ({}),
    getProviderState: (id) => {
      const p = states[id];
      return p
        ? { operabilityState: p.state, balanceStatus: p.balance }
        : { operabilityState: 'unknown' };
    },
    listKnownProviders: () => Object.keys(states),
  };
}
function fakeCatalog(): CatalogView {
  return {
    countActiveModelsForProvider: async () => 1,
    countUsableModelsForProvider: async () => 1,
  };
}
function fakeMetadata(): ProviderMetadataView {
  return {
    hasCredential: () => true,
    isAggregator: () => false,
    isRouter: () => false,
    isLocal: () => false,
  };
}

describe('ProviderProbeRegistry', () => {
  it('refuses to register a probe with billableRisk != "none"', () => {
    const reg = new ProviderProbeRegistry();
    expect(() =>
      reg.register({
        providerId: 'risky',
        endpointType: 'models',
        billableRisk: 'unknown',
        probe: async () => ({ liveOperabilityState: 'healthy', observedAt: 0, latencyMs: 0 }),
      }),
    ).toThrow(/Refusing to register/);
  });

  it('returns probeSupported=false for unregistered providers', () => {
    const reg = new ProviderProbeRegistry();
    const meta = reg.getMetadata('not-registered');
    expect(meta.probeSupported).toBe(false);
    expect(meta.probeBillableRisk).toBe('unknown');
  });

  it('runs a registered probe and returns the result', async () => {
    const reg = new ProviderProbeRegistry();
    reg.register({
      providerId: 'p-a',
      endpointType: 'balance',
      billableRisk: 'none',
      probe: async () => ({
        liveOperabilityState: 'healthy',
        liveBalanceStatus: 'has_credits',
        observedAt: 1,
        latencyMs: 10,
      }),
    });
    const r = await reg.run('p-a', 5000);
    expect(r?.liveBalanceStatus).toBe('has_credits');
    expect(r?.endpointType).toBe('balance');
  });

  it('captures probe errors without throwing', async () => {
    const reg = new ProviderProbeRegistry();
    reg.register({
      providerId: 'p-broken',
      endpointType: 'health',
      billableRisk: 'none',
      probe: async () => {
        throw new Error('connect ETIMEDOUT');
      },
    });
    const r = await reg.run('p-broken', 100);
    expect(r?.error).toContain('connect ETIMEDOUT');
  });
});

describe('reconcileProviderState', () => {
  it('cached_no_credits_but_live_has_credits is CRITICAL', () => {
    const r = reconcileProviderState({
      providerId: 'p-stale',
      cachedOperabilityState: 'no_credits',
      cachedBalanceStatus: 'no_credits',
      probe: {
        providerId: 'p-stale',
        endpointType: 'balance',
        billableRisk: 'none',
        liveOperabilityState: 'healthy',
        liveBalanceStatus: 'has_credits',
        observedAt: 1,
        latencyMs: 5,
      } as ProviderProbeResult,
    });
    expect(r.verdict).toBe('cached_no_credits_but_live_has_credits');
    expect(r.isCriticalStale).toBe(true);
  });

  it('cached_has_credits_but_live_no_credits is NOT critical (just refresh)', () => {
    const r = reconcileProviderState({
      providerId: 'p-x',
      cachedOperabilityState: 'healthy',
      cachedBalanceStatus: 'has_credits',
      probe: {
        providerId: 'p-x',
        endpointType: 'balance',
        billableRisk: 'none',
        liveOperabilityState: 'no_credits',
        liveBalanceStatus: 'no_credits',
        observedAt: 1,
        latencyMs: 5,
      } as ProviderProbeResult,
    });
    expect(r.verdict).toBe('cached_has_credits_but_live_no_credits');
    expect(r.isCriticalStale).toBe(false);
  });

  it('cached_healthy_but_live_auth_failed is CRITICAL', () => {
    const r = reconcileProviderState({
      providerId: 'p-auth',
      cachedOperabilityState: 'healthy',
      probe: {
        providerId: 'p-auth',
        endpointType: 'health',
        billableRisk: 'none',
        liveOperabilityState: 'auth_failed',
        observedAt: 1,
        latencyMs: 5,
      } as ProviderProbeResult,
    });
    expect(r.verdict).toBe('cached_healthy_but_live_auth_failed');
    expect(r.isCriticalStale).toBe(true);
  });

  it('probe error → verdict=provider_probe_error, not critical', () => {
    const r = reconcileProviderState({
      providerId: 'p-err',
      cachedOperabilityState: 'unknown',
      probe: {
        providerId: 'p-err',
        endpointType: 'health',
        billableRisk: 'none',
        liveOperabilityState: 'unknown',
        observedAt: 1,
        latencyMs: 1,
        error: 'timeout',
      } as ProviderProbeResult,
    });
    expect(r.verdict).toBe('provider_probe_error');
    expect(r.isCriticalStale).toBe(false);
  });

  it('no probe → provider_probe_not_supported, not critical', () => {
    const r = reconcileProviderState({
      providerId: 'p-no-probe',
      cachedOperabilityState: 'unknown',
    });
    expect(r.verdict).toBe('provider_probe_not_supported');
    expect(r.isCriticalStale).toBe(false);
  });

  it('aligned when states agree', () => {
    const r = reconcileProviderState({
      providerId: 'p-agree',
      cachedOperabilityState: 'healthy',
      cachedBalanceStatus: 'has_credits',
      probe: {
        providerId: 'p-agree',
        endpointType: 'balance',
        billableRisk: 'none',
        liveOperabilityState: 'healthy',
        liveBalanceStatus: 'has_credits',
        observedAt: 1,
        latencyMs: 1,
      } as ProviderProbeResult,
    });
    expect(r.verdict).toBe('aligned');
  });
});

describe('ProviderCreditAuditService — non_billable_probe mode', () => {
  it('still runs metadata for unregistered providers but marks them not_supported in reconciliation', async () => {
    const reg = new ProviderProbeRegistry();
    // No probes registered.
    const svc = new ProviderCreditAuditService({
      hub: fakeHub({ 'p-a': { state: 'healthy' } }),
      catalog: fakeCatalog(),
      metadata: fakeMetadata(),
      probeRegistry: reg,
    });
    const r = await svc.run({
      mode: 'non_billable_probe',
      maxTotalCostUsd: 0,
      includeAggregators: true,
      includeRouters: true,
      includeLocal: true,
    });
    expect(r.mode).toBe('non_billable_probe');
    expect(r.providerResults[0].reconciliation?.verdict).toBe('provider_probe_not_supported');
    expect(r.staleOperabilityStates.length).toBe(0); // not_supported is NOT a stale state
    expect(r.criticalStaleOperabilityStateCount).toBe(0);
  });

  it('detects critical_stale when cached=no_credits but probe says has_credits', async () => {
    const reg = new ProviderProbeRegistry();
    reg.register({
      providerId: 'p-stale',
      endpointType: 'balance',
      billableRisk: 'none',
      probe: async () => ({
        liveOperabilityState: 'healthy',
        liveBalanceStatus: 'has_credits',
        observedAt: Date.now(),
        latencyMs: 1,
      }),
    });
    const svc = new ProviderCreditAuditService({
      hub: fakeHub({ 'p-stale': { state: 'no_credits', balance: 'no_credits' } }),
      catalog: fakeCatalog(),
      metadata: fakeMetadata(),
      probeRegistry: reg,
    });
    const r = await svc.run({
      mode: 'non_billable_probe',
      maxTotalCostUsd: 0,
      includeAggregators: true,
      includeRouters: true,
      includeLocal: true,
    });
    expect(r.criticalStaleOperabilityStateCount).toBe(1);
    expect(r.staleOperabilityStates[0].reason).toBe('cached_no_credits_but_live_has_credits');
    expect(r.staleOperabilityStates[0].isCritical).toBe(true);
  });

  it('zero fetch even in non_billable_probe mode (registered probe is the only call path)', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('fetch must not be called from audit'); });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const reg = new ProviderProbeRegistry();
      const svc = new ProviderCreditAuditService({
        hub: fakeHub({ 'p-a': { state: 'healthy' } }),
        catalog: fakeCatalog(),
        metadata: fakeMetadata(),
        probeRegistry: reg,
      });
      await svc.run({
        mode: 'non_billable_probe',
        maxTotalCostUsd: 0,
        includeAggregators: true,
        includeRouters: true,
        includeLocal: true,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('still refuses minimal_billable_probe', async () => {
    const svc = new ProviderCreditAuditService({
      hub: fakeHub({}),
      catalog: fakeCatalog(),
      metadata: fakeMetadata(),
    });
    await expect(
      svc.run({
        mode: 'minimal_billable_probe',
        maxTotalCostUsd: 1,
        includeAggregators: true,
        includeRouters: true,
        includeLocal: true,
      }),
    ).rejects.toThrow(/minimal_billable_probe is not implemented/);
  });
});
