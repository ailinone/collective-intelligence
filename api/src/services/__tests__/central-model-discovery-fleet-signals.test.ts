// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Per-process signals a discovery round used to provide as a side effect,
 * kept correct now that one round runs fleet-wide (discovery lease) and the
 * api runs none at boot (2026-09-24 review of the SAB Phase 1d PR).
 *
 * 1. Auto-disable circuit breaker input (getAutoDisableDiscoverySignal):
 *    - a process that never ran a complete round, with no fleet verdict, is
 *      UNTRUSTED (the sweep then disables nothing), instead of returning the
 *      empty "every provider is healthy" set it used to;
 *    - a fresh fleet verdict published on redis-lease is trusted and carries the
 *      publisher's flagged providers;
 *    - a complete round under the lease makes the local verdict trusted and
 *      publishes it; a round cut short by a lost lease does neither;
 *    - with the lease disabled the fleet key is never read nor written.
 * 2. Provider balances (refreshProviderBalances): the map the selector's
 *    funding gate reads can be filled without a discovery round, is not
 *    re-probed while fresh, and shares one sweep between concurrent callers.
 *
 * Hermetic: prototype stubs for the network/DB steps (same convention as
 * central-model-discovery-lease.test.ts); the lease, the fleet store, the
 * provider registry and the operability hub are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isDiscoveryLeaseEnabled: vi.fn(() => true),
  acquireDiscoveryLease: vi.fn(),
  readDiscoveryHealthSnapshot: vi.fn(),
  publishDiscoveryHealthSnapshot: vi.fn(),
  getProviderRegistry: vi.fn(),
  recordProbeResult: vi.fn(),
}));

vi.mock('@/database/client', () => ({ prisma: {} }));
vi.mock('@/services/discovery-lease', () => ({
  isDiscoveryLeaseEnabled: h.isDiscoveryLeaseEnabled,
  acquireDiscoveryLease: h.acquireDiscoveryLease,
}));
vi.mock('@/services/discovery-fleet-health', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/discovery-fleet-health')>()),
  readDiscoveryHealthSnapshot: h.readDiscoveryHealthSnapshot,
  publishDiscoveryHealthSnapshot: h.publishDiscoveryHealthSnapshot,
}));
vi.mock('@/providers/provider-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/provider-registry')>()),
  getProviderRegistry: () => h.getProviderRegistry(),
}));
vi.mock('@/core/provider-operability-hub', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/provider-operability-hub')>()),
  getProviderOperabilityHub: () => ({ recordProbeResult: h.recordProbeResult }),
}));

import {
  CentralModelDiscoveryService,
  type DiscoverySource,
} from '@/services/central-model-discovery-service';
import type { DiscoveryHealthSnapshot } from '@/services/discovery-fleet-health';

type Proto = Record<string, (...args: never[]) => unknown>;
const proto = CentralModelDiscoveryService.prototype as unknown as Proto;

const HOUR = 60 * 60 * 1000;
const ORIGINAL_CONCURRENCY = process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY;

/** provider -> models its only source reports (0 = broken discovery). */
function makeService(modelsByProvider: Record<string, number>): CentralModelDiscoveryService {
  const sources: DiscoverySource[] = Object.keys(modelsByProvider).map((provider) => ({
    name: `${provider}-source`,
    type: 'native_api' as const,
    priority: 1,
    providers: [provider],
    fetcher: async () => [] as never,
  }));
  vi.spyOn(proto, 'processDiscoveredModels').mockImplementation(((
    sourceName: string,
    source: DiscoverySource
  ) =>
    Promise.resolve({
      source: sourceName,
      provider: source.providers.join(','),
      modelsDiscovered: modelsByProvider[source.providers[0]] ?? 0,
      modelsUpdated: 0,
      modelsNew: 0,
      errors: [],
    })) as never);
  const service = new CentralModelDiscoveryService();
  (service as unknown as { discoverySources: Map<string, DiscoverySource> }).discoverySources =
    new Map(sources.map((s) => [s.name, s]));
  return service;
}

