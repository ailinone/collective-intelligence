// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Configuration Archive (OI-06)
 *
 * Quality-diversity archive for strategy configurations.
 *
 * Instead of optimizing for a single "best" strategy per task type (reward
 * maximization), this archive maintains multiple elites — one per behavioral
 * niche defined by (taskType × complexity × optimizationDimension).
 *
 * Rationale:
 * - Standard optimization converges to a single optimum, which is brittle
 * - Quality-diversity maintains a multi-cell map of elites across behavior space
 * - Each cell in the map stores the BEST configuration for that niche
 * - New configurations only replace the current elite if they score higher
 * - This provides: (1) robustness via diversity, (2) instant alternatives
 *   when the primary strategy degrades, (3) coverage of multiple user preferences
 *
 * Integration:
 * - Triage already classifies requests into TriageStrategy (speed/cost/quality/balanced/adaptive)
 * - This archive maps those preferences to validated elite configurations
 * - The orchestration engine queries the archive BEFORE the Thompson Sampling bandit
 *   when a clear optimization preference is identified by triage
 *
 * Storage: In-memory archive + periodic sync to strategy_weights table
 * Max cells: ~300 (13 task types × 3 complexities × ~8 dimensions)
 */

import { prisma } from '@/database/client';
import { narrowAs } from '@/utils/type-guards';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'configuration-archive' });

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Optimization dimensions — each represents a different user preference.
 * Aligned with TriageStrategy values plus additional nuanced dimensions.
 */
export type OptimizationDimension =
  | 'quality'          // Maximize quality score
  | 'cost-efficient'   // Maximize quality/cost ratio
  | 'speed'            // Maximize quality with minimum latency
  | 'balanced'         // Weighted combination of quality, cost, latency
  | 'reliability'      // Maximize success rate
  | 'quality-per-token'; // Maximize quality / total tokens (efficiency)

/**
 * A cell in the behavior space — uniquely identifies a niche.
 */
export interface ArchiveCell {
  taskType: string;
  complexity: string;
  dimension: OptimizationDimension;
}

/**
 * An elite configuration stored in a cell.
 */
export interface EliteConfig {
  strategy: string;
  fitness: number;            // Fitness on the cell's optimization dimension
  avgQuality: number;
  avgCost: number;            // USD
  avgLatency: number;         // ms
  successRate: number;        // 0-1
  sampleCount: number;        // How many observations formed this elite
  avgTokens: number;          // Average total tokens
  lastUpdated: number;        // timestamp ms
  promotionSource: 'benchmark' | 'production' | 'champion-challenger';
}

/**
 * Full state of the archive for admin inspection.
 */
export interface ArchiveSnapshot {
  cellCount: number;
  totalElites: number;
  coverageByDimension: Record<OptimizationDimension, number>;
  coverageByTaskType: Record<string, number>;
  topElites: Array<ArchiveCell & EliteConfig>;
  lastSyncedAt: string | null;
}

// ─── Fitness Functions ──────────────────────────────────────────────────────

/**
 * Each optimization dimension has its own fitness function.
 * Higher fitness = better elite for that dimension.
 */
const FITNESS_FUNCTIONS: Record<OptimizationDimension, (e: EliteConfig) => number> = {
  'quality': (e) => e.avgQuality * e.successRate,
  'cost-efficient': (e) => {
    const cost = Math.max(e.avgCost, 0.0001);
    return (e.avgQuality * e.successRate) / cost;
  },
  'speed': (e) => {
    const latencyPenalty = Math.min(e.avgLatency / 30000, 1); // normalized to 30s max
    return e.avgQuality * e.successRate * (1 - latencyPenalty * 0.5);
  },
  'balanced': (e) => {
    const cost = Math.max(e.avgCost, 0.0001);
    const latencyNorm = Math.min(e.avgLatency / 10000, 1);
    return (
      e.avgQuality * 0.4 +
      e.successRate * 0.25 +
      (1 / (1 + cost * 100)) * 0.2 +
      (1 - latencyNorm) * 0.15
    );
  },
  'reliability': (e) => {
    // Weight success rate heavily, but require minimum quality
    return e.successRate * 0.7 + Math.min(e.avgQuality, 0.8) * 0.3;
  },
  'quality-per-token': (e) => {
    const tokens = Math.max(e.avgTokens, 100);
    return (e.avgQuality * e.successRate * 1000) / tokens;
  },
};

