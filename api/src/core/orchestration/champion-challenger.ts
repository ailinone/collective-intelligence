// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Champion / Challenger Framework
 *
 * Compares current production strategy weights (champion) against new benchmark
 * results (challenger). Promotes only when the challenger beats the champion by
 * a configurable margin across quality-adjusted success rate.
 *
 * Integration: Called from continuous-benchmark-job after benchmark run completes.
 * Instead of directly upserting weights, the job should call evaluateChallenger()
 * first and only promote if approved.
 */
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { ciMetrics } from '@/observability/ci-metrics';

const log = logger.child({ component: 'champion-challenger' });

const CONFIG = {
  /** Minimum quality-adjusted improvement (percentage points) to promote */
  promotionThreshold: parseFloat(process.env.CC_PROMOTION_THRESHOLD || '0.03'),
  /** Maximum quality degradation before rejecting entire challenger set */
  degradationLimit: parseFloat(process.env.CC_DEGRADATION_LIMIT || '0.05'),
  /** Minimum sample count before a champion can be challenged */
  minChampionSamples: parseInt(process.env.CC_MIN_CHAMPION_SAMPLES || '10', 10),
  /** Minimum sample count for challenger data to be considered */
  minChallengerSamples: parseInt(process.env.CC_MIN_CHALLENGER_SAMPLES || '3', 10),
};

export interface BenchmarkResult {
  taskType: string;
  complexity: string;
  strategy: string;
  qualityScore: number;
  success: boolean;
  durationMs: number;
  costUsd?: number;
}

interface StrategyWeightRow {
  taskType: string;
  complexity: string;
  strategy: string;
  avgQuality: number;
  successRate: number;
  weight: number;
  sampleCount: number;
}

export interface PromotionEntry {
  taskType: string;
  complexity: string;
  strategy: string;
  championQuality: number;
  challengerQuality: number;
  delta: number;
}

export interface RejectionEntry {
  taskType: string;
  complexity: string;
  strategy: string;
  reason: string;
  championQuality: number;
  challengerQuality: number;
  delta: number;
}

export interface ChampionChallengerResult {
  promoted: PromotionEntry[];
  rejected: RejectionEntry[];
  unchanged: number;
  overallVerdict: 'promoted' | 'rejected' | 'no-change';
  timestamp: string;
}

/**
 * Aggregates benchmark results into per-(taskType, complexity, strategy) metrics.
 */
