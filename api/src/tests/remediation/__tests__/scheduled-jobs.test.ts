// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit test: cron activation flag (REL-01 split-brain fix)
 *
 * Proves the single source of truth (`isBullmqCronsEnabled`) that BOTH index.ts
 * and the job registry now derive from, and that BullMQ distributed crons are
 * the default-on (and only) scheduler. The legacy in-process node-cron fallback
 * has been removed, so:
 *   - unset env  → BullMQ crons ENABLED (jobs registered; node-cron not used)
 *   - "false"    → explicit opt-out. index.ts fails fast (fatal misconfig, NOT
 *                  zero crons); the registry functions degrade to a defensive
 *                  no-op and never fall back to per-process node-cron.
 *
 * Hermetic: bullmq, the Redis client, and prom-client are mocked, so the test
 * touches no network and needs no running Redis.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock handles so the vi.mock factories below can reference them.
const h = vi.hoisted(() => {
  const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
  const queueClose = vi.fn().mockResolvedValue(undefined);
  const workerClose = vi.fn().mockResolvedValue(undefined);
  const workerOn = vi.fn();
  const QueueCtor = vi.fn(() => ({ upsertJobScheduler, close: queueClose }));
  const WorkerCtor = vi.fn(() => ({ on: workerOn, close: workerClose }));
  const createRedisClient = vi.fn(() => ({}) as unknown);
  return {
    upsertJobScheduler,
    queueClose,
    workerClose,
    workerOn,
    QueueCtor,
    WorkerCtor,
    createRedisClient,
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

const originalEnv = process.env.USE_BULLMQ_CRONS;

async function loadModule() {
  return import('@/jobs/register-scheduled-jobs');
}

beforeEach(() => {
  delete process.env.USE_BULLMQ_CRONS;
  vi.clearAllMocks();
});

afterEach(async () => {
  // Reset module-level scheduledQueue/scheduledWorker between tests.
  const mod = await loadModule();
  await mod.shutdownScheduledTasks();
  if (originalEnv === undefined) {
    delete process.env.USE_BULLMQ_CRONS;
  } else {
    process.env.USE_BULLMQ_CRONS = originalEnv;
  }
});

describe('isBullmqCronsEnabled — single source of truth (REL-01)', () => {
  it('defaults to ENABLED when USE_BULLMQ_CRONS is unset (BullMQ is the default)', async () => {
    delete process.env.USE_BULLMQ_CRONS;
    const { isBullmqCronsEnabled } = await loadModule();
    expect(isBullmqCronsEnabled()).toBe(true);
  });

  it('is ENABLED for "true"', async () => {
    process.env.USE_BULLMQ_CRONS = 'true';
    const { isBullmqCronsEnabled } = await loadModule();
    expect(isBullmqCronsEnabled()).toBe(true);
  });

  it('is ENABLED for any non-"false" value (only the exact string "false" opts out)', async () => {
    process.env.USE_BULLMQ_CRONS = 'yes';
    const { isBullmqCronsEnabled } = await loadModule();
    expect(isBullmqCronsEnabled()).toBe(true);
  });

  it('is DISABLED only for the explicit opt-out "false"', async () => {
    process.env.USE_BULLMQ_CRONS = 'false';
    const { isBullmqCronsEnabled } = await loadModule();
    expect(isBullmqCronsEnabled()).toBe(false);
  });
});

describe('registerScheduledJobs — default-on registration', () => {
  it('registers BullMQ repeatable jobs when USE_BULLMQ_CRONS is UNSET (no explicit "true" required)', async () => {
    delete process.env.USE_BULLMQ_CRONS;
    const { registerScheduledJobs } = await loadModule();

    await registerScheduledJobs();

    // BullMQ path taken: a Queue was constructed and job schedulers upserted.
    expect(h.QueueCtor).toHaveBeenCalled();
    expect(h.upsertJobScheduler).toHaveBeenCalled();
  });

  it('does NOT register (defensive no-op) when USE_BULLMQ_CRONS=false — explicit opt-out, node-cron not used', async () => {
    process.env.USE_BULLMQ_CRONS = 'false';
    const { registerScheduledJobs } = await loadModule();

    // Returns silently; crucially it does NOT construct a Queue and does NOT
    // spin up any per-process node-cron scheduler (which no longer exists).
    await expect(registerScheduledJobs()).resolves.toBeUndefined();
    expect(h.QueueCtor).not.toHaveBeenCalled();
    expect(h.upsertJobScheduler).not.toHaveBeenCalled();
  });
});

describe('startScheduledTasksWorker — gated by the same single flag', () => {
  it('starts the worker when USE_BULLMQ_CRONS is UNSET', async () => {
    delete process.env.USE_BULLMQ_CRONS;
    const { startScheduledTasksWorker } = await loadModule();

    await startScheduledTasksWorker();

    expect(h.WorkerCtor).toHaveBeenCalled();
  });

  it('does NOT start the worker when USE_BULLMQ_CRONS=false', async () => {
    process.env.USE_BULLMQ_CRONS = 'false';
    const { startScheduledTasksWorker } = await loadModule();

    await expect(startScheduledTasksWorker()).resolves.toBeUndefined();
    expect(h.WorkerCtor).not.toHaveBeenCalled();
  });
});

describe('module surface', () => {
  it('exports the activation helper and lifecycle functions', async () => {
    const mod = await loadModule();
    expect(typeof mod.isBullmqCronsEnabled).toBe('function');
    expect(typeof mod.registerScheduledJobs).toBe('function');
    expect(typeof mod.startScheduledTasksWorker).toBe('function');
    expect(typeof mod.shutdownScheduledTasks).toBe('function');
  });

  it('shutdownScheduledTasks completes without error when nothing was started', async () => {
    const mod = await loadModule();
    await expect(mod.shutdownScheduledTasks()).resolves.toBeUndefined();
  });
});
