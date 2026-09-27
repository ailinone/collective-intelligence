// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 2026-09-24 production finding: the "model-discovery-hourly" job never
 * completed. runDiscovery() awaited buildIndex() over 118k models (O(n*G*M),
 * hours of CPU) inside `discoveryInFlight` and inside the job body, so every
 * later tick was a no-op, the job blocked worker shutdown until SIGKILL, and
 * BullMQ then re-dispatched it mid-rollout.
 *
 * These tests wire the REAL runner to the REAL equivalence service (only the
 * central discovery service and the Prisma client are mocked) and prove:
 *   - the tick resolves while the index for a large catalog is still building;
 *   - `discoveryInFlight` is released on success, error and abort (deadline);
 *   - a round abandoned at the deadline still refreshes the index when it ends;
 *   - a round skipped by the fleet-wide discovery lease never starts a build;
 *   - graceful shutdown stops the background build promptly.
 *
 * The index build is now linear (seconds for the whole catalog), so "still
 * building" is held deterministically: the catalog read is a deferred promise,
 * and a 0 ms slice (MODEL_EQUIVALENCE_BUILD_SLICE_MS) makes the grouping yield
 * at every checkpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handFixture, syntheticCatalog } from './fixtures/equivalence-catalog.fixture';

const h = vi.hoisted(() => {
  const discoverAllModels = vi.fn();
  // Mirrors the real contract: the runner calls the exclusive variant (the
  // fleet-wide discovery lease), which runs the same round and wraps it in
  // an outcome, so every discoverAllModels assertion below still holds.
  const discoverAllModelsExclusive = vi.fn(async () => ({
    status: 'completed' as const,
    results: await discoverAllModels(),
    leaseEpoch: null,
  }));
  const service = {
    discoverAllModels,
    discoverAllModelsExclusive,
    getDiscoveryHealth: vi.fn().mockReturnValue({ sources: [], criticalMissing: [] }),
    retryFailedSources: vi.fn().mockResolvedValue([]),
    refreshProviderBalances: vi.fn().mockResolvedValue(false),
    getProviderBalanceStatus: vi.fn(() => new Map()),
  };
  return {
    discoverAllModels,
    discoverAllModelsExclusive,
    getCentralModelDiscoveryService: vi.fn().mockResolvedValue(service),
    queryRaw: vi.fn(),
  };
});

vi.mock('@/services/central-model-discovery-service', () => ({
  getCentralModelDiscoveryService: h.getCentralModelDiscoveryService,
}));
vi.mock('@/database/client', () => ({
  prisma: { $queryRaw: h.queryRaw },
}));

type Runner = typeof import('@/services/model-discovery-runner');
type Equivalence = typeof import('@/services/model-equivalence-service');

const ROUND_OK = [{ source: 's', provider: 'p', modelsDiscovered: 1, errors: [] }];
const LARGE_CATALOG = syntheticCatalog(60000, 31).map((r) => ({
  uid: r.uid,
  modelId: r.modelId,
  providerId: r.providerId,
  providerName: r.provider,
  sourceType: r.sourceType,
}));
const SMALL_CATALOG = handFixture().map((r) => ({
  uid: r.uid,
  modelId: r.modelId,
  providerId: r.providerId,
  providerName: r.provider,
  sourceType: r.sourceType,
}));

let runner: Runner;
let equivalence: Equivalence;

