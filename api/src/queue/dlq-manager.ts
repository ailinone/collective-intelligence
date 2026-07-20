// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dead Letter Queue Manager
 * C3 fix: Centralized DLQ routing, inspection, and replay for all BullMQ queues.
 * ADR-003: Every BullMQ queue MUST have an associated DLQ. No job may disappear silently.
 *
 * When a job exhausts all retries, it is moved to `{queueName}-dlq` with full error context.
 * Admin endpoints (wired separately in routes) allow inspection and replay.
 */

import { Queue, QueueEvents, Job } from 'bullmq';
import { createRedisClient } from '@/cache/redis-client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'dlq-manager' });

// ── Metric imports (lazily resolved) ──
let dlqSizeGauge: { set: (labels: Record<string, string>, value: number) => void } | null = null;
let dlqReplayTotal: { inc: (labels: Record<string, string>) => void } | null = null;
let dlqRoutedTotal: { inc: (labels: Record<string, string>) => void } | null = null;

async function ensureMetrics() {
  if (dlqSizeGauge) return;
  try {
    const promClient = await import('prom-client');
    dlqSizeGauge = new promClient.Gauge({ name: 'ailin_dev_dlq_size', help: 'Number of jobs in DLQ', labelNames: ['queue'] });
    dlqReplayTotal = new promClient.Counter({ name: 'ailin_dev_dlq_replay_total', help: 'DLQ replay attempts', labelNames: ['queue', 'status'] });
    dlqRoutedTotal = new promClient.Counter({ name: 'ailin_dev_dlq_routed_total', help: 'Jobs routed to DLQ', labelNames: ['queue'] });
  } catch {
    // Metrics unavailable — non-fatal
  }
}

// ── DLQ Infrastructure ──

interface DLQPair {
  sourceQueue: Queue;
  dlqQueue: Queue;
  events: QueueEvents;
}

const dlqPairs = new Map<string, DLQPair>();

/** DLQ job data structure */
export interface DLQJobData {
  originalQueue: string;
  originalJobId: string;
  originalJobName: string;
  originalData: unknown;
  failedAt: string;
  error: string;
  attempts: number;
  stacktrace?: string;
}

/**
 * Set up DLQ routing for a source queue.
 * When a job exhausts all retries on the source queue, it is moved to `{queueName}-dlq`.
 * Call this once per queue during application bootstrap.
 *
 * @param sourceQueue - The BullMQ Queue instance to monitor
 */
export async function setupDLQ(sourceQueue: Queue): Promise<void> {
  await ensureMetrics();

  const queueName = sourceQueue.name;

  // Prevent double-registration
  if (dlqPairs.has(queueName)) {
    log.debug({ queue: queueName }, 'DLQ already registered for queue, skipping');
    return;
  }

  const dlqConnection = createRedisClient(`dlq-${queueName}`);
  const dlqQueue = new Queue<DLQJobData>(`${queueName}-dlq`, {
    connection: dlqConnection,
    defaultJobOptions: {
      // DLQ jobs are kept for 30 days for investigation
      removeOnComplete: { age: 30 * 86_400 },
      removeOnFail: { age: 30 * 86_400 },
    },
  });

  const eventsConnection = createRedisClient(`dlq-events-${queueName}`);
  const events = new QueueEvents(queueName, { connection: eventsConnection });

  events.on('failed', async ({ jobId, failedReason }) => {
    try {
      const job = await Job.fromId(sourceQueue, jobId);
      if (!job) return;

      // R6 fix: Only route to DLQ if all retries are exhausted.
      // job.opts.attempts may be undefined when inherited from defaultJobOptions.
      // Fall back to the source queue's defaultJobOptions, then to 1.
      const maxAttempts = job.opts?.attempts
        ?? (sourceQueue.defaultJobOptions as { attempts?: number } | undefined)?.attempts
        ?? 1;
      if (job.attemptsMade < maxAttempts) return;

      await dlqQueue.add('dead-letter', {
        originalQueue: queueName,
        originalJobId: String(job.id),
        originalJobName: job.name,
        originalData: job.data,
        failedAt: new Date().toISOString(),
        error: failedReason || 'Unknown error',
        attempts: job.attemptsMade,
        stacktrace: job.stacktrace?.[job.stacktrace.length - 1],
      } satisfies DLQJobData);

      dlqRoutedTotal?.inc({ queue: queueName });
      log.warn(
        { queue: queueName, jobId, jobName: job.name, attempts: job.attemptsMade, error: failedReason },
        'Job moved to DLQ after exhausting retries'
      );
    } catch (err) {
      log.error({ queue: queueName, jobId, err }, 'Failed to route job to DLQ');
    }
  });

  dlqPairs.set(queueName, { sourceQueue, dlqQueue, events });
  log.info({ queue: queueName, dlq: `${queueName}-dlq` }, 'DLQ routing active');
}

