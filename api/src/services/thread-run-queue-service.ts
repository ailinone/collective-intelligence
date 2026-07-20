// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Thread Run Queue Service (BullMQ)
 *
 * Manages asynchronous execution of Thread Runs for the Assistants API.
 * Implements the OpenAI-compatible Assistants/Threads/Runs workflow.
 *
 * Flow:
 *   1. Run created via API → status: 'queued'
 *   2. Job added to BullMQ queue
 *   3. Worker picks up job → status: 'in_progress'
 *   4. Orchestration engine executes → status: 'completed' or 'failed'
 *   5. Response message added to thread
 *
 * Features:
 *   - Priority-based processing (enterprise > pro > free)
 *   - Automatic retry on transient failures
 *   - Status tracking and progress updates
 *   - Tool call handling (requires_action state)
 *   - Graceful timeout handling
 */

import type { Redis } from 'ioredis';
import { Queue, Worker, type Job } from 'bullmq';
import { createRedisClient, releaseRedisClient } from '@/cache/redis-client';
import { logger } from '@/utils/logger';
import { config } from '@/config';
import { getQueueRuntimeState } from '@/queue/queue-runtime-state';
import { serializeError } from '@/utils/type-guards';
import type { ThreadRun } from '@/types/threads';

const QUEUE_NAME = 'thread-runs';

/**
 * Queue job data for thread runs
 */
export interface ThreadRunJobData {
  runId: string;
  threadId: string;
  assistantId: string;
  organizationId: string;
  userId?: string;
  model?: string;
  instructions?: string;
  tools?: Array<{
    type: 'code_interpreter' | 'file_search' | 'function';
    function?: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  temperature?: number;
  topP?: number;
  maxCompletionTokens?: number;
  priority: number; // 1-10000 (lower = higher priority)
  queuedAt: number;
}

/**
 * Queue result
 */
export interface ThreadRunQueueResult {
  status: 'queued';
  runId: string;
  position: number;
  estimatedWaitTimeMs: number;
}

/**
 * Worker processor function type
 */
export type ThreadRunProcessor = (job: Job<ThreadRunJobData>) => Promise<ThreadRun>;

type ManagedWorker = {
  worker: Worker<ThreadRunJobData, ThreadRun>;
  connection: Redis;
};

class ThreadRunQueueService {
  private queue: Queue<ThreadRunJobData> | null = null;
  private workers: ManagedWorker[] = [];
  private queueConnection: Redis | null = null;
  private readonly log = logger.child({ component: 'thread-run-queue' });
  private processor?: ThreadRunProcessor;

  constructor() {
    const runtimeState = getQueueRuntimeState();
    if (!runtimeState.enabled) {
      this.log.warn(
        { reason: runtimeState.reason, details: runtimeState.details },
        'Thread run queue disabled via runtime state'
      );
      return;
    }

    try {
      this.queueConnection = createRedisClient('thread-run-queue');

      this.queue = new Queue(QUEUE_NAME, {
        connection: this.queueConnection,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: {
            age: 3600, // 1 hour
            count: 1000,
          },
          removeOnFail: {
            age: 86400, // 24 hours
            count: 5000,
          },
        },
      }) as Queue<ThreadRunJobData>;

      this.log.info({ queueName: QUEUE_NAME }, 'Thread run queue initialized');

      // C3 fix: DLQ routing (ADR-003)
      import('@/queue/dlq-manager.js')
        .then(({ setupDLQ }) => setupDLQ(this.queue!))
        .catch((err) => this.log.warn({ err: serializeError(err) }, 'Failed to setup DLQ for thread-runs queue'));
    } catch (error) {
      this.queue = null;
      if (this.queueConnection) {
        releaseRedisClient(this.queueConnection).catch((releaseError) => {
          this.log.warn(
            { error: serializeError(releaseError) },
            'Failed to release queue Redis connection after initialization error'
          );
        });
        this.queueConnection = null;
      }
      this.log.error({ error }, 'Failed to initialize thread run queue');
    }
  }

  /**
   * Check if queue is available
   */
  isAvailable(): boolean {
    return this.queue !== null;
  }

  /**
   * Add a run to the queue for processing
   */
  async enqueue(data: ThreadRunJobData): Promise<ThreadRunQueueResult> {
    if (!this.queue) {
      throw new Error('Thread run queue not initialized');
    }

    const job = await this.queue.add('execute-run', data, {
      priority: data.priority,
      jobId: data.runId, // Use runId as jobId for deduplication
    });

    // Get queue position
    const waiting = await this.queue.getWaitingCount();

    this.log.info(
      {
        runId: data.runId,
        threadId: data.threadId,
        jobId: job.id,
        position: waiting,
      },
      'Thread run queued for execution'
    );

    return {
      status: 'queued',
      runId: data.runId,
      position: waiting,
      estimatedWaitTimeMs: waiting * 5000, // Estimate 5s per job
    };
  }

  /**
   * Start workers to process thread runs
   */
  async startWorkers(processor: ThreadRunProcessor): Promise<void> {
    if (!this.queue) {
      this.log.warn('Cannot start workers - queue not initialized');
      return;
    }

    this.processor = processor;
    const workerCount = Math.min(config.queue.workerCount, 5); // Max 5 workers for thread runs

    for (let i = 0; i < workerCount; i++) {
      try {
        const connection = createRedisClient(`thread-run-worker-${i}`);

        const worker = new Worker<ThreadRunJobData, ThreadRun>(
          QUEUE_NAME,
          async (job) => {
            return processor(job);
          },
          {
            connection,
            concurrency: 10, // 10 concurrent jobs per worker
            limiter: {
              max: 100,
              duration: 60000, // 100 jobs per minute per worker
            },
          }
        );

        // Event handlers
        worker.on('completed', (job, result) => {
          this.log.info(
            {
              jobId: job.id,
              runId: job.data.runId,
              status: result.status,
            },
            'Thread run completed'
          );
        });

        worker.on('failed', (job, error) => {
          this.log.error(
            {
              jobId: job?.id,
              runId: job?.data.runId,
              error: error.message,
            },
            'Thread run failed'
          );
        });

        worker.on('error', (error) => {
          this.log.error({ error: error.message }, 'Worker error');
        });

        this.workers.push({ worker, connection });
        this.log.info({ workerId: i }, 'Thread run worker started');
      } catch (error) {
        this.log.error({ workerId: i, error }, 'Failed to start thread run worker');
      }
    }

    this.log.info({ workerCount: this.workers.length }, 'Thread run workers running');
  }

  /**
   * Stop all workers gracefully
   */
  async stopWorkers(): Promise<void> {
    this.log.info({ workerCount: this.workers.length }, 'Stopping thread run workers...');

    const closePromises = this.workers.map(async ({ worker, connection }, index) => {
      try {
        await worker.close();
        await releaseRedisClient(connection);
        this.log.debug({ workerId: index }, 'Worker stopped');
      } catch (error) {
        this.log.warn({ workerId: index, error }, 'Error stopping worker');
      }
    });

    await Promise.all(closePromises);
    this.workers = [];

    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }

    if (this.queueConnection) {
      await releaseRedisClient(this.queueConnection);
      this.queueConnection = null;
    }

    this.log.info('Thread run queue shutdown complete');
  }

  /**
   * Get job by run ID
   */
  async getJob(runId: string): Promise<Job<ThreadRunJobData> | undefined> {
    if (!this.queue) {
      return undefined;
    }
    return this.queue.getJob(runId);
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    if (!this.queue) {
      return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    }

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }
}

// Singleton instance
export const threadRunQueueService = new ThreadRunQueueService();

