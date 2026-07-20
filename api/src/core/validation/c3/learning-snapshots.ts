// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Learning Snapshots — Class 3 Validation Infrastructure
 *
 * Provides longitudinal tracking of learning system state over time (P1.4).
 * Without this, there's no evidence that the system learns — only that it
 * updates internal state.
 *
 * Tracks:
 * - Bandit α/β per niche over time
 * - Configuration archive cell fitness over time
 * - Pareto frontier size and composition over time
 * - Knowledge graph edge weights over time
 * - Triage calibrator accuracy over time
 * - Scorer correlation (heuristic vs judge) over time
 *
 * STATUS (2026-06-11): STAGED, not wired into the live request path — by
 * design. Persists longitudinal snapshots to the DB (see prisma import) so a
 * C3 run can show the learning system actually improves across repetitions,
 * not just mutates state. It is NOT dead code: it is the longitudinal-evidence
 * mechanism for the gated C3 experiment. Guarded by c3-smoke-test.test.ts.
 * Wire `recordSnapshot`/`computeLearningTrend` into the experiment-runner's
 * post-run hook when the gated C3 experiment is executed.
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'learning-snapshots' });

// ─── Types ──────────────────────────────────────────────────────────────────

export type SnapshotMetricType =
  | 'bandit_params'
  | 'archive_fitness'
  | 'pareto_frontier'
  | 'knowledge_graph'
  | 'triage_accuracy'
  | 'scorer_correlation'
  | 'selection_regret'
  | 'cumulative_quality';

export interface LearningSnapshot {
  metricType: SnapshotMetricType;
  /** Niche key (e.g., "coding|high|debate") — null for global metrics */
  niche: string | null;
  /** Execution count at snapshot time */
  executionCount: number;
  /** The metric value (structured as JSON) */
  value: Record<string, unknown>;
  timestamp: Date;
}

// ─── Snapshot Writers ───────────────────────────────────────────────────────

/**
 * Record a bandit parameter snapshot.
 * Call after every N bandit updates (e.g., every 100).
 */
export async function snapshotBanditParams(
  niche: string,
  alpha: number,
  beta: number,
  executionCount: number
): Promise<void> {
  await writeSnapshot({
    metricType: 'bandit_params',
    niche,
    executionCount,
    value: {
      alpha,
      beta,
      meanWinRate: alpha / (alpha + beta),
      observations: Math.round(alpha + beta - 2),
    },
    timestamp: new Date(),
  });
}

/**
 * Record archive cell fitness snapshot.
 */
export async function snapshotArchiveFitness(
  niche: string,
  cellCount: number,
  avgFitness: number,
  bestFitness: number,
  executionCount: number
): Promise<void> {
  await writeSnapshot({
    metricType: 'archive_fitness',
    niche,
    executionCount,
    value: { cellCount, avgFitness, bestFitness },
    timestamp: new Date(),
  });
}

/**
 * Record Pareto frontier snapshot.
 */
export async function snapshotParetoFrontier(
  niche: string,
  frontierSize: number,
  avgQuality: number,
  avgCost: number,
  executionCount: number
): Promise<void> {
  await writeSnapshot({
    metricType: 'pareto_frontier',
    niche,
    executionCount,
    value: { frontierSize, avgQuality, avgCost },
    timestamp: new Date(),
  });
}

/**
 * Record knowledge graph snapshot.
 */
export async function snapshotKnowledgeGraph(
  edgeCount: number,
  avgWeight: number,
  topEdges: Array<{ from: string; to: string; weight: number }>,
  executionCount: number
): Promise<void> {
  await writeSnapshot({
    metricType: 'knowledge_graph',
    niche: null,
    executionCount,
    value: { edgeCount, avgWeight, topEdges: topEdges.slice(0, 10) },
    timestamp: new Date(),
  });
}

/**
 * Record triage accuracy snapshot.
 */
export async function snapshotTriageAccuracy(
  accuracy: number,
  totalPredictions: number,
  correctPredictions: number,
  executionCount: number
): Promise<void> {
  await writeSnapshot({
    metricType: 'triage_accuracy',
    niche: null,
    executionCount,
    value: { accuracy, totalPredictions, correctPredictions },
    timestamp: new Date(),
  });
}

/**
 * Record scorer correlation snapshot (heuristic vs judge).
 */
