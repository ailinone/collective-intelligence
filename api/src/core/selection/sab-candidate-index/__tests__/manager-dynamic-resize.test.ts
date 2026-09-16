// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic manager-level coverage for ADR-028 (Layer 1)'s dynamic buffer
 * resizing: after each successful build, `maybeResizeAfterBuild` compares
 * the real row count against the currently-allocated capacity and — only
 * when meaningfully over- or under-provisioned — reallocates the
 * SharedArrayBuffers and starts a fresh worker against them (`scheduleResize`
 * in manager.ts). `node:worker_threads` is mocked with an EventEmitter
 * stand-in (same technique as manager-rebuild-failed-metrics.test.ts) so
 * this exercises the manager's real resize/respawn logic without a real
 * worker_thread or database.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerationMeta, SabWorkerData, WorkerToMainMessage } from '../types';

const { FakeWorker } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  class FakeWorker extends EventEmitter {
    static instances: FakeWorker[] = [];
    posted: unknown[] = [];
    workerData: unknown;
    terminated = false;
    constructor(_filename: string, options?: { workerData?: unknown }) {
      super();
      this.workerData = options?.workerData;
      FakeWorker.instances.push(this);
    }
    postMessage(msg: unknown): void {
      this.posted.push(msg);
    }
    async terminate(): Promise<number> {
      this.terminated = true;
      return 0;
    }
  }
  return { FakeWorker };
});

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }));

type ManagerModule = typeof import('../manager');
type MetricsModule = typeof import('@/observability/ci-metrics');
let current: ManagerModule | null = null;

async function loadFresh(): Promise<{ manager: ManagerModule; metrics: MetricsModule }> {
  vi.resetModules();
  const manager = await import('../manager');
  const metrics = await import('@/observability/ci-metrics');
  current = manager;
  return { manager, metrics };
}

function emitOn(worker: InstanceType<typeof FakeWorker>, msg: WorkerToMainMessage): void {
  worker.emit('message', msg);
}

async function gaugeValue(gauge: { get(): Promise<{ values: Array<{ value: number }> }> }): Promise<number> {
  const { values } = await gauge.get();
  return values[0]?.value ?? 0;
}

function fakeMeta(rowCount: number): GenerationMeta {
  return {
    rowCount,
    curatedTotal: rowCount,
    aggregatedTotal: 0,
    curatedProviderCount: 1,
    providerCount: 1,
    capNames: ['chat'],
    distinctMasks: [1, 0, 0, 0],
    providers: [{ id: 'p1', name: 'p1', idx: 0 }],
    distinctCapabilities: 1,
    metadataBlobUsedBytes: rowCount * 10,
    idBlobUsedBytes: rowCount * 5,
  };
}

afterEach(async () => {
  if (current) await current.stopSabCandidateIndex();
  current = null;
  vi.unstubAllEnvs();
  vi.resetModules();
  FakeWorker.instances = [];
});

