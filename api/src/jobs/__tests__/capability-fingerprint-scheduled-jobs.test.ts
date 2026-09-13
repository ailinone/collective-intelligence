// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tiered Capability Fingerprint — BullMQ scheduled-job registration.
 *
 * Mirrors `model-discovery-hourly-job.test.ts`'s pattern (hermetic: bullmq,
 * the Redis client, prom-client, and the job module itself are all mocked —
 * no real Redis/network/DB/provider calls).
 *
 * What these pin:
 *   - Both jobs ('capability-fingerprint-daily' for the curated bucket,
 *     'capability-fingerprint-rotation' for the aggregated/long-tail
 *     bucket) register with their documented default cron patterns.
 *   - Both are OFF by default and share ONE opt-in gate
 *     (CAPABILITY_FINGERPRINT_JOB_ENABLED) — a catalog-wide probing job
 *     must never activate itself just by merging this change.
 *   - Each handler delegates to the correct bucket-specific runner.
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
  const runCapabilityFingerprintDailyNow = vi.fn().mockResolvedValue(undefined);
  const runCapabilityFingerprintRotationNow = vi.fn().mockResolvedValue(undefined);
  return {
    upsertJobScheduler,
    removeJobScheduler,
    queueClose,
    QueueCtor,
    WorkerCtor,
    createRedisClient,
    runCapabilityFingerprintDailyNow,
    runCapabilityFingerprintRotationNow,
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
vi.mock('@/jobs/capability-fingerprint-job', () => ({
  runCapabilityFingerprintDailyNow: h.runCapabilityFingerprintDailyNow,
  runCapabilityFingerprintRotationNow: h.runCapabilityFingerprintRotationNow,
}));

const ORIGINAL_USE_BULLMQ = process.env.USE_BULLMQ_CRONS;
const ORIGINAL_ENABLED = process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED;
const ORIGINAL_DAILY_CRON = process.env.CAPABILITY_FINGERPRINT_DAILY_CRON;
const ORIGINAL_ROTATION_CRON = process.env.CAPABILITY_FINGERPRINT_ROTATION_CRON;

async function loadModule() {
  return import('@/jobs/register-scheduled-jobs');
}

beforeEach(() => {
  delete process.env.USE_BULLMQ_CRONS;
  delete process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED;
  delete process.env.CAPABILITY_FINGERPRINT_DAILY_CRON;
  delete process.env.CAPABILITY_FINGERPRINT_ROTATION_CRON;
  vi.clearAllMocks();
});

afterEach(async () => {
  const mod = await loadModule();
  await mod.shutdownScheduledTasks();
  if (ORIGINAL_USE_BULLMQ === undefined) delete process.env.USE_BULLMQ_CRONS;
  else process.env.USE_BULLMQ_CRONS = ORIGINAL_USE_BULLMQ;
  if (ORIGINAL_ENABLED === undefined) delete process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED;
  else process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED = ORIGINAL_ENABLED;
  if (ORIGINAL_DAILY_CRON === undefined) delete process.env.CAPABILITY_FINGERPRINT_DAILY_CRON;
  else process.env.CAPABILITY_FINGERPRINT_DAILY_CRON = ORIGINAL_DAILY_CRON;
  if (ORIGINAL_ROTATION_CRON === undefined) delete process.env.CAPABILITY_FINGERPRINT_ROTATION_CRON;
  else process.env.CAPABILITY_FINGERPRINT_ROTATION_CRON = ORIGINAL_ROTATION_CRON;
});

describe('capability-fingerprint scheduled jobs', () => {
  it('are NOT registered by default (opt-in job — no silent activation)', async () => {
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    expect(
      h.upsertJobScheduler.mock.calls.find((c) => c[0] === 'capability-fingerprint-daily')
    ).toBeUndefined();
    expect(
      h.upsertJobScheduler.mock.calls.find((c) => c[0] === 'capability-fingerprint-rotation')
    ).toBeUndefined();
  });

  it('registers BOTH jobs with their documented default patterns once opted in', async () => {
    process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED = 'true';
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    const daily = h.upsertJobScheduler.mock.calls.find((c) => c[0] === 'capability-fingerprint-daily');
    expect(daily?.[1]).toEqual({ pattern: '0 6 * * *' });
    expect(daily?.[2]).toMatchObject({
      name: 'capability-fingerprint-daily',
      data: { jobName: 'capability-fingerprint-daily' },
    });

    const rotation = h.upsertJobScheduler.mock.calls.find(
      (c) => c[0] === 'capability-fingerprint-rotation'
    );
    expect(rotation?.[1]).toEqual({ pattern: '30 6 * * *' });
    expect(rotation?.[2]).toMatchObject({
      name: 'capability-fingerprint-rotation',
      data: { jobName: 'capability-fingerprint-rotation' },
    });
  });

  it('is NOT enabled by any value other than the exact literal "true" (fails closed, unlike the inverse-sense flags elsewhere in this file)', async () => {
    process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED = 'TRUE';
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    expect(
      h.upsertJobScheduler.mock.calls.find((c) => c[0] === 'capability-fingerprint-daily')
    ).toBeUndefined();
  });

  it('honors per-job cron overrides independently', async () => {
    process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED = 'true';
    process.env.CAPABILITY_FINGERPRINT_DAILY_CRON = '0 8 * * *';
    process.env.CAPABILITY_FINGERPRINT_ROTATION_CRON = '45 8 * * *';
    const { registerScheduledJobs } = await loadModule();
    await registerScheduledJobs();

    const daily = h.upsertJobScheduler.mock.calls.find((c) => c[0] === 'capability-fingerprint-daily');
    expect(daily?.[1]).toEqual({ pattern: '0 8 * * *' });
    const rotation = h.upsertJobScheduler.mock.calls.find(
      (c) => c[0] === 'capability-fingerprint-rotation'
    );
    expect(rotation?.[1]).toEqual({ pattern: '45 8 * * *' });
  });

  it("the daily job's handler delegates to the curated-bucket runner", async () => {
    process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED = 'true';
    const { registerScheduledJobs, startScheduledTasksWorker } = await loadModule();
    await registerScheduledJobs();
    await startScheduledTasksWorker();

    const processorCall = h.WorkerCtor.mock.calls[0];
    const processor = processorCall?.[1] as (job: {
      data: { jobName: string };
      id: string;
    }) => Promise<void>;

    await processor({ data: { jobName: 'capability-fingerprint-daily' }, id: 'job-1' });
    expect(h.runCapabilityFingerprintDailyNow).toHaveBeenCalledTimes(1);
    expect(h.runCapabilityFingerprintRotationNow).not.toHaveBeenCalled();
  });

  it("the rotation job's handler delegates to the aggregated-bucket runner", async () => {
    process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED = 'true';
    const { registerScheduledJobs, startScheduledTasksWorker } = await loadModule();
    await registerScheduledJobs();
    await startScheduledTasksWorker();

    const processorCall = h.WorkerCtor.mock.calls[0];
    const processor = processorCall?.[1] as (job: {
      data: { jobName: string };
      id: string;
    }) => Promise<void>;

    await processor({ data: { jobName: 'capability-fingerprint-rotation' }, id: 'job-2' });
    expect(h.runCapabilityFingerprintRotationNow).toHaveBeenCalledTimes(1);
    expect(h.runCapabilityFingerprintDailyNow).not.toHaveBeenCalled();
  });
});