async function load(): Promise<void> {
  vi.resetModules();
  runner = await import('@/services/model-discovery-runner');
  equivalence = await import('@/services/model-equivalence-service');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(async () => {
  h.discoverAllModels.mockReset();
  h.discoverAllModelsExclusive.mockClear();
  h.queryRaw.mockReset();
  process.env.MODEL_EQUIVALENCE_LAZY_REBUILD = 'false';
  await load();
});

afterEach(async () => {
  equivalence.shutdownModelEquivalenceIndex();
  await equivalence.getModelEquivalenceService().whenIdle();
  delete process.env.MODEL_EQUIVALENCE_LAZY_REBUILD;
  delete process.env.MODEL_EQUIVALENCE_BUILD_SLICE_MS;
});

describe('model discovery tick vs. equivalence index', () => {
  it('resolves without waiting for the index of a large catalog', async () => {
    h.discoverAllModels.mockResolvedValue(ROUND_OK);
    const read = deferred<typeof LARGE_CATALOG>();
    h.queryRaw.mockReturnValue(read.promise);
    process.env.MODEL_EQUIVALENCE_BUILD_SLICE_MS = '0';
    const eq = equivalence.getModelEquivalenceService();

    const started = Date.now();
    await runner.runScheduledModelDiscovery();
    const tickMs = Date.now() - started;

    // The build cannot have finished: its catalog read is still pending.
    expect(h.discoverAllModels).toHaveBeenCalledTimes(1);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(eq.isRebuilding()).toBe(true);
    expect(eq.getStats().lastBuildAt).toBeNull();
    expect(tickMs).toBeLessThan(5000);

    // Let the read complete: the build is now in its grouping, yielding at
    // every checkpoint (0 ms slice), and graceful shutdown stops it promptly.
    read.resolve(LARGE_CATALOG);
    for (let i = 0; i < 5; i++) await tick();
    expect(eq.isRebuilding()).toBe(true);
    // Promptly means within the next event-loop turns, not a wall-clock bound
    // (a whole 60k-row build at a 0 ms slice takes well under a second).
    equivalence.shutdownModelEquivalenceIndex();
    await tick();
    await tick();
    expect(eq.isRebuilding()).toBe(false);
    await eq.whenIdle();
    expect(eq.getStats().lastBuildAt).toBeNull();
  });

  it('releases the in-flight flag after a successful round, even while the index builds', async () => {
    h.discoverAllModels.mockResolvedValue(ROUND_OK);
    const read = deferred<typeof LARGE_CATALOG>();
    h.queryRaw.mockReturnValueOnce(read.promise).mockResolvedValue(SMALL_CATALOG);
    const eq = equivalence.getModelEquivalenceService();

    await runner.runScheduledModelDiscovery();
    await runner.runScheduledModelDiscovery();

    expect(h.discoverAllModels).toHaveBeenCalledTimes(2);
    // The second round's rebuild request was coalesced behind the first.
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(eq.isRebuilding()).toBe(true);

    // The queued follow-up runs once the first build is done.
    read.resolve(LARGE_CATALOG);
    await eq.whenIdle();
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
    expect(eq.getStats().lastBuildAt).toBeInstanceOf(Date);
  });

  it('releases the in-flight flag after a failed round', async () => {
    h.discoverAllModels.mockRejectedValueOnce(new Error('provider down')).mockResolvedValue(ROUND_OK);
    h.queryRaw.mockResolvedValue(SMALL_CATALOG);

    await expect(runner.runScheduledModelDiscovery()).resolves.toBeUndefined();
    await runner.runScheduledModelDiscovery();

    expect(h.discoverAllModels).toHaveBeenCalledTimes(2);
    await equivalence.getModelEquivalenceService().whenIdle();
    expect(h.queryRaw).toHaveBeenCalledTimes(1); // only the successful round
  });

  it('releases the in-flight flag when the job signal aborts (deadline), and refreshes the index when the abandoned round ends', async () => {
    let finishRound!: (value: typeof ROUND_OK) => void;
    h.discoverAllModels
      .mockReturnValueOnce(new Promise((resolve) => (finishRound = resolve)))
      .mockResolvedValue(ROUND_OK);
    h.queryRaw.mockResolvedValue(SMALL_CATALOG);
    const eq = equivalence.getModelEquivalenceService();

    const controller = new AbortController();
    const tick = runner.runScheduledModelDiscovery(controller.signal);
    setTimeout(() => controller.abort(new Error('deadline')), 20);
    await expect(tick).resolves.toBeUndefined();
    expect(eq.isRebuilding()).toBe(false);

    // Not skipped as "already running": the flag was released.
    await runner.runScheduledModelDiscovery();
    expect(h.discoverAllModels).toHaveBeenCalledTimes(2);
    await eq.whenIdle();
    const buildsAfterSecondRound = h.queryRaw.mock.calls.length;

    finishRound(ROUND_OK);
    await new Promise((resolve) => setImmediate(resolve));
    await eq.whenIdle();
    expect(h.queryRaw.mock.calls.length).toBe(buildsAfterSecondRound + 1);
  });

  it('never builds the index for a round skipped by the fleet-wide discovery lease', async () => {
    h.discoverAllModelsExclusive.mockResolvedValueOnce({
      status: 'skipped',
      reason: 'lease-held',
      holder: '7|ci-worker:1:abcd',
    } as never);
    h.queryRaw.mockResolvedValue(SMALL_CATALOG);
    const eq = equivalence.getModelEquivalenceService();

    await runner.runScheduledModelDiscovery();
    await eq.whenIdle();

    expect(h.discoverAllModels).not.toHaveBeenCalled();
    expect(eq.isRebuilding()).toBe(false);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it('still skips a tick while a round is genuinely running in this process', async () => {
    let finishRound!: (value: typeof ROUND_OK) => void;
    h.discoverAllModels.mockReturnValueOnce(new Promise((resolve) => (finishRound = resolve)));
    h.queryRaw.mockResolvedValue(SMALL_CATALOG);

    const first = runner.runScheduledModelDiscovery();
    await new Promise((resolve) => setImmediate(resolve));
    await runner.runScheduledModelDiscovery();
    expect(h.discoverAllModels).toHaveBeenCalledTimes(1);

    finishRound(ROUND_OK);
    await first;
  });
});