const ALL_DIMENSIONS: OptimizationDimension[] = [
  'quality', 'cost-efficient', 'speed', 'balanced', 'reliability', 'quality-per-token',
];

// ─── Archive Implementation ─────────────────────────────────────────────────

function cellKey(cell: ArchiveCell): string {
  return `${cell.taskType}|${cell.complexity}|${cell.dimension}`;
}

/**
 * ConfigurationArchive — quality-diversity archive.
 *
 * Each cell stores the best-performing strategy for a specific
 * (taskType, complexity, optimizationDimension) niche.
 */
class ConfigurationArchive {
  private elites = new Map<string, { cell: ArchiveCell; elite: EliteConfig }>();
  private lastSyncedAt: number | null = null;

  // S-NEW fix (ADR-004): Redis backing for cross-instance convergence
  private redis: import('./redis-backed-state').RedisBackedMap<{ cell: ArchiveCell; elite: EliteConfig }> | null = null;

  // Minimum observations before an entry can become an elite
  private static readonly MIN_SAMPLES = 5;
  // Sync interval to DB
  private static readonly SYNC_INTERVAL_MS = 3_600_000; // 1 hour
  // Decay factor for stale elites (applied during sync)
  private static readonly STALE_DECAY_DAYS = 14;
  private static readonly STALE_DECAY_FACTOR = 0.95;

  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startSyncTimer();
  }

  /**
   * S-NEW fix (ADR-004): Connect Redis backing for cross-instance convergence.
   * Feature-flagged via ARCHIVE_USE_REDIS=true.
   */
  async connectRedis(): Promise<void> {
    if (process.env.ARCHIVE_USE_REDIS !== 'true') return;
    try {
      const { RedisBackedMap } = await import('./redis-backed-state.js');
      const { getRedisClient } = await import('@/cache/redis-client.js');
      this.redis = new RedisBackedMap<{ cell: ArchiveCell; elite: EliteConfig }>({
        keyPrefix: 'archive:elites',
        localTtlMs: 5000, // 5s local cache — elites change less frequently than bandits
      });
      this.redis.connect(narrowAs<import('./redis-backed-state').RedisLike>(getRedisClient()));
      const loaded = await this.redis.loadAll();
      // Merge: Redis wins if it has higher fitness or more samples
      for (const [field, value] of this.redis.entries()) {
        const existing = this.elites.get(field);
        if (!existing || value.elite.fitness > existing.elite.fitness) {
          this.elites.set(field, value);
        }
      }
      log.info({ loaded, localElites: this.elites.size }, 'Configuration archive Redis backing connected');
    } catch (err) {
      log.warn({ err }, 'Failed to connect Redis backing for archive — operating local-only');
    }
  }

  /**
   * Try to insert a new configuration into the archive.
   * It will replace the current elite ONLY if the new config has higher fitness
   * on the cell's optimization dimension.
   *
   * Returns true if the new config became the elite, false if rejected.
   */
  tryInsert(
    taskType: string,
    complexity: string,
    config: Omit<EliteConfig, 'fitness' | 'lastUpdated'>,
    options?: { excludeDimensions?: OptimizationDimension[] },
  ): { inserted: boolean; cellsUpdated: string[] } {
    if (config.sampleCount < ConfigurationArchive.MIN_SAMPLES) {
      return { inserted: false, cellsUpdated: [] };
    }

    const cellsUpdated: string[] = [];
    const excludeSet = new Set(options?.excludeDimensions ?? []);

    // Try insertion across ALL dimensions — a single strategy can be elite
    // in multiple dimensions simultaneously (e.g., fastest AND most reliable)
    for (const dimension of ALL_DIMENSIONS) {
      if (excludeSet.has(dimension)) continue;
      const cell: ArchiveCell = { taskType, complexity, dimension };
      const key = cellKey(cell);

      const fitness = FITNESS_FUNCTIONS[dimension]({
        ...config,
        fitness: 0,
        lastUpdated: Date.now(),
      });

      const existing = this.elites.get(key);

      if (!existing || fitness > existing.elite.fitness) {
        const entry = {
          cell,
          elite: {
            ...config,
            fitness,
            lastUpdated: Date.now(),
          },
        };
        this.elites.set(key, entry);
        // S-NEW: sync to Redis for cross-instance convergence
        this.redis?.setFireAndForget(key, entry);
        cellsUpdated.push(dimension);

        if (existing) {
          log.debug({
            taskType, complexity, dimension,
            oldStrategy: existing.elite.strategy,
            oldFitness: existing.elite.fitness.toFixed(4),
            newStrategy: config.strategy,
            newFitness: fitness.toFixed(4),
          }, 'Elite replaced in archive');
        }
      }
    }

    return { inserted: cellsUpdated.length > 0, cellsUpdated };
  }

  /**
   * Get the elite configuration for a specific niche.
   * Returns null if no elite exists for the cell.
   */
  getElite(
    taskType: string,
    complexity: string,
    dimension: OptimizationDimension,
  ): EliteConfig | null {
    const key = cellKey({ taskType, complexity, dimension });
    return this.elites.get(key)?.elite ?? null;
  }

  /**
   * Get the best strategy recommendation for a given optimization preference.
   * Maps TriageStrategy → OptimizationDimension and returns the archive elite.
   */
  getRecommendation(
    taskType: string,
    complexity: string,
    triagePreference: string,
  ): { strategy: string; fitness: number; dimension: OptimizationDimension } | null {
    // Map triage strategy to archive dimension
    const dimensionMap: Record<string, OptimizationDimension> = {
      'speed': 'speed',
      'cost': 'cost-efficient',
      'quality': 'quality',
      'balanced': 'balanced',
      'adaptive': 'quality',  // Adaptive defaults to quality, adjusted dynamically
    };

    const dimension = dimensionMap[triagePreference] ?? 'balanced';
    const elite = this.getElite(taskType, complexity, dimension);

    if (!elite) return null;

    return {
      strategy: elite.strategy,
      fitness: elite.fitness,
      dimension,
    };
  }

  /**
   * Get all elites for a (taskType, complexity) pair across all dimensions.
   * Useful for showing the "bench of alternatives" when the primary strategy degrades.
   */
  getAlternatives(
    taskType: string,
    complexity: string,
  ): Array<{ dimension: OptimizationDimension; elite: EliteConfig }> {
    const results: Array<{ dimension: OptimizationDimension; elite: EliteConfig }> = [];

    for (const dimension of ALL_DIMENSIONS) {
      const elite = this.getElite(taskType, complexity, dimension);
      if (elite) {
        results.push({ dimension, elite });
      }
    }

    return results;
  }

  /**
   * Ingest results from a benchmark run — batch insert all strategy scores.
   */
  ingestBenchmarkResults(results: Array<{
    taskType: string;
    complexity: string;
    strategy: string;
    avgQuality: number;
    avgCost: number;
    avgLatency: number;
    successRate: number;
    sampleCount: number;
    avgTokens?: number;
  }>): { totalInserted: number; cellsUpdated: number } {
    let totalInserted = 0;
    let cellsUpdated = 0;

    for (const result of results) {
      const hasTokenData = result.avgTokens !== undefined && result.avgTokens > 0;
      const { inserted, cellsUpdated: cells } = this.tryInsert(
        result.taskType,
        result.complexity,
        {
          strategy: result.strategy,
          avgQuality: result.avgQuality,
          avgCost: result.avgCost,
          avgLatency: result.avgLatency,
          successRate: result.successRate,
          sampleCount: result.sampleCount,
          avgTokens: result.avgTokens ?? 0,
          promotionSource: 'benchmark',
        },
        // Exclude quality-per-token if no real token data provided
        hasTokenData ? undefined : { excludeDimensions: ['quality-per-token'] },
      );

      if (inserted) {
        totalInserted++;
        cellsUpdated += cells.length;
      }
    }

    log.info({ totalInserted, cellsUpdated, inputCount: results.length },
      'Benchmark results ingested into configuration archive');

    return { totalInserted, cellsUpdated };
  }

  /**
   * Ingest a single production execution result.
   * Accumulates incrementally — lighter than benchmark batch insertion.
   */
  ingestProductionResult(params: {
    taskType: string;
    complexity: string;
    strategy: string;
    qualityScore: number;
    costUsd: number;
    latencyMs: number;
    success: boolean;
    totalTokens?: number;
  }): void {
    // For production results, we need to merge with existing data incrementally.
    // Check if there's already an elite for this strategy in any dimension.
    const existingEntries = ALL_DIMENSIONS.map(dim => {
      const elite = this.getElite(params.taskType, params.complexity, dim);
      return { dim, elite };
    }).filter(e => e.elite?.strategy === params.strategy);

    if (existingEntries.length > 0) {
      // Update existing elite with exponential moving average
      for (const { dim, elite } of existingEntries) {
        if (!elite) continue;
        const alpha = 0.1; // EMA weight for new observation
        const updated: Omit<EliteConfig, 'fitness' | 'lastUpdated'> = {
          strategy: params.strategy,
          avgQuality: elite.avgQuality * (1 - alpha) + params.qualityScore * alpha,
          avgCost: elite.avgCost * (1 - alpha) + params.costUsd * alpha,
          avgLatency: elite.avgLatency * (1 - alpha) + params.latencyMs * alpha,
          successRate: elite.successRate * (1 - alpha) + (params.success ? 1 : 0) * alpha,
          sampleCount: elite.sampleCount + 1,
          avgTokens: elite.avgTokens * (1 - alpha) + (params.totalTokens ?? 0) * alpha,
          promotionSource: 'production',
        };

        const fitness = FITNESS_FUNCTIONS[dim]({
          ...updated,
          fitness: 0,
          lastUpdated: Date.now(),
        });

        const key = cellKey({ taskType: params.taskType, complexity: params.complexity, dimension: dim });
        const entry = {
          cell: { taskType: params.taskType, complexity: params.complexity, dimension: dim },
          elite: { ...updated, fitness, lastUpdated: Date.now() },
        };
        this.elites.set(key, entry);
        // S-NEW: sync to Redis
        this.redis?.setFireAndForget(key, entry);
      }
    } else {
      // No existing elite for this strategy — try a cold insert
      // Only if we have at least MIN_SAMPLES worth of prior data
      this.tryInsert(params.taskType, params.complexity, {
        strategy: params.strategy,
        avgQuality: params.qualityScore,
        avgCost: params.costUsd,
        avgLatency: params.latencyMs,
        successRate: params.success ? 1 : 0,
        sampleCount: 1, // Will be rejected by MIN_SAMPLES check — that's OK
        avgTokens: params.totalTokens ?? 0,
        promotionSource: 'production',
      });
    }
  }

  /**
   * Seed the archive from the strategy_weights DB table on cold start.
   * Uses the same data the bandit uses, but organizes it by fitness dimension.
   */
  async seedFromDB(): Promise<number> {
    try {
      const rows = await prisma.strategyWeight.findMany({
        where: { sampleCount: { gte: ConfigurationArchive.MIN_SAMPLES } },
      });

      let seeded = 0;
      for (const row of rows) {
        // strategy_weights table does NOT store latency or token data.
        // Set them to 0 and exclude dimensions that depend on them (speed,
        // quality-per-token) to avoid fabricating performance characteristics.
        // Those dimensions will only be populated by production/benchmark data
        // that actually measures latency and token usage.
        const { inserted } = this.tryInsert(
          row.taskType,
          row.complexity,
          {
            strategy: row.strategy,
            avgQuality: Number(row.avgQuality),
            avgCost: Number(row.avgCostEfficiency) > 0
              ? Number(row.avgQuality) / Number(row.avgCostEfficiency)
              : 0.01,
            avgLatency: 0,
            successRate: Number(row.successRate),
            sampleCount: row.sampleCount,
            avgTokens: 0,
            promotionSource: 'champion-challenger',
          },
          { excludeDimensions: ['speed', 'quality-per-token'] },
        );
        if (inserted) seeded++;
      }

      log.info({ seeded, totalRows: rows.length }, 'Configuration archive seeded from DB');
      return seeded;
    } catch (err) {
      log.warn({ error: String(err) }, 'Failed to seed configuration archive from DB');
      return 0;
    }
  }

  /**
   * Decay stale elites to prevent permanently pinned configurations.
   * Applied during periodic sync: elites older than STALE_DECAY_DAYS
   * have their fitness multiplied by STALE_DECAY_FACTOR.
   */
  private applyDecay(): number {
    const now = Date.now();
    const staleThreshold = now - ConfigurationArchive.STALE_DECAY_DAYS * 86_400_000;
    let decayed = 0;

    for (const [key, entry] of this.elites) {
      if (entry.elite.lastUpdated < staleThreshold) {
        entry.elite.fitness *= ConfigurationArchive.STALE_DECAY_FACTOR;
        this.elites.set(key, entry);
        // S-NEW: sync decay to Redis
        this.redis?.setFireAndForget(key, entry);
        decayed++;
      }
    }

    if (decayed > 0) {
      log.debug({ decayed }, 'Applied staleness decay to archive elites');
    }

    return decayed;
  }

  /**
   * Get full archive snapshot for admin inspection.
   */
  getSnapshot(): ArchiveSnapshot {
    const coverageByDimension: Record<string, number> = {};
    const coverageByTaskType: Record<string, number> = {};

    for (const dim of ALL_DIMENSIONS) {
      coverageByDimension[dim] = 0;
    }

    const topElites: Array<ArchiveCell & EliteConfig> = [];

    for (const entry of this.elites.values()) {
      coverageByDimension[entry.cell.dimension] =
        (coverageByDimension[entry.cell.dimension] ?? 0) + 1;
      coverageByTaskType[entry.cell.taskType] =
        (coverageByTaskType[entry.cell.taskType] ?? 0) + 1;

      topElites.push({
        ...entry.cell,
        ...entry.elite,
      });
    }

    // Sort by fitness descending
    topElites.sort((a, b) => b.fitness - a.fitness);

    return {
      cellCount: this.elites.size,
      totalElites: this.elites.size,
      coverageByDimension: coverageByDimension as Record<OptimizationDimension, number>,
      coverageByTaskType,
      topElites: topElites.slice(0, 50), // Cap at 50 for API response
      lastSyncedAt: this.lastSyncedAt
        ? new Date(this.lastSyncedAt).toISOString()
        : null,
    };
  }

  /**
   * Get archive statistics (lightweight).
   */
  getStats(): {
    cellCount: number;
    dimensionCoverage: Record<string, number>;
    uniqueStrategies: number;
    avgFitness: number;
    oldestEliteAge: number;
  } {
    const dimCoverage: Record<string, number> = {};
    const strategies = new Set<string>();
    let totalFitness = 0;
    let oldestTimestamp = Date.now();

    for (const entry of this.elites.values()) {
      dimCoverage[entry.cell.dimension] = (dimCoverage[entry.cell.dimension] ?? 0) + 1;
      strategies.add(entry.elite.strategy);
      totalFitness += entry.elite.fitness;
      if (entry.elite.lastUpdated < oldestTimestamp) {
        oldestTimestamp = entry.elite.lastUpdated;
      }
    }

    return {
      cellCount: this.elites.size,
      dimensionCoverage: dimCoverage,
      uniqueStrategies: strategies.size,
      avgFitness: this.elites.size > 0 ? totalFitness / this.elites.size : 0,
      oldestEliteAge: this.elites.size > 0 ? Date.now() - oldestTimestamp : 0,
    };
  }

  /**
   * Periodic sync: apply decay + log state.
   */
  private async periodicSync(): Promise<void> {
    this.applyDecay();
    this.lastSyncedAt = Date.now();
    const stats = this.getStats();
    log.info({
      cellCount: stats.cellCount,
      uniqueStrategies: stats.uniqueStrategies,
      avgFitness: stats.avgFitness.toFixed(4),
    }, 'Configuration archive periodic sync completed');
  }

  private startSyncTimer(): void {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => {
      this.periodicSync().catch(err => {
        log.warn({ error: String(err) }, 'Archive sync failed');
      });
    }, ConfigurationArchive.SYNC_INTERVAL_MS);

    // Don't prevent process shutdown
    if (this.syncTimer && typeof this.syncTimer === 'object' && 'unref' in this.syncTimer) {
      this.syncTimer.unref();
    }
  }

  /**
   * Shutdown — clean up timer.
   */
  shutdown(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
}

// ─── Singleton Export ───────────────────────────────────────────────────────

export const configurationArchive = new ConfigurationArchive();

export default configurationArchive;
