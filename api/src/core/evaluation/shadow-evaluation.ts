// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shadow Evaluation Layer
 *
 * For a configurable fraction of requests, executes an alternative strategy
 * alongside the primary one and compares outcomes. This produces:
 * - Regret: how much better the alternative would have been
 * - Competitive evidence: which strategy actually wins per niche
 * - Calibration signal: are our selection heuristics correct?
 *
 * Shadow evaluation never interferes with the primary response. It runs
 * asynchronously after the primary execution completes.
 *
 * Budget control: configurable sampling rate + max cost per window.
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'shadow-evaluation' });

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  enabled: process.env.SHADOW_EVAL_ENABLED !== 'false',
  /** Fraction of requests to shadow-evaluate (0.0 - 1.0) */
  samplingRate: parseFloat(process.env.SHADOW_EVAL_SAMPLING_RATE || '0.05'),
  /** Maximum shadow eval cost per hour (USD) */
  maxCostPerHourUsd: parseFloat(process.env.SHADOW_EVAL_MAX_COST_HOUR || '1.0'),
  /** Maximum concurrent shadow evals */
  maxConcurrent: parseInt(process.env.SHADOW_EVAL_MAX_CONCURRENT || '3', 10),
};

// ─── State ──────────────────────────────────────────────────────────────────

let currentHourCostUsd = 0;
let currentHourStart = Date.now();
let activeShadowEvals = 0;

