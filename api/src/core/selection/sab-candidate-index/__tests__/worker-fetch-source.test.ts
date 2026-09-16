// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic coverage for ADR-028 (Layer 1)'s fetch-source change: by default
 * the SAB worker's rebuild fetch must go ONLY through the paginated
 * Postgres path (`fetchCatalogModelsPaged`) and must NEVER call the Redis
 * client — the >100MB `JSON.parse` of the fleet-wide snapshot was the
 * single largest contributor to the 2026-09-16 Canary 3 OOM (see ADR-028).
 * `SAB_CANDIDATE_WORKER_SOURCE=redis-first` restores the pre-ADR-028
 * behavior for a fast rollback without a code revert.
 *
 * `worker.ts` cannot be imported in a normal test process as-is — it
 * dereferences `workerData`/`parentPort` at module load time, which are
 * `null`/`undefined` outside a real `worker_thread` — so this test mocks
 * `node:worker_threads` with a fake `parentPort` (an EventEmitter with a
 * `postMessage` spy, same technique `manager-rebuild-failed-metrics.test.ts`
 * uses on the manager side of this same boundary) and fake `workerData`
 * (real SharedArrayBuffers sized via the same `buildCapacityConfig`/
 * `computeLayout` worker.ts itself uses, so the module's own buffer-size
 * mismatch guard doesn't reject them). `./postgres-paged-fetch` and
 * `@/cache/redis-client` are mocked so no real network or database I/O ever
 * happens.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCapacityConfig } from '../capacity';
import { computeLayout } from '../schema';

const FAKE_DATABASE_URL = 'postgresql://fake-user:fake-pass@fake-host:5432/fake_db';

const redisGetMock = vi.fn();
vi.mock('@/cache/redis-client', () => ({
  getRedisClient: () => ({ get: redisGetMock }),
}));

const fetchPagedMock = vi.fn(async () => ({ models: [], pages: 1 }));
vi.mock('../postgres-paged-fetch', async () => {
  const actual = await vi.importActual<typeof import('../postgres-paged-fetch')>('../postgres-paged-fetch');
  return { ...actual, fetchCatalogModelsPaged: fetchPagedMock };
});

interface FakeParentPort extends EventEmitter {
  postMessage: (msg: unknown) => void;
  posted: unknown[];
}

function makeFakeWorkerData(effectiveMaxModels = 100) {
  const { totalBytes } = computeLayout(buildCapacityConfig(effectiveMaxModels));
  return {
    bufferA: new SharedArrayBuffer(totalBytes),
    bufferB: new SharedArrayBuffer(totalBytes),
    control: new SharedArrayBuffer(64),
    databaseUrl: FAKE_DATABASE_URL,
    effectiveMaxModels,
  };
}

async function loadWorkerWithFakeThreadContext(): Promise<FakeParentPort> {
  const fakeParentPort = new EventEmitter() as FakeParentPort;
  fakeParentPort.posted = [];
  fakeParentPort.postMessage = (msg: unknown) => {
    fakeParentPort.posted.push(msg);
  };
  const workerData = makeFakeWorkerData();

  vi.doMock('node:worker_threads', () => ({ parentPort: fakeParentPort, workerData }));
  vi.resetModules();
  await import('../worker'); // top-level side effect: registers the 'message' handler, posts 'ready'
  return fakeParentPort;
}

async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('node:worker_threads');
  redisGetMock.mockReset();
  fetchPagedMock.mockClear();
});

describe('sab-candidate-index worker — fetch source selection (ADR-028, Layer 1)', () => {
  it('default (postgres-only): never calls Redis, fetches exclusively via the paginated Postgres path', async () => {
    const parentPort = await loadWorkerWithFakeThreadContext();
    expect(parentPort.posted).toEqual([{ type: 'ready' }]);

    parentPort.emit('message', { type: 'rebuild' });
    await tick();

    expect(redisGetMock).not.toHaveBeenCalled();
    expect(fetchPagedMock).toHaveBeenCalledTimes(1);

    const outcome = parentPort.posted.find(
      (m): m is { type: string; source?: string } =>
        typeof m === 'object' && m !== null && 'type' in m && (m.type === 'rebuilt' || m.type === 'rebuild-failed')
    );
    expect(outcome).toBeDefined();
    if (outcome?.type === 'rebuilt') {
      expect(outcome.source).toBe('postgres');
    }
  });

  it('SAB_CANDIDATE_WORKER_SOURCE=redis-first restores the pre-ADR-028 Redis-first fetch order', async () => {
    vi.stubEnv('SAB_CANDIDATE_WORKER_SOURCE', 'redis-first');
    redisGetMock.mockResolvedValue(null); // empty snapshot -> falls through to Postgres, but Redis IS consulted first
    const parentPort = await loadWorkerWithFakeThreadContext();

    parentPort.emit('message', { type: 'rebuild' });
    await tick();

    expect(redisGetMock).toHaveBeenCalledTimes(1);
    expect(fetchPagedMock).toHaveBeenCalledTimes(1); // falls back since Redis returned an empty snapshot
  });

  it('SAB_CANDIDATE_WORKER_SOURCE=redis-first returns Redis rows directly without ever touching Postgres when the snapshot is present', async () => {
    vi.stubEnv('SAB_CANDIDATE_WORKER_SOURCE', 'redis-first');
    const redisModel = {
      id: 'redis-model-1',
      providerId: 'p1',
      provider: 'p1',
      name: 'redis-model-1',
      displayName: 'redis-model-1',
      contextWindow: 8000,
      maxOutputTokens: 1000,
      inputCostPer1k: 0.01,
      outputCostPer1k: 0.02,
      capabilities: ['chat'],
      performance: { latencyMs: 1, throughput: 1, quality: 1, reliability: 1 },
      status: 'active',
      metadata: {},
    };
    redisGetMock.mockResolvedValue(JSON.stringify([redisModel]));
    const parentPort = await loadWorkerWithFakeThreadContext();

    parentPort.emit('message', { type: 'rebuild' });
    await tick();

    expect(redisGetMock).toHaveBeenCalledTimes(1);
    expect(fetchPagedMock).not.toHaveBeenCalled();
    const rebuilt = parentPort.posted.find(
      (m): m is { type: 'rebuilt'; source: string } =>
        typeof m === 'object' && m !== null && (m as { type?: string }).type === 'rebuilt'
    );
    expect(rebuilt?.source).toBe('redis');
  });
});
