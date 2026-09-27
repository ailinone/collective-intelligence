// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Fleet-dedup fix (2026-09): startModelDiscoveryRunner() used to register a
 * plain per-process `setInterval` (default hourly) that called
 * discoverAllModels() — real outbound HTTP calls against every provider's
 * live API — independently in EVERY process. Since index.ts calls this
 * unconditionally at boot, the production topology (2 `ci_api` replicas +
 * `ci_worker`) ran the full ~95-provider sweep three times over, once per
 * process, every hour.
 *
 * These tests pin the fixed behavior, mirroring cache-refresh-ahead.test.ts's
 * proof pattern for the sibling fix: the per-process side now NEVER
 * schedules a recurring call to discoverAllModels() itself, no matter how
 * much wall-clock time elapses — that responsibility moved entirely to the
 * "model-discovery-hourly" BullMQ job (see
 * jobs/__tests__/model-discovery-hourly-job.test.ts), whose handler calls
 * the new runScheduledModelDiscovery() export tested directly here. The
 * one-time at-boot fire and the 30s self-healing retry remain genuinely
 * per-process and unchanged.
 *
 * Hermetic: central-model-discovery-service and model-equivalence-service
 * are fully mocked, with no real discovery/network/DB I/O. The interaction with
 * the REAL equivalence service is covered by
 * model-discovery-runner-equivalence.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const discoverAllModels = vi
    .fn()
    .mockResolvedValue([{ source: 'test', provider: 'test', modelsDiscovered: 1, errors: [] }]);
  const getDiscoveryHealth = vi.fn().mockReturnValue({ sources: [], criticalMissing: [] });
  const retryFailedSources = vi.fn().mockResolvedValue([]);
  // Mirrors the real contract: the exclusive variant runs the same round
  // (so every discoverAllModels call-count assertion below still holds) and
  // wraps it in an outcome.
  const discoverAllModelsExclusive = vi.fn(async () => ({
    status: 'completed' as const,
    results: await discoverAllModels(),
    leaseEpoch: null,
  }));
  const refreshProviderBalances = vi.fn().mockResolvedValue(true);
  const getProviderBalanceStatus = vi.fn(() => new Map());
  const service = {
    discoverAllModels,
    discoverAllModelsExclusive,
    getDiscoveryHealth,
    retryFailedSources,
    refreshProviderBalances,
    getProviderBalanceStatus,
  };
  const getCentralModelDiscoveryService = vi.fn().mockResolvedValue(service);
  const scheduleModelEquivalenceIndexRebuild = vi.fn();
  return {
    discoverAllModels,
    discoverAllModelsExclusive,
    getDiscoveryHealth,
    retryFailedSources,
    getCentralModelDiscoveryService,
    scheduleModelEquivalenceIndexRebuild,
    refreshProviderBalances,
  };
});

vi.mock('@/services/central-model-discovery-service', () => ({
  getCentralModelDiscoveryService: h.getCentralModelDiscoveryService,
}));
vi.mock('@/services/model-equivalence-service', () => ({
  scheduleModelEquivalenceIndexRebuild: h.scheduleModelEquivalenceIndexRebuild,
}));

const ORIGINAL_AUTO_SYNC = process.env.MODEL_DISCOVERY_AUTO_SYNC;
const ORIGINAL_RUN_ON_START = process.env.MODEL_DISCOVERY_RUN_ON_START;
const ORIGINAL_RETRY_DELAY = process.env.DISCOVERY_RETRY_DELAY_MS;
const ORIGINAL_BALANCE_INTERVAL = process.env.PROVIDER_BALANCE_REFRESH_INTERVAL_MS;

