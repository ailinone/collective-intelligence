// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Request Queue Service (BullMQ)
 *
 * Absorbs traffic spikes and provides graceful degradation
 * Critical for massive scale (10,000+ req/s peaks)
 *
 * Architecture:
 *   - Queue: Absorbs bursts (10,000+ req/s → managed processing)
 *   - Workers: Process queued requests (20 workers, 100 concurrency each)
 *   - Priority: Enterprise > Pro > Free tiers
 *   - Timeout: Max 120s in queue
 *
 * Benefits:
 *   - Handles 10,000 req/s peaks (vs 5,000 direct capacity)
 *   - Graceful degradation (queue vs reject)
 *   - Priority-based processing
 *   - Retry on failure
 *
 * Scenarios:
 *   - Normal load (350 req/s): Direct processing (no queue)
 *   - Peak load (10,000 req/s): 50% direct, 50% queued (2-5s wait)
 *   - Extreme peak (20,000 req/s): 25% direct, 75% queued (5-30s wait)
 */

import type { Redis } from 'ioredis';
import { getErrorMessage } from '@/utils/type-guards';
import { Queue, Worker, type Job } from 'bullmq';
import { createRedisClient, releaseRedisClient } from '@/cache/redis-client';
import type { ChatRequest, ChatResponse, OrchestrationContext } from '@/types';
import { logger } from '@/utils/logger';
import { config } from '@/config';
import { disableQueueRuntime, getQueueRuntimeState } from '@/queue/queue-runtime-state';
import { queueResultService } from '@/services/request-queue-result-service';
import { queueSize, queueProcessed, queueWaitTime } from '@/utils/metrics';

/**
 * Queue job data
 */
interface QueuedRequest {
  requestId: string;
  organizationId: string;
  userId?: string;
  request: ChatRequest;
  context?: OrchestrationContext;
  priority: number; // 1-10000 (lower = higher priority)
  correlationId?: string; // G8 fix (ADR-005): propagated from HTTP request context for tracing
  queuedAt: number;
}

/**
 * Queue result
 */
interface QueuedResponse {
  status: 'queued';
  queueId: string;
  position: number;
  estimatedWaitTimeMs: number;
  priority: number;
}

type ManagedWorker = {
  worker: Worker<QueuedRequest, ChatResponse>;
  connection: Redis;
};

class RequestQueueService {
  private queue: Queue<QueuedRequest> | null = null;
  private workers: ManagedWorker[] = [];
  private queueConnection: Redis | null = null;
  private readonly log = logger.child({ component: 'request-queue' });
  private readonly baseWorkerCount = config.queue.workerCount;
  private readonly scaleConfig = config.queue.scale;
  private monitorHandle?: NodeJS.Timeout;
  private lastScaleAt = 0;
  private scalingInProgress = false;
  private processor?: (job: Job<QueuedRequest>) => Promise<ChatResponse>;

