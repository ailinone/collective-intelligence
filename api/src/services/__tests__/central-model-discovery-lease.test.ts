// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CentralModelDiscoveryService + the fleet-wide discovery lease.
 *
 * Pins the contract every caller relies on (boot sync, runner, hourly job,
 * admin trigger all go through discoverAllModels/discoverAllModelsExclusive):
 *   - lease held by another process: no source is fetched, the caller gets
 *     `status: 'skipped'` (discoverAllModels returns []);
 *   - lease acquired: the round runs and the lease is released exactly once,
 *     also when the round throws;
 *   - lease lost mid-round (fencing): sources not yet started are skipped
 *     with DISCOVERY_LEASE_LOST_ERROR and are not recorded as source failures;
 *   - lease disabled: the lease module is never touched (today's behaviour);
 *   - concurrent callers in one process share one acquisition.
 *
 * Hermetic: same prototype-stubbing convention as
 * central-model-discovery-source-concurrency.test.ts; the lease module is
 * mocked, so nothing reaches Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isDiscoveryLeaseEnabled: vi.fn(() => true),
  acquireDiscoveryLease: vi.fn(),
}));

vi.mock('@/database/client', () => ({ prisma: {} }));
vi.mock('@/services/discovery-lease', () => ({
  isDiscoveryLeaseEnabled: h.isDiscoveryLeaseEnabled,
  acquireDiscoveryLease: h.acquireDiscoveryLease,
}));
// A completed leased round publishes the fleet health verdict; keep that off
// Redis here (its contract is covered by central-model-discovery-fleet-signals.test.ts).
vi.mock('@/services/discovery-fleet-health', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/discovery-fleet-health')>()),
  publishDiscoveryHealthSnapshot: vi.fn().mockResolvedValue(true),
  readDiscoveryHealthSnapshot: vi.fn().mockResolvedValue(null),
}));

import {
  CentralModelDiscoveryService,
  DISCOVERY_LEASE_LOST_ERROR,
  type DiscoverySource,
} from '@/services/central-model-discovery-service';

type Proto = Record<string, (...args: never[]) => unknown>;
const proto = CentralModelDiscoveryService.prototype as unknown as Proto;

const ORIGINAL_CONCURRENCY = process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY;

function makeService(sourceCount: number, fetched: string[]): CentralModelDiscoveryService {
  const sources: DiscoverySource[] = Array.from({ length: sourceCount }, (_, i) => ({
    name: `source-${i}`,
    type: 'native_api' as const,
    priority: 1,
    providers: [`provider-${i}`],
    fetcher: async () => {
      fetched.push(`source-${i}`);
      return [] as never;
    },
  }));
  const service = new CentralModelDiscoveryService();
  (service as unknown as { discoverySources: Map<string, DiscoverySource> }).discoverySources =
    new Map(sources.map((s) => [s.name, s]));
  return service;
}

function heldLease(epoch: number, isValid: () => boolean = () => true) {
  const release = vi.fn().mockResolvedValue(undefined);
  return {
    release,
    acquisition: {
      acquired: true as const,
      failedOpen: false,
      lease: { token: `${epoch}|test`, epoch, isValid, release },
    },
  };
}

let recordSourceFailure: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.isDiscoveryLeaseEnabled.mockReset().mockReturnValue(true);
  h.acquireDiscoveryLease.mockReset();
  vi.spyOn(proto, 'initializeSources').mockResolvedValue(undefined as never);
  vi.spyOn(proto, 'processDiscoveredModels').mockImplementation(((
    sourceName: string,
    source: DiscoverySource
  ) =>
    Promise.resolve({
      source: sourceName,
      provider: source.providers.join(','),
      modelsDiscovered: 1,
      modelsUpdated: 0,
      modelsNew: 1,
      errors: [],
    })) as never);
  vi.spyOn(proto, 'recordDiscoveryResults').mockResolvedValue(undefined as never);
  vi.spyOn(proto, 'updateProviderModelCountMetrics').mockResolvedValue(undefined as never);
  vi.spyOn(proto, 'invalidateCaches').mockResolvedValue(undefined as never);
  vi.spyOn(proto, 'checkProviderBalances').mockResolvedValue(undefined as never);
  recordSourceFailure = vi.spyOn(proto, 'recordSourceFailure');
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_CONCURRENCY === undefined) delete process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY;
  else process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY = ORIGINAL_CONCURRENCY;
});

