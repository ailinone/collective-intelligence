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
 * are fully mocked — no real discovery/network/DB I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const discoverAllModels = vi
    .fn()
    .mockResolvedValue([{ source: 'test', provider: 'test', modelsDiscovered: 1, errors: [] }]);
  const getDiscoveryHealth = vi.fn().mockReturnValue({ sources: [], criticalMissing: [] });
  const retryFailedSources = vi.fn().mockResolvedValue([]);
  const service = { discoverAllModels, getDiscoveryHealth, retryFailedSources };
  const getCentralModelDiscoveryService = vi.fn().mockResolvedValue(service);
  const buildIndex = vi.fn().mockResolvedValue({ groups: 0, models: 0, durationMs: 0 });
  return {
    discoverAllModels,
    getDiscoveryHealth,
    retryFailedSources,
    getCentralModelDiscoveryService,
    buildIndex,
  };
});

vi.mock('@/services/central-model-discovery-service', () => ({
  getCentralModelDiscoveryService: h.getCentralModelDiscoveryService,
}));
vi.mock('@/services/model-equivalence-service', () => ({
  getModelEquivalenceService: () => ({ buildIndex: h.buildIndex }),
}));

const ORIGINAL_AUTO_SYNC = process.env.MODEL_DISCOVERY_AUTO_SYNC;
const ORIGINAL_RUN_ON_START = process.env.MODEL_DISCOVERY_RUN_ON_START;
const ORIGINAL_RETRY_DELAY = process.env.DISCOVERY_RETRY_DELAY_MS;

async function loadModule() {
  return import('@/services/model-discovery-runner');
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.discoverAllModels.mockClear();
  h.getDiscoveryHealth.mockClear();
  h.retryFailedSources.mockClear();
  h.getCentralModelDiscoveryService.mockClear();
  h.buildIndex.mockClear();
  delete process.env.MODEL_DISCOVERY_AUTO_SYNC;
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

  it('stopModelDiscoveryRunner() is a safe no-op (no per-process timer left to stop)', async () => {
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
});
