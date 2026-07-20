// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderCreditAuditService — metadata_only mode.
 *
 * Pins:
 *   - Reads from hub + catalog views via injectable interfaces
 *   - NEVER calls a real provider
 *   - Classifies operability states correctly
 *   - Counts buckets, local providers, aggregators, routers separately
 *   - Refuses to run non_billable_probe / minimal_billable_probe (out of
 *     scope for this turn)
 */
import { describe, it, expect, vi } from 'vitest';
import { ProviderCreditAuditService } from '../provider-credit-audit-service';
import type {
  OperabilityHubView,
  CatalogView,
  ProviderMetadataView,
} from '../provider-credit-audit-service';

function fakeHub(providers: Record<string, { state: string; balance?: string }>): OperabilityHubView {
  return {
    getSummary: () => ({}),
    getProviderState: (id) => {
      const p = providers[id];
      return p
        ? { operabilityState: p.state, balanceStatus: p.balance }
        : { operabilityState: 'unknown' };
    },
    listKnownProviders: () => Object.keys(providers),
  };
}

function fakeCatalog(counts: Record<string, { visible: number; usable: number }>): CatalogView {
  return {
    countActiveModelsForProvider: async (id) => counts[id]?.visible ?? 0,
    countUsableModelsForProvider: async (id) => counts[id]?.usable ?? 0,
  };
}

function fakeMetadata(meta: Record<string, { credential?: boolean; aggregator?: boolean; router?: boolean; local?: boolean }>): ProviderMetadataView {
  return {
    hasCredential: (id) => meta[id]?.credential ?? true,
    isAggregator: (id) => meta[id]?.aggregator ?? false,
    isRouter: (id) => meta[id]?.router ?? false,
    isLocal: (id) => meta[id]?.local ?? false,
  };
}