async function loadModule() {
  return import('@/services/model-discovery-runner');
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.discoverAllModels.mockClear();
  h.discoverAllModelsExclusive.mockClear();
  h.getDiscoveryHealth.mockClear();
  h.retryFailedSources.mockClear();
  h.getCentralModelDiscoveryService.mockClear();
  h.scheduleModelEquivalenceIndexRebuild.mockClear();
  h.refreshProviderBalances.mockReset().mockResolvedValue(true);
  delete process.env.MODEL_DISCOVERY_AUTO_SYNC;
  delete process.env.PROVIDER_BALANCE_REFRESH_INTERVAL_MS;
  delete process.env.MODEL_DISCOVERY_RUN_ON_START;
  process.env.DISCOVERY_RETRY_DELAY_MS = '30000';
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_AUTO_SYNC === undefined) delete process.env.MODEL_DISCOVERY_AUTO_SYNC;
  else process.env.MODEL_DISCOVERY_AUTO_SYNC = ORIGINAL_AUTO_SYNC;
  if (ORIGINAL_RUN_ON_START === undefined) delete process.env.MODEL_DISCOVERY_RUN_ON_START;
  else process.env.MODEL_DISCOVERY_RUN_ON_START = ORIGINAL_RUN_ON_START;
  if (ORIGINAL_RETRY_DELAY === undefined) delete process.env.DISCOVERY_RETRY_DELAY_MS;
  else process.env.DISCOVERY_RETRY_DELAY_MS = ORIGINAL_RETRY_DELAY;
  if (ORIGINAL_BALANCE_INTERVAL === undefined) {
    delete process.env.PROVIDER_BALANCE_REFRESH_INTERVAL_MS;
  } else {
    process.env.PROVIDER_BALANCE_REFRESH_INTERVAL_MS = ORIGINAL_BALANCE_INTERVAL;
  }
});

describe('model-discovery-runner: per-process boot discovery (fleet-dedup fix)', () => {
  it('fires the one-time at-boot discovery exactly once, and NEVER schedules a recurring call — no matter how much time elapses', async () => {
    const { startModelDiscoveryRunner } = await loadModule();
    await startModelDiscoveryRunner();

    // Let the fire-and-forget boot discovery settle.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.discoverAllModels).toHaveBeenCalledTimes(1);

    // Advance well past what used to be several multiples of the default
    // 60-minute interval (and past the 30s self-heal retry). A recurring
    // per-process timer would call discoverAllModels() again here; the fix
    // means it must not.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); // 6 hours
    expect(h.discoverAllModels).toHaveBeenCalledTimes(1);
  });

  it('still runs the 30s self-healing retry (per-process, unchanged) without ever calling discoverAllModels again', async () => {
    h.getDiscoveryHealth.mockReturnValue({
      sources: [{ sourceName: 'flaky-provider', retriable: true }],
      criticalMissing: [],
    });

    const { startModelDiscoveryRunner } = await loadModule();
    await startModelDiscoveryRunner();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.retryFailedSources).toHaveBeenCalledTimes(1);
    expect(h.discoverAllModels).toHaveBeenCalledTimes(1); // still just the boot fire
  });

  it('does not run any discovery (boot or recurring) when MODEL_DISCOVERY_AUTO_SYNC=false (kill-switch)', async () => {
    process.env.MODEL_DISCOVERY_AUTO_SYNC = 'false';
    const { startModelDiscoveryRunner } = await loadModule();
    await startModelDiscoveryRunner();

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(h.discoverAllModels).not.toHaveBeenCalled();
    expect(h.getCentralModelDiscoveryService).not.toHaveBeenCalled();
  });

  it('skips only the at-boot fire when MODEL_DISCOVERY_RUN_ON_START=false, independent of the (now fleet-deduped) recurring sweep', async () => {
    process.env.MODEL_DISCOVERY_RUN_ON_START = 'false';
    const { startModelDiscoveryRunner } = await loadModule();
    await startModelDiscoveryRunner();

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(h.discoverAllModels).not.toHaveBeenCalled();
  });

  it('stopModelDiscoveryRunner() is safe to call (no discovery timer to stop)', async () => {
    const { startModelDiscoveryRunner, stopModelDiscoveryRunner } = await loadModule();
    await startModelDiscoveryRunner();
    await vi.advanceTimersByTimeAsync(0);

    expect(() => stopModelDiscoveryRunner()).not.toThrow();
    // Discovery already fired once at boot; stopping must not undo that or
    // trigger anything further.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(h.discoverAllModels).toHaveBeenCalledTimes(1);
  });
});

