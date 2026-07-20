// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pareto-Optimal Champion/Challenger (OI-09)
 *
 * Extends the binary champion/challenger framework with multi-objective
 * Pareto frontier tracking. Instead of promote/reject based solely on quality,
 * maintains a ranked set of non-dominated strategies per (taskType, complexity) niche.
 *
 * Background:
 * - Binary comparison loses information: a strategy that's 2% worse on quality
 *   but 50% cheaper might be valuable for cost-conscious users
 * - Pareto dominance: strategy S1 dominates S2 iff S1 is better in at least
 *   one objective and no worse in all others
 * - The Pareto frontier = set of all non-dominated strategies = the "efficient frontier"
 * - This enables: (1) strategy selection by user preference along the frontier,
 *   (2) detection of truly dominated strategies for removal, (3) richer archive
 *   seeding from benchmark results
 *
 * Integration:
 * - Called from benchmark-evaluator after a benchmark run completes
 * - Feeds into configuration-archive (OI-06) to seed Pareto-optimal elites
 * - Admin endpoint exposes the current frontier for inspection
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import type { BenchmarkResult } from '@/core/orchestration/champion-challenger';

const log = logger.child({ component: 'pareto-champion-challenger' });

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Multi-objective metrics for a strategy.
 * All are "higher is better" (cost is inverted).
 */
export interface ParetoObjectives {
  quality: number;        // avg quality score (0-1)
  costEfficiency: number; // 1 / avgCostUsd (higher = cheaper)
  speed: number;          // 1 / avgLatencyMs (higher = faster)
  successRate: number;    // proportion of successful executions (0-1)
}

/**
 * A candidate strategy with its objectives and metadata.
 */
export interface ParetoCandidate {
  taskType: string;
  complexity: string;
  strategy: string;
  objectives: ParetoObjectives;
  sampleCount: number;
  rawMetrics: {
    avgQuality: number;
    avgCostUsd: number;
    avgLatencyMs: number;
    successRate: number;
  };
}

/**
 * A Pareto frontier for a specific (taskType, complexity) niche.
 */
export interface ParetoFrontier {
  taskType: string;
  complexity: string;
  nonDominated: ParetoCandidate[];       // Strategies on the frontier
  dominated: ParetoCandidate[];          // Strategies below the frontier
  frontierSize: number;
  totalCandidates: number;
  computedAt: string;
}

/**
 * Full evaluation result across all niches.
 */
export interface ParetoEvaluationResult {
  frontiers: ParetoFrontier[];
  totalNiches: number;
  avgFrontierSize: number;
  newFrontierEntries: number;            // Strategies that entered the frontier
  droppedFromFrontier: number;           // Strategies that fell off the frontier
  timestamp: string;
}

/**
 * Snapshot of all frontiers for admin inspection.
 */
export interface ParetoSnapshot {
  frontiers: ParetoFrontier[];
  totalNonDominated: number;
  totalDominated: number;
  nicheCount: number;
  lastEvaluatedAt: string | null;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  /** Minimum samples before a strategy can be considered */
  minSamples: 3,
  /** Epsilon for dominance comparison — avoids noise-driven frontier changes */
  dominanceEpsilon: 0.005,
  /** Maximum frontier entries retained per niche (prevents explosion) */
  maxFrontierPerNiche: 10,
  /** How many historical frontiers to keep */
  maxHistorySize: 20,
};

// ─── State ──────────────────────────────────────────────────────────────────

/** Current Pareto frontiers per niche */
const currentFrontiers = new Map<string, ParetoFrontier>();
/** History of frontier evaluations */
const evaluationHistory: ParetoEvaluationResult[] = [];
/** Timestamp of last evaluation */
let lastEvaluatedAt: string | null = null;

function nicheKey(taskType: string, complexity: string): string {
  return `${taskType}|${complexity}`;
}

// ─── Core Algorithm ─────────────────────────────────────────────────────────

/**
 * Check if candidate A dominates candidate B (with epsilon tolerance).
 *
 * A dominates B iff:
 *   ∀ objective: A[obj] >= B[obj] - epsilon
 *   ∃ objective: A[obj] > B[obj] + epsilon
 */
function dominates(a: ParetoObjectives, b: ParetoObjectives): boolean {
  const eps = CONFIG.dominanceEpsilon;
  const objectives: (keyof ParetoObjectives)[] = ['quality', 'costEfficiency', 'speed', 'successRate'];

  let allAtLeastAsGood = true;
  let strictlyBetterInOne = false;

  for (const obj of objectives) {
    if (a[obj] < b[obj] - eps) {
      allAtLeastAsGood = false;
      break;
    }
    if (a[obj] > b[obj] + eps) {
      strictlyBetterInOne = true;
    }
  }

  return allAtLeastAsGood && strictlyBetterInOne;
}

