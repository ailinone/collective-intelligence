// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Context Cache Cleanup Job (Enterprise-Grade)
 *
 * Purpose:
 * - Prevent database bloat from expired cached contexts
 * - Maintain optimal performance for context cache lookups
 * - Free up storage from unused/expired contexts
 *
 * Schedule:
 * - Every hour (configurable via CONTEXT_CACHE_CLEANUP_CRON)
 *
 * Scale Support:
 * - Handles millions of cached contexts
 * - Batch deletion (prevents transaction timeout)
 * - Metrics for monitoring
 */

import cron, { type ScheduledTask } from 'node-cron';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { getRedisClient } from '@/cache/redis-client';
import promClient from 'prom-client';

const log = logger.child({ component: 'context-cache-cleanup-job' });

// ============================================
// Prometheus Metrics
// ============================================

function getOrCreateMetric<T extends promClient.Metric>(name: string, createFn: () => T): T {
  const existing = promClient.register.getSingleMetric(name);
  if (existing) {
    return existing as T;
  }
  return createFn();
}

export const contextCacheCleanupRowsDeleted = getOrCreateMetric(
  'ailin_dev_context_cache_cleanup_rows_deleted_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_context_cache_cleanup_rows_deleted_total',
      help: 'Total expired cached contexts deleted by cleanup job',
    })
);

export const contextCacheCleanupDuration = getOrCreateMetric(
  'ailin_dev_context_cache_cleanup_duration_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_context_cache_cleanup_duration_seconds',
      help: 'Duration of context cache cleanup job execution',
      buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
    })
);

export const contextCacheCleanupErrors = getOrCreateMetric(
  'ailin_dev_context_cache_cleanup_errors_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_context_cache_cleanup_errors_total',
      help: 'Total errors in context cache cleanup job',
    })
);

// ============================================
// Configuration
// ============================================

const CONFIG = {
  // Batch processing (prevent transaction timeouts)
  batchSize: parseInt(process.env.CONTEXT_CACHE_CLEANUP_BATCH_SIZE || '1000', 10),
  maxBatchesPerRun: parseInt(process.env.CONTEXT_CACHE_CLEANUP_MAX_BATCHES || '50', 10),

  // Schedule: Every hour (cleanup expired contexts)
  cronSchedule: process.env.CONTEXT_CACHE_CLEANUP_CRON || '0 * * * *',

  // Redis key prefix for context cache
  redisKeyPrefix: 'context-cache',
};

// ============================================
// Cleanup Implementation
// ============================================

/**
 * Delete expired cached contexts from PostgreSQL
 * Uses batch deletion to prevent transaction timeouts
 */
async function deleteExpiredContexts(): Promise<number> {
  const now = new Date();
  let totalDeleted = 0;
  let batchCount = 0;

  log.info({ batchSize: CONFIG.batchSize }, 'Starting context cache cleanup');

  while (batchCount < CONFIG.maxBatchesPerRun) {
    try {
      // Find expired contexts in batch
      const expiredContexts = await prisma.cachedContext.findMany({
        where: {
          expiresAt: { lt: now },
        },
        select: { id: true, organizationId: true },
        take: CONFIG.batchSize,
      });

      if (expiredContexts.length === 0) {
        break;
      }

      // Delete from PostgreSQL
      const ids = expiredContexts.map((c: { id: string }) => c.id);
      const result = await prisma.cachedContext.deleteMany({
        where: {
          id: { in: ids },
        },
      });

      totalDeleted += result.count;
      batchCount++;

      // Also clean up Redis keys (best effort)
      const redis = getRedisClient();
      const redisKeys = expiredContexts.map(
        (c: { id: string; organizationId: string }) => `${CONFIG.redisKeyPrefix}:${c.organizationId}:${c.id}`
      );

      if (redisKeys.length > 0) {
        try {
          await redis.del(...redisKeys);
        } catch (redisError) {
          log.warn({ error: redisError }, 'Failed to delete Redis keys for expired contexts');
        }
      }

      log.debug(
        {
          batch: batchCount,
          deleted: result.count,
          totalDeleted,
        },
        'Context cache batch cleaned up'
      );

      // Small delay between batches (prevent database overload)
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch (error) {
      log.error(
        {
          error,
          batch: batchCount,
          totalDeleted,
        },
        'Error cleaning up context cache batch'
      );
      break;
    }
  }

  return totalDeleted;
}

/**
 * Run full context cache cleanup
 */
async function runContextCacheCleanup(): Promise<void> {
  const startTime = Date.now();

  log.info('🗑️ Starting context cache cleanup job');

  try {
    const deletedCount = await deleteExpiredContexts();
    const duration = Date.now() - startTime;

    log.info(
      {
        duration,
        deleted: deletedCount,
      },
      '✅ Context cache cleanup job completed successfully'
    );

    // Update Prometheus metrics
    contextCacheCleanupRowsDeleted.inc(deletedCount);
    contextCacheCleanupDuration.observe(duration / 1000);
  } catch (error) {
    const duration = Date.now() - startTime;

    log.error(
      {
        error,
        duration,
      },
      '❌ Context cache cleanup job failed'
    );

    contextCacheCleanupErrors.inc();
    contextCacheCleanupDuration.observe(duration / 1000);
  }
}

// ============================================
// Cron Job Management
// ============================================

let cronJob: ScheduledTask | null = null;

/**
 * Start context cache cleanup job
 * Default schedule: Every hour
 */
export function startContextCacheCleanupJob(): void {
  if (cronJob) {
    log.warn('Context cache cleanup job already running');
    return;
  }

  log.info(
    {
      schedule: CONFIG.cronSchedule,
      batchSize: CONFIG.batchSize,
      maxBatchesPerRun: CONFIG.maxBatchesPerRun,
    },
    'Starting context cache cleanup scheduled job'
  );

  cronJob = cron.schedule(
    CONFIG.cronSchedule,
    async () => {
      await runContextCacheCleanup();
    },
    {
      timezone: 'UTC',
    }
  );

  log.info('✅ Context cache cleanup job scheduled');
}

/**
 * Stop context cache cleanup job
 */
export function stopContextCacheCleanupJob(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    log.info('Context cache cleanup job stopped');
  }
}

/**
 * Run cleanup immediately (for manual execution/testing)
 */
export async function runContextCacheCleanupNow(): Promise<number> {
  log.info('Running context cache cleanup (manual execution)');
  const startTime = Date.now();
  const deletedCount = await deleteExpiredContexts();
  const duration = Date.now() - startTime;

  log.info({ deletedCount, duration }, 'Manual context cache cleanup completed');
  return deletedCount;
}

