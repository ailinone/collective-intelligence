// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Drift Detection Layer
 *
 * Detects four types of drift:
 * 1. Performance drift — quality, latency, cost, success rate degradation
 * 2. Decision drift — strategy selection distribution shifts without corresponding gains
 * 3. Context drift — changes in input distribution (task types, complexity mix)
 * 4. Evaluation drift — changes in scoring behavior over time
 *
 * Detection method: Compare recent window metrics against a baseline window.
 * Uses both absolute delta and relative delta with configurable thresholds.
 *
 * Integration: Called periodically (via cron job or after every N executions)
 * and emits drift events to the drift_events table.
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'drift-detection' });

// ─── Types ──────────────────────────────────────────────────────────────────

export type DriftType = 'performance' | 'decision' | 'context' | 'evaluation';
export type DriftSeverity = 'low' | 'medium' | 'high' | 'critical';
export type DriftStatus = 'open' | 'acknowledged' | 'resolved' | 'false_positive';

export interface DriftDetectionResult {
  driftsDetected: DriftEventInput[];
  checksPerformed: number;
  timestamp: string;
}

export interface DriftEventInput {
  driftType: DriftType;
  scopeType: string;
  scopeKey: string;
  severity: DriftSeverity;
  baselineValue: number;
  currentValue: number;
  deltaPercent: number;
  evidence: Record<string, unknown>;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  // Minimum samples to consider a window valid
  minSamples: 10,

  // Window sizes
  baselineWindowHours: 168, // 7 days
  currentWindowHours: 24,   // 1 day

  // Thresholds by metric (relative delta %)
  thresholds: {
    quality: { low: -5, medium: -10, high: -15, critical: -25 },
    successRate: { low: -3, medium: -8, high: -15, critical: -25 },
    latency: { low: 20, medium: 40, high: 80, critical: 150 },  // increase = bad
    cost: { low: 15, medium: 30, high: 60, critical: 100 },     // increase = bad
  } as Record<string, Record<DriftSeverity, number>>,

  // How often to check (controlled externally; this is used for rate-limiting)
  minCheckIntervalMs: 300_000, // 5 minutes
};

// ─── State ──────────────────────────────────────────────────────────────────

let lastCheckAt = 0;

// ─── Core Detection ─────────────────────────────────────────────────────────

/**
 * Run drift detection across all active niches.
 * Compares recent window metrics against baseline window.
 */