function heldLease(epoch: number, isValid: () => boolean = () => true) {
  return {
    acquired: true as const,
    failedOpen: false,
    lease: {
      token: `${epoch}|test`,
      epoch,
      isValid,
      release: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function fleetSnapshot(overrides: Partial<DiscoveryHealthSnapshot> = {}): DiscoveryHealthSnapshot {
  return {
    version: 1,
    completedAt: Date.now() - 20 * 60 * 1000,
    unhealthyProviders: ['aws-bedrock'],
    sourcesAttempted: 250,
    owner: 'ci-worker:1',
    leaseEpoch: 9,
    ...overrides,
  };
}

beforeEach(() => {
  h.isDiscoveryLeaseEnabled.mockReset().mockReturnValue(true);
  h.acquireDiscoveryLease.mockReset();
  h.readDiscoveryHealthSnapshot.mockReset().mockResolvedValue(null);
  h.publishDiscoveryHealthSnapshot.mockReset().mockResolvedValue(true);
  h.getProviderRegistry.mockReset();
  h.recordProbeResult.mockReset();
  vi.spyOn(proto, 'initializeSources').mockResolvedValue(undefined as never);
  vi.spyOn(proto, 'recordDiscoveryResults').mockResolvedValue(undefined as never);
  vi.spyOn(proto, 'updateProviderModelCountMetrics').mockResolvedValue(undefined as never);
  vi.spyOn(proto, 'invalidateCaches').mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_CONCURRENCY === undefined) delete process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY;
  else process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY = ORIGINAL_CONCURRENCY;
});

describe('getAutoDisableDiscoverySignal (auto-disable circuit breaker input)', () => {
  beforeEach(() => {
    vi.spyOn(proto, 'checkProviderBalances').mockResolvedValue(undefined as never);
  });

  it('is UNTRUSTED on a process that never ran a round when the fleet has no verdict', async () => {
    const service = makeService({ openai: 5, 'aws-bedrock': 0 });

    // The old input: empty for lack of data, which the sweep read as
    // "every provider is healthy".
    expect(service.getProvidersWithoutHealthyDiscovery().size).toBe(0);

    const signal = await service.getAutoDisableDiscoverySignal();
    expect(signal.trusted).toBe(false);
    expect(h.readDiscoveryHealthSnapshot).toHaveBeenCalledTimes(1);
  });

  it('trusts a fresh fleet verdict and exempts the providers it flagged', async () => {
    h.readDiscoveryHealthSnapshot.mockResolvedValue(fleetSnapshot());
    const service = makeService({ openai: 5 });

    const signal = await service.getAutoDisableDiscoverySignal();

    expect(signal).toMatchObject({ trusted: true, basis: 'fleet' });
    if (!signal.trusted) throw new Error('unreachable');
    expect(signal.unhealthyProviders).toEqual(new Set(['aws-bedrock']));
  });

  it('does not trust a fleet verdict older than the limit', async () => {
    h.readDiscoveryHealthSnapshot.mockResolvedValue(
      fleetSnapshot({ completedAt: Date.now() - 4 * HOUR })
    );
    const service = makeService({ openai: 5 });

    const signal = await service.getAutoDisableDiscoverySignal({ maxAgeMs: 3 * HOUR });

    expect(signal.trusted).toBe(false);
  });

  it('a complete round under the lease makes the local verdict trusted and publishes it', async () => {
    h.acquireDiscoveryLease.mockResolvedValue(heldLease(12));
    const service = makeService({ openai: 5, 'aws-bedrock': 0, orqai: 0 });

    const outcome = await service.discoverAllModelsExclusive();
    expect(outcome.status).toBe('completed');

    const signal = await service.getAutoDisableDiscoverySignal();
    expect(signal).toMatchObject({ trusted: true, basis: 'local' });
    if (!signal.trusted) throw new Error('unreachable');
    expect(signal.unhealthyProviders).toEqual(new Set(['aws-bedrock', 'orqai']));

    expect(h.publishDiscoveryHealthSnapshot).toHaveBeenCalledTimes(1);
    const published = h.publishDiscoveryHealthSnapshot.mock.calls[0][0] as DiscoveryHealthSnapshot;
    expect(published).toMatchObject({
      version: 1,
      unhealthyProviders: ['aws-bedrock', 'orqai'],
      sourcesAttempted: 3,
      leaseEpoch: 12,
    });
    expect(Date.now() - published.completedAt).toBeLessThan(60_000);
  });

  it('a round cut short by a lost lease neither vouches locally nor publishes', async () => {
    process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY = '1';
    let checks = 0;
    h.acquireDiscoveryLease.mockResolvedValue(heldLease(13, () => ++checks <= 1));
    const service = makeService({ openai: 5, 'aws-bedrock': 0, orqai: 0 });

    const outcome = await service.discoverAllModelsExclusive();
    expect(outcome.status).toBe('completed');

    const signal = await service.getAutoDisableDiscoverySignal();
    expect(signal.trusted).toBe(false);
    expect(h.publishDiscoveryHealthSnapshot).not.toHaveBeenCalled();
  });

  it('with the lease disabled, never touches the fleet key and relies on its own complete round', async () => {
    h.isDiscoveryLeaseEnabled.mockReturnValue(false);
    const service = makeService({ openai: 5, 'aws-bedrock': 0 });

    expect((await service.getAutoDisableDiscoverySignal()).trusted).toBe(false);

    await service.discoverAllModelsExclusive();
    const signal = await service.getAutoDisableDiscoverySignal();

    expect(signal).toMatchObject({ trusted: true, basis: 'local' });
    if (!signal.trusted) throw new Error('unreachable');
    expect(signal.unhealthyProviders).toEqual(new Set(['aws-bedrock']));
    expect(h.readDiscoveryHealthSnapshot).not.toHaveBeenCalled();
    expect(h.publishDiscoveryHealthSnapshot).not.toHaveBeenCalled();
    expect(h.acquireDiscoveryLease).not.toHaveBeenCalled();
  });

  it('a stale local round is not enough on its own', async () => {
    h.isDiscoveryLeaseEnabled.mockReturnValue(false);
    const service = makeService({ openai: 5 });
    await service.discoverAllModelsExclusive();

    const signal = await service.getAutoDisableDiscoverySignal({ now: Date.now() + 4 * HOUR });

    expect(signal.trusted).toBe(false);
  });
});

describe('refreshProviderBalances (per-process balance map without a discovery round)', () => {
  function registryWith(balances: Record<string, boolean>, probeCount: { n: number }) {
    return {
      getProviderNames: () => Object.keys(balances),
      get: (name: string) => ({
        checkBalance: async () => {
          probeCount.n += 1;
          return { hasCredits: balances[name], balance: balances[name] ? 10 : 0, currency: 'USD' };
        },
      }),
    };
  }

  it('fills the map the selector reads, which is all "unknown" before any round', async () => {
    const probes = { n: 0 };
    h.getProviderRegistry.mockReturnValue(registryWith({ openai: true, deepseek: false }, probes));
    const service = makeService({});

    expect(service.getModelBalanceStatus('openai')).toBe('unknown');
    expect(service.getLastProviderBalanceCheckAt()).toBeNull();

    await expect(service.refreshProviderBalances()).resolves.toBe(true);

    expect(service.getModelBalanceStatus('openai')).toBe('has-credits');
    expect(service.getModelBalanceStatus('deepseek')).toBe('no-credits');
    expect(service.getLastProviderBalanceCheckAt()).toBeInstanceOf(Date);
    expect(probes.n).toBe(2);
  });

  it('skips while the last sweep is younger than maxAgeMs', async () => {
    const probes = { n: 0 };
    h.getProviderRegistry.mockReturnValue(registryWith({ openai: true }, probes));
    const service = makeService({});

    await service.refreshProviderBalances();
    await expect(service.refreshProviderBalances({ maxAgeMs: HOUR })).resolves.toBe(false);
    expect(probes.n).toBe(1);

    // Without a max age (or once it has passed) it probes again.
    await expect(service.refreshProviderBalances()).resolves.toBe(true);
    expect(probes.n).toBe(2);
  });

  it('shares one sweep between concurrent callers', async () => {
    const probes = { n: 0 };
    h.getProviderRegistry.mockReturnValue(registryWith({ openai: true }, probes));
    const service = makeService({});

    const [a, b] = await Promise.all([
      service.refreshProviderBalances(),
      service.refreshProviderBalances(),
    ]);

    expect([a, b]).toEqual([true, true]);
    expect(probes.n).toBe(1);
  });

  it('reports false and keeps "unknown" when the provider registry is not initialised yet', async () => {
    h.getProviderRegistry.mockImplementation(() => {
      throw new Error('Provider registry not initialized. Call initializeProviderRegistry first.');
    });
    const service = makeService({});

    await expect(service.refreshProviderBalances()).resolves.toBe(false);
    expect(service.getModelBalanceStatus('openai')).toBe('unknown');
    expect(service.getLastProviderBalanceCheckAt()).toBeNull();
  });
});
