// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MODEL_DISCOVERY_SOURCE_CONCURRENCY caps how many discovery sources run at
 * once inside runDiscoveryRound (each source ends in an interactive
 * bulk-upsert transaction that can hold a pooled backend for up to 20 s).
 * Unset/0 keeps today's full fan-out; the per-source results are identical
 * either way.
 *
 * Hermetic: constructs a real CentralModelDiscoveryService (same convention
 * as central-model-discovery-unhealthy-providers.test.ts) with the private
 * network/DB-touching steps stubbed on the prototype before construction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/database/client', () => ({ prisma: {} }));

import {
  CentralModelDiscoveryService,
  type DiscoverySource,
} from '@/services/central-model-discovery-service';

interface Deferred {
  promise: Promise<unknown[]>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<unknown[]>((res) => {
    resolve = () => res([]);
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

type Proto = Record<string, (...args: never[]) => unknown>;
const proto = CentralModelDiscoveryService.prototype as unknown as Proto;

const ORIGINAL_CONCURRENCY = process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY;

function makeService(sources: DiscoverySource[]): CentralModelDiscoveryService {
  const service = new CentralModelDiscoveryService();
  (service as unknown as { discoverySources: Map<string, DiscoverySource> }).discoverySources = new Map(
    sources.map((s) => [s.name, s])
  );
  return service;
}

function fakeSources(gates: Deferred[], started: string[]): DiscoverySource[] {
  return gates.map((gate, i) => ({
    name: `source-${i}`,
    type: 'native_api' as const,
    priority: 1,
    providers: [`provider-${i}`],
    fetcher: async () => {
      started.push(`source-${i}`);
      return gate.promise as Promise<never>;
    },
  }));
}

beforeEach(() => {
  vi.spyOn(proto, 'initializeSources').mockResolvedValue(undefined as never);
  vi.spyOn(proto, 'processDiscoveredModels').mockImplementation(((sourceName: string, source: DiscoverySource) =>
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
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_CONCURRENCY === undefined) delete process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY;
  else process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY = ORIGINAL_CONCURRENCY;
});

describe('runDiscoveryRound — MODEL_DISCOVERY_SOURCE_CONCURRENCY', () => {
  it('=2: at most two sources are fetching at once, results match full fan-out', async () => {
    process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY = '2';
    const gates = Array.from({ length: 5 }, deferred);
    const started: string[] = [];
    const service = makeService(fakeSources(gates, started));

    const run = service.discoverAllModels();
    await flush();
    expect(started).toEqual(['source-0', 'source-1']);

    gates[0].resolve();
    await flush();
    expect(started).toEqual(['source-0', 'source-1', 'source-2']);

    gates[1].resolve();
    gates[2].resolve();
    await flush();
    expect(started).toHaveLength(5);

    gates[3].resolve();
    gates[4].resolve();
    const results = await run;

    expect(results.map((r) => r.source)).toEqual(['source-0', 'source-1', 'source-2', 'source-3', 'source-4']);
    expect(results.every((r) => r.modelsDiscovered === 1 && r.errors.length === 0)).toBe(true);
  });

  it('unset: caps fan-out at the default of 4, unlike full Promise.all', async () => {
    delete process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY;
    const gates = Array.from({ length: 5 }, deferred);
    const started: string[] = [];
    const service = makeService(fakeSources(gates, started));

    const run = service.discoverAllModels();
    await flush();
    expect(started).toEqual(['source-0', 'source-1', 'source-2', 'source-3']);

    gates[0].resolve();
    await flush();
    expect(started).toHaveLength(5);

    gates.slice(1).forEach((g) => g.resolve());
    const results = await run;
    expect(results).toHaveLength(5);
  });

  it("explicit '0': restores full unbounded fan-out (operator escape hatch)", async () => {
    process.env.MODEL_DISCOVERY_SOURCE_CONCURRENCY = '0';
    const gates = Array.from({ length: 5 }, deferred);
    const started: string[] = [];
    const service = makeService(fakeSources(gates, started));

    const run = service.discoverAllModels();
    await flush();
    expect(started).toHaveLength(5);

    gates.forEach((g) => g.resolve());
    const results = await run;
    expect(results).toHaveLength(5);
  });
});