describe('model-discovery-runner: runScheduledModelDiscovery (fleet-elected BullMQ tick)', () => {
  it('calls discoverAllModels exactly once per invocation, independent of startModelDiscoveryRunner', async () => {
    const { runScheduledModelDiscovery } = await loadModule();

    await runScheduledModelDiscovery();

    expect(h.discoverAllModels).toHaveBeenCalledTimes(1);
    expect(h.getCentralModelDiscoveryService).toHaveBeenCalledTimes(1);
  });

  it('does not throw when discoverAllModels rejects — a failed fleet-wide tick must not crash the BullMQ worker', async () => {
    h.discoverAllModels.mockRejectedValueOnce(new Error('provider API down'));
    const { runScheduledModelDiscovery } = await loadModule();

    await expect(runScheduledModelDiscovery()).resolves.toBeUndefined();
  });

  it('two back-to-back ticks each still run discovery once (no lingering in-flight guard from a prior tick)', async () => {
    const { runScheduledModelDiscovery } = await loadModule();

    await runScheduledModelDiscovery();
    await runScheduledModelDiscovery();

    expect(h.discoverAllModels).toHaveBeenCalledTimes(2);
  });

  it('requests the equivalence rebuild in the background after a round this process ran (never on failure)', async () => {
    const { runScheduledModelDiscovery } = await loadModule();

    await runScheduledModelDiscovery();
    expect(h.discoverAllModelsExclusive).toHaveBeenCalledTimes(1);
    expect(h.scheduleModelEquivalenceIndexRebuild).toHaveBeenCalledTimes(1);
    expect(h.scheduleModelEquivalenceIndexRebuild).toHaveBeenCalledWith('discovery');

    h.discoverAllModels.mockRejectedValueOnce(new Error('provider API down'));
    await runScheduledModelDiscovery();
    expect(h.scheduleModelEquivalenceIndexRebuild).toHaveBeenCalledTimes(1);
  });

  it('does not request the equivalence rebuild when another process holds the discovery lease, and a later tick still runs', async () => {
    h.discoverAllModelsExclusive.mockResolvedValueOnce({
      status: 'skipped',
      reason: 'lease-held',
      holder: '7|ci-worker:1:abcd',
    } as never);
    const { runScheduledModelDiscovery } = await loadModule();

    await expect(runScheduledModelDiscovery()).resolves.toBeUndefined();
    expect(h.scheduleModelEquivalenceIndexRebuild).not.toHaveBeenCalled();

    // The skipped tick must not leave the in-flight guard stuck.
    await runScheduledModelDiscovery();
    expect(h.discoverAllModels).toHaveBeenCalledTimes(1);
    expect(h.scheduleModelEquivalenceIndexRebuild).toHaveBeenCalledTimes(1);
    expect(h.scheduleModelEquivalenceIndexRebuild).toHaveBeenCalledWith('discovery');
  });

  it('a tick skipped by the lease still refreshes the provider balances of this process (when stale)', async () => {
    h.discoverAllModelsExclusive.mockResolvedValueOnce({
      status: 'skipped',
      reason: 'lease-held',
      holder: '8|ci-api-2:1:abcd',
    } as never);
    const { runScheduledModelDiscovery } = await loadModule();

    await runScheduledModelDiscovery();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.refreshProviderBalances).toHaveBeenCalledTimes(1);
    // Half the default hourly interval: a no-op when the map is fresh.
    expect(h.refreshProviderBalances).toHaveBeenCalledWith({ maxAgeMs: 30 * 60 * 1000 });
  });

  it('a tick this process ran does not trigger an extra balance refresh (the round refreshes them)', async () => {
    const { runScheduledModelDiscovery } = await loadModule();

    await runScheduledModelDiscovery();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.refreshProviderBalances).not.toHaveBeenCalled();
  });

  it('returns promptly when the job signal aborts, and the next tick is not skipped', async () => {
    h.discoverAllModels.mockReturnValueOnce(new Promise(() => undefined));
    const { runScheduledModelDiscovery } = await loadModule();
    const controller = new AbortController();

    const tick = runScheduledModelDiscovery(controller.signal);
    controller.abort(new Error('job deadline'));
    await expect(tick).resolves.toBeUndefined();

    await runScheduledModelDiscovery();
    expect(h.discoverAllModels).toHaveBeenCalledTimes(2);
  });

  it('a round abandoned at the job deadline requests the equivalence rebuild once it completes', async () => {
    let finishRound!: (value: unknown) => void;
    h.discoverAllModelsExclusive.mockReturnValueOnce(
      new Promise((resolve) => (finishRound = resolve)) as never
    );
    const { runScheduledModelDiscovery } = await loadModule();
    const controller = new AbortController();

    const tick = runScheduledModelDiscovery(controller.signal);
    controller.abort(new Error('job deadline'));
    await expect(tick).resolves.toBeUndefined();
    expect(h.scheduleModelEquivalenceIndexRebuild).not.toHaveBeenCalled();

    finishRound({ status: 'completed', results: [], leaseEpoch: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduleModelEquivalenceIndexRebuild).toHaveBeenCalledTimes(1);
    expect(h.scheduleModelEquivalenceIndexRebuild).toHaveBeenCalledWith('discovery-after-abandon');
  });

  it('a round abandoned at the job deadline that the lease skipped never requests the equivalence rebuild', async () => {
    let finishRound!: (value: unknown) => void;
    h.discoverAllModelsExclusive.mockReturnValueOnce(
      new Promise((resolve) => (finishRound = resolve)) as never
    );
    const { runScheduledModelDiscovery } = await loadModule();
    const controller = new AbortController();

    const tick = runScheduledModelDiscovery(controller.signal);
    controller.abort(new Error('job deadline'));
    await expect(tick).resolves.toBeUndefined();

    finishRound({ status: 'skipped', reason: 'lease-held', holder: '9|ci-api-1:1:abcd' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduleModelEquivalenceIndexRebuild).not.toHaveBeenCalled();
  });
});

