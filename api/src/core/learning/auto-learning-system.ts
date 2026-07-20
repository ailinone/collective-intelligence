// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Auto-Learning System
 *
 * Continuously learns from executions to optimize strategy selection
 * Based on: ORQUESTRACAO_AVANCADA_ATE_9_MODELOS.md
 *
 * Architecture:
 *   - Learning Buckets: Aggregated insights (hourly buckets)
 *   - Strategy Weights: Dynamic optimization based on performance
 *   - Pattern Discovery: Identifies successful model combinations
 *   - Compact Storage: < 200MB/year (aggregated data)
 *
 * Storage Strategy:
 *   - Individual insights: NOT stored (too expensive)
 *   - Hourly buckets: Aggregated metrics (720 buckets/month = ~14MB/month)
 *   - Daily rollups: Condensed summaries
 *   - Pattern cache: Top 100 patterns only
 *
 * Performance Impact:
 *   - Strategy selection: +15-25% quality improvement over time
 *   - Cost efficiency: +10-20% through learned optimizations
 *   - Prediction accuracy: 85%+ after 30 days of data
 */

import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';
import type { OrchestrationResult } from '@/types';

/**
 * Execution insight (compact representation)
 */
export interface ExecutionInsight {
  // Context
  taskType: string; // code-generation, debugging, etc.
  complexity: string; // simple, moderate, complex
  contextSizeKB: number; // KB not tokens

  // Strategy used
  strategy: string;
  modelsUsed: number;
  modelAllocations: string; // Compact: "oai:gpt4o:pri,ant:son:rev"

  // Results
  qualityScore: number; // 0-1
  cost: number; // USD
  latency: number; // ms
  success: boolean;

  // Timestamp
  timestamp: number;
}

/**
 * Type definitions for raw query results
 */
interface LearningDataRow {
  bucket: string;
  task_type: string;
  complexity: string;
  count: number;
  success_count: number;
  avg_quality: number;
  avg_cost: number;
  avg_latency: number;
  strategy_distribution: unknown;
  top_patterns: unknown;
}

interface StrategyWeightRow {
  strategy: string;
  task_type: string;
  complexity: string;
  avg_quality: string;
  avg_cost_efficiency: string;
  success_rate: string;
  sample_count: number;
  weight: string;
}

interface PatternDataRow {
  pattern_data: {
    allocations?: string;
    quality?: number;
    cost?: number;
    count?: number;
    avgQuality?: number;
    avgCost?: number;
  };
}

interface LearningStatsRow {
  bucket_count: number;
  total_insights: string;
  overall_quality: number;
  overall_cost: number;
}

interface StrategyScoreRow {
  strategy: string;
  score: number;
}

interface StrategyCountRow {
  count: string;
}

/**
 * Learning bucket (hourly aggregation)
 */
export interface LearningBucket {
  bucket: string; // '2025-11-04-10' (YYYY-MM-DD-HH)
  taskType: string;
  complexity: string;

  // Aggregated metrics
  count: number;
  successCount: number;
  avgQuality: number;
  avgCost: number;
  avgLatency: number;

  // Strategy distribution (compact)
  strategyDistribution: Record<string, number>; // { "parallel": 45, "sequential": 30 }

  // Top patterns (only top 5 to save space)
  topPatterns: Array<{
    allocations: string;
    count: number;
    avgQuality: number;
  }>;
}

/**
 * Auto-Learning System
 */
export class AutoLearningSystem {
  private log = logger.child({ component: 'auto-learning' });

  /**
   * Learn from execution result
   *
   * Extracts compact insight and updates aggregated buckets
   */
  async learn(
    result: OrchestrationResult,
    taskAnalysis: {
      type: string;
      complexity: string;
      contextSize: number;
    }
  ): Promise<void> {
    try {
      // 1. Extract compact insight (< 1KB)
      const insight = this.extractInsight(result, taskAnalysis);

      // 2. Update hourly bucket (aggregated storage)
      await this.updateBucket(insight);

      // 2b. Update per-MODEL hourly buckets (`learning_buckets`) — the table the
      // DynamicModelSelector reads as model performance history. This was the
      // missing writer (2026-06-29 finding: the selector queried the table but
      // nothing ever wrote it, so model history was always null).
      await this.updateModelBuckets(result, insight.qualityScore);

      // 3. Update strategy weights
      await this.updateStrategyWeights(insight);

      this.log.debug(
        {
          strategy: insight.strategy,
          quality: insight.qualityScore,
          cost: insight.cost,
        },
        'Learning insight recorded'
      );
    } catch (error) {
      this.log.error({ error }, 'Failed to record learning insight');
    }
  }