// ── Admin Operations ──

export interface DLQJobInfo {
  id: string;
  originalQueue: string;
  originalJobId: string;
  originalJobName: string;
  failedAt: string;
  error: string;
  attempts: number;
  addedToDlqAt: number;
}

/**
 * List jobs in a specific queue's DLQ, with pagination.
 */
export async function listDLQJobs(
  queueName: string,
  page = 1,
  limit = 20,
): Promise<{ jobs: DLQJobInfo[]; total: number }> {
  const pair = dlqPairs.get(queueName);
  if (!pair) {
    return { jobs: [], total: 0 };
  }

  const start = (page - 1) * limit;
  const end = start + limit - 1;

  const [waitingJobs, waitingCount] = await Promise.all([
    pair.dlqQueue.getJobs(['waiting', 'delayed', 'completed', 'failed'], start, end),
    pair.dlqQueue.getJobCounts(),
  ]);

  const total = Object.values(waitingCount).reduce((sum, n) => sum + n, 0);
  const jobs: DLQJobInfo[] = waitingJobs
    .filter((j): j is Job<DLQJobData> => j !== undefined && j.data !== undefined)
    .map((job) => ({
      id: String(job.id),
      originalQueue: job.data.originalQueue,
      originalJobId: job.data.originalJobId,
      originalJobName: job.data.originalJobName,
      failedAt: job.data.failedAt,
      error: job.data.error,
      attempts: job.data.attempts,
      addedToDlqAt: job.timestamp,
    }));

  return { jobs, total };
}

/**
 * Replay a single job from DLQ back to its source queue.
 */
export async function replayDLQJob(
  queueName: string,
  dlqJobId: string,
): Promise<{ success: boolean; newJobId?: string; error?: string }> {
  const pair = dlqPairs.get(queueName);
  if (!pair) {
    return { success: false, error: `No DLQ registered for queue: ${queueName}` };
  }

  try {
    const dlqJob = await Job.fromId(pair.dlqQueue, dlqJobId);
    if (!dlqJob || !dlqJob.data) {
      return { success: false, error: `DLQ job not found: ${dlqJobId}` };
    }

    const data = dlqJob.data as DLQJobData;

    // Re-enqueue to the source queue with fresh attempts
    const newJob = await pair.sourceQueue.add(
      data.originalJobName || 'replayed',
      data.originalData,
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
    );

    // Remove from DLQ after successful re-enqueue
    await dlqJob.remove();

    dlqReplayTotal?.inc({ queue: queueName, status: 'success' });
    log.info(
      { queue: queueName, dlqJobId, newJobId: newJob.id, originalJobId: data.originalJobId },
      'DLQ job replayed to source queue'
    );

    return { success: true, newJobId: String(newJob.id) };
  } catch (err) {
    dlqReplayTotal?.inc({ queue: queueName, status: 'failed' });
    const message = err instanceof Error ? err.message : String(err);
    log.error({ queue: queueName, dlqJobId, err: message }, 'Failed to replay DLQ job');
    return { success: false, error: message };
  }
}

/**
 * Get DLQ size for all registered queues (for metrics/monitoring).
 */
export async function getDLQSizes(): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};

  for (const [queueName, pair] of dlqPairs) {
    try {
      const counts = await pair.dlqQueue.getJobCounts();
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      sizes[queueName] = total;
      dlqSizeGauge?.set({ queue: queueName }, total);
    } catch {
      sizes[queueName] = -1; // Error reading
    }
  }

  return sizes;
}

/**
 * Get list of all queues that have DLQ routing configured.
 */
export function getRegisteredDLQQueues(): string[] {
  return Array.from(dlqPairs.keys());
}

/**
 * Graceful shutdown: close all DLQ event listeners and queues.
 */
export async function shutdownDLQManager(): Promise<void> {
  for (const [queueName, pair] of dlqPairs) {
    try {
      await pair.events.close();
      await pair.dlqQueue.close();
      log.debug({ queue: queueName }, 'DLQ pair closed');
    } catch (err) {
      log.error({ queue: queueName, err }, 'Error closing DLQ pair');
    }
  }
  dlqPairs.clear();
  log.info('DLQ manager shut down');
}