export async function snapshotScorerCorrelation(
  pearsonR: number,
  sampleCount: number,
  avgHeuristic: number,
  avgJudge: number,
  executionCount: number
): Promise<void> {
  await writeSnapshot({
    metricType: 'scorer_correlation',
    niche: null,
    executionCount,
    value: { pearsonR, sampleCount, avgHeuristic, avgJudge },
    timestamp: new Date(),
  });
}

/**
 * Record selection regret snapshot (bandit vs oracle or random).
 */
export async function snapshotSelectionRegret(
  niche: string,
  banditQuality: number,
  randomQuality: number,
  oracleQuality: number,
  cumulativeRegret: number,
  executionCount: number
): Promise<void> {
  await writeSnapshot({
    metricType: 'selection_regret',
    niche,
    executionCount,
    value: { banditQuality, randomQuality, oracleQuality, cumulativeRegret },
    timestamp: new Date(),
  });
}

// ─── Snapshot Reader ────────────────────────────────────────────────────────

/**
 * Query snapshots for a metric type and optional niche.
 * Returns snapshots ordered by execution count for time-series analysis.
 */
export async function getSnapshots(
  metricType: SnapshotMetricType,
  niche?: string,
  limit = 500
): Promise<LearningSnapshot[]> {
  try {
    const rows = await prisma.$queryRaw<Array<{
      metric_type: string;
      niche: string | null;
      execution_count: number;
      value: string;
      created_at: Date;
    }>>`
      SELECT metric_type, niche, execution_count, value, created_at
      FROM learning_snapshots
      WHERE metric_type = ${metricType}
      ${niche ? prisma.$queryRaw`AND niche = ${niche}` : prisma.$queryRaw`AND niche IS NULL`}
      ORDER BY execution_count ASC
      LIMIT ${limit}
    `;

    return rows.map(row => ({
      metricType: row.metric_type as SnapshotMetricType,
      niche: row.niche,
      executionCount: row.execution_count,
      // The DB column is JSONB; Postgres + node-postgres can deliver it
      // either parsed-already or as a string depending on the driver
      // path. Accept both and narrow to the snapshot shape.
      value: (typeof row.value === 'string'
        ? (JSON.parse(row.value) as Record<string, unknown>)
        : (row.value as Record<string, unknown>)),
      timestamp: row.created_at,
    }));
  } catch (err) {
    log.warn({ error: String(err), metricType, niche }, 'Failed to query learning snapshots');
    return [];
  }
}

/**
 * Compute learning trend from snapshots.
 * Returns slope of linear regression on the primary metric.
 */
export function computeLearningTrend(
  snapshots: LearningSnapshot[],
  valueKey: string
): { slope: number; rSquared: number; improving: boolean } {
  if (snapshots.length < 3) {
    return { slope: 0, rSquared: 0, improving: false };
  }

  const xs = snapshots.map(s => s.executionCount);
  const ys = snapshots.map(s => {
    const val = s.value[valueKey];
    return typeof val === 'number' ? val : 0;
  });

  // Simple linear regression
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumX2 = xs.reduce((acc, x) => acc + x * x, 0);
  const _sumY2 = ys.reduce((acc, y) => acc + y * y, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, rSquared: 0, improving: false };

  const slope = (n * sumXY - sumX * sumY) / denom;

  // R² (coefficient of determination)
  const ssRes = ys.reduce((acc, y, i) => {
    const predicted = (sumY / n) + slope * (xs[i] - sumX / n);
    return acc + (y - predicted) ** 2;
  }, 0);
  const ssTot = ys.reduce((acc, y) => acc + (y - sumY / n) ** 2, 0);
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { slope, rSquared, improving: slope > 0 };
}

// ─── Internal ───────────────────────────────────────────────────────────────

async function writeSnapshot(snapshot: LearningSnapshot): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO learning_snapshots (metric_type, niche, execution_count, value, created_at)
      VALUES (
        ${snapshot.metricType},
        ${snapshot.niche},
        ${snapshot.executionCount},
        ${JSON.stringify(snapshot.value)}::jsonb,
        ${snapshot.timestamp}
      )
    `;
  } catch (err) {
    log.warn({ error: String(err), metricType: snapshot.metricType }, 'Failed to write learning snapshot');
  }
}