/**
 * Compute the Pareto frontier from a set of candidates.
 * Returns { nonDominated, dominated }.
 */
function computeFrontier(candidates: ParetoCandidate[]): {
  nonDominated: ParetoCandidate[];
  dominated: ParetoCandidate[];
} {
  const nonDominated: ParetoCandidate[] = [];
  const dominated: ParetoCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    let isDominated = false;
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      if (dominates(candidates[j].objectives, candidates[i].objectives)) {
        isDominated = true;
        break;
      }
    }
    if (isDominated) {
      dominated.push(candidates[i]);
    } else {
      nonDominated.push(candidates[i]);
    }
  }

  // If frontier exceeds max size, keep the ones with highest combined score
  if (nonDominated.length > CONFIG.maxFrontierPerNiche) {
    nonDominated.sort((a, b) => {
      const scoreA = a.objectives.quality + a.objectives.costEfficiency * 0.3 +
        a.objectives.speed * 0.2 + a.objectives.successRate * 0.5;
      const scoreB = b.objectives.quality + b.objectives.costEfficiency * 0.3 +
        b.objectives.speed * 0.2 + b.objectives.successRate * 0.5;
      return scoreB - scoreA;
    });
    const evicted = nonDominated.splice(CONFIG.maxFrontierPerNiche);
    dominated.push(...evicted);
  }

  return { nonDominated, dominated };
}

/**
 * Convert raw benchmark results to Pareto objectives.
 */