describe('CentralModelDiscoveryService: discovery lease', () => {
  it('skips the whole round when another process holds the lease', async () => {
    h.acquireDiscoveryLease.mockResolvedValue({ acquired: false, holder: '41|ci-worker:1:abcd' });
    const fetched: string[] = [];
    const service = makeService(3, fetched);

    const outcome = await service.discoverAllModelsExclusive();

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'lease-held',
      holder: '41|ci-worker:1:abcd',
    });
    expect(fetched).toEqual([]);
    await expect(service.discoverAllModels()).resolves.toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('runs the round under the lease, reports its epoch and releases it exactly once', async () => {
    const { acquisition, release } = heldLease(42);
    h.acquireDiscoveryLease.mockResolvedValue(acquisition);
    const fetched: string[] = [];
    const service = makeService(3, fetched);

    const outcome = await service.discoverAllModelsExclusive();

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    expect(outcome.leaseEpoch).toBe(42);
    expect(outcome.results.map((r) => r.source)).toEqual(['source-0', 'source-1', 'source-2']);
    expect(fetched).toHaveLength(3);
    expect(h.acquireDiscoveryLease).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease when the round throws', async () => {
    const { acquisition, release } = heldLease(43);
    h.acquireDiscoveryLease.mockResolvedValue(acquisition);
    vi.spyOn(proto, 'invalidateCaches').mockRejectedValue(new Error('cache down') as never);
    const service = makeService(2, []);

    await expect(service.discoverAllModelsExclusive()).rejects.toThrow('cache down');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('stops dispatching sources once the lease is lost, without recording them as source failures', async () => {
    process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY = '1';
    let checks = 0;
    // Valid for the first two sources, lost from the third on.
    const { acquisition, release } = heldLease(44, () => ++checks <= 2);
    h.acquireDiscoveryLease.mockResolvedValue(acquisition);
    const fetched: string[] = [];
    const service = makeService(5, fetched);

    const outcome = await service.discoverAllModelsExclusive();

    if (outcome.status !== 'completed') throw new Error('expected a completed round');
    expect(fetched).toEqual(['source-0', 'source-1']);
    expect(outcome.results.map((r) => r.errors)).toEqual([
      [],
      [],
      [DISCOVERY_LEASE_LOST_ERROR],
      [DISCOVERY_LEASE_LOST_ERROR],
      [DISCOVERY_LEASE_LOST_ERROR],
    ]);
    expect(outcome.results.slice(2).every((r) => r.modelsDiscovered === 0)).toBe(true);
    expect(recordSourceFailure).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('never touches the lease when it is disabled (non-production default)', async () => {
    h.isDiscoveryLeaseEnabled.mockReturnValue(false);
    const fetched: string[] = [];
    const service = makeService(2, fetched);

    const outcome = await service.discoverAllModelsExclusive();

    expect(outcome).toMatchObject({ status: 'completed', leaseEpoch: null });
    expect(fetched).toHaveLength(2);
    expect(h.acquireDiscoveryLease).not.toHaveBeenCalled();
  });

  it('concurrent callers in one process share one lease acquisition and one round', async () => {
    const { acquisition, release } = heldLease(45);
    h.acquireDiscoveryLease.mockResolvedValue(acquisition);
    const fetched: string[] = [];
    const service = makeService(2, fetched);

    const [a, b] = await Promise.all([
      service.discoverAllModels(),
      service.discoverAllModelsExclusive(),
    ]);

    expect(a).toHaveLength(2);
    expect(b.status).toBe('completed');
    expect(fetched).toHaveLength(2);
    expect(h.acquireDiscoveryLease).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a round that failed open (Redis unreachable) still runs every source', async () => {
    h.acquireDiscoveryLease.mockResolvedValue({
      acquired: true,
      failedOpen: true,
      lease: {
        token: null,
        epoch: null,
        isValid: () => true,
        release: vi.fn().mockResolvedValue(undefined),
      },
    });
    const fetched: string[] = [];
    const service = makeService(3, fetched);

    const outcome = await service.discoverAllModelsExclusive();

    expect(outcome).toMatchObject({ status: 'completed', leaseEpoch: null });
    expect(fetched).toHaveLength(3);
  });
});