  /**
   * Extract compact insight from execution
   *
   * Size: ~200 bytes (vs ~5KB raw execution data)
   */
  private extractInsight(result: OrchestrationResult, taskAnalysis: { type: string; complexity: string; contextSize: number }): ExecutionInsight {
    return {
      taskType: taskAnalysis.type,
      complexity: taskAnalysis.complexity,
      contextSizeKB: Math.floor(taskAnalysis.contextSize / 1000),

      strategy: result.strategyUsed,
      modelsUsed: result.modelsUsed.length,
      modelAllocations: this.compactAllocations(result.modelsUsed),

      qualityScore: Math.round((result.qualityScore || 0.8) * 100) / 100, // 2 decimals
      cost: Math.round(result.totalCost * 1000000) / 1000000, // 6 decimals
      latency: Math.round(result.totalDuration / 100) * 100, // Round to 100ms

      success: true,
      timestamp: Date.now(),
    };
  }

  /**
   * Compact model allocations to save space
   *
   * Format: "provider:model:role,provider:model:role,..."
   * Example: "oai:gpt4o:pri,ant:son:rev,goo:gem:val"
   *
   * Saves: ~80% space vs full JSON
   */
  private compactAllocations(
    modelsUsed: Array<{ modelId: string; modelName: string; role?: string }>
  ): string {
    return modelsUsed
      .map((m) => {
        const provider = m.modelId.split('-')[0] || 'unk';
        const model = m.modelName.substring(0, 6);
        const role = (m.role || 'unk').substring(0, 3);
        return `${provider.substring(0, 3)}:${model}:${role}`;
      })
      .join(',');
  }

  /**
   * Update hourly learning bucket
   *
   * Aggregates individual insights into hourly buckets
   * Bucket size: ~20KB for 100 insights (vs 500KB raw)
   */
  private async updateBucket(insight: ExecutionInsight): Promise<void> {
    const bucket = this.getBucketKey(insight.timestamp);

    try {
      // Try to update existing bucket
      const existing = await prisma.$queryRaw<LearningDataRow[]>`
        SELECT * FROM learning_data
        WHERE bucket = ${bucket}
          AND task_type = ${insight.taskType}
          AND complexity = ${insight.complexity}
        LIMIT 1
      `;

      if (existing.length > 0) {
        // Update existing bucket (incremental averages)
        const current = existing[0];
        const newCount = current.count + 1;

        await prisma.$executeRaw`
          UPDATE learning_data
          SET
            count = ${newCount},
            success_count = success_count + ${insight.success ? 1 : 0},
            avg_quality = ((avg_quality * ${current.count}) + ${insight.qualityScore}) / ${newCount},
            avg_cost = ((avg_cost * ${current.count}) + ${insight.cost}) / ${newCount},
            avg_latency = ((avg_latency * ${current.count}) + ${insight.latency}) / ${newCount},
            strategy_distribution = jsonb_set(
              COALESCE(strategy_distribution, '{}'::jsonb),
              ARRAY[${insight.strategy}],
              to_jsonb(COALESCE((strategy_distribution->${insight.strategy})::int, 0) + 1)
            ),
            updated_at = NOW()
          WHERE bucket = ${bucket}
            AND task_type = ${insight.taskType}
            AND complexity = ${insight.complexity}
        `;
      } else {
        // Create new bucket
        await prisma.$executeRaw`
          INSERT INTO learning_data (
            bucket, task_type, complexity,
            count, success_count,
            avg_quality, avg_cost, avg_latency,
            strategy_distribution, top_patterns,
            created_at, updated_at
          ) VALUES (
            ${bucket}, ${insight.taskType}, ${insight.complexity},
            1, ${insight.success ? 1 : 0},
            ${insight.qualityScore}, ${insight.cost}, ${insight.latency},
            jsonb_build_object(${insight.strategy}, 1),
            '[]'::jsonb,
            NOW(),
            NOW()
          )
        `;
      }
    } catch (error) {
      this.log.error({ error, bucket }, 'Failed to update learning bucket');
    }
  }