function resetHourlyBudgetIfNeeded(): void {
  const now = Date.now();
  if (now - currentHourStart > 3_600_000) {
    currentHourCostUsd = 0;
    currentHourStart = now;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ShadowEvalInput {
  decisionTraceId: string;
  taskType: string;
  complexity: string;
  chosenStrategy: string;
  chosenQuality: number;
  chosenLatencyMs: number;
  chosenCostUsd: number;
}

export interface ShadowEvalResult {
  shadowStrategy: string;
  shadowQuality: number;
  shadowLatencyMs: number;
  shadowCostUsd: number;
  qualityRegret: number;
  winnerStrategy: string;
}

// ─── Core Logic ─────────────────────────────────────────────────────────────

/**
 * Decide whether to run a shadow evaluation for this request.
 * Uses sampling rate + budget control + concurrency limits.
 */
export function shouldRunShadowEval(): boolean {
  if (!CONFIG.enabled) return false;

  resetHourlyBudgetIfNeeded();

  // Budget exhausted
  if (currentHourCostUsd >= CONFIG.maxCostPerHourUsd) return false;

  // Concurrency limit
  if (activeShadowEvals >= CONFIG.maxConcurrent) return false;

  // Sampling
  return Math.random() < CONFIG.samplingRate;
}

/**
 * Record a shadow evaluation result.
 * Called after executing the shadow strategy and comparing outcomes.
 */
export async function recordShadowEvaluation(
  input: ShadowEvalInput,
  shadow: ShadowEvalResult,
): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO shadow_evaluations (
        decision_trace_id, task_type, complexity,
        chosen_strategy, chosen_quality, chosen_latency_ms, chosen_cost_usd,
        shadow_strategy, shadow_quality, shadow_latency_ms, shadow_cost_usd,
        quality_regret, winner_strategy, comparison_summary
      ) VALUES (
        ${input.decisionTraceId}, ${input.taskType}, ${input.complexity},
        ${input.chosenStrategy}, ${input.chosenQuality}, ${input.chosenLatencyMs}, ${input.chosenCostUsd},
        ${shadow.shadowStrategy}, ${shadow.shadowQuality}, ${shadow.shadowLatencyMs}, ${shadow.shadowCostUsd},
        ${shadow.qualityRegret}, ${shadow.winnerStrategy},
        ${JSON.stringify({
          chosenScore: input.chosenQuality,
          shadowScore: shadow.shadowQuality,
          qualityDelta: shadow.shadowQuality - input.chosenQuality,
          latencyDelta: shadow.shadowLatencyMs - input.chosenLatencyMs,
          costDelta: shadow.shadowCostUsd - input.chosenCostUsd,
        })}::jsonb
      )
    `;

    // Track cost budget
    currentHourCostUsd += shadow.shadowCostUsd;

    log.info({
      decisionTraceId: input.decisionTraceId,
      chosen: input.chosenStrategy,
      shadow: shadow.shadowStrategy,
      qualityRegret: shadow.qualityRegret.toFixed(4),
      winner: shadow.winnerStrategy,
    }, 'Shadow evaluation recorded');
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to record shadow evaluation');
  }
}

/**
 * Execute a shadow evaluation for a completed request.
 * Runs the alternative strategy and compares with the primary result.
 *
 * This is the integration point — called from the orchestration engine
 * after the primary execution completes.
 *
 * @param executeStrategy - function that executes a strategy and returns quality/cost/latency
 */
export async function runShadowEvaluation(
  input: ShadowEvalInput,
  shadowStrategyName: string,
  executeStrategy: (strategyName: string) => Promise<{
    quality: number;
    latencyMs: number;
    costUsd: number;
  }>,
): Promise<ShadowEvalResult | null> {
  if (!shouldRunShadowEval()) return null;

  activeShadowEvals++;
  try {
    const shadowResult = await executeStrategy(shadowStrategyName);

    const qualityRegret = shadowResult.quality - input.chosenQuality;
    const winnerStrategy = qualityRegret > 0.02
      ? shadowStrategyName // Shadow was meaningfully better
      : qualityRegret < -0.02
        ? input.chosenStrategy // Chosen was meaningfully better
        : input.chosenStrategy; // Tie goes to chosen (no regret)

    const result: ShadowEvalResult = {
      shadowStrategy: shadowStrategyName,
      shadowQuality: shadowResult.quality,
      shadowLatencyMs: shadowResult.latencyMs,
      shadowCostUsd: shadowResult.costUsd,
      qualityRegret: Math.max(0, qualityRegret), // Regret is always non-negative
      winnerStrategy,
    };

    await recordShadowEvaluation(input, result);
    return result;
  } catch (err) {
    log.warn({ error: String(err), shadow: shadowStrategyName }, 'Shadow evaluation execution failed');
    return null;
  } finally {
    activeShadowEvals--;
  }
}

/**
 * Get recent shadow evaluation statistics for admin inspection.
 */
export async function getShadowEvalStats(hours: number = 24): Promise<{
  totalEvals: number;
  avgRegret: number;
  chosenWinRate: number;
  shadowWinRate: number;
  topRegretStrategies: Array<{ chosen: string; shadow: string; avgRegret: number; count: number }>;
}> {
  try {
    const since = new Date(Date.now() - hours * 3_600_000);

    const stats = await prisma.$queryRaw<Array<{
      total: bigint;
      avg_regret: number | null;
      chosen_wins: bigint;
      shadow_wins: bigint;
    }>>`
      SELECT
        COUNT(*) as total,
        AVG(quality_regret) as avg_regret,
        COUNT(*) FILTER (WHERE winner_strategy = chosen_strategy) as chosen_wins,
        COUNT(*) FILTER (WHERE winner_strategy = shadow_strategy) as shadow_wins
      FROM shadow_evaluations
      WHERE created_at >= ${since}
    `;

    const row = stats[0];
    const total = Number(row?.total ?? 0);

    const topRegret = await prisma.$queryRaw<Array<{
      chosen_strategy: string;
      shadow_strategy: string;
      avg_regret: number;
      cnt: bigint;
    }>>`
      SELECT chosen_strategy, shadow_strategy, AVG(quality_regret) as avg_regret, COUNT(*) as cnt
      FROM shadow_evaluations
      WHERE created_at >= ${since} AND quality_regret > 0
      GROUP BY chosen_strategy, shadow_strategy
      ORDER BY avg_regret DESC
      LIMIT 10
    `;

    return {
      totalEvals: total,
      avgRegret: row?.avg_regret ?? 0,
      chosenWinRate: total > 0 ? Number(row?.chosen_wins ?? 0) / total : 0,
      shadowWinRate: total > 0 ? Number(row?.shadow_wins ?? 0) / total : 0,
      topRegretStrategies: topRegret.map(r => ({
        chosen: r.chosen_strategy,
        shadow: r.shadow_strategy,
        avgRegret: r.avg_regret,
        count: Number(r.cnt),
      })),
    };
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to get shadow eval stats');
    return { totalEvals: 0, avgRegret: 0, chosenWinRate: 0, shadowWinRate: 0, topRegretStrategies: [] };
  }
}

/**
 * Get current shadow evaluation configuration and budget status.
 */
export function getShadowEvalConfig(): {
  enabled: boolean;
  samplingRate: number;
  maxCostPerHourUsd: number;
  currentHourCostUsd: number;
  activeShadowEvals: number;
  budgetRemaining: number;
} {
  resetHourlyBudgetIfNeeded();
  return {
    enabled: CONFIG.enabled,
    samplingRate: CONFIG.samplingRate,
    maxCostPerHourUsd: CONFIG.maxCostPerHourUsd,
    currentHourCostUsd,
    activeShadowEvals,
    budgetRemaining: Math.max(0, CONFIG.maxCostPerHourUsd - currentHourCostUsd),
  };
}
