// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Learning Validation Layer
 *
 * Proves the system is actually learning by comparing performance across
 * time windows. Answers: "are decisions getting better over time?"
 *
 * Validation criteria:
 * 1. Improvement must be measurable (baseline vs comparison window)
 * 2. Improvement must be statistically meaningful (beyond noise)
 * 3. No critical regressions in other dimensions
 * 4. Stability must be maintained (not oscillating)
 *
 * Verdicts:
 * - "improving" — statistically significant improvement, no regressions
 * - "stable" — no significant change (acceptable state)
 * - "degrading" — statistically significant degradation
 * - "inconclusive" — insufficient data or contradictory signals
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'learning-validation' });

// ─── Types ──────────────────────────────────────────────────────────────────

export type LearningVerdict = 'improving' | 'stable' | 'degrading' | 'inconclusive';

export interface LearningValidationResult {
  scopeType: string;
  scopeKey: string;
  baselineWindow: string;
  comparisonWindow: string;
  baselineMetrics: WindowMetrics;
  comparisonMetrics: WindowMetrics;
  improvementDelta: Record<string, number>;
  regressions: Array<{ metric: string; delta: number; severity: string }>;
  learningVelocity: number;
  stabilityIndex: number;
  validated: boolean;
  verdict: LearningVerdict;
}

export interface WindowMetrics {
  sampleSize: number;
  avgQuality: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  successRate: number;
  qualityStddev: number;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  minSamplesPerWindow: 10,
  // Minimum improvement to count as "improving" (5% relative)
  significanceThreshold: 0.05,
  // Regression threshold — if any metric degrades beyond this, flag it
  regressionThreshold: -0.10,
  // Stability: if stddev of quality scores is below this, system is stable
  stabilityThreshold: 0.15,
};

// ─── Core Validation ────────────────────────────────────────────────────────

/**
 * Validate learning by comparing two time windows.
 * Returns a verdict on whether the system is actually improving.
 */
export async function validateLearning(params: {
  scopeType: string;
  scopeKey: string;
  baselineStart: Date;
  baselineEnd: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
}): Promise<LearningValidationResult> {
  const baselineWindow = params.baselineStart.toISOString().slice(0, 10);
  const comparisonWindow = params.comparisonStart.toISOString().slice(0, 10);

  const baseline = await getWindowMetrics(params.scopeKey, params.baselineStart, params.baselineEnd);
  const comparison = await getWindowMetrics(params.scopeKey, params.comparisonStart, params.comparisonEnd);

  // Insufficient data
  if (!baseline || !comparison ||
      baseline.sampleSize < CONFIG.minSamplesPerWindow ||
      comparison.sampleSize < CONFIG.minSamplesPerWindow) {
    const result: LearningValidationResult = {
      scopeType: params.scopeType,
      scopeKey: params.scopeKey,
      baselineWindow,
      comparisonWindow,
      baselineMetrics: baseline ?? emptyMetrics(),
      comparisonMetrics: comparison ?? emptyMetrics(),
      improvementDelta: {},
      regressions: [],
      learningVelocity: 0,
      stabilityIndex: 0,
      validated: false,
      verdict: 'inconclusive',
    };
    return result;
  }

  // Calculate deltas (positive = improvement for quality/successRate; negative = improvement for latency/cost)
  const qualityDelta = comparison.avgQuality - baseline.avgQuality;
  const successDelta = comparison.successRate - baseline.successRate;
  const latencyDelta = baseline.avgLatencyMs > 0
    ? (baseline.avgLatencyMs - comparison.avgLatencyMs) / baseline.avgLatencyMs
    : 0; // positive = faster = better
  const costDelta = baseline.avgCostUsd > 0
    ? (baseline.avgCostUsd - comparison.avgCostUsd) / baseline.avgCostUsd
    : 0; // positive = cheaper = better

  const improvementDelta: Record<string, number> = {
    quality: qualityDelta,
    successRate: successDelta,
    latencyImprovement: latencyDelta,
    costImprovement: costDelta,
  };

  // Detect regressions
  const regressions: Array<{ metric: string; delta: number; severity: string }> = [];

  if (qualityDelta < CONFIG.regressionThreshold) {
    regressions.push({
      metric: 'quality',
      delta: qualityDelta,
      severity: qualityDelta < -0.20 ? 'critical' : 'warning',
    });
  }
  if (successDelta < CONFIG.regressionThreshold) {
    regressions.push({
      metric: 'successRate',
      delta: successDelta,
      severity: successDelta < -0.20 ? 'critical' : 'warning',
    });
  }
  if (latencyDelta < CONFIG.regressionThreshold) {
    regressions.push({
      metric: 'latency',
      delta: latencyDelta,
      severity: latencyDelta < -0.30 ? 'critical' : 'warning',
    });
  }

  // Calculate learning velocity (quality improvement per unit of time)
  const windowDurationDays = (params.comparisonEnd.getTime() - params.comparisonStart.getTime()) / 86_400_000;
  const learningVelocity = windowDurationDays > 0 ? qualityDelta / windowDurationDays : 0;

  // Stability index: 1 - normalized stddev (higher = more stable)
  const stabilityIndex = comparison.qualityStddev > 0
    ? Math.max(0, 1 - comparison.qualityStddev / CONFIG.stabilityThreshold)
    : 1.0;

  // Determine verdict
  let verdict: LearningVerdict;
  const hasCriticalRegression = regressions.some(r => r.severity === 'critical');

  if (hasCriticalRegression) {
    verdict = 'degrading';
  } else if (qualityDelta >= CONFIG.significanceThreshold && regressions.length === 0) {
    verdict = 'improving';
  } else if (Math.abs(qualityDelta) < CONFIG.significanceThreshold && regressions.length === 0) {
    verdict = 'stable';
  } else if (qualityDelta < -CONFIG.significanceThreshold) {
    verdict = 'degrading';
  } else {
    verdict = 'inconclusive';
  }

  const validated = verdict === 'improving' && regressions.length === 0 && stabilityIndex > 0.5;

  const result: LearningValidationResult = {
    scopeType: params.scopeType,
    scopeKey: params.scopeKey,
    baselineWindow,
    comparisonWindow,
    baselineMetrics: baseline,
    comparisonMetrics: comparison,
    improvementDelta,
    regressions,
    learningVelocity,
    stabilityIndex,
    validated,
    verdict,
  };

  // Persist the report
  await persistReport(result);

  log.info({
    scope: params.scopeKey,
    verdict,
    qualityDelta: qualityDelta.toFixed(4),
    learningVelocity: learningVelocity.toFixed(6),
    stabilityIndex: stabilityIndex.toFixed(3),
    regressions: regressions.length,
  }, 'Learning validation completed');

  return result;
}