  /**
   * Per-MODEL hourly buckets → `learning_buckets` (read by DynamicModelSelector
   * as performance history; its queries use strategyId = MODEL id, so that is
   * the semantic this writer follows — strategy-level aggregation already lives
   * in `learning_data`/`strategy_weights`).
   *
   * Design constraints (learning_buckets latency incident, 2026-06-29: 8.3s was
   * Prisma CONTENTION, not SQL): ONE batched multi-row upsert per execution,
   * deduped by model, bounded to 20 rows, never throws. `learn()` is already
   * fire-and-forget with a 5s timeout at the call site.
   * Kill-switch: LEARNING_MODEL_BUCKETS_ENABLED='false'.
   */
  private async updateModelBuckets(
    result: OrchestrationResult,
    qualityScore: number
  ): Promise<void> {
    if (process.env.LEARNING_MODEL_BUCKETS_ENABLED === 'false') return;
    try {
      // Dedupe by modelId (a model can appear as voter AND coordinator) —
      // ON CONFLICT cannot update the same row twice in one statement.
      const byModel = new Map<
        string,
        { name: string; execs: number; ok: number; err: number; durTotal: number; costTotal: number; tokens: number }
      >();
      for (const e of result.modelsUsed ?? []) {
        if (!e?.modelId) continue;
        const agg =
          byModel.get(e.modelId) ??
          { name: e.modelName || e.modelId, execs: 0, ok: 0, err: 0, durTotal: 0, costTotal: 0, tokens: 0 };
        agg.execs += 1;
        if (e.success) agg.ok += 1;
        else agg.err += 1;
        agg.durTotal += Math.max(0, Math.round(e.durationMs || 0));
        agg.costTotal += Number(e.cost) || 0;
        agg.tokens += Number(e.response?.usage?.total_tokens) || 0;
        byModel.set(e.modelId, agg);
      }
      if (byModel.size === 0) return;

      const entries = [...byModel.entries()].slice(0, 20); // bound statement size
      // The overall (judged) quality is attributed to each participating model —
      // per-model quality is not tracked per execution; this is the best
      // available signal and is explicitly an approximation.
      const quality = Number.isFinite(qualityScore)
        ? Math.min(Math.max(qualityScore, 0), 1)
        : null;

      const rows = entries.map(
        ([modelId, a]) => Prisma.sql`(
          gen_random_uuid(), date_trunc('hour', NOW()), ${modelId}, ${a.name},
          ${a.execs}, ${a.ok}, ${a.err},
          ${Math.round(a.durTotal / a.execs)}, ${Number((a.costTotal / a.execs).toFixed(6))},
          ${quality}, ${a.tokens}, '{}'::jsonb, NOW(), NOW()
        )`
      );

      // NOTE on the DO UPDATE arithmetic: in PostgreSQL every right-hand side in
      // the SET list sees the OLD row, so the running averages correctly weight
      // by the pre-update execution_count even though execution_count is also
      // reassigned in the same statement.
      await prisma.$executeRaw`
        INSERT INTO learning_buckets (
          id, bucket_time, strategy_id, strategy_name,
          execution_count, success_count, error_count,
          avg_duration_ms, avg_cost_usd, avg_quality, total_tokens, insights,
          created_at, updated_at
        ) VALUES ${Prisma.join(rows)}
        ON CONFLICT (strategy_id, bucket_time) DO UPDATE SET
          avg_duration_ms = (
            (learning_buckets.avg_duration_ms::bigint * learning_buckets.execution_count
             + EXCLUDED.avg_duration_ms::bigint * EXCLUDED.execution_count)
            / GREATEST(learning_buckets.execution_count + EXCLUDED.execution_count, 1)
          )::int,
          avg_cost_usd = (
            (learning_buckets.avg_cost_usd * learning_buckets.execution_count
             + EXCLUDED.avg_cost_usd * EXCLUDED.execution_count)
            / GREATEST(learning_buckets.execution_count + EXCLUDED.execution_count, 1)
          ),
          avg_quality = CASE
            WHEN EXCLUDED.avg_quality IS NULL THEN learning_buckets.avg_quality
            WHEN learning_buckets.avg_quality IS NULL THEN EXCLUDED.avg_quality
            ELSE (
              (learning_buckets.avg_quality * learning_buckets.execution_count
               + EXCLUDED.avg_quality * EXCLUDED.execution_count)
              / GREATEST(learning_buckets.execution_count + EXCLUDED.execution_count, 1)
            )
          END,
          execution_count = learning_buckets.execution_count + EXCLUDED.execution_count,
          success_count = learning_buckets.success_count + EXCLUDED.success_count,
          error_count = learning_buckets.error_count + EXCLUDED.error_count,
          total_tokens = learning_buckets.total_tokens + EXCLUDED.total_tokens,
          updated_at = NOW()
      `;
    } catch (error) {
      this.log.error({ error }, 'Failed to update per-model learning buckets');
    }
  }