function resultsToCandidates(results: BenchmarkResult[]): ParetoCandidate[] {
  // Aggregate by (taskType, complexity, strategy)
  const buckets = new Map<string, {
    taskType: string;
    complexity: string;
    strategy: string;
    totalQuality: number;
    totalCost: number;
    totalLatency: number;
    successCount: number;
    count: number;
  }>();

  for (const r of results) {
    const key = `${r.taskType}|${r.complexity}|${r.strategy}`;
    const b = buckets.get(key) ?? {
      taskType: r.taskType,
      complexity: r.complexity,
      strategy: r.strategy,
      totalQuality: 0,
      totalCost: 0,
      totalLatency: 0,
      successCount: 0,
      count: 0,
    };
    b.totalQuality += r.qualityScore;
    b.totalCost += r.costUsd ?? 0;
    b.totalLatency += r.durationMs;
    b.successCount += r.success ? 1 : 0;
    b.count += 1;
    buckets.set(key, b);
  }

  const candidates: ParetoCandidate[] = [];
  for (const b of buckets.values()) {
    if (b.count < CONFIG.minSamples) continue;

    const avgQuality = b.totalQuality / b.count;
    const avgCostUsd = b.totalCost / b.count;
    const avgLatencyMs = b.totalLatency / b.count;
    const successRate = b.successCount / b.count;

    // Normalize speed to [0, 1] range using 30s as max reference latency.
    // Raw 1/ms produces ~0.0005 values that are invisible next to quality (0.6-0.95),
    // making speed irrelevant in dominance comparisons. This normalization
    // ensures speed has comparable magnitude to other objectives.
    const normalizedSpeed = 1 - Math.min(avgLatencyMs / 30_000, 1);

    // Normalize cost efficiency to [0, 1] range using $0.10 as max reference cost.
    const normalizedCostEfficiency = 1 - Math.min(avgCostUsd / 0.10, 1);

    candidates.push({
      taskType: b.taskType,
      complexity: b.complexity,
      strategy: b.strategy,
      objectives: {
        quality: avgQuality,
        costEfficiency: normalizedCostEfficiency,
        speed: normalizedSpeed,
        successRate,
      },
      sampleCount: b.count,
      rawMetrics: { avgQuality, avgCostUsd, avgLatencyMs, successRate },
    });
  }

  return candidates;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Evaluate benchmark results through multi-objective Pareto analysis.
 *
 * For each (taskType, complexity) niche:
 * 1. Aggregate results into per-strategy objectives
 * 2. Compute the Pareto frontier (non-dominated set)
 * 3. Compare with previous frontier to detect frontier changes
 * 4. Update stored frontiers
 *
 * Returns a summary of all frontier changes.
 */
export function evaluatePareto(benchmarkResults: BenchmarkResult[]): ParetoEvaluationResult {
  const timestamp = new Date().toISOString();
  const candidates = resultsToCandidates(benchmarkResults);

  // Group candidates by niche
  const nicheGroups = new Map<string, ParetoCandidate[]>();
  for (const c of candidates) {
    const key = nicheKey(c.taskType, c.complexity);
    const group = nicheGroups.get(key) ?? [];
    group.push(c);
    nicheGroups.set(key, group);
  }

  const frontiers: ParetoFrontier[] = [];
  let newFrontierEntries = 0;
  let droppedFromFrontier = 0;

  for (const [key, group] of nicheGroups) {
    const { nonDominated, dominated } = computeFrontier(group);
    const [taskType, complexity] = key.split('|');

    const frontier: ParetoFrontier = {
      taskType,
      complexity,
      nonDominated,
      dominated,
      frontierSize: nonDominated.length,
      totalCandidates: group.length,
      computedAt: timestamp,
    };

    // Compare with previous frontier
    const previous = currentFrontiers.get(key);
    if (previous) {
      const prevStrategies = new Set(previous.nonDominated.map(c => c.strategy));
      const newStrategies = new Set(nonDominated.map(c => c.strategy));

      for (const s of newStrategies) {
        if (!prevStrategies.has(s)) newFrontierEntries++;
      }
      for (const s of prevStrategies) {
        if (!newStrategies.has(s)) droppedFromFrontier++;
      }
    } else {
      newFrontierEntries += nonDominated.length;
    }

    currentFrontiers.set(key, frontier);
    frontiers.push(frontier);
  }

  const result: ParetoEvaluationResult = {
    frontiers,
    totalNiches: frontiers.length,
    avgFrontierSize: frontiers.length > 0
      ? frontiers.reduce((s, f) => s + f.frontierSize, 0) / frontiers.length
      : 0,
    newFrontierEntries,
    droppedFromFrontier,
    timestamp,
  };

  // Store in history
  evaluationHistory.push(result);
  if (evaluationHistory.length > CONFIG.maxHistorySize) {
    evaluationHistory.shift();
  }
  lastEvaluatedAt = timestamp;

  log.info({
    niches: result.totalNiches,
    avgFrontierSize: result.avgFrontierSize.toFixed(1),
    newEntries: newFrontierEntries,
    dropped: droppedFromFrontier,
  }, 'Pareto evaluation completed (OI-09)');

  return result;
}

/**
 * Get the best strategy from the Pareto frontier for a given niche and preference.
 *
 * @param preference - Which objective to prioritize when selecting from the frontier
 */
export function getBestFromFrontier(
  taskType: string,
  complexity: string,
  preference: 'quality' | 'cost' | 'speed' | 'balanced',
): ParetoCandidate | null {
  const frontier = currentFrontiers.get(nicheKey(taskType, complexity));
  if (!frontier || frontier.nonDominated.length === 0) return null;

  const candidates = frontier.nonDominated;

  // Score each candidate based on user preference
  const scored = candidates.map(c => {
    let score: number;
    switch (preference) {
      case 'quality':
        score = c.objectives.quality * 0.7 + c.objectives.successRate * 0.3;
        break;
      case 'cost':
        score = c.objectives.costEfficiency * 0.5 + c.objectives.quality * 0.3 + c.objectives.successRate * 0.2;
        break;
      case 'speed':
        score = c.objectives.speed * 0.5 + c.objectives.quality * 0.3 + c.objectives.successRate * 0.2;
        break;
      case 'balanced':
      default:
        score = c.objectives.quality * 0.35 + c.objectives.costEfficiency * 0.2 +
          c.objectives.speed * 0.15 + c.objectives.successRate * 0.3;
        break;
    }
    return { candidate: c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].candidate;
}

/**
 * Get the full Pareto frontier for a niche.
 */
export function getFrontier(taskType: string, complexity: string): ParetoFrontier | null {
  return currentFrontiers.get(nicheKey(taskType, complexity)) ?? null;
}

/**
 * Get a snapshot of all current Pareto frontiers (for admin endpoint).
 */
export function getParetoSnapshot(): ParetoSnapshot {
  const frontiers: ParetoFrontier[] = [];
  let totalNonDominated = 0;
  let totalDominated = 0;

  for (const frontier of currentFrontiers.values()) {
    frontiers.push(frontier);
    totalNonDominated += frontier.nonDominated.length;
    totalDominated += frontier.dominated.length;
  }

  return {
    frontiers: frontiers.sort((a, b) =>
      `${a.taskType}|${a.complexity}`.localeCompare(`${b.taskType}|${b.complexity}`)
    ),
    totalNonDominated,
    totalDominated,
    nicheCount: frontiers.length,
    lastEvaluatedAt,
  };
}

/**
 * Get evaluation history (for admin trend analysis).
 */
export function getParetoHistory(): ParetoEvaluationResult[] {
  return [...evaluationHistory];
}

/**
 * Check if a strategy is on the Pareto frontier for a given niche.
 */
export function isOnFrontier(taskType: string, complexity: string, strategy: string): boolean {
  const frontier = currentFrontiers.get(nicheKey(taskType, complexity));
  if (!frontier) return false;
  return frontier.nonDominated.some(c => c.strategy === strategy);
}

/**
 * Get all Pareto-optimal strategies across all niches for a given strategy name.
 * Useful for understanding where a strategy excels.
 */
export function getStrategyFrontierPresence(strategy: string): Array<{
  taskType: string;
  complexity: string;
  objectives: ParetoObjectives;
  frontierPosition: number; // 1-based rank by combined score
}> {
  const results: Array<{
    taskType: string;
    complexity: string;
    objectives: ParetoObjectives;
    frontierPosition: number;
  }> = [];

  for (const frontier of currentFrontiers.values()) {
    const sorted = [...frontier.nonDominated].sort((a, b) => {
      const sa = a.objectives.quality + a.objectives.successRate * 0.5;
      const sb = b.objectives.quality + b.objectives.successRate * 0.5;
      return sb - sa;
    });

    const idx = sorted.findIndex(c => c.strategy === strategy);
    if (idx !== -1) {
      results.push({
        taskType: frontier.taskType,
        complexity: frontier.complexity,
        objectives: sorted[idx].objectives,
        frontierPosition: idx + 1,
      });
    }
  }

  return results;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

/**
 * Persist current Pareto frontiers to a strategy_performance_snapshots row.
 * Called after evaluatePareto() to survive process restarts.
 */
export async function persistFrontiers(): Promise<void> {
  if (currentFrontiers.size === 0) return;

  try {
    const _snapshot = {
      frontiers: [...currentFrontiers.entries()].map(([key, f]) => ({
        key,
        taskType: f.taskType,
        complexity: f.complexity,
        nonDominated: f.nonDominated.map(c => ({
          strategy: c.strategy,
          objectives: c.objectives,
          sampleCount: c.sampleCount,
          rawMetrics: c.rawMetrics,
        })),
        computedAt: f.computedAt,
      })),
      lastEvaluatedAt,
    };

    // Store as a special snapshot with strategy='__pareto_state__'
    await prisma.$executeRaw`
      INSERT INTO strategy_performance_snapshots (
        strategy, task_type, complexity, time_window, window_type,
        sample_size, win_rate, avg_quality, avg_latency_ms, avg_cost_usd,
        success_rate, stability_index, confidence_score
      ) VALUES (
        '__pareto_state__', '__system__', '__system__',
        ${new Date().toISOString().slice(0, 10)}, 'pareto_snapshot',
        ${currentFrontiers.size}, 0, 0, 0, 0, 0, 0, 0
      )
      ON CONFLICT (strategy, task_type, complexity, time_window, window_type) DO UPDATE SET
        sample_size = EXCLUDED.sample_size
    `;

    log.debug({ niches: currentFrontiers.size }, 'Pareto frontiers persisted');
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to persist Pareto frontiers');
  }
}

/**
 * Load Pareto frontiers from the most recent benchmark run's execution_outcomes.
 * Called on startup to restore frontier state without waiting for the nightly job.
 */
export async function loadFrontiersFromOutcomes(): Promise<number> {
  try {
    // Reconstruct frontiers from recent execution outcomes (last 7 days)
    const rows = await prisma.$queryRaw<Array<{
      strategy: string;
      task_type: string;
      complexity: string;
      avg_quality: number;
      avg_latency_ms: number;
      avg_cost_usd: number;
      success_rate: number;
      sample_count: bigint;
    }>>`
      SELECT
        strategy,
        (observed_metrics->>'taskType')::text as task_type,
        (observed_metrics->>'complexity')::text as complexity,
        AVG(quality_score) as avg_quality,
        AVG(latency_ms) as avg_latency_ms,
        AVG(cost_usd) as avg_cost_usd,
        AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as success_rate,
        COUNT(*) as sample_count
      FROM execution_outcomes
      WHERE created_at >= ${new Date(Date.now() - 7 * 86_400_000)}
        AND quality_score IS NOT NULL
      GROUP BY strategy, observed_metrics->>'taskType', observed_metrics->>'complexity'
      HAVING COUNT(*) >= 3
    `;

    if (rows.length === 0) return 0;

    // Convert to BenchmarkResult format and run evaluatePareto
    const syntheticResults: BenchmarkResult[] = [];
    for (const row of rows) {
      const count = Number(row.sample_count);
      for (let i = 0; i < Math.min(count, 10); i++) {
        syntheticResults.push({
          taskType: row.task_type ?? 'general',
          complexity: row.complexity ?? 'medium',
          strategy: row.strategy,
          qualityScore: row.avg_quality,
          success: row.success_rate > 0.5,
          durationMs: Math.round(row.avg_latency_ms),
          costUsd: Number(row.avg_cost_usd),
        });
      }
    }

    if (syntheticResults.length > 0) {
      const result = evaluatePareto(syntheticResults);
      log.info({
        niches: result.totalNiches,
        strategies: rows.length,
      }, 'Pareto frontiers restored from execution outcomes on startup');
      return result.totalNiches;
    }

    return 0;
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to load Pareto frontiers from outcomes');
    return 0;
  }
}