describe('model-discovery-runner: per-process provider balance refresh (2026-09-24 review fix)', () => {
  it('refreshes once at start and then once per interval, each skipped while fresh', async () => {
    const { startProviderBalanceRefresh, stopProviderBalanceRefresh } = await loadModule();

    startProviderBalanceRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.refreshProviderBalances).toHaveBeenCalledTimes(1);
    expect(h.refreshProviderBalances).toHaveBeenLastCalledWith({ maxAgeMs: 30 * 60 * 1000 });

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(h.refreshProviderBalances).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(h.refreshProviderBalances).toHaveBeenCalledTimes(4);

    stopProviderBalanceRefresh();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(h.refreshProviderBalances).toHaveBeenCalledTimes(4);
    // Never a discovery round.
    expect(h.discoverAllModels).not.toHaveBeenCalled();
  });

  it('a second start replaces the timer instead of stacking a second one', async () => {
    const { startProviderBalanceRefresh, stopModelDiscoveryRunner } = await loadModule();

    startProviderBalanceRefresh();
    startProviderBalanceRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.refreshProviderBalances).toHaveBeenCalledTimes(2); // one per start

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(h.refreshProviderBalances).toHaveBeenCalledTimes(3); // one timer, not two

    stopModelDiscoveryRunner();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(h.refreshProviderBalances).toHaveBeenCalledTimes(3);
  });

  it('honours PROVIDER_BALANCE_REFRESH_INTERVAL_MS', async () => {
    process.env.PROVIDER_BALANCE_REFRESH_INTERVAL_MS = String(10 * 60 * 1000);
    const { startProviderBalanceRefresh, stopProviderBalanceRefresh } = await loadModule();

    startProviderBalanceRefresh();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(h.refreshProviderBalances).toHaveBeenCalledTimes(4); // start + 3 ticks
    expect(h.refreshProviderBalances).toHaveBeenLastCalledWith({ maxAgeMs: 5 * 60 * 1000 });
    stopProviderBalanceRefresh();
  });

  it.each([
    ['PROVIDER_BALANCE_REFRESH_INTERVAL_MS=0', 'PROVIDER_BALANCE_REFRESH_INTERVAL_MS', '0'],
    ['MODEL_DISCOVERY_AUTO_SYNC=false', 'MODEL_DISCOVERY_AUTO_SYNC', 'false'],
  ])('is off with %s', async (_label, key, value) => {
    process.env[key] = value;
    const { startProviderBalanceRefresh } = await loadModule();

    startProviderBalanceRefresh();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

    expect(h.refreshProviderBalances).not.toHaveBeenCalled();
  });

  it('is not started by startModelDiscoveryRunner (index.ts starts it after the provider catalog loads)', async () => {
    process.env.MODEL_DISCOVERY_RUN_ON_START = 'false';
    const { startModelDiscoveryRunner } = await loadModule();

    await startModelDiscoveryRunner();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

    expect(h.refreshProviderBalances).not.toHaveBeenCalled();
  });

  it('a failing refresh is contained (the timer keeps running)', async () => {
    h.refreshProviderBalances.mockRejectedValueOnce(new Error('registry exploded'));
    const { startProviderBalanceRefresh, stopProviderBalanceRefresh } = await loadModule();

    startProviderBalanceRefresh();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(h.refreshProviderBalances).toHaveBeenCalledTimes(2);
    stopProviderBalanceRefresh();
  });

  it('resolveProviderBalanceRefreshIntervalMs: hourly default, 0 turns it off, floor of one minute', async () => {
    const { resolveProviderBalanceRefreshIntervalMs, DEFAULT_PROVIDER_BALANCE_REFRESH_INTERVAL_MS } =
      await loadModule();
    const resolve = (raw: string) =>
      resolveProviderBalanceRefreshIntervalMs({ PROVIDER_BALANCE_REFRESH_INTERVAL_MS: raw });

    expect(DEFAULT_PROVIDER_BALANCE_REFRESH_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(resolveProviderBalanceRefreshIntervalMs({})).toBe(60 * 60 * 1000);
    expect(resolve('')).toBe(60 * 60 * 1000);
    expect(resolve('0')).toBe(0);
    expect(resolve('1000')).toBe(60 * 1000);
    expect(resolve('900000')).toBe(15 * 60 * 1000);
    expect(resolve('-1')).toBe(60 * 60 * 1000);
    expect(resolve('abc')).toBe(60 * 60 * 1000);
  });
});