describe('ProviderCreditAuditService — metadata_only', () => {
  it('classifies a healthy provider with models as "usable"', async () => {
    const svc = new ProviderCreditAuditService({
      hub: fakeHub({ 'p-a': { state: 'healthy', balance: 'has_credits' } }),
      catalog: fakeCatalog({ 'p-a': { visible: 5, usable: 5 } }),
      metadata: fakeMetadata({ 'p-a': { credential: true } }),
    });
    const r = await svc.run({
      mode: 'metadata_only',
      maxTotalCostUsd: 0,
      includeAggregators: true,
      includeRouters: true,
      includeLocal: true,
    });
    expect(r.providersUsable).toBe(1);
    expect(r.modelsUsable).toBe(5);
    expect(r.providerResults[0].classification).toBe('usable');
  });

  it('classifies no_credits / auth_failed / rate_limited correctly', async () => {
    const svc = new ProviderCreditAuditService({
      hub: fakeHub({
        'p-broke': { state: 'no_credits' },
        'p-auth': { state: 'auth_failed' },
        'p-rate': { state: 'rate_limited' },
      }),
      catalog: fakeCatalog({
        'p-broke': { visible: 3, usable: 3 },
        'p-auth': { visible: 2, usable: 2 },
        'p-rate': { visible: 1, usable: 1 },
      }),
      metadata: fakeMetadata({}),
    });
    const r = await svc.run({
      mode: 'metadata_only',
      maxTotalCostUsd: 0,
      includeAggregators: true,
      includeRouters: true,
      includeLocal: true,
    });
    expect(r.providersNoCredits).toBe(1);
    expect(r.providersAuthFailed).toBe(1);
    expect(r.providersRateLimited).toBe(1);
    expect(r.providersUsable).toBe(0);
  });

  it('respects includeLocal / includeAggregators / includeRouters flags', async () => {
    const svc = new ProviderCreditAuditService({
      hub: fakeHub({
        'cloud-1': { state: 'healthy' },
        'ollama': { state: 'healthy' },
        'aihub': { state: 'healthy' },
      }),
      catalog: fakeCatalog({
        'cloud-1': { visible: 1, usable: 1 },
        'ollama': { visible: 1, usable: 1 },
        'aihub': { visible: 100, usable: 100 },
      }),
      metadata: fakeMetadata({
        ollama: { local: true },
        aihub: { aggregator: true },
      }),
    });
    const r = await svc.run({
      mode: 'metadata_only',
      maxTotalCostUsd: 0,
      includeAggregators: false,
      includeRouters: false,
      includeLocal: false,
    });
    expect(r.providersConfigured).toBe(1); // only cloud-1
    expect(r.localProvidersConsidered).toBe(0);
    expect(r.aggregatorsConsidered).toBe(0);
  });

  it('flags "classification_says_usable_but_no_models_visible" when state is healthy but catalog returns 0', async () => {
    const svc = new ProviderCreditAuditService({
      hub: fakeHub({ 'p-empty': { state: 'healthy' } }),
      catalog: fakeCatalog({ 'p-empty': { visible: 0, usable: 0 } }),
      metadata: fakeMetadata({}),
    });
    const r = await svc.run({
      mode: 'metadata_only',
      maxTotalCostUsd: 0,
      includeAggregators: true,
      includeRouters: true,
      includeLocal: true,
    });
    expect(r.providerResults[0].classification).toBe('no_models_visible');
    expect(r.providerResults[0].notes?.[0]).toContain('no_models_visible');
  });

  it('honors maxProviders cap', async () => {
    const svc = new ProviderCreditAuditService({
      hub: fakeHub({
        'p-1': { state: 'healthy' },
        'p-2': { state: 'healthy' },
        'p-3': { state: 'healthy' },
      }),
      catalog: fakeCatalog({}),
      metadata: fakeMetadata({}),
    });
    const r = await svc.run({
      mode: 'metadata_only',
      maxTotalCostUsd: 0,
      maxProviders: 2,
      includeAggregators: true,
      includeRouters: true,
      includeLocal: true,
    });
    expect(r.providersInspected).toBe(2);
  });

  it('marks no_credential_configured when metadata.hasCredential=false', async () => {
    const svc = new ProviderCreditAuditService({
      hub: fakeHub({ 'p-x': { state: 'healthy' } }),
      catalog: fakeCatalog({ 'p-x': { visible: 5, usable: 5 } }),
      metadata: fakeMetadata({ 'p-x': { credential: false } }),
    });
    const r = await svc.run({
      mode: 'metadata_only',
      maxTotalCostUsd: 0,
      includeAggregators: true,
      includeRouters: true,
      includeLocal: true,
    });
    expect(r.providersWithCredential).toBe(0);
    expect(r.providerResults[0].classification).toBe('no_credential_configured');
  });

  it('non_billable_probe is now SUPPORTED (Strategy 01C.0.2); see provider-credit-audit-non-billable.test.ts for full coverage', async () => {
    const svc = new ProviderCreditAuditService({
      hub: fakeHub({ 'p-a': { state: 'healthy' } }),
      catalog: fakeCatalog({ 'p-a': { visible: 1, usable: 1 } }),
      metadata: fakeMetadata({}),
    });
    const r = await svc.run({
      mode: 'non_billable_probe',
      maxTotalCostUsd: 0,
      includeAggregators: true,
      includeRouters: true,
      includeLocal: true,
    });
    // Without a probe registry, every provider gets `provider_probe_not_supported`.
    expect(r.providerResults[0].reconciliation?.verdict).toBe('provider_probe_not_supported');
  });

  it('refuses to run minimal_billable_probe', async () => {
    const svc = new ProviderCreditAuditService({
      hub: fakeHub({}),
      catalog: fakeCatalog({}),
      metadata: fakeMetadata({}),
    });
    await expect(
      svc.run({
        mode: 'minimal_billable_probe',
        maxTotalCostUsd: 1.0,
        includeAggregators: true,
        includeRouters: true,
        includeLocal: true,
      }),
    ).rejects.toThrow(/minimal_billable_probe is not implemented/);
  });

  it('zero provider call: catalog methods are awaited but no fetch is made', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('fetch must not be called'); });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const svc = new ProviderCreditAuditService({
        hub: fakeHub({ 'p-a': { state: 'healthy' } }),
        catalog: fakeCatalog({ 'p-a': { visible: 1, usable: 1 } }),
        metadata: fakeMetadata({}),
      });
      await svc.run({
        mode: 'metadata_only',
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
});
