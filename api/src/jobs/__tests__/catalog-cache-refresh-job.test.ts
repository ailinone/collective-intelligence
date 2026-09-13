// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capacity-scaling plan (docs/CAPACITY-SCALING-PLAN-10K-USERS.md, Track 1
 * §2.3): the "catalog-cache-refresh" BullMQ repeatable job is the single
 * fleet-wide writer for the catalog hot-path cache, reusing the exact
 * REL-01 mechanism (BullMQ upsertJobScheduler + Redis-locked single
 * execution) already established for every other scheduled job in this
 * registry.
 *
 * These tests pin:
 *  - the job is registered with a 4-minute-equivalent cron pattern and an
 *    env override, matching every other job's shape;
 *  - it is gated by the SAME kill-switch as the per-process keep-warm timer
 *    (CACHE_REFRESH_AHEAD_ENABLED=false disables both halves together);
 *  - its handler calls model-catalog-service's refreshCatalogCacheAhead()
 *    (the Postgres-hitting, Redis-publishing half), not the per-process
 *    Redis-only hydrate.
 *
 * Hermetic: bullmq, the Redis client, and prom-client are mocked (same
 * pattern as src/tests/remediation/__tests__/scheduled-jobs.test.ts) — no
 * real Redis/network/DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
  const removeJobScheduler = vi.fn().mockResolvedValue(undefined);
  const queueClose = vi.fn().mockResolvedValue(undefined);
  const QueueCtor = vi.fn(() => ({
    upsertJobScheduler,
    removeJobScheduler,
    close: queueClose,
  }));
  const WorkerCtor = vi.fn(() => ({ on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }));
  const createRedisClient = vi.fn(() => ({}) as unknown);
  const refreshCatalogCacheAhead = vi.fn().mockResolvedValue(undefined);
  return {
    upsertJobScheduler,
    removeJobScheduler,
    queueClose,
    QueueCtor,
    WorkerCtor,
    createRedisClient,
    refreshCatalogCacheAhead,
  };
});

vi.mock('bullmq', () => ({
  Queue: h.QueueCtor,
  Worker: h.WorkerCtor,
}));
vi.mock('@/cache/redis-client', () => ({
  createRedisClient: h.createRedisClient,
}));
vi.mock('prom-client', () => ({
  Counter: vi.fn(() => ({ inc: vi.fn() })),
  Histogram: vi.fn(() => ({ observe: vi.fn() })),
}));
vi.mock('@/services/model-catalog-service', () => ({
  refreshCatalogCacheAhead: h.refreshCatalogCacheAhead,
}));

const ORIGINAL_USE_BULLMQ = process.env.USE_BULLMQ_CRONS;
const ORIGINAL_ENABLED = process.env.CACHE_REFRESH_AHEAD_ENABLED;
const ORIGINAL_CRON_OVERRIDE = process.env.CATALOG_CACHE_REFRESH_CRON;

async function loadModule() {
  return import('@/jobs/register-scheduled-jobs');
}

beforeEach(() => {
  delete process.env.USE_BULLMQ_CRONS;
  delete process.env.CACHE_REFRESH_AHEAD_ENABLED;
  delete process.env.CATALOG_CACHE_REFRESH_CRON;
  vi.clearAllMocks();
});

afterEach(async () => {
  const mod = await loadModule();
  await mod.shutdownScheduledTasks();
  if (ORIGINAL_USE_BULLMQ === undefined) delete process.env.USE_BULLMQ_CRONS;
  else process.env.USE_BULLMQ_CRONS = ORIGINAL_USE_BULLMQ;
  if (ORIGINAL_ENABLED === undefined) delete process.env.CACHE_REFRESH_AHEAD_ENABLED;
  else process.env.CACHE_REFRESH_AHEAD_ENABLED = ORIGINAL_ENABLED;
  if (ORIGINAL_CRON_OVERRIDE === undefined) delete process.env.CATALOG_CACHE_REFRESH_CRON;
  else process.env.CATALOG_CACHE_REFRESH_CRON = ORIGINAL_CRON_OVERRIDE;
});

describe('catalog-cache-refresh scheduled job registration', () => {
  it('registers a 4-minute repeatable job by default', async () => {
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    const call = h.upsertJobScheduler.mock.calls.find((c) => c[0] === 'catalog-cache-refresh');
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual({ pattern: '*/4 * * * *' });
    expect(call?.[2]).toMatchObject({ name: 'catalog-cache-refresh', data: { jobName: 'catalog-cache-refresh' } });
  });

  it('honors CATALOG_CACHE_REFRESH_CRON as an override of the default pattern', async () => {
    process.env.CATALOG_CACHE_REFRESH_CRON = '*/2 * * * *';
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    const call = h.upsertJobScheduler.mock.calls.find((c) => c[0] === 'catalog-cache-refresh');
    expect(call?.[1]).toEqual({ pattern: '*/2 * * * *' });
  });

  it('is disabled by the SAME kill-switch as the per-process keep-warm timer', async () => {
    process.env.CACHE_REFRESH_AHEAD_ENABLED = 'false';
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    const call = h.upsertJobScheduler.mock.calls.find((c) => c[0] === 'catalog-cache-refresh');
    expect(call).toBeUndefined();
  });

  it('is NOT registered when BullMQ crons are explicitly disabled (USE_BULLMQ_CRONS=false) — no fallback scheduler exists', async () => {
    process.env.USE_BULLMQ_CRONS = 'false';
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    expect(h.QueueCtor).not.toHaveBeenCalled();
    expect(h.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("the job's handler delegates to model-catalog-service's refreshCatalogCacheAhead (the Postgres-hitting, Redis-publishing half)", async () => {
    // Import the handler map indirectly by exercising the worker's job
    // processor: register, then simulate BullMQ invoking the worker
    // callback it was constructed with for a `catalog-cache-refresh` job.
    const { registerScheduledJobs, startScheduledTasksWorker } = await loadModule();
    await registerScheduledJobs();
    await startScheduledTasksWorker();

    // The Worker constructor's second argument is the processor function.
    const processorCall = h.WorkerCtor.mock.calls[0];
    expect(processorCall).toBeDefined();
    const processor = processorCall?.[1] as (job: {
      data: { jobName: string };
      id: string;
    }) => Promise<void>;

    await processor({ data: { jobName: 'catalog-cache-refresh' }, id: 'test-job-1' });

    expect(h.refreshCatalogCacheAhead).toHaveBeenCalledTimes(1);
  });
});