describe('sab-candidate-index/manager — dynamic resize (ADR-028, Layer 1)', () => {
  it('shrinks away from the ceiling after a small first build, then grows back (never exceeding the ceiling) as the catalog grows', async () => {
    // Ceiling small enough for a fast test; margin left at its 30% default.
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '1000');
    const { manager, metrics } = await loadFresh();

    manager.ensureSabCandidateIndexStarted();
    expect(FakeWorker.instances.length).toBe(1);
    // First-ever allocation always uses the ceiling — no live signal yet.
    expect(FakeWorker.instances[0].workerData).toMatchObject({ effectiveMaxModels: 1000 });

    emitOn(FakeWorker.instances[0], { type: 'ready' });
    expect(FakeWorker.instances[0].posted).toEqual([{ type: 'rebuild' }]);

    // Build 1: 100 rows in a 1000-capacity generation — massively
    // over-provisioned (100 * 1.3 = 130, well under the 60% shrink
    // threshold of 600) -> triggers a shrink resize.
    emitOn(FakeWorker.instances[0], {
      type: 'rebuilt',
      gen: 0,
      meta: fakeMeta(100),
      buildMs: 5,
      source: 'postgres',
      peakRssBytes: 50 * 1024 * 1024,
    });

    expect(FakeWorker.instances.length).toBe(2);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    const shrunkTo = (FakeWorker.instances[1].workerData as SabWorkerData).effectiveMaxModels;
    expect(shrunkTo).toBe(Math.ceil(100 * 1.3)); // 130
    expect(shrunkTo).toBeLessThan(1000);

    let status = manager.getSabCandidateIndexStatus();
    expect(status.maxModelsEffective).toBe(shrunkTo);
    // Mid-resize, before the new generation's first build: fails open, same
    // as any other cold-start window.
    expect(manager.getSabCandidateModels({ contextSize: 1000 }, 400, 300, 0.15)).toBeNull();

    // The new (second) worker announces ready and gets its own rebuild
    // request — the resize did not skip the normal ready -> rebuild flow.
    emitOn(FakeWorker.instances[1], { type: 'ready' });
    expect(FakeWorker.instances[1].posted).toEqual([{ type: 'rebuild' }]);

    // Build 2 on the SHRUNK generation: 125 of 130 slots used (96% >= the
    // 90% grow threshold) and desired (ceil(125*1.3)=163) exceeds current
    // capacity -> triggers a grow resize.
    emitOn(FakeWorker.instances[1], {
      type: 'rebuilt',
      gen: 0,
      meta: fakeMeta(125),
      buildMs: 5,
      source: 'postgres',
      peakRssBytes: 55 * 1024 * 1024,
    });

    expect(FakeWorker.instances.length).toBe(3);
    expect(FakeWorker.instances[1].terminated).toBe(true);
    const grownTo = (FakeWorker.instances[2].workerData as SabWorkerData).effectiveMaxModels;
    expect(grownTo).toBe(Math.ceil(125 * 1.3)); // 163
    expect(grownTo).toBeGreaterThan(shrunkTo);
    expect(grownTo).toBeLessThanOrEqual(1000); // never exceeds the ceiling

    status = manager.getSabCandidateIndexStatus();
    expect(status.maxModelsEffective).toBe(grownTo);

    // The third (current) generation completes its own build normally and
    // starts serving — the resize machinery doesn't interfere with the
    // ordinary zero-downtime rebuild path once settled.
    emitOn(FakeWorker.instances[2], { type: 'ready' });
    emitOn(FakeWorker.instances[2], {
      type: 'rebuilt',
      gen: 0,
      meta: fakeMeta(125),
      buildMs: 5,
      source: 'postgres',
      peakRssBytes: 55 * 1024 * 1024,
    });
    status = manager.getSabCandidateIndexStatus();
    // `status.ready` reflects the real Atomics ACTIVE_GEN flip, which only a
    // REAL worker.ts ever performs — this FakeWorker only emits the message
    // a real worker would send AFTER doing that flip, so the Prometheus
    // gauge (set directly by handleWorkerMessage on every 'rebuilt', same
    // assertion style as manager-rebuild-failed-metrics.test.ts) is the
    // faithful signal to check here instead.
    expect(await gaugeValue(metrics.sabCandidateIndexReady)).toBe(1);
    expect(status.maxModelsEffective).toBe(grownTo); // stable — no further resize for the same rowCount
  });

  it('a build at the ceiling with high usage does not resize further (nothing left to grow into)', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '1000');
    const { manager } = await loadFresh();
    manager.ensureSabCandidateIndexStarted();
    emitOn(FakeWorker.instances[0], { type: 'ready' });

    emitOn(FakeWorker.instances[0], {
      type: 'rebuilt',
      gen: 0,
      meta: fakeMeta(900), // under the ceiling itself, so this build succeeded
      buildMs: 5,
      source: 'postgres',
      peakRssBytes: 50 * 1024 * 1024,
    });

    // 900 of 1000 is >= the 90% grow threshold, but currentCap already
    // equals the ceiling (atCeiling), so nothing to grow into — no resize.
    expect(FakeWorker.instances.length).toBe(1);
    expect(manager.getSabCandidateIndexStatus().maxModelsEffective).toBe(1000);
  });

  it('clamps a resize target at the MAX_MODELS ceiling even when the desired size (row count x margin) would exceed it', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '1000');
    const { manager } = await loadFresh();
    manager.ensureSabCandidateIndexStarted();
    emitOn(FakeWorker.instances[0], { type: 'ready' });

    // Shrink to a small capacity first (100 rows in a 1000-capacity gen).
    emitOn(FakeWorker.instances[0], {
      type: 'rebuilt',
      gen: 0,
      meta: fakeMeta(100),
      buildMs: 5,
      source: 'postgres',
      peakRssBytes: 50 * 1024 * 1024,
    });
    expect(FakeWorker.instances.length).toBe(2);
    expect((FakeWorker.instances[1].workerData as SabWorkerData).effectiveMaxModels).toBe(130);
    emitOn(FakeWorker.instances[1], { type: 'ready' });

    // Now report a catalog that grew far past what even ceil(rowCount*1.3)
    // would need if the ceiling didn't exist (5000 * 1.3 = 6500) — the
    // resize must clamp to exactly the 1000 ceiling, never allocate beyond
    // capacity.ts's MAX_MODELS design ceiling.
    emitOn(FakeWorker.instances[1], {
      type: 'rebuilt',
      gen: 0,
      meta: fakeMeta(5000),
      buildMs: 5,
      source: 'postgres',
      peakRssBytes: 50 * 1024 * 1024,
    });

    expect(FakeWorker.instances.length).toBe(3);
    const clamped = (FakeWorker.instances[2].workerData as SabWorkerData).effectiveMaxModels;
    expect(clamped).toBe(1000);
  });

  it('SAB_CANDIDATE_DYNAMIC_RESIZE=false disables resizing entirely, regardless of row count', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '1000');
    vi.stubEnv('SAB_CANDIDATE_DYNAMIC_RESIZE', 'false');
    const { manager, metrics } = await loadFresh();
    manager.ensureSabCandidateIndexStarted();
    emitOn(FakeWorker.instances[0], { type: 'ready' });

    emitOn(FakeWorker.instances[0], {
      type: 'rebuilt',
      gen: 0,
      meta: fakeMeta(3), // would otherwise trigger a huge shrink
      buildMs: 5,
      source: 'postgres',
      peakRssBytes: 50 * 1024 * 1024,
    });

    expect(FakeWorker.instances.length).toBe(1); // no resize, no second worker
    expect(manager.getSabCandidateIndexStatus().maxModelsEffective).toBe(1000);
    expect(await gaugeValue(metrics.sabCandidateIndexReady)).toBe(1);
  });
});
