// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic check that a failed rebuild is visible from Prometheus, not only
 * from the worker's log line. The 2026-09-11 canary (ADR-027, "Canary 2")
 * failed every build on a capacity error while every SAB metric read
 * exactly like a freshly booted process (ready=0, builds=0, crashes=0).
 *
 * `node:worker_threads` is mocked with an EventEmitter stand-in so the
 * manager's message handling runs without a real worker (the real worker
 * is covered by sab-worker-concurrent-load-benchmark.test.ts). Capacity env
 * is shrunk before the dynamic import so the SharedArrayBuffers the manager
 * allocates stay tiny.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationMeta, WorkerToMainMessage } from '../types';

const { FakeWorker } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  class FakeWorker extends EventEmitter {
    static instances: FakeWorker[] = [];
    posted: unknown[] = [];
    constructor() {
      super();
      FakeWorker.instances.push(this);
    }
    postMessage(msg: unknown): void {
      this.posted.push(msg);
    }
    async terminate(): Promise<number> {
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

async function counterValue(
  counter: { get(): Promise<{ values: Array<{ labels: Record<string, string | number>; value: number }> }> },
  labels: Record<string, string>
): Promise<number> {
  const { values } = await counter.get();
  const hit = values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return hit?.value ?? 0;
}

async function gaugeValue(gauge: { get(): Promise<{ values: Array<{ value: number }> }> }): Promise<number> {
  const { values } = await gauge.get();
  return values[0]?.value ?? 0;
}

function emit(msg: WorkerToMainMessage): void {
  const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
  worker.emit('message', msg);
}

beforeEach(() => {
  vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '16');
  vi.stubEnv('SAB_CANDIDATE_CURATED_CAP', '16');
  vi.stubEnv('SAB_CANDIDATE_AGGREGATED_CAP', '16');
  vi.stubEnv('SAB_CANDIDATE_MAX_PROVIDERS', '4');
  vi.stubEnv('SAB_CANDIDATE_ID_BLOB_BYTES', '1024');
  vi.stubEnv('SAB_CANDIDATE_PROVIDER_BLOB_BYTES', '1024');
  FakeWorker.instances = [];
});

afterEach(async () => {
  if (current) await current.stopSabCandidateIndex();
  current = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('sab-candidate-index/manager — rebuild-failed surfacing', () => {
  it('a failed FIRST build increments build_failures_total{reason} and leaves ready=0 / status.ready=false', async () => {
    const { manager, metrics } = await loadFresh();
    metrics.sabCandidateIndexBuildFailuresTotal.reset();

    manager.ensureSabCandidateIndexStarted();
    expect(FakeWorker.instances.length).toBe(1);
    expect(await gaugeValue(metrics.sabCandidateIndexReady)).toBe(0);
    expect(await gaugeValue(metrics.sabCandidateIndexMetadataBlobCapacityBytes)).toBe(16 * 1024);

    emit({ type: 'ready' });
    expect(FakeWorker.instances[0].posted).toEqual([{ type: 'rebuild' }]);

    emit({
      type: 'rebuild-failed',
      reason: 'capacity',
      error: 'capacity error: metadata string blob needs 109000000 bytes for 112140 rows but capacity is 67108864',
    });
    emit({ type: 'rebuild-failed', reason: 'fetch', error: 'Postgres fallback fetch failed: timeout' });

    expect(await counterValue(metrics.sabCandidateIndexBuildFailuresTotal, { reason: 'capacity' })).toBe(1);
    expect(await counterValue(metrics.sabCandidateIndexBuildFailuresTotal, { reason: 'fetch' })).toBe(1);
    expect(await gaugeValue(metrics.sabCandidateIndexReady)).toBe(0);

    const status = manager.getSabCandidateIndexStatus();
    expect(status.started).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.builds).toBe(0);
    expect(status.buildFailures).toBe(2);
    expect(status.crashes).toBe(0);
    expect(status.lastFailureReason).toBe('fetch');
    expect(status.lastError).toContain('Postgres fallback fetch failed');
    expect(status.metadataBlobCapacityBytes).toBe(16 * 1024);
    expect(manager.getSabCandidateModels({ contextSize: 1000 }, 400, 300, 0.15)).toBeNull();
  });

  it('a successful build publishes distinct_capabilities and metadata_blob_used_bytes and clears the failure state', async () => {
    const { manager, metrics } = await loadFresh();
    manager.ensureSabCandidateIndexStarted();
    emit({ type: 'ready' });
    emit({ type: 'rebuild-failed', reason: 'capacity', error: 'capacity error: x' });

    const meta: GenerationMeta = {
      rowCount: 3,
      curatedTotal: 3,
      aggregatedTotal: 0,
      curatedProviderCount: 1,
      providerCount: 1,
      capNames: ['chat', 'tool_use', 'vision'],
      distinctMasks: [7, 0, 0, 0],
      providers: [{ id: 'p1', name: 'p1', idx: 0 }],
      distinctCapabilities: 3,
      metadataBlobUsedBytes: 4_321,
      idBlobUsedBytes: 12,
    };
    emit({ type: 'rebuilt', gen: 0, meta, buildMs: 12.5, source: 'redis' });

    expect(await gaugeValue(metrics.sabCandidateIndexDistinctCapabilities)).toBe(3);
    expect(await gaugeValue(metrics.sabCandidateIndexMetadataBlobUsedBytes)).toBe(4_321);
    expect(await gaugeValue(metrics.sabCandidateIndexReady)).toBe(1);

    const status = manager.getSabCandidateIndexStatus();
    expect(status.builds).toBe(1);
    expect(status.buildFailures).toBe(1);
    expect(status.lastError).toBeNull();
    expect(status.lastFailureReason).toBeNull();
    expect(status.distinctCapabilities).toBe(3);
    expect(status.metadataBlobUsedBytes).toBe(4_321);
    expect(status.lastSource).toBe('redis');
  });
});
