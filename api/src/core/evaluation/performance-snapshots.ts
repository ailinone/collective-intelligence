// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Performance Snapshot Aggregation
 *
 * Periodically computes aggregated strategy performance metrics per niche
 * and time window. These snapshots form the basis for:
 * - Competitive benchmarking between strategies
 * - Drift detection baselines
 * - Learning validation comparisons
 * - Admin dashboards
 *
 * Schedule: Called from the evaluation cron job (daily + on-demand).
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'performance-snapshots' });

/**
 * Generate daily performance snapshots for all active strategies.
 * Aggregates execution_outcomes from the previous day.
 */
export async function generateDailySnapshots(date?: Date): Promise<number> {
  const targetDate = date ?? new Date(Date.now() - 86_400_000); // yesterday
  const dayStr = targetDate.toISOString().slice(0, 10);
  const dayStart = new Date(dayStr + 'T00:00:00Z');
  const dayEnd = new Date(dayStr + 'T23:59:59.999Z');

  try {
    // Get all active niches for that day
    const niches = await prisma.$queryRaw<Array<{
      strategy: string;
      task_type: string;
      complexity: string;
      sample_size: bigint;
      avg_quality: number | null;
      avg_latency_ms: number | null;
      avg_cost_usd: number | null;
      success_rate: number | null;
      quality_p10: number | null;
      quality_p90: number | null;
      quality_stddev: number | null;
    }>>`
      SELECT
        strategy,
        (observed_metrics->>'taskType')::text as task_type,
        (observed_metrics->>'complexity')::text as complexity,
        COUNT(*) as sample_size,
        AVG(quality_score) as avg_quality,
        AVG(latency_ms) as avg_latency_ms,
        AVG(cost_usd) as avg_cost_usd,
        AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as success_rate,
        PERCENTILE_CONT(0.1) WITHIN GROUP (ORDER BY quality_score) as quality_p10,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY quality_score) as quality_p90,
        STDDEV(quality_score) as quality_stddev
      FROM execution_outcomes
      WHERE created_at >= ${dayStart}
        AND created_at < ${dayEnd}
        AND quality_score IS NOT NULL
      GROUP BY strategy, observed_metrics->>'taskType', observed_metrics->>'complexity'
      HAVING COUNT(*) >= 3
    `;

    let inserted = 0;
    for (const niche of niches) {
      const sampleSize = Number(niche.sample_size);
      const avgQuality = niche.avg_quality ?? 0;
      const stddev = niche.quality_stddev ?? 0;

      // Stability index: 1 - normalized stddev (0 = chaotic, 1 = perfectly stable)
      const stabilityIndex = stddev > 0 ? Math.max(0, 1 - stddev / 0.15) : 1.0;

      // Confidence score based on sample size (saturates at ~50)
      const confidenceScore = Math.min(1.0, sampleSize / 50);

      await prisma.$executeRaw`
        INSERT INTO strategy_performance_snapshots (
          strategy, task_type, complexity, time_window, window_type,
          sample_size, win_rate, avg_quality, avg_latency_ms, avg_cost_usd,
          success_rate, quality_p10, quality_p90, stability_index, confidence_score
        ) VALUES (
          ${niche.strategy},
          ${niche.task_type ?? 'general'},
          ${niche.complexity ?? 'medium'},
          ${dayStr},
          'daily',
          ${sampleSize},
          ${avgQuality},
          ${avgQuality},
          ${Math.round(niche.avg_latency_ms ?? 0)},
          ${niche.avg_cost_usd ?? 0},
          ${niche.success_rate ?? 0},
          ${niche.quality_p10 ?? 0},
          ${niche.quality_p90 ?? 0},
          ${stabilityIndex},
          ${confidenceScore}
        )
        ON CONFLICT (strategy, task_type, complexity, time_window, window_type) DO UPDATE SET
          sample_size = EXCLUDED.sample_size,
          avg_quality = EXCLUDED.avg_quality,
          avg_latency_ms = EXCLUDED.avg_latency_ms,
          avg_cost_usd = EXCLUDED.avg_cost_usd,
          success_rate = EXCLUDED.success_rate,
          quality_p10 = EXCLUDED.quality_p10,
          quality_p90 = EXCLUDED.quality_p90,
          stability_index = EXCLUDED.stability_index,
          confidence_score = EXCLUDED.confidence_score
      `;
      inserted++;
    }

    log.info({ date: dayStr, snapshots: inserted }, 'Daily performance snapshots generated');
    return inserted;
  } catch (err) {
    log.error({ error: String(err) }, 'Failed to generate daily snapshots');
    return 0;
  }
}

/**
 * Get competitive benchmarking data — strategies ranked by quality per niche.
 */
export async function getCompetitiveBenchmark(params: {
  taskType?: string;
  complexity?: string;
  windowDays?: number;
}): Promise<Array<{
  strategy: string;
  taskType: string;
  avgQuality: number;
  successRate: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  sampleSize: number;
  stabilityIndex: number;
  confidenceScore: number;
}>> {
  const days = params.windowDays ?? 7;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  try {
    const rows = await prisma.$queryRaw<Array<{
      strategy: string;
      task_type: string;
      avg_quality: number;
      success_rate: number;
      avg_latency_ms: number;
      avg_cost_usd: number;
      total_samples: bigint;
      avg_stability: number;
      avg_confidence: number;
    }>>`
      SELECT
        strategy,
        task_type,
        AVG(avg_quality) as avg_quality,
        AVG(success_rate) as success_rate,
        AVG(avg_latency_ms) as avg_latency_ms,
        AVG(avg_cost_usd) as avg_cost_usd,
        SUM(sample_size) as total_samples,
        AVG(stability_index) as avg_stability,
        AVG(confidence_score) as avg_confidence
      FROM strategy_performance_snapshots
      WHERE window_type = 'daily'
        AND time_window >= ${since}
        AND (${params.taskType ?? ''} = '' OR task_type = ${params.taskType ?? ''})
        AND (${params.complexity ?? ''} = '' OR complexity = ${params.complexity ?? ''})
      GROUP BY strategy, task_type
      ORDER BY AVG(avg_quality) DESC
    `;

    return rows.map(r => ({
      strategy: r.strategy,
      taskType: r.task_type,
      avgQuality: r.avg_quality,
      successRate: r.success_rate,
      avgLatencyMs: Math.round(r.avg_latency_ms),
      avgCostUsd: Number(r.avg_cost_usd),
      sampleSize: Number(r.total_samples),
      stabilityIndex: r.avg_stability,
      confidenceScore: r.avg_confidence,
    }));
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to get competitive benchmark');
    return [];
  }
}