  constructor() {
    const runtimeState = getQueueRuntimeState();
    if (!runtimeState.enabled) {
      this.log.warn(
        { reason: runtimeState.reason, details: runtimeState.details },
        'Request queue disabled via runtime state'
      );
      return;
    }

    try {
      this.queueConnection = createRedisClient('queue-primary');

      this.queue = new Queue(config.queue.queueName, {
        connection: this.queueConnection,
        defaultJobOptions: {
          attempts: config.queue.maxAttempts,
          backoff: {
            type: config.queue.backoffStrategy,
            delay: config.queue.backoffInitialDelayMs,
          },
          removeOnComplete: {
            age: config.queue.resultTtlSeconds,
            count: 1000,
          },
          removeOnFail: {
            age: config.queue.resultTtlSeconds,
            count: 5000,
          },
        },
      }) as Queue<QueuedRequest>;

      this.log.info(
        {
          configuredWorkers: config.queue.workerCount,
          autoscale: this.scaleConfig.enabled
            ? {
                minWorkers: this.scaleConfig.minWorkers,
                maxWorkers: this.scaleConfig.maxWorkers,
                scaleStep: this.scaleConfig.scaleStep,
                scaleUpUtilPercent: this.scaleConfig.scaleUpUtilizationPercent,
                scaleDownUtilPercent: this.scaleConfig.scaleDownUtilizationPercent,
                monitorIntervalMs: this.scaleConfig.monitorIntervalMs,
              }
            : false,
          concurrency: config.queue.workerConcurrency,
          queueName: config.queue.queueName,
        },
        'Request queue initialized'
      );

      // C3 fix: Set up DLQ routing for this queue (ADR-003)
      import('@/queue/dlq-manager.js')
        .then(({ setupDLQ }) => setupDLQ(this.queue!))
        .catch((err: unknown) => this.log.warn({ err }, 'Failed to setup DLQ for chat-requests queue'));
    } catch (error) {
      this.queue = null;
      if (this.queueConnection) {
        releaseRedisClient(this.queueConnection).catch((releaseError: unknown) => {
          this.log.warn(
            { error: releaseError },
            'Failed to release queue Redis connection after initialization error'
          );
        });
        this.queueConnection = null;
      }
      disableQueueRuntime('queue_initialization_failed', {
        message: getErrorMessage(error),
      });
      this.log.error({ error }, 'Failed to initialize request queue');
    }
  }

  /**
   * Check if system should queue request
   *
   * Queue if:
   *   - System load > 80%
   *   - Active workers > 80% capacity
   *   - Queue has pending jobs
   */
  async shouldQueue(): Promise<{ queue: boolean; load: number; reason?: string }> {
    const runtimeState = getQueueRuntimeState();
    if (!runtimeState.enabled || !this.queue) {
      return {
        queue: false,
        load: 0,
        reason: runtimeState.reason ?? 'Queue disabled',
      };
    }

    if (runtimeState.configuration.forceQueue) {
      return {
        queue: true,
        load: 100,
        reason: 'queue_forced_by_configuration',
      };
    }

    try {
      // Double-check queue is available (defensive programming for tests)
      if (!this.queue) {
        return {
          queue: false,
          load: 0,
          reason: 'Queue not initialized',
        };
      }

      // Get queue metrics
      const waiting = await this.queue.getWaitingCount();
      const active = await this.queue.getActiveCount();

      queueSize.set({ queue_name: config.queue.queueName }, waiting);

      // Calculate system load
      const { capacity } = this.getWorkerCapacity();
      const currentLoad = capacity === 0 ? 0 : (active / capacity) * 100;

      if (currentLoad > 80) {
        return {
          queue: true,
          load: currentLoad,
          reason: `System at ${currentLoad.toFixed(0)}% capacity`,
        };
      }

      if (waiting > 0) {
        return {
          queue: true,
          load: currentLoad,
          reason: `${waiting} requests already queued`,
        };
      }

      return { queue: false, load: currentLoad };
    } catch (error) {
      this.log.error({ error }, 'Failed to check queue status');
      // On error, don't queue (fail fast)
      return { queue: false, load: 0, reason: 'Queue check failed' };
    }
  }

  /**
   * Add request to queue
   */
  async enqueue(
    requestId: string,
    organizationId: string,
    userId: string | undefined,
    request: ChatRequest,
    context: OrchestrationContext | undefined,
    tier: 'enterprise' | 'pro' | 'free' = 'free'
  ): Promise<QueuedResponse> {
    const runtimeState = getQueueRuntimeState();
    if (!runtimeState.enabled || !this.queue) {
      throw new Error(runtimeState.reason || 'Request queue is disabled');
    }

    // Double-check queue is available (defensive programming for tests)
    if (!this.queue) {
      throw new Error('Queue not initialized');
    }

    const priority = this.calculatePriority(tier);

    // G8 fix (ADR-005): Propagate correlationId into job data for cross-flow tracing.
    // Without this, traces break at the queue boundary — the worker has no way to
    // reconstruct the HTTP request's correlation context.
    let correlationId: string | undefined;
    try {
      const { getCorrelationId } = await import('@/api/middleware/request-context.js');
      correlationId = getCorrelationId();
    } catch {
      // Outside HTTP request context — leave undefined
    }

    const job = await this.queue.add(
      'process-chat',
      {
        requestId,
        organizationId,
        userId,
        request,
        context,
        priority,
        correlationId,
        queuedAt: Date.now(),
      },
      {
        priority,
        jobId: requestId,
      }
    );

    await queueResultService.setQueued(job.id!, {
      organizationId,
      userId,
      enqueueTimestamp: Date.now(),
      priority,
      tier,
    });

    const position = await this.queue.getWaitingCount();
    const estimatedWaitTimeMs = this.estimateWaitTime(position, priority);

    this.log.info(
      {
        requestId,
        position,
        priority,
        tier,
        estimatedWaitMs: estimatedWaitTimeMs,
      },
      'Request queued'
    );

    return {
      status: 'queued',
      queueId: job.id!,
      position,
      estimatedWaitTimeMs,
      priority,
    };
  }