function aggregateChallengerResults(results: BenchmarkResult[]): Map<string, { avgQuality: number; successRate: number; sampleCount: number }> {
  const buckets = new Map<string, { totalQuality: number; successCount: number; count: number }>();

  for (const r of results) {
    const key = `${r.taskType}|${r.complexity}|${r.strategy}`;
    const bucket = buckets.get(key) ?? { totalQuality: 0, successCount: 0, count: 0 };
    bucket.totalQuality += r.qualityScore;
    bucket.successCount += r.success ? 1 : 0;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  const aggregated = new Map<string, { avgQuality: number; successRate: number; sampleCount: number }>();
  for (const [key, bucket] of buckets) {
    aggregated.set(key, {
      avgQuality: bucket.count > 0 ? bucket.totalQuality / bucket.count : 0,
      successRate: bucket.count > 0 ? bucket.successCount / bucket.count : 0,
      sampleCount: bucket.count,
    });
  }

  return aggregated;
}

/**
 * Loads current champion weights from the database.
 */
async function loadChampionWeights(): Promise<Map<string, StrategyWeightRow>> {
  const rows = await prisma.strategyWeight.findMany();
  const map = new Map<string, StrategyWeightRow>();
  for (const row of rows) {
    const key = `${row.taskType}|${row.complexity}|${row.strategy}`;
    map.set(key, {
      taskType: row.taskType,
      complexity: row.complexity,
      strategy: row.strategy,
      avgQuality: Number(row.avgQuality),
      successRate: Number(row.successRate),
      weight: Number(row.weight),
      sampleCount: row.sampleCount,
    });
  }
  return map;
}

/**
 * Evaluates whether challenger results warrant promotion over the current champion.
 *
 * Rules:
 * 1. For each (taskType, complexity, strategy) triple:
 *    - If challenger avgQuality beats champion by >= promotionThreshold → promote
 *    - If challenger avgQuality degrades by > degradationLimit → reject ALL
 *    - Otherwise → unchanged
 * 2. If ANY single strategy degrades beyond the limit, the entire challenger set is rejected.
 * 3. Champion must have minChampionSamples for comparison; otherwise treated as new entry.
 */
export async function evaluateChallenger(
  challengerResults: BenchmarkResult[],
): Promise<ChampionChallengerResult> {
  const timestamp = new Date().toISOString();
  const championMap = await loadChampionWeights();
  const challengerMap = aggregateChallengerResults(challengerResults);

  const promoted: PromotionEntry[] = [];
  const rejected: RejectionEntry[] = [];
  let unchanged = 0;
  let hasCriticalDegradation = false;

  for (const [key, challenger] of challengerMap) {
    if (challenger.sampleCount < CONFIG.minChallengerSamples) {
      unchanged++;
      continue;
    }

    const champion = championMap.get(key);

    // No existing champion — this is a new entry, auto-promote
    if (!champion || champion.sampleCount < CONFIG.minChampionSamples) {
      const [taskType, complexity, strategy] = key.split('|');
      promoted.push({
        taskType, complexity, strategy,
        championQuality: champion?.avgQuality ?? 0,
        challengerQuality: challenger.avgQuality,
        delta: challenger.avgQuality - (champion?.avgQuality ?? 0),
      });
      continue;
    }

    const delta = challenger.avgQuality - champion.avgQuality;
    const [taskType, complexity, strategy] = key.split('|');

    // Check for critical degradation
    if (delta < -CONFIG.degradationLimit) {
      hasCriticalDegradation = true;
      rejected.push({
        taskType, complexity, strategy,
        reason: `Degradation ${(delta * 100).toFixed(2)}pp exceeds limit ${(CONFIG.degradationLimit * 100).toFixed(1)}pp`,
        championQuality: champion.avgQuality,
        challengerQuality: challenger.avgQuality,
        delta,
      });
      continue;
    }

    // Check for promotion
    if (delta >= CONFIG.promotionThreshold) {
      promoted.push({
        taskType, complexity, strategy,
        championQuality: champion.avgQuality,
        challengerQuality: challenger.avgQuality,
        delta,
      });
    } else {
      unchanged++;
    }
  }

  // If any critical degradation, reject everything
  let overallVerdict: 'promoted' | 'rejected' | 'no-change';
  if (hasCriticalDegradation) {
    overallVerdict = 'rejected';
    // Move all promoted entries to rejected
    for (const p of promoted) {
      rejected.push({
        ...p,
        reason: `Blocked: other strategy(ies) showed critical degradation`,
      });
    }
    promoted.length = 0;
  } else if (promoted.length > 0) {
    overallVerdict = 'promoted';
  } else {
    overallVerdict = 'no-change';
  }

  const result: ChampionChallengerResult = { promoted, rejected, unchanged, overallVerdict, timestamp };

  // Log and emit metrics
  log.info({ overallVerdict, promoted: promoted.length, rejected: rejected.length, unchanged }, 'Champion/Challenger evaluation complete');

  for (const p of promoted) {
    log.info({ ...p }, 'Strategy promoted');
    ciMetrics.championChallengerPromotions?.inc({ task_type: p.taskType, complexity: p.complexity, strategy: p.strategy });
    ciMetrics.championChallengerQualityDelta?.observe({ task_type: p.taskType, strategy: p.strategy }, p.delta);
  }

  for (const r of rejected) {
    log.warn({ ...r }, 'Strategy rejected');
    ciMetrics.championChallengerRejections?.inc({ task_type: r.taskType, complexity: r.complexity, strategy: r.strategy, reason: 'degradation' });
  }

  return result;
}

/**
 * Applies promotion: upserts promoted challenger weights into the database.
 * Only call this when evaluateChallenger returns overallVerdict === 'promoted'.
 */
export async function promoteChallenger(
  evaluation: ChampionChallengerResult,
  challengerResults: BenchmarkResult[],
): Promise<void> {
  if (evaluation.overallVerdict !== 'promoted') {
    log.warn('promoteChallenger called but verdict is not "promoted" — skipping');
    return;
  }

  const challengerMap = aggregateChallengerResults(challengerResults);
  const promotedKeys = new Set(evaluation.promoted.map(p => `${p.taskType}|${p.complexity}|${p.strategy}`));

  for (const [key, challenger] of challengerMap) {
    if (!promotedKeys.has(key)) continue;

    const [taskType, complexity, strategy] = key.split('|');
    const weight = 1.0 + challenger.avgQuality * 0.5;

    await prisma.strategyWeight.upsert({
      where: { taskType_complexity_strategy: { taskType, complexity, strategy } },
      update: {
        avgQuality: challenger.avgQuality,
        successRate: challenger.successRate,
        weight,
        sampleCount: { increment: challenger.sampleCount },
      },
      create: {
        taskType,
        complexity,
        strategy,
        avgQuality: challenger.avgQuality,
        successRate: challenger.successRate,
        weight,
        sampleCount: challenger.sampleCount,
        avgCostEfficiency: 0.70,
      },
    });

    log.info({ taskType, complexity, strategy, quality: challenger.avgQuality, weight }, 'Strategy weight promoted');
  }
}