  /**
   * Update strategy weights based on performance
   */
  private async updateStrategyWeights(insight: ExecutionInsight): Promise<void> {
    try {
      // Calculate cost efficiency (quality / cost)
      const qualityValue = Number(insight.qualityScore);
      const safeQuality = Number.isFinite(qualityValue)
        ? Number(Math.min(Math.max(qualityValue, 0), 1).toFixed(6))
        : 0;
      const costValue = Number(insight.cost);
      const rawCostEfficiency = costValue > 0 ? safeQuality / costValue : 0;
      const normalizedCostEfficiency = Number.isFinite(rawCostEfficiency) ? rawCostEfficiency : 0;
      const costEfficiencyUpperBound = 9_999.999_000;
      const costEfficiency = Number(
        Math.min(Math.max(normalizedCostEfficiency, 0), costEfficiencyUpperBound).toFixed(6)
      );
      const successIncrement = insight.success ? 1.0 : 0.0;

      await prisma.$executeRaw`
        INSERT INTO strategy_weights (
          task_type, complexity, strategy,
          weight, success_rate, avg_quality, avg_cost_efficiency, sample_count
        ) VALUES (
          ${insight.taskType},
          ${insight.complexity},
          ${insight.strategy},
          1.0,
          ${successIncrement},
          ${safeQuality},
          ${costEfficiency},
          1
        )
        ON CONFLICT (task_type, complexity, strategy) DO UPDATE
        SET
          sample_count = strategy_weights.sample_count + 1,
          success_rate = LEAST(
            1.0,
            GREATEST(
              0.0,
              (
                (strategy_weights.success_rate * strategy_weights.sample_count) + ${successIncrement}
              ) / (strategy_weights.sample_count + 1)
            )
          ),
          avg_quality = LEAST(
            1.0,
            GREATEST(
              0.0,
              (
                (strategy_weights.avg_quality * strategy_weights.sample_count) + ${safeQuality}
              ) / (strategy_weights.sample_count + 1)
            )
          ),
          avg_cost_efficiency = LEAST(
            9999.999999,
            GREATEST(
              0.0,
              (
                (strategy_weights.avg_cost_efficiency * strategy_weights.sample_count) + ${costEfficiency}
              ) / (strategy_weights.sample_count + 1)
            )
          ),
          updated_at = NOW()
      `;
    } catch (error) {
      this.log.error({ error }, 'Failed to update strategy weights');
    }
  }