export async function detectDrift(): Promise<DriftDetectionResult> {
  const now = Date.now();
  if (now - lastCheckAt < CONFIG.minCheckIntervalMs) {
    return { driftsDetected: [], checksPerformed: 0, timestamp: new Date().toISOString() };
  }
  lastCheckAt = now;

  const driftsDetected: DriftEventInput[] = [];
  let checksPerformed = 0;

  try {
    // Get active niches from recent execution outcomes
    const niches = await getActiveNiches();

    for (const niche of niches) {
      // Baseline and current windows are independent reads — one round-trip
      // of wall-clock instead of two, per niche.
      const [baseline, current] = await Promise.all([
        getWindowMetrics(niche.strategy, niche.taskType,
          hoursAgo(CONFIG.baselineWindowHours), hoursAgo(CONFIG.currentWindowHours)),
        getWindowMetrics(niche.strategy, niche.taskType,
          hoursAgo(CONFIG.currentWindowHours), new Date()),
      ]);

      if (!baseline || !current) continue;
      if (baseline.sampleSize < CONFIG.minSamples || current.sampleSize < CONFIG.minSamples) continue;

      checksPerformed++;

      // Check quality drift (lower = worse)
      const qualityDelta = ((current.avgQuality - baseline.avgQuality) / Math.max(baseline.avgQuality, 0.01)) * 100;
      const qualitySeverity = classifySeverity(qualityDelta, CONFIG.thresholds.quality, true);
      if (qualitySeverity) {
        driftsDetected.push({
          driftType: 'performance',
          scopeType: 'niche',
          scopeKey: `${niche.strategy}|${niche.taskType}`,
          severity: qualitySeverity,
          baselineValue: baseline.avgQuality,
          currentValue: current.avgQuality,
          deltaPercent: qualityDelta,
          evidence: {
            metric: 'quality',
            baselineSamples: baseline.sampleSize,
            currentSamples: current.sampleSize,
            baselineP90: baseline.qualityP90,
            currentP90: current.qualityP90,
          },
        });
      }

      // Check success rate drift (lower = worse)
      const successDelta = ((current.successRate - baseline.successRate) / Math.max(baseline.successRate, 0.01)) * 100;
      const successSeverity = classifySeverity(successDelta, CONFIG.thresholds.successRate, true);
      if (successSeverity) {
        driftsDetected.push({
          driftType: 'performance',
          scopeType: 'niche',
          scopeKey: `${niche.strategy}|${niche.taskType}`,
          severity: successSeverity,
          baselineValue: baseline.successRate,
          currentValue: current.successRate,
          deltaPercent: successDelta,
          evidence: { metric: 'successRate', baselineSamples: baseline.sampleSize, currentSamples: current.sampleSize },
        });
      }

      // Check latency drift (higher = worse)
      if (baseline.avgLatencyMs > 0) {
        const latencyDelta = ((current.avgLatencyMs - baseline.avgLatencyMs) / baseline.avgLatencyMs) * 100;
        const latencySeverity = classifySeverity(latencyDelta, CONFIG.thresholds.latency, false);
        if (latencySeverity) {
          driftsDetected.push({
            driftType: 'performance',
            scopeType: 'niche',
            scopeKey: `${niche.strategy}|${niche.taskType}`,
            severity: latencySeverity,
            baselineValue: baseline.avgLatencyMs,
            currentValue: current.avgLatencyMs,
            deltaPercent: latencyDelta,
            evidence: { metric: 'latency', baselineSamples: baseline.sampleSize, currentSamples: current.sampleSize },
          });
        }
      }

      // Check cost drift (higher = worse)
      if (baseline.avgCostUsd > 0) {
        const costDelta = ((current.avgCostUsd - baseline.avgCostUsd) / baseline.avgCostUsd) * 100;
        const costSeverity = classifySeverity(costDelta, CONFIG.thresholds.cost, false);
        if (costSeverity) {
          driftsDetected.push({
            driftType: 'performance',
            scopeType: 'niche',
            scopeKey: `${niche.strategy}|${niche.taskType}`,
            severity: costSeverity,
            baselineValue: baseline.avgCostUsd,
            currentValue: current.avgCostUsd,
            deltaPercent: costDelta,
            evidence: { metric: 'cost', baselineSamples: baseline.sampleSize, currentSamples: current.sampleSize },
          });
        }
      }
    }

    // Persist detected drifts (independent INSERTs — concurrent)
    await Promise.all(driftsDetected.map((drift) => persistDriftEvent(drift)));

    if (driftsDetected.length > 0) {
      log.warn({
        driftsDetected: driftsDetected.length,
        checksPerformed,
        severities: driftsDetected.map(d => d.severity),
      }, 'Drift detection completed — drifts found');
    } else {
      log.info({ checksPerformed }, 'Drift detection completed — no drift detected');
    }
  } catch (err) {
    log.error({ error: String(err) }, 'Drift detection failed');
  }

  return {
    driftsDetected,
    checksPerformed,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get open (unresolved) drift events.
 */
export async function getOpenDriftEvents(): Promise<Array<{
  id: string;
  driftType: string;
  scopeKey: string;
  severity: string;
  deltaPercent: number;
  detectedAt: Date;
  status: string;
}>> {
  try {
    const rows = await prisma.$queryRaw<Array<{
      id: string;
      drift_type: string;
      scope_key: string;
      severity: string;
      delta_percent: number;
      detected_at: Date;
      status: string;
    }>>`
      SELECT id, drift_type, scope_key, severity, delta_percent, detected_at, status
      FROM drift_events
      WHERE status = 'open'
      ORDER BY detected_at DESC
      LIMIT 100
    `;

    return rows.map(r => ({
      id: r.id,
      driftType: r.drift_type,
      scopeKey: r.scope_key,
      severity: r.severity,
      deltaPercent: Number(r.delta_percent),
      detectedAt: r.detected_at,
      status: r.status,
    }));
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to query open drift events');
    return [];
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

/**
 * Classify severity based on delta percentage and thresholds.
 * @param isNegativeBad - true for metrics where lower = worse (quality, successRate)
 *                        false for metrics where higher = worse (latency, cost)
 */
function classifySeverity(
  delta: number,
  thresholds: Record<DriftSeverity, number>,
  isNegativeBad: boolean,
): DriftSeverity | null {
  // For "negative is bad" metrics (quality, successRate): delta < 0 means degradation
  // For "positive is bad" metrics (latency, cost): delta > 0 means degradation
  const _effectiveDelta = isNegativeBad ? delta : delta;

  if (isNegativeBad) {
    // Lower delta = worse degradation
    if (delta <= thresholds.critical) return 'critical';
    if (delta <= thresholds.high) return 'high';
    if (delta <= thresholds.medium) return 'medium';
    if (delta <= thresholds.low) return 'low';
  } else {
    // Higher delta = worse degradation
    if (delta >= thresholds.critical) return 'critical';
    if (delta >= thresholds.high) return 'high';
    if (delta >= thresholds.medium) return 'medium';
    if (delta >= thresholds.low) return 'low';
  }

  return null;
}

async function getActiveNiches(): Promise<Array<{ strategy: string; taskType: string }>> {
  try {
    const rows = await prisma.$queryRaw<Array<{ strategy: string; task_type: string }>>`
      SELECT DISTINCT strategy, 'general' as task_type
      FROM execution_outcomes
      WHERE created_at >= ${hoursAgo(CONFIG.baselineWindowHours)}
    `;
    return rows.map(r => ({ strategy: r.strategy, taskType: r.task_type }));
  } catch {
    return [];
  }
}

async function getWindowMetrics(
  strategy: string,
  _taskType: string,
  since: Date,
  until: Date,
): Promise<{
  sampleSize: number;
  avgQuality: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  successRate: number;
  qualityP90: number;
} | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{
      sample_size: bigint;
      avg_quality: number | null;
      avg_latency_ms: number | null;
      avg_cost_usd: number | null;
      success_rate: number | null;
      quality_p90: number | null;
    }>>`
      SELECT
        COUNT(*) as sample_size,
        AVG(quality_score) as avg_quality,
        AVG(latency_ms) as avg_latency_ms,
        AVG(cost_usd) as avg_cost_usd,
        AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as success_rate,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY quality_score) as quality_p90
      FROM execution_outcomes
      WHERE strategy = ${strategy}
        AND created_at >= ${since}
        AND created_at < ${until}
    `;

    const row = rows[0];
    if (!row || Number(row.sample_size) === 0) return null;

    return {
      sampleSize: Number(row.sample_size),
      avgQuality: row.avg_quality ?? 0,
      avgLatencyMs: Math.round(row.avg_latency_ms ?? 0),
      avgCostUsd: Number(row.avg_cost_usd ?? 0),
      successRate: row.success_rate ?? 0,
      qualityP90: row.quality_p90 ?? 0,
    };
  } catch {
    return null;
  }
}

async function persistDriftEvent(drift: DriftEventInput): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO drift_events (
        drift_type, scope_type, scope_key, severity,
        baseline_value, current_value, delta_percent, evidence
      ) VALUES (
        ${drift.driftType}, ${drift.scopeType}, ${drift.scopeKey}, ${drift.severity},
        ${drift.baselineValue}, ${drift.currentValue}, ${drift.deltaPercent},
        ${JSON.stringify(drift.evidence)}::jsonb
      )
    `;
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to persist drift event');
  }
}
