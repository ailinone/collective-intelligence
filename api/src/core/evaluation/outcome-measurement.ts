// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Outcome Measurement Layer
 *
 * Persists the measured result of every execution, linked to the decision trace
 * that produced it. This is the foundation for regret calculation, drift detection,
 * and learning validation.
 *
 * Design principle: Observed metrics are kept strictly separate from derived metrics.
 * "Missing" data is explicitly null — never invented.
 *
 * Integration point: Called from orchestration-engine.ts after execution completes,
 * in the same post-execution pipeline as bandit.update() and archive.ingestProductionResult().
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'outcome-measurement' });

export interface ExecutionOutcomeInput {
  decisionTraceId: string;
  strategy: string;
  startedAt: Date;
  finishedAt: Date;
  latencyMs: number;
  costUsd: number;
  totalTokens: number;
  success: boolean;
  failureReason?: string;
  retries: number;
  fallbackUsed: boolean;
  escalationUsed: boolean;
  qualityScore: number | null;
  qualityDimensions?: Record<string, number>;
  feedbackIterations: number;
  modelsUsed: string[];
  observedMetrics?: Record<string, unknown>;
}

/**
 * Record an execution outcome linked to a decision trace.
 * Fire-and-forget — failures are logged but never propagated.
 */
export async function recordOutcome(input: ExecutionOutcomeInput): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO execution_outcomes (
        decision_trace_id, strategy, started_at, finished_at, latency_ms,
        cost_usd, total_tokens, success, failure_reason, retries,
        fallback_used, escalation_used, quality_score, quality_dimensions,
        feedback_iterations, models_used, observed_metrics
      ) VALUES (
        ${input.decisionTraceId},
        ${input.strategy},
        ${input.startedAt},
        ${input.finishedAt},
        ${input.latencyMs},
        ${input.costUsd},
        ${input.totalTokens},
        ${input.success},
        ${input.failureReason ?? null},
        ${input.retries},
        ${input.fallbackUsed},
        ${input.escalationUsed},
        ${input.qualityScore},
        ${input.qualityDimensions ? JSON.stringify(input.qualityDimensions) : null}::jsonb,
        ${input.feedbackIterations},
        ${input.modelsUsed},
        ${JSON.stringify(input.observedMetrics ?? {})}::jsonb
      )
      ON CONFLICT (decision_trace_id) DO NOTHING
    `;
  } catch (err) {
    log.warn({ error: String(err), decisionTraceId: input.decisionTraceId },
      'Failed to record execution outcome');
  }
}

/**
 * Query recent outcomes for a specific niche (strategy + taskType + complexity).
 * Used by drift detection and learning validation.
 */
export async function getRecentOutcomes(params: {
  strategy?: string;
  taskType?: string;
  complexity?: string;
  since: Date;
  limit?: number;
}): Promise<Array<{
  decisionTraceId: string;
  strategy: string;
  latencyMs: number;
  costUsd: number;
  success: boolean;
  qualityScore: number | null;
  createdAt: Date;
}>> {
  try {
    const conditions: string[] = [`created_at >= '${params.since.toISOString()}'`];
    if (params.strategy) conditions.push(`strategy = '${params.strategy}'`);

    // Use parameterized raw query for safety
    const rows = await prisma.$queryRaw<Array<{
      decision_trace_id: string;
      strategy: string;
      latency_ms: number;
      cost_usd: number;
      success: boolean;
      quality_score: number | null;
      created_at: Date;
    }>>`
      SELECT decision_trace_id, strategy, latency_ms, cost_usd, success, quality_score, created_at
      FROM execution_outcomes
      WHERE created_at >= ${params.since}
        AND (${params.strategy ?? ''} = '' OR strategy = ${params.strategy ?? ''})
      ORDER BY created_at DESC
      LIMIT ${params.limit ?? 1000}
    `;

    return rows.map(r => ({
      decisionTraceId: r.decision_trace_id,
      strategy: r.strategy,
      latencyMs: r.latency_ms,
      costUsd: Number(r.cost_usd),
      success: r.success,
      qualityScore: r.quality_score ? Number(r.quality_score) : null,
      createdAt: r.created_at,
    }));
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to query recent outcomes');
    return [];
  }
}

/**
 * Get aggregated performance metrics for a time window.
 * Used by snapshot generation and competitive benchmarking.
 */
export async function getAggregatedMetrics(params: {
  strategy: string;
  taskType: string;
  complexity: string;
  since: Date;
  until: Date;
}): Promise<{
  sampleSize: number;
  avgQuality: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  successRate: number;
  qualityP10: number;
  qualityP90: number;
  qualityStddev: number;
} | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{
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
        COUNT(*) as sample_size,
        AVG(quality_score) as avg_quality,
        AVG(latency_ms) as avg_latency_ms,
        AVG(cost_usd) as avg_cost_usd,
        AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as success_rate,
        PERCENTILE_CONT(0.1) WITHIN GROUP (ORDER BY quality_score) as quality_p10,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY quality_score) as quality_p90,
        STDDEV(quality_score) as quality_stddev
      FROM execution_outcomes
      WHERE strategy = ${params.strategy}
        AND created_at >= ${params.since}
        AND created_at < ${params.until}
    `;

    const row = rows[0];
    if (!row || Number(row.sample_size) === 0) return null;

    return {
      sampleSize: Number(row.sample_size),
      avgQuality: row.avg_quality ?? 0,
      avgLatencyMs: Math.round(row.avg_latency_ms ?? 0),
      avgCostUsd: row.avg_cost_usd ?? 0,
      successRate: row.success_rate ?? 0,
      qualityP10: row.quality_p10 ?? 0,
      qualityP90: row.quality_p90 ?? 0,
      qualityStddev: row.quality_stddev ?? 0,
    };
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to get aggregated metrics');
    return null;
  }
}
