// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Error Learning System
 * Learns from errors, blocks, rate limits to improve strategy selection
 */

import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import type { Prisma } from '@/generated/prisma/index.js';

/**
 * Error event for learning
 */
interface ErrorEvent {
  provider: string;
  model: string;
  errorType:
    | 'rate-limit'
    | 'timeout'
    | 'provider-error'
    | 'model-unavailable'
    | 'quality-low'
    | 'other';
  errorCode?: string;
  taskType: string;
  strategy: string;
  timestamp: number;
  recovered: boolean;
  recoveryStrategy?: string;
  latencyMs?: number;
}

/**
 * Provider health score (learned from errors)
 */
interface ProviderHealthScore {
  provider: string;
  reliability: number; // 0-1 (1 = never fails)
  avgLatency: number;
  rateLimitFrequency: number; // Errors per 1000 requests
  lastError: number | null; // Timestamp
  recommendedForTasks: string[]; // Task types where this provider works best
  errorRate: number; // 0-1 proportion of failures
}

/**
 * Aggregated bucket for error events
 */
interface AggregatedBucket {
  bucket: string;
  taskType: string;
  insights: {
    errorTypes: Record<string, number>;
    recoveryStrategies: Record<string, number>;
    avgLatency: number;
  };
  metrics: {
    totalEvents: number;
    errorRate: number;
    successRate: number;
  };
}

/**
 * Error Learning System
 * Uses errors/blocks/successes to continuously improve orchestration
 */
class ErrorLearningSystem {
  private log = logger.child({ component: 'error-learning' });
  private errorBuffer: ErrorEvent[] = [];
  private BUFFER_SIZE = 100;
  private FLUSH_INTERVAL = 60000; // Flush every minute

  constructor() {
    // Start periodic flush
    this.startPeriodicFlush();
  }

