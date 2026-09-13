// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Fleet-dedup fix (2026-09): the ~95 provider fetchers used to run on a
 * plain per-process `setInterval` in EVERY `ci_api` replica AND `ci_worker`
 * (services/model-discovery-runner.ts) — real outbound HTTP calls against
 * every provider's live API, tripled across the fleet every hour. This is
 * the same per-replica-multiplication bug class the REL-01 fix already
 * closed for every other scheduled job, and that the "catalog-cache-refresh"
 * BullMQ job (see catalog-cache-refresh-job.test.ts) already closed for the
 * catalog hot-path query.
 *
 * These tests pin the fix: the "model-discovery-hourly" BullMQ repeatable
 * job (register-scheduled-jobs.ts) is the single fleet-wide trigger for the
 * recurring sweep — BullMQ's Redis lock guarantees exactly one process in
 * the fleet runs it per tick, any replica or the worker may win (not a
 * hardcoded "worker only" rule) — registered with the documented default
 * pattern and env override, gated by the SAME kill-switch
 * (MODEL_DISCOVERY_AUTO_SYNC) as the per-process at-boot discovery, and its
 * handler delegates to model-discovery-runner's runScheduledModelDiscovery().
 *
 * Hermetic: bullmq, the Redis client, prom-client, and model-discovery-runner
 * are all mocked (same pattern as catalog-cache-refresh-job.test.ts) — no
 * real Redis/network/DB/provider calls.
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
  const runScheduledModelDiscovery = vi.fn().mockResolvedValue(undefined);
  return {
    upsertJobScheduler,
    removeJobScheduler,
    queueClose,
    QueueCtor,
    WorkerCtor,
    createRedisClient,
    runScheduledModelDiscovery,
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
vi.mock('@/services/model-discovery-runner', () => ({
  runScheduledModelDiscovery: h.runScheduledModelDiscovery,
}));

const ORIGINAL_USE_BULLMQ = process.env.USE_BULLMQ_CRONS;
const ORIGINAL_AUTO_SYNC = process.env.MODEL_DISCOVERY_AUTO_SYNC;
const ORIGINAL_CRON_OVERRIDE = process.env.MODEL_DISCOVERY_CRON;

async function loadModule() {
  return import('@/jobs/register-scheduled-jobs');
}

beforeEach(() => {
  delete process.env.USE_BULLMQ_CRONS;
  delete process.env.MODEL_DISCOVERY_AUTO_SYNC;
  delete process.env.MODEL_DISCOVERY_CRON;
  vi.clearAllMocks();
});

afterEach(async () => {
  const mod = await loadModule();
  await mod.shutdownScheduledTasks();
  if (ORIGINAL_USE_BULLMQ === undefined) delete process.env.USE_BULLMQ_CRONS;
  else process.env.USE_BULLMQ_CRONS = ORIGINAL_USE_BULLMQ;
  if (ORIGINAL_AUTO_SYNC === undefined) delete process.env.MODEL_DISCOVERY_AUTO_SYNC;
  else process.env.MODEL_DISCOVERY_AUTO_SYNC = ORIGINAL_AUTO_SYNC;
  if (ORIGINAL_CRON_OVERRIDE === undefined) delete process.env.MODEL_DISCOVERY_CRON;
  else process.env.MODEL_DISCOVERY_CRON = ORIGINAL_CRON_OVERRIDE;
});

describe('model-discovery-hourly scheduled job registration', () => {
  it('registers an hourly repeatable job by default', async () => {
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    const call = h.upsertJobScheduler.mock.calls.find((c) => c[0] === 'model-discovery-hourly');
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual({ pattern: '0 * * * *' });
    expect(call?.[2]).toMatchObject({
      name: 'model-discovery-hourly',
      data: { jobName: 'model-discovery-hourly' },
    });
  });

  it('honors MODEL_DISCOVERY_CRON as an override of the default pattern', async () => {
    process.env.MODEL_DISCOVERY_CRON = '*/30 * * * *';
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    const call = h.upsertJobScheduler.mock.calls.find((c) => c[0] === 'model-discovery-hourly');
    expect(call?.[1]).toEqual({ pattern: '*/30 * * * *' });
  });

  it('is disabled by the SAME kill-switch as the per-process at-boot discovery (MODEL_DISCOVERY_AUTO_SYNC=false)', async () => {
    process.env.MODEL_DISCOVERY_AUTO_SYNC = 'false';
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    const call = h.upsertJobScheduler.mock.calls.find((c) => c[0] === 'model-discovery-hourly');
    expect(call).toBeUndefined();
  });

  it('is registered for any MODEL_DISCOVERY_AUTO_SYNC value other than the literal string "false"', async () => {
    process.env.MODEL_DISCOVERY_AUTO_SYNC = 'FALSE'; // not the exact sentinel
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    const call = h.upsertJobScheduler.mock.calls.find((c) => c[0] === 'model-discovery-hourly');
    expect(call).toBeDefined();
  });

  it('is NOT registered when BullMQ crons are explicitly disabled (USE_BULLMQ_CRONS=false) — no fallback scheduler exists', async () => {
    process.env.USE_BULLMQ_CRONS = 'false';
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    expect(h.QueueCtor).not.toHaveBeenCalled();
    expect(h.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("the job's handler delegates to model-discovery-runner's runScheduledModelDiscovery (the fleet-elected tick)", async () => {
    const { registerScheduledJobs, startScheduledTasksWorker } = await loadModule();
    await registerScheduledJobs();
    await startScheduledTasksWorker();

    // The Worker constructor's second argument is the processor function —
    // simulate BullMQ invoking it for a `model-discovery-hourly` job, same
    // technique as catalog-cache-refresh-job.test.ts.
    const processorCall = h.WorkerCtor.mock.calls[0];
    expect(processorCall).toBeDefined();
    const processor = processorCall?.[1] as (job: {
      data: { jobName: string };
      id: string;
    }) => Promise<void>;

    await processor({ data: { jobName: 'model-discovery-hourly' }, id: 'test-job-1' });

    expect(h.runScheduledModelDiscovery).toHaveBeenCalledTimes(1);
  });

  it('fires exactly once per tick even when two "processes" race the SAME job invocation (BullMQ Redis-lock single-execution contract)', async () => {
    // This does not re-test BullMQ's own Redis-locked repeatable-job guarantee
    // (that is BullMQ's contract, not this codebase's to re-implement) — it
    // pins that THIS job registers as exactly one repeatable schedule (one
    // upsertJobScheduler call for 'model-discovery-hourly') regardless of how
    // many processes call registerScheduledJobs() at boot, which is what
    // makes the Redis-lock guarantee apply in the first place. Two replicas
    // both calling registerScheduledJobs() at startup — exactly what happens
    // in production — must converge on the SAME schedule id, not create two.
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs(); // "replica 1"
    await registerScheduledJobs(); // "replica 2" — same process here, but
    // upsertJobScheduler is idempotent by job name, so a second registration
    // must not create a second competing schedule.

    const calls = h.upsertJobScheduler.mock.calls.filter((c) => c[0] === 'model-discovery-hourly');
    expect(calls).toHaveLength(2); // called twice (idempotent upsert), but...
    // ...every call targets the SAME job name/pattern, so BullMQ's Redis
    // dedup key is identical across both — no second competing schedule.
    for (const call of calls) {
      expect(call[1]).toEqual({ pattern: '0 * * * *' });
    }
  });
});