  /**
   * Calculate priority based on tier
   *
   * Priority tiers:
   *   - Enterprise: 1-1000 (highest priority)
   *   - Pro: 1001-5000
   *   - Free: 5001-10000 (lowest priority)
   */
  private calculatePriority(tier: 'enterprise' | 'pro' | 'free'): number {
    const basePriorities = {
      enterprise: config.queue.priority.enterprise,
      pro: config.queue.priority.pro,
      free: config.queue.priority.free,
    };

    // Add jitter to prevent starvation
    const jitterRange = config.queue.priority.jitter;
    const jitter =
      jitterRange > 0 ? Math.floor(Math.random() * (jitterRange * 2 + 1)) - jitterRange : 0;

    return Math.max(1, basePriorities[tier] + jitter);
  }

  /**
   * Estimate wait time based on queue position and priority
   */
  private estimateWaitTime(position: number, priority: number): number {
    // Average processing time per request
    const avgProcessingTimeMs = 16000; // 16s average orchestration

    // Workers process in parallel
    const effectiveRate = Math.max(1, config.queue.workerCount * config.queue.workerConcurrency);

    // Estimate based on position
    const baseWaitMs = (position / effectiveRate) * avgProcessingTimeMs;

    // Adjust for priority (higher priority = less wait)
    const priorityFactor = priority / 10000; // 0.0 (best) to 1.0 (worst)
    const adjustedWaitMs = baseWaitMs * (0.5 + priorityFactor * 0.5);

    return Math.round(adjustedWaitMs);
  }

  /**
   * Get queue statistics
   */
  async getStatistics(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    capacity: number;
    utilizationPercent: number;
    workerCount: number;
  }> {
    const runtimeState = getQueueRuntimeState();
    if (!runtimeState.enabled || !this.queue) {
      const { workerCount, capacity } = this.getWorkerCapacity();
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        capacity,
        utilizationPercent: 0,
        workerCount,
      };
    }