describe('model-discovery-runner: isBootDiscoveryEnabled (shared by both boot entry points)', () => {
  it('is on by default and off when either MODEL_DISCOVERY_RUN_ON_START or MODEL_DISCOVERY_AUTO_SYNC is "false"', async () => {
    const { isBootDiscoveryEnabled } = await loadModule();

    expect(isBootDiscoveryEnabled({})).toBe(true);
    expect(isBootDiscoveryEnabled({ MODEL_DISCOVERY_RUN_ON_START: 'true' })).toBe(true);
    expect(isBootDiscoveryEnabled({ MODEL_DISCOVERY_RUN_ON_START: 'false' })).toBe(false);
    expect(isBootDiscoveryEnabled({ MODEL_DISCOVERY_AUTO_SYNC: 'false' })).toBe(false);
    expect(
      isBootDiscoveryEnabled({
        MODEL_DISCOVERY_AUTO_SYNC: 'true',
        MODEL_DISCOVERY_RUN_ON_START: 'false',
      })
    ).toBe(false);
  });

  it('reads process.env by default', async () => {
    process.env.MODEL_DISCOVERY_RUN_ON_START = 'false';
    const { isBootDiscoveryEnabled } = await loadModule();
    expect(isBootDiscoveryEnabled()).toBe(false);
  });
});