  /**
   * Record error event
   */
  recordError(event: Omit<ErrorEvent, 'timestamp'>): void {
    const fullEvent: ErrorEvent = {
      ...event,
      timestamp: Date.now(),
    };

    this.errorBuffer.push(fullEvent);

    this.log.info(
      {
        provider: event.provider,
        errorType: event.errorType,
        recovered: event.recovered,
      },
      'Error event recorded'
    );

    // Flush if buffer full
    if (this.errorBuffer.length >= this.BUFFER_SIZE) {
      this.flush().catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.log.error({ error: errorMessage }, 'Failed to flush error buffer');
      });
    }
  }

  /**
   * Record successful request (for baseline comparison)
   */
  recordSuccess(
    provider: string,
    model: string,
    taskType: string,
    strategy: string,
    latency: number
  ): void {
    // Record as successful event (no error type)
    // This helps calculate reliability scores

    this.errorBuffer.push({
      provider,
      model,
      errorType: 'other', // 'other' means success
      taskType,
      strategy,
      timestamp: Date.now(),
      recovered: true, // Success = recovered by default
      latencyMs: Number.isFinite(latency) ? latency : undefined,
    });

    // Flush if buffer full
    if (this.errorBuffer.length >= this.BUFFER_SIZE) {
      this.flush().catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.log.error({ error: errorMessage }, 'Failed to flush error buffer');
      });
    }
  }

  /**
   * Flush error buffer to database
   */
  private async flush(): Promise<void> {
    if (this.errorBuffer.length === 0) return;

    const events = [...this.errorBuffer];
    this.errorBuffer = [];

    this.log.info({ count: events.length }, 'Flushing error events');

    try {
      // Store in learning_data table (aggregated)
      // Group by provider + error type + task type
      const aggregated = this.aggregateEvents(events);

      for (const entry of aggregated) {
        // Map aggregated structure to Prisma schema
        // Extract bucket (format: "YYYY-MM-DDTHH:taskType:provider" -> "YYYY-MM-DD-HH")
        const bucketParts = entry.bucket.split(':');
        const dateTimePart = bucketParts[0]; // "YYYY-MM-DDTHH"
        const bucketFormatted = dateTimePart.replace('T', '-'); // "YYYY-MM-DD-HH"
        const taskType = entry.taskType || 'general';
        const complexity = this.inferComplexity(entry.metrics); // Infer from metrics

        // Calculate metrics
        const count = entry.metrics.totalEvents || 0;
        const successCount = Math.round((entry.metrics.successRate || 0) * count);
        const errorRate = entry.metrics.errorRate || 0;
        const avgQualityValue = Number((1.0 - errorRate).toFixed(4));
        const avgLatencyValue = Number.isFinite(entry.insights.avgLatency ?? null)
          ? Math.round(entry.insights.avgLatency ?? 0)
          : 0;
        const avgCostValue = 0; // Cost not tracked in error events

        // Strategy distribution from insights
        const strategyDistribution = entry.insights.recoveryStrategies || {};

        // Top patterns (error types)
        const topPatterns = Object.entries(entry.insights.errorTypes || {})
          .sort(([, a], [, b]) => (b as number) - (a as number))
          .slice(0, 5)
          .map(([type, count]) => ({ type, count }));

        // Store in database
        await prisma.learningData.upsert({
          where: {
            bucket_taskType_complexity: {
              bucket: bucketFormatted,
              taskType,
              complexity,
            },
          },
          create: {
            bucket: bucketFormatted,
            taskType,
            complexity,
            count,
            successCount,
            avgQuality: avgQualityValue,
            avgCost: avgCostValue,
            avgLatency: avgLatencyValue,
            strategyDistribution: strategyDistribution as Prisma.InputJsonValue,
            topPatterns: topPatterns as Prisma.InputJsonValue,
          },
          update: {
            count: { increment: count },
            successCount: { increment: successCount },
            // Update averages (weighted)
            avgQuality: { set: avgQualityValue },
            avgLatency: { set: avgLatencyValue },
            strategyDistribution: { set: strategyDistribution as Prisma.InputJsonValue },
            topPatterns: { set: topPatterns as Prisma.InputJsonValue },
          },
        });
      }

      this.log.info({ entries: aggregated.length }, 'Error events flushed (temp disabled)');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to flush error events to database');

      // Re-add to buffer to not lose data
      this.errorBuffer.unshift(...events);
    }
  }

  /**
   * Aggregate error events for compact storage
   */
  private aggregateEvents(events: ErrorEvent[]): AggregatedBucket[] {
    const buckets = new Map<string, ErrorEvent[]>();

    // Group by hour + task type + provider
    for (const event of events) {
      const hourBucket = new Date(event.timestamp).toISOString().slice(0, 13); // YYYY-MM-DDTHH
      const key = `${hourBucket}:${event.taskType}:${event.provider}`;

      if (!buckets.has(key)) {
        buckets.set(key, []);
      }
      buckets.get(key)!.push(event);
    }

    // Aggregate each bucket
    const aggregated: AggregatedBucket[] = [];

    for (const [bucket, bucketEvents] of buckets) {
      const totalEvents = bucketEvents.length;
      const errors = bucketEvents.filter((e) => e.errorType !== 'other');
      const successes = bucketEvents.filter((e) => e.errorType === 'other' || e.recovered);

      const errorsByType: Record<string, number> = {};
      for (const event of errors) {
        errorsByType[event.errorType] = (errorsByType[event.errorType] || 0) + 1;
      }

      const latencySamples = bucketEvents
        .map((event) => event.latencyMs)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const avgLatency =
        latencySamples.length > 0
          ? latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length
          : null;

      aggregated.push({
        bucket,
        taskType: bucketEvents[0].taskType,
        insights: {
          errorTypes: errorsByType,
          recoveryStrategies: bucketEvents
            .filter((e) => e.recoveryStrategy)
            .reduce((acc: Record<string, number>, e) => {
              acc[e.recoveryStrategy!] = (acc[e.recoveryStrategy!] || 0) + 1;
              return acc;
            }, {}),
          avgLatency: avgLatency || 0,
        },
        metrics: {
          totalEvents,
          errorRate: errors.length / totalEvents,
          successRate: successes.length / totalEvents,
        },
      });
    }

    return aggregated;
  }

  /**
   * Infer task complexity from metrics
   */
  private inferComplexity(metrics: { errorRate?: number; totalEvents?: number }): string {
    const errorRate = metrics.errorRate || 0;
    const totalEvents = metrics.totalEvents || 0;

    // High error rate + many events = complex task
    if (errorRate > 0.3 && totalEvents > 10) {
      return 'high';
    }

    // Medium error rate = medium complexity
    if (errorRate > 0.1) {
      return 'medium';
    }

    // Low error rate = simple task
    return 'low';
  }

  /**
   * Get provider health scores based on error history
   */
  async getProviderHealthScores(): Promise<ProviderHealthScore[]> {
    try {
      const since = new Date(Date.now() - 7 * 86400000);

      const rows = await prisma.$queryRaw<
        Array<{
          provider: string | null;
          total_requests: bigint | number;
          success_count: bigint | number;
          error_count: bigint | number;
          rate_limit_count: bigint | number;
          avg_latency: number | null;
          last_error_epoch: number | null;
          recommended_tasks: string[] | null;
        }>
      >`
        WITH provider_logs AS (
          SELECT
            COALESCE(
              m.provider_id,
              CASE WHEN rl.model_id IS NOT NULL AND POSITION(':' IN rl.model_id) > 0
                   THEN SPLIT_PART(rl.model_id, ':', 1)
                   ELSE 'unknown'
              END
            ) AS provider,
            rl.status,
            rl.error_code,
            rl.duration_ms,
            rl.created_at,
            rl.metadata ->> 'taskType' AS task_type
          FROM request_logs rl
          LEFT JOIN models m ON rl.model_id = m.id
          WHERE rl.created_at >= ${since}
        ),
        summary AS (
          SELECT
            provider,
            COUNT(*)::bigint AS total_requests,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::bigint AS success_count,
            SUM(CASE WHEN status <> 'success' THEN 1 ELSE 0 END)::bigint AS error_count,
            SUM(
              CASE
                WHEN status <> 'success'
                  AND (error_code ILIKE 'rate_limit%' OR error_code = '429' OR error_code = 'RATE_LIMIT')
                THEN 1
                ELSE 0
              END
            )::bigint AS rate_limit_count,
            AVG(duration_ms)::float AS avg_latency,
            MAX(
              CASE WHEN status <> 'success' THEN EXTRACT(EPOCH FROM created_at) END
            ) AS last_error_epoch
          FROM provider_logs
          GROUP BY provider
        ),
        task_rank AS (
          SELECT
            provider,
            task_type,
            COUNT(*) AS cnt,
            ROW_NUMBER() OVER (PARTITION BY provider ORDER BY COUNT(*) DESC) AS rn
          FROM provider_logs
          WHERE status = 'success' AND task_type IS NOT NULL
          GROUP BY provider, task_type
        )
        SELECT
          s.provider,
          s.total_requests,
          s.success_count,
          s.error_count,
          s.rate_limit_count,
          s.avg_latency,
          s.last_error_epoch,
          COALESCE(
            (
              SELECT ARRAY(
                SELECT task_type
                FROM task_rank tr
                WHERE tr.provider = s.provider AND tr.rn <= 5
              )
            ),
            ARRAY[]::text[]
          ) AS recommended_tasks
        FROM summary s
      `;

      return rows.map((row) => {
        const provider = row.provider ?? 'unknown';
        const total = Number(row.total_requests ?? 0);
        const successes = Number(row.success_count ?? 0);
        const errors = Number(row.error_count ?? 0);
        const rateLimits = Number(row.rate_limit_count ?? 0);

        const reliability = total > 0 ? successes / total : 0.5;
        const rateLimitFrequency = total > 0 ? (rateLimits / total) * 1000 : 0;
        const errorRate = total > 0 ? errors / total : 0;

        return {
          provider,
          reliability: Number.isFinite(reliability) ? Number(reliability.toFixed(4)) : 0,
          avgLatency:
            row.avg_latency !== null && Number.isFinite(row.avg_latency)
              ? Math.round(Number(row.avg_latency))
              : 0,
          rateLimitFrequency: Number.isFinite(rateLimitFrequency)
            ? Number(rateLimitFrequency.toFixed(2))
            : 0,
          lastError:
            row.last_error_epoch !== null ? Math.floor(Number(row.last_error_epoch) * 1000) : null,
          recommendedForTasks: Array.isArray(row.recommended_tasks)
            ? row.recommended_tasks.filter((task): task is string => typeof task === 'string')
            : [],
          errorRate: Number.isFinite(errorRate) ? Number(errorRate.toFixed(4)) : 0,
        } satisfies ProviderHealthScore;
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to compute provider health scores');
      return [];
    }
  }

  /**
   * Get hour bucket for timestamp
   */
  private getHourBucket(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 13); // YYYY-MM-DDTHH
  }

  /**
   * Start periodic flush
   */
  private startPeriodicFlush(): void {
    setInterval(() => {
      if (this.errorBuffer.length > 0) {
        this.flush().catch((err: unknown) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.log.error({ error: errorMessage }, 'Periodic flush failed');
        });
      }
    }, this.FLUSH_INTERVAL);
  }

  /**
   * Get recommendations based on error history
   */
  async getRecommendations(taskType: string): Promise<{
    avoidProviders: string[];
    preferProviders: string[];
    reasoning: string;
  }> {
    let scores = await this.getProviderHealthScores();

    if (taskType) {
      const taskSpecific = scores.filter((score) => score.recommendedForTasks.includes(taskType));
      if (taskSpecific.length > 0) {
        scores = taskSpecific;
      }
    }

    // Sort by reliability
    scores.sort((a, b) => b.reliability - a.reliability);

    // Avoid providers with high error rates
    const avoidProviders = scores
      .filter((s) => s.reliability < 0.8 || s.errorRate > 0.2 || s.rateLimitFrequency > 50)
      .map((s) => s.provider);

    // Prefer reliable providers
    const preferProviders = scores
      .filter((s) => s.reliability > 0.95 && s.rateLimitFrequency < 10 && s.errorRate < 0.1)
      .map((s) => s.provider);

    const reasoning = `Based on last 7 days: ${preferProviders.length} reliable providers, ${avoidProviders.length} to avoid`;

    return {
      avoidProviders,
      preferProviders,
      reasoning,
    };
  }
}

// Export singleton instance
export const errorLearningSystem = new ErrorLearningSystem();