    // Double-check queue is available (defensive programming for tests)
    if (!this.queue) {
      const { workerCount, capacity } = this.getWorkerCapacity();
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        capacity,
        utilizationPercent: 0,
        workerCount,
      };
    }

    const [waiting, active, completed, failed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
    ]);

    const { capacity, workerCount } = this.getWorkerCapacity();
    const utilizationPercent = (active / capacity) * 100;

    queueSize.set({ queue_name: config.queue.queueName }, waiting);

    return {
      waiting,
      active,
      completed,
      failed,
      capacity,
      utilizationPercent,
      workerCount,
    };
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    queueSize: number;
    workersActive: number;
    utilizationPercent: number;
    workerCount: number;
  }> {
    const runtimeState = getQueueRuntimeState();
    if (!runtimeState.enabled || !this.queue) {
      return {
        healthy: true,
        queueSize: 0,
        workersActive: 0,
        utilizationPercent: 0,
        workerCount: this.getWorkerCapacity().workerCount,
      };
    }

    try {
      const stats = await this.getStatistics();

      return {
        healthy: stats.utilizationPercent < 95, // Healthy if <95% utilized
        queueSize: stats.waiting,
        workersActive: stats.active,
        utilizationPercent: stats.utilizationPercent,
        workerCount: stats.workerCount,
      };
    } catch (error) {
      this.log.error({ error }, 'Queue health check failed');
      return {
        healthy: false,
        queueSize: 0,
        workersActive: 0,
        utilizationPercent: 0,
        workerCount: this.getWorkerCapacity().workerCount,
      };
    }
  }

  /**
   * Start workers (call this on server startup)
   */
  async startWorkers(processor: (job: Job<QueuedRequest>) => Promise<ChatResponse>): Promise<void> {
    const runtimeState = getQueueRuntimeState();
    if (!runtimeState.enabled) {
      this.log.info('Queue disabled - workers not started');
      return;
    }

    if (!this.queue) {
      throw new Error('Queue not initialized');
    }

    this.processor = processor;

    const initialWorkers = this.scaleConfig.enabled
      ? Math.max(1, this.scaleConfig.minWorkers)
      : this.baseWorkerCount;

    await this.scaleTo(initialWorkers);

    if (this.scaleConfig.enabled) {
      this.startAutoScaleMonitor();
    }
  }

  /**
   * Stop all workers (call this on server shutdown)
   */
  async stopWorkers(): Promise<void> {
    this.log.info('Stopping queue workers');

    if (this.monitorHandle) {
      clearInterval(this.monitorHandle);
      this.monitorHandle = undefined;
    }

    if (this.workers.length > 0) {
      await Promise.all(this.workers.map(({ worker }) => worker.close()));
      await Promise.all(
        this.workers.map(async ({ connection }) => {
          await releaseRedisClient(connection);
        })
      );
      this.workers = [];
    }

    this.processor = undefined;
    this.lastScaleAt = 0;

    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }

    if (this.queueConnection) {
      await releaseRedisClient(this.queueConnection);
      this.queueConnection = null;
    }

    this.log.info('Queue workers stopped');
  }

  private getWorkerCapacity(): { workerCount: number; capacity: number } {
    const workerCount = this.workers.length > 0 ? this.workers.length : this.baseWorkerCount;
    const capacity = Math.max(1, workerCount) * config.queue.workerConcurrency;
    return { workerCount, capacity };
  }

  private buildWorker(processor: (job: Job<QueuedRequest>) => Promise<ChatResponse>) {
    const connection = createRedisClient(`queue-worker-${this.workers.length + 1}`);
    let worker: Worker<QueuedRequest, ChatResponse> | undefined;
    try {
      worker = new Worker<QueuedRequest, ChatResponse>(config.queue.queueName, processor, {
        connection,
        concurrency: config.queue.workerConcurrency,
        limiter: {
          max: config.queue.workerConcurrency,
          duration: 1000, // Process up to 100 jobs per second per worker
        },
      });
      this.workers.push({ worker, connection });
    } catch (error) {
      releaseRedisClient(connection).catch((releaseError: unknown) => {
        this.log.warn(
          { error: releaseError },
          'Failed to release worker Redis connection after initialization error'
        );
      });
      throw error;
    }

    worker.on('active', (job) => {
      queueResultService.setProcessing(job.id!).catch((error: unknown) => {
        this.log.error({ error, jobId: job.id }, 'Failed to cache processing status');
      });
    });

    worker.on('completed', (job) => {
      const queueTime = Date.now() - job.data.queuedAt;
      queueResultService.setCompleted(job.id!, job.returnvalue, queueTime).catch((error: unknown) => {
        this.log.error({ error, jobId: job.id }, 'Failed to cache completed job result');
      });
      this.log.info(
        { jobId: job.id, queueTimeMs: queueTime },
        'Queue job completed event processed'
      );

      queueProcessed.inc({ queue_name: config.queue.queueName, status: 'completed' });
      if (queueTime >= 0) {
        queueWaitTime.observe({ queue_name: config.queue.queueName }, queueTime / 1000);
      }

      this.log.debug(
        {
          jobId: job.id,
          requestId: job.data.requestId,
          queueTimeMs: queueTime,
        },
        'Job completed'
      );
    });

    worker.on('failed', (job, error) => {
      if (job?.id) {
        queueResultService.setFailed(job.id, error).catch((err: unknown) => {
          this.log.error({ error: err, jobId: job.id }, 'Failed to cache failed job result');
        });
      }
      this.log.warn({ jobId: job?.id, error: error.message }, 'Queue job failed event processed');

      queueProcessed.inc({ queue_name: config.queue.queueName, status: 'failed' });
      if (job?.data?.queuedAt) {
        const queueTime = Date.now() - job.data.queuedAt;
        if (queueTime >= 0) {
          queueWaitTime.observe({ queue_name: config.queue.queueName }, queueTime / 1000);
        }
      }

      this.log.error(
        {
          jobId: job?.id,
          requestId: job?.data?.requestId,
          error: error.message,
        },
        'Job failed'
      );
    });
  }

  private async scaleTo(target: number): Promise<void> {
    if (!this.processor) {
      return;
    }

    const normalizedTarget = this.scaleConfig.enabled
      ? Math.max(
          this.scaleConfig.minWorkers,
          Math.min(this.scaleConfig.maxWorkers, Math.floor(target))
        )
      : Math.max(1, Math.floor(target));

    if (normalizedTarget === this.workers.length) {
      return;
    }

    if (normalizedTarget > this.workers.length) {
      const toAdd = normalizedTarget - this.workers.length;
      this.log.info(
        {
          action: 'scale_up',
          previous: this.workers.length,
          target: normalizedTarget,
          step: toAdd,
        },
        'Scaling queue workers up'
      );

      for (let i = 0; i < toAdd; i += 1) {
        this.buildWorker(this.processor);
      }
    } else {
      const toRemove = this.workers.length - normalizedTarget;
      this.log.info(
        {
          action: 'scale_down',
          previous: this.workers.length,
          target: normalizedTarget,
          step: toRemove,
        },
        'Scaling queue workers down'
      );

      const removable = this.workers.splice(normalizedTarget);
      await Promise.all(removable.map(({ worker }) => worker.close()));
      await Promise.all(removable.map(({ connection }) => releaseRedisClient(connection)));
    }

    const { capacity } = this.getWorkerCapacity();
    this.log.info(
      {
        workers: this.workers.length,
        totalCapacity: capacity,
      },
      'Queue worker pool resized'
    );
  }

  private startAutoScaleMonitor(): void {
    if (this.monitorHandle || !this.queue) {
      return;
    }

    this.monitorHandle = setInterval(async () => {
      if (!this.processor || this.scalingInProgress) {
        return;
      }

      const now = Date.now();
      if (now - this.lastScaleAt < this.scaleConfig.cooldownMs) {
        return;
      }

      this.scalingInProgress = true;
      try {
        const stats = await this.getStatistics();

        let target = this.workers.length;
        if (
          stats.utilizationPercent >= this.scaleConfig.scaleUpUtilizationPercent ||
          stats.waiting >= this.scaleConfig.scaleUpQueueSize
        ) {
          target = Math.min(this.scaleConfig.maxWorkers, target + this.scaleConfig.scaleStep);
        } else if (
          stats.utilizationPercent <= this.scaleConfig.scaleDownUtilizationPercent &&
          stats.waiting <= this.scaleConfig.scaleDownQueueSize
        ) {
          target = Math.max(this.scaleConfig.minWorkers, target - this.scaleConfig.scaleStep);
        }

        if (target !== this.workers.length) {
          await this.scaleTo(target);
          this.lastScaleAt = now;
        }
      } catch (error) {
        this.log.error({ error }, 'Queue auto-scale evaluation failed');
      } finally {
        this.scalingInProgress = false;
      }
    }, this.scaleConfig.monitorIntervalMs);

    if (typeof this.monitorHandle.unref === 'function') {
      this.monitorHandle.unref();
    }
  }
}

// Export singleton instance
export const requestQueueService = new RequestQueueService();