/**
 * Run validation for all active strategies.
 * Compares the last 7 days (baseline) vs the last 24 hours (comparison).
 */
export async function validateAllStrategies(): Promise<LearningValidationResult[]> {
  const results: LearningValidationResult[] = [];

  try {
    const strategies = await prisma.$queryRaw<Array<{ strategy: string }>>`
      SELECT DISTINCT strategy FROM execution_outcomes
      WHERE created_at >= ${new Date(Date.now() - 7 * 86_400_000)}
    `;

    // Each strategy's validation is independent (2 read aggregates + 1 report
    // INSERT, no cross-strategy state). Serially this was ~3 DB round-trips ×
    // ~17 strategies ≈ 51 sequential queries per admin call; concurrent, the
    // wall-clock cost is one strategy's worth.
    const validated = await Promise.all(
      strategies.map(({ strategy }) =>
        validateLearning({
          scopeType: 'strategy',
          scopeKey: strategy,
          baselineStart: new Date(Date.now() - 7 * 86_400_000),
          baselineEnd: new Date(Date.now() - 1 * 86_400_000),
          comparisonStart: new Date(Date.now() - 1 * 86_400_000),
          comparisonEnd: new Date(),
        })
      )
    );
    results.push(...validated);
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to validate all strategies');
  }

  return results;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function emptyMetrics(): WindowMetrics {
  return { sampleSize: 0, avgQuality: 0, avgLatencyMs: 0, avgCostUsd: 0, successRate: 0, qualityStddev: 0 };
}

async function getWindowMetrics(
  scopeKey: string,
  since: Date,
  until: Date,
): Promise<WindowMetrics | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{
      sample_size: bigint;
      avg_quality: number | null;
      avg_latency_ms: number | null;
      avg_cost_usd: number | null;
      success_rate: number | null;
      quality_stddev: number | null;
    }>>`
      SELECT
        COUNT(*) as sample_size,
        AVG(quality_score) as avg_quality,
        AVG(latency_ms) as avg_latency_ms,
        AVG(cost_usd) as avg_cost_usd,
        AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as success_rate,
        STDDEV(quality_score) as quality_stddev
      FROM execution_outcomes
      WHERE created_at >= ${since}
        AND created_at < ${until}
        AND (${scopeKey} = 'global' OR strategy = ${scopeKey})
    `;

    const row = rows[0];
    if (!row || Number(row.sample_size) === 0) return null;

    return {
      sampleSize: Number(row.sample_size),
      avgQuality: row.avg_quality ?? 0,
      avgLatencyMs: Math.round(row.avg_latency_ms ?? 0),
      avgCostUsd: Number(row.avg_cost_usd ?? 0),
      successRate: row.success_rate ?? 0,
      qualityStddev: row.quality_stddev ?? 0,
    };
  } catch {
    return null;
  }
}

async function persistReport(result: LearningValidationResult): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO learning_validation_reports (
        scope_type, scope_key, baseline_window, comparison_window,
        baseline_metrics, comparison_metrics, improvement_delta,
        regressions, learning_velocity, stability_index,
        validated, verdict
      ) VALUES (
        ${result.scopeType}, ${result.scopeKey},
        ${result.baselineWindow}, ${result.comparisonWindow},
        ${JSON.stringify(result.baselineMetrics)}::jsonb,
        ${JSON.stringify(result.comparisonMetrics)}::jsonb,
        ${JSON.stringify(result.improvementDelta)}::jsonb,
        ${JSON.stringify(result.regressions)}::jsonb,
        ${result.learningVelocity},
        ${result.stabilityIndex},
        ${result.validated},
        ${result.verdict}
      )
    `;
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to persist learning validation report');
  }
}