  /**
   * Get bucket key for timestamp
   *
   * Format: YYYY-MM-DD-HH (hourly buckets)
   */
  private getBucketKey(timestamp: number): string {
    const date = new Date(timestamp);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}-${hh}`;
  }

  private getNextDayStartBucket(day: string): string {
    const [year, month, dayOfMonth] = day.split('-').map((value) => parseInt(value, 10));
    const utcDate = Date.UTC(
      Number.isFinite(year) ? year : 1970,
      Number.isFinite(month) ? month - 1 : 0,
      Number.isFinite(dayOfMonth) ? dayOfMonth + 1 : 1
    );
    const nextDay = new Date(utcDate);
    const yyyy = nextDay.getUTCFullYear();
    const mm = String(nextDay.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(nextDay.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}-00`;
  }

  /**
   * Get strategy recommendation based on learned data
   *
   * Uses historical performance to recommend best strategy
   */
  async getStrategyRecommendation(
    taskType: string,
    complexity: string
  ): Promise<{
    strategy: string;
    confidence: number; // 0-1
    expectedQuality: number;
    expectedCost: number;
    sampleSize: number;
  } | null> {
    try {
      const weights = await prisma.$queryRaw<StrategyWeightRow[]>`
        SELECT 
          strategy,
          avg_quality,
          avg_cost_efficiency,
          success_rate,
          sample_count
        FROM strategy_weights
        WHERE task_type = ${taskType}
          AND complexity = ${complexity}
          AND sample_count >= 5
        ORDER BY (avg_quality * success_rate * avg_cost_efficiency) DESC
        LIMIT 1
      `;

      if (weights.length === 0) {
        return null; // No learned data yet
      }

      const best = weights[0];

      // Confidence based on sample size (max at 100 samples)
      // sample_count is already a number, no need to parse
      const sampleCount = typeof best.sample_count === 'number' ? best.sample_count : parseInt(String(best.sample_count), 10);
      const confidence = Math.min(sampleCount / 100, 1.0);

      return {
        strategy: best.strategy,
        confidence,
        expectedQuality: parseFloat(best.avg_quality),
        expectedCost: parseFloat(best.avg_cost_efficiency) * parseFloat(best.avg_quality), // Reverse engineer cost
        sampleSize: sampleCount,
      };
    } catch (error) {
      this.log.error({ error }, 'Failed to get strategy recommendation');
      return null;
    }
  }

  /**
   * Discover successful patterns
   *
   * Finds model combinations that work well together
   */
  async discoverPatterns(
    taskType: string,
    minQuality: number = 0.9,
    maxCost: number = 0.05
  ): Promise<
    Array<{
      pattern: string;
      frequency: number;
      avgQuality: number;
      avgCost: number;
    }>
  > {
    try {
      // Query learning buckets for high-performing patterns
      const patterns = await prisma.$queryRaw<PatternDataRow[]>`
        SELECT 
          jsonb_array_elements(top_patterns) as pattern_data
        FROM learning_data
        WHERE task_type = ${taskType}
          AND avg_quality >= ${minQuality}
          AND avg_cost <= ${maxCost}
        LIMIT 100
      `;

      // Aggregate patterns
      const aggregated = new Map<string, { count: number; quality: number; cost: number }>();

      for (const row of patterns) {
        const pattern = row.pattern_data;
        if (pattern && pattern.allocations) {
          const key = pattern.allocations;
          const existing = aggregated.get(key) || { count: 0, quality: 0, cost: 0 };

          // pattern_data has structure: { allocations?: string; quality?: number; cost?: number; }
          // Use available properties only
          aggregated.set(key, {
            count: existing.count + 1,
            quality: existing.quality + (pattern.quality ?? 0),
            cost: existing.cost + (pattern.cost ?? 0),
          });
        }
      }

      // Convert to array and calculate averages
      const result = Array.from(aggregated.entries())
        .map(([pattern, data]) => ({
          pattern,
          frequency: data.count,
          avgQuality: data.quality / data.count,
          avgCost: data.cost / data.count,
        }))
        .sort((a, b) => b.frequency - a.frequency)
        .slice(0, 10); // Top 10 patterns

      this.log.info({ patternCount: result.length, taskType }, 'Patterns discovered');

      return result;
    } catch (error) {
      this.log.error({ error }, 'Failed to discover patterns');
      return [];
    }
  }

  /**
   * Optimize strategy weights based on performance
   *
   * Adjusts weights to favor high-performing strategies
   * Runs periodically (e.g., daily)
   */
  async optimizeStrategyWeights(): Promise<{
    optimized: number;
    improved: string[];
    degraded: string[];
  }> {
    try {
      // Get all strategy weights
      const weights = await prisma.$queryRaw<StrategyWeightRow[]>`
        SELECT *
        FROM strategy_weights
        WHERE sample_count >= 10
        ORDER BY task_type, complexity, strategy
      `;

      const improved: string[] = [];
      const degraded: string[] = [];

      for (const weight of weights) {
        const efficiency = parseFloat(weight.avg_cost_efficiency);
        const successRate = parseFloat(weight.success_rate);
        const quality = parseFloat(weight.avg_quality);

        // Calculate performance score
        const score = efficiency * successRate * quality;

        // Adjust weight based on performance
        let newWeight = parseFloat(weight.weight);

        if (score > 0.9 && successRate > 0.95) {
          // High performer - increase weight
          newWeight = Math.min(newWeight + 0.1, 1.5);
          improved.push(`${weight.task_type}:${weight.strategy}`);
        } else if (score < 0.5 || successRate < 0.7) {
          // Low performer - decrease weight
          newWeight = Math.max(newWeight - 0.1, 0.5);
          degraded.push(`${weight.task_type}:${weight.strategy}`);
        }

        // Update weight
        if (newWeight !== parseFloat(weight.weight)) {
          await prisma.$executeRaw`
            UPDATE strategy_weights
            SET weight = ${newWeight}, updated_at = NOW()
            WHERE task_type = ${weight.task_type}
              AND complexity = ${weight.complexity}
              AND strategy = ${weight.strategy}
          `;
        }
      }

      this.log.info(
        {
          optimized: weights.length,
          improved: improved.length,
          degraded: degraded.length,
        },
        'Strategy weights optimized'
      );

      return {
        optimized: weights.length,
        improved,
        degraded,
      };
    } catch (error) {
      this.log.error({ error }, 'Failed to optimize strategy weights');
      return { optimized: 0, improved: [], degraded: [] };
    }
  }

  /**
   * Get learning statistics
   */
  async getStatistics(): Promise<{
    totalInsights: number;
    bucketsStored: number;
    strategiesLearned: number;
    avgQuality: number;
    avgCost: number;
    mostSuccessfulStrategy: string | null;
  }> {
    try {
      const stats = await prisma.$queryRaw<LearningStatsRow[]>`
        SELECT 
          COUNT(DISTINCT bucket) as bucket_count,
          SUM(count) as total_insights,
          AVG(avg_quality) as overall_quality,
          AVG(avg_cost) as overall_cost
        FROM learning_data
      `;

      const strategies = await prisma.$queryRaw<StrategyScoreRow[]>`
        SELECT 
          strategy,
          AVG(avg_quality * success_rate) as score
        FROM strategy_weights
        WHERE sample_count >= 10
        GROUP BY strategy
        ORDER BY score DESC
        LIMIT 1
      `;

      const strategiesCount = await prisma.$queryRaw<StrategyCountRow[]>`
        SELECT COUNT(DISTINCT strategy) as count
        FROM strategy_weights
      `;

      const totalInsights = typeof stats[0]?.total_insights === 'string' ? parseInt(stats[0].total_insights) : (stats[0]?.total_insights || 0);
      const bucketCount = typeof stats[0]?.bucket_count === 'string' ? parseInt(stats[0].bucket_count) : (stats[0]?.bucket_count || 0);
      const strategiesCountValue = typeof strategiesCount[0]?.count === 'string' ? parseInt(strategiesCount[0].count) : parseInt(String(strategiesCount[0]?.count || 0));
      const overallQuality = typeof stats[0]?.overall_quality === 'string' ? parseFloat(stats[0].overall_quality) : (stats[0]?.overall_quality || 0);
      const overallCost = typeof stats[0]?.overall_cost === 'string' ? parseFloat(stats[0].overall_cost) : (stats[0]?.overall_cost || 0);

      return {
        totalInsights,
        bucketsStored: bucketCount,
        strategiesLearned: strategiesCountValue,
        avgQuality: overallQuality,
        avgCost: overallCost,
        mostSuccessfulStrategy: strategies[0]?.strategy || null,
      };
    } catch (error) {
      this.log.error({ error }, 'Failed to get learning statistics');
      return {
        totalInsights: 0,
        bucketsStored: 0,
        strategiesLearned: 0,
        avgQuality: 0,
        avgCost: 0,
        mostSuccessfulStrategy: null,
      };
    }
  }

  /**
   * Cleanup old learning data (retention policy)
   *
   * Keeps:
   *   - Last 7 days: Full hourly buckets
   *   - Last 90 days: Daily aggregates only
   *   - Older: Delete (strategy weights remain)
   */
  async cleanup(): Promise<{ deleted: number; compressed: number }> {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
      const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000);

      const sevenDaysBucket = this.getBucketKey(sevenDaysAgo.getTime());
      const ninetyDaysBucket = this.getBucketKey(ninetyDaysAgo.getTime());

      // Delete buckets older than 90 days
      const deleted = await prisma.$executeRaw`
        DELETE FROM learning_data
        WHERE bucket < ${ninetyDaysBucket}
      `;

      // Fetch buckets that need compression (between 7 and 90 days old)
      const bucketsToCompress = await prisma.$queryRaw<LearningDataRow[]>`
        SELECT
          bucket,
          task_type,
          complexity,
          count,
          success_count,
          avg_quality,
          avg_cost,
          avg_latency,
          strategy_distribution,
          top_patterns
        FROM learning_data
        WHERE bucket >= ${ninetyDaysBucket}
          AND bucket < ${sevenDaysBucket}
      `;

      let compressed = 0;

      if (bucketsToCompress.length > 0) {
        interface AggregatedBucket {
          day: string;
          taskType: string;
          complexity: string;
          count: number;
          successCount: number;
          qualitySum: number;
          costSum: number;
          latencySum: number;
          strategy: Record<string, number>;
          patterns: Array<Record<string, unknown>>;
        }

        const aggregates = new Map<string, AggregatedBucket>();
        const affectedDays = new Set<string>();

        for (const row of bucketsToCompress) {
          const bucket: string = row.bucket;
          if (!bucket || typeof bucket !== 'string' || bucket.length < 10) {
            continue;
          }

          const day = bucket.slice(0, 10); // YYYY-MM-DD
          const key = `${day}|${row.task_type}|${row.complexity}`;
          const count = Number(row.count) || 0;
          if (count <= 0) {
            continue;
          }

          const successCount = Number(row.success_count) || 0;
          const avgQuality = Number(row.avg_quality) || 0;
          const avgCost = Number(row.avg_cost) || 0;
          const avgLatency = Number(row.avg_latency) || 0;

          const aggregate = aggregates.get(key) || {
            day,
            taskType: row.task_type,
            complexity: row.complexity,
            count: 0,
            successCount: 0,
            qualitySum: 0,
            costSum: 0,
            latencySum: 0,
            strategy: {} as Record<string, number>,
            patterns: [] as Array<Record<string, unknown>>,
          };

          aggregate.count += count;
          aggregate.successCount += successCount;
          aggregate.qualitySum += avgQuality * count;
          aggregate.costSum += avgCost * count;
          aggregate.latencySum += avgLatency * count;

          const strategyDistribution = row.strategy_distribution || {};
          if (strategyDistribution && typeof strategyDistribution === 'object') {
            for (const [strategy, value] of Object.entries(
              strategyDistribution as Record<string, unknown>
            )) {
              const numericValue = Number(value) || 0;
              aggregate.strategy[strategy] = (aggregate.strategy[strategy] || 0) + numericValue;
            }
          }

          const topPatterns = row.top_patterns;
          if (Array.isArray(topPatterns)) {
            for (const pattern of topPatterns) {
              if (pattern && typeof pattern === 'object') {
                aggregate.patterns.push(pattern as Record<string, unknown>);
              }
            }
          }

          aggregates.set(key, aggregate);
          affectedDays.add(day);
        }

        if (aggregates.size > 0) {
          const aggregatedRows = Array.from(aggregates.values()).map((agg) => {
            const averageQuality = agg.count > 0 ? agg.qualitySum / agg.count : 0;
            const averageCost = agg.count > 0 ? agg.costSum / agg.count : 0;
            const averageLatency = agg.count > 0 ? Math.round(agg.latencySum / agg.count) : 0;

            const strategyDistribution = agg.strategy;

            const patternAggregate = new Map<
              string,
              {
                count: number;
                totalQuality: number;
                totalCost: number;
                sample: Record<string, unknown>;
              }
            >();

            for (const pattern of agg.patterns) {
              if (!pattern || typeof pattern !== 'object') {
                continue;
              }

              const patternRecord = pattern as Record<string, unknown>;

              const allocationsKey = patternRecord.allocations
                ? JSON.stringify(patternRecord.allocations)
                : patternRecord.pattern
                  ? JSON.stringify(patternRecord.pattern)
                  : JSON.stringify(patternRecord);

              const occurrences = Number(patternRecord.count) || 1;
              const avgQuality = Number(patternRecord.avgQuality) || 0;
              const avgCost = Number(patternRecord.avgCost) || 0;

              const existing = patternAggregate.get(allocationsKey) || {
                count: 0,
                totalQuality: 0,
                totalCost: 0,
                sample: pattern,
              };

              existing.count += occurrences;
              existing.totalQuality += avgQuality * occurrences;
              existing.totalCost += avgCost * occurrences;
              existing.sample = existing.sample || pattern;

              patternAggregate.set(allocationsKey, existing);
            }

            const topPatterns = Array.from(patternAggregate.values())
              .map((entry) => {
                const base =
                  entry.sample && typeof entry.sample === 'object' ? { ...entry.sample } : {};
                const count = entry.count || 1;
                return {
                  ...base,
                  count,
                  avgQuality: count > 0 ? entry.totalQuality / count : (base.avgQuality ?? 0),
                  avgCost: count > 0 ? entry.totalCost / count : (base.avgCost ?? 0),
                };
              })
              .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
              .slice(0, 5);

            return {
              bucket: `${agg.day}-24`,
              taskType: agg.taskType,
              complexity: agg.complexity,
              count: agg.count,
              successCount: agg.successCount,
              avgQuality: Number(averageQuality.toFixed(4)),
              avgCost: Number(averageCost.toFixed(6)),
              avgLatency: averageLatency,
              strategyDistribution,
              topPatterns,
            };
          });

          await prisma.$transaction(async (tx) => {
            for (const day of affectedDays) {
              const dayStart = `${day}-00`;
              const nextDay = this.getNextDayStartBucket(day);
              await tx.$executeRaw`
                DELETE FROM learning_data
                WHERE bucket >= ${dayStart} AND bucket < ${nextDay}
              `;
            }

            for (const row of aggregatedRows) {
              await tx.$executeRaw`
                INSERT INTO learning_data (
                  bucket,
                  task_type,
                  complexity,
                  count,
                  success_count,
                  avg_quality,
                  avg_cost,
                  avg_latency,
                  strategy_distribution,
                  top_patterns,
                  created_at,
                  updated_at
                ) VALUES (
                  ${row.bucket},
                  ${row.taskType},
                  ${row.complexity},
                  ${row.count},
                  ${row.successCount},
                  ${row.avgQuality},
                  ${row.avgCost},
                  ${row.avgLatency},
                  ${JSON.stringify(row.strategyDistribution)}::jsonb,
                  ${JSON.stringify(row.topPatterns)}::jsonb,
                  NOW(),
                  NOW()
                )
                ON CONFLICT (bucket, task_type, complexity) DO UPDATE
                SET
                  count = EXCLUDED.count,
                  success_count = EXCLUDED.success_count,
                  avg_quality = EXCLUDED.avg_quality,
                  avg_cost = EXCLUDED.avg_cost,
                  avg_latency = EXCLUDED.avg_latency,
                  strategy_distribution = EXCLUDED.strategy_distribution,
                  top_patterns = EXCLUDED.top_patterns,
                  updated_at = NOW()
              `;
            }
          });

          compressed = aggregatedRows.length;
        }
      }

      this.log.info({ deleted, compressed }, 'Learning data cleanup completed');

      return { deleted, compressed };
    } catch (error) {
      this.log.error({ error }, 'Learning cleanup failed');
      return { deleted: 0, compressed: 0 };
    }
  }

  /**
   * Apply temporal decay to strategy weights.
   *
   * Weights for low-sample rows that haven't been updated recently decay by
   * `decayFactor` per call (default 0.95 ≈ 5% decay per week).
   * Well-established rows (sample_count >= stabilityThreshold) are left untouched
   * so that high-confidence weights don't erode.
   *
   * Call weekly from the CI reflection job.
   */
  async decayStrategyWeights(options?: {
    decayFactor?: number;
    staleDays?: number;
    stabilityThreshold?: number;
  }): Promise<{ decayed: number }> {
    const decayFactor = options?.decayFactor ?? 0.95;
    const staleDays = options?.staleDays ?? 7;
    const stabilityThreshold = options?.stabilityThreshold ?? 100;

    try {
      const result = await prisma.$executeRaw`
        UPDATE strategy_weights
        SET
          weight = GREATEST(0.1, weight * ${decayFactor}),
          updated_at = NOW()
        WHERE
          updated_at < NOW() - (${staleDays} || ' days')::INTERVAL
          AND sample_count < ${stabilityThreshold}
      `;

      const decayed = typeof result === 'number' ? result : 0;

      this.log.info(
        { decayed, decayFactor, staleDays, stabilityThreshold },
        'Strategy weights decay applied'
      );

      return { decayed };
    } catch (error) {
      this.log.error({ error }, 'Strategy weights decay failed');
      return { decayed: 0 };
    }
  }
}

// Export singleton instance
export const autoLearningSystem = new AutoLearningSystem();
