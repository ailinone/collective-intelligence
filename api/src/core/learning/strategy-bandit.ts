// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Thompson Sampling Bandit for Strategy Selection
 *
 * Maintains Beta(α, β) distributions per (taskType, complexity, strategy).
 * At selection time, samples from each distribution and picks the highest.
 * After execution, updates α (success) or β (failure) based on quality.
 *
 * Why Thompson Sampling:
 * - Exploration/exploitation balance: automatically explores uncertain strategies
 * - Bayesian: seeded with Bayesian priors from strategy_weights table
 * - Online: updates on every execution without a training phase
 * - Interpretable: α/(α+β) = estimated win rate, (α+β) = confidence
 *
 * Storage:
 * - In-memory: distributions updated after every execution
 * - Redis flush every FLUSH_INTERVAL_MS for cross-instance sharing
 * - DB read on cold start to seed from strategy_weights priors
 *
 * Quality threshold for success/failure classification:
 * - quality >= SUCCESS_THRESHOLD → α++
 * - quality < FAILURE_THRESHOLD → β++
 * - Between thresholds → partial update (proportional)
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { narrowAs } from '@/utils/type-guards';
import { learningBanditsAlpha, learningBanditsBeta, banditRollbacksTotal } from '@/observability/ci-metrics';

const log = logger.child({ component: 'strategy-bandit' });

const SUCCESS_THRESHOLD = 0.75;
const FAILURE_THRESHOLD = 0.50;
const FLUSH_INTERVAL_MS = 30_000;
// Minimum number of observations before bandit takes over from prior
const MIN_OBSERVATIONS_FOR_OVERRIDE = 5;

interface BetaParams {
  alpha: number; // successes + 1
  beta: number;  // failures  + 1
}

type BanditKey = string; // `${taskType}|${complexity}|${strategy}`

function key(taskType: string, complexity: string, strategy: string): BanditKey {
  return `${taskType}|${complexity}|${strategy}`;
}

/** Standard normal draw via Box–Muller. */
function gaussianSample(): number {
  let u = 0;
  while (u === 0) u = Math.random(); // avoid log(0)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/**
 * Gamma(shape, 1) draw via Marsaglia & Tsang (2000) squeeze method. For
 * shape < 1 we boost to shape+1 and rescale by U^(1/shape), keeping the
 * method exact across the whole domain (bandit priors can be fractional).
 * The rejection loop accepts in ~1.0–1.5 iterations on average.
 */
function gammaSample(shape: number): number {
  if (shape < 1) {
    let u = 0;
    while (u === 0) u = Math.random();
    return gammaSample(shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = gaussianSample();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * TRUE Beta(α, β) draw via two Gamma draws: X/(X+Y) with X~Gamma(α), Y~Gamma(β).
 *
 * This must be a real Beta draw, not a mean±noise approximation: an unexplored
 * arm has Beta(1,1) = Uniform(0,1) and needs a fair chance of sampling above an
 * incumbent's posterior mean for Thompson exploration to work at all. The
 * previous approximation kept fresh arms pinned near 0.5, which froze
 * exploration of never-selected strategies (audit: cold-start trap) — and its
 * docstring wrongly claimed "Johnk's method".
 *
 * Inputs are floored at 1e-6 (seeded priors can be fractional/zero); output is
 * clamped to [0.01, 0.99] to preserve the exploration contract (never fully
 * exploit/discard an arm on a single draw). Exported for statistical tests.
 */
export function betaSample(alpha: number, beta: number): number {
  const a = alpha > 0 ? alpha : 1e-6;
  const b = beta > 0 ? beta : 1e-6;
  const x = gammaSample(a);
  const y = gammaSample(b);
  const sum = x + y;
  if (!Number.isFinite(sum) || sum <= 0) return a / (a + b); // degenerate guard
  return Math.max(0.01, Math.min(0.99, x / sum));
}

/**
 * Success-Story Snapshot — stores bandit state at a point in time
 * for auto-rollback if reward rate degrades (Schmidhuber 1994 principle).
 */
interface SuccessStorySnapshot {
  snapshotId: string;
  timestamp: number;
  params: Map<BanditKey, BetaParams>;
  rewardRate: number; // avg quality / avg latency ratio at snapshot time
}

/** Recent execution window for reward rate calculation */
interface RecentExecution {
  qualityScore: number;
  durationMs: number;
  timestamp: number;
}

/** Auto-rollback configuration */
const ROLLBACK_CONFIG = {
  /** How often to snapshot (ms) — default 6 hours */
  snapshotIntervalMs: parseInt(process.env.BANDIT_SNAPSHOT_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10),
  /** Max snapshots to retain */
  maxSnapshots: parseInt(process.env.BANDIT_MAX_SNAPSHOTS || '20', 10),
  /** Degradation threshold for auto-rollback — if reward rate drops below this fraction of best snapshot */
  degradationThreshold: parseFloat(process.env.BANDIT_ROLLBACK_THRESHOLD || '0.95'),
  /** Minimum executions in window before rollback check activates */
  minExecutionsForCheck: parseInt(process.env.BANDIT_MIN_EXECUTIONS || '50', 10),
  /** Sliding window for reward rate (ms) — default 24 hours */
  rewardWindowMs: parseInt(process.env.BANDIT_REWARD_WINDOW_MS || String(24 * 60 * 60 * 1000), 10),
};

class StrategyBandit {
  private readonly params = new Map<BanditKey, BetaParams>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  // S-NEW fix (ADR-004): Redis backing for cross-instance convergence
  private redis: import('./redis-backed-state').RedisBackedMap<BetaParams> | null = null;

  // Success-Story state
  private snapshots: SuccessStorySnapshot[] = [];
  private recentExecutions: RecentExecution[] = [];
  private lastRollbackAt = 0;

  constructor() {
    this.startFlushTimer();
    this.startSnapshotTimer();
    // Warm up from DB on first use (lazy)
  }

  /**
   * S-NEW fix (ADR-004): Connect Redis backing for cross-instance convergence.
   * After connecting, every params.set() also writes to Redis, and cold start
   * loads from Redis before seeding from DB. Feature-flagged via BANDIT_USE_REDIS=true.
   */
  async connectRedis(): Promise<void> {
    if (process.env.BANDIT_USE_REDIS !== 'true') return;
    try {
      const { RedisBackedMap } = await import('./redis-backed-state.js');
      const { getRedisClient } = await import('@/cache/redis-client.js');
      this.redis = new RedisBackedMap<BetaParams>({
        keyPrefix: 'bandit:strategy',
        localTtlMs: 1000, // 1s local cache — hot reads use local, converge within 1s
      });
      this.redis.connect(narrowAs<import('./redis-backed-state').RedisLike>(getRedisClient()));
      // Load existing state from Redis (other instances may have updated it)
      const loaded = await this.redis.loadAll();
      // Merge Redis state into local params (Redis wins for convergence)
      for (const [field, value] of this.redis.entries()) {
        const existing = this.params.get(field as BanditKey);
        // Only overwrite local if Redis has more observations (higher alpha+beta)
        if (!existing || (value.alpha + value.beta) > (existing.alpha + existing.beta)) {
          this.params.set(field as BanditKey, value);
        }
      }
      log.info({ loaded, localParams: this.params.size }, 'Strategy bandit Redis backing connected');
    } catch (err) {
      log.warn({ err }, 'Failed to connect Redis backing for strategy bandit — operating local-only');
    }
  }

  /**
   * Select the best strategy for a (taskType, complexity) pair using Thompson Sampling.
   * Returns null if no strategies have been registered yet for this context.
   */
  selectStrategy(
    taskType: string,
    complexity: string,
    candidateStrategies: string[]
  ): { strategy: string; sampledScore: number } | null {
    if (candidateStrategies.length === 0) return null;

    // Warm up lazily on first call
    if (!this.initialized) {
      // Non-blocking; will be seeded on next call if this one is cold
      this.seedFromDB().catch((e) => log.warn({ error: String(e) }, 'Bandit seed failed'));
      this.initialized = true;
    }

    let bestStrategy = candidateStrategies[0];
    let bestScore = -1;

    for (const strategy of candidateStrategies) {
      const k = key(taskType, complexity, strategy);
      const params = this.params.get(k) ?? { alpha: 1, beta: 1 }; // Uninformative prior
      const score = betaSample(params.alpha, params.beta);

      if (score > bestScore) {
        bestScore = score;
        bestStrategy = strategy;
      }
    }

    log.debug(
      { taskType, complexity, selected: bestStrategy, sampledScore: bestScore },
      'Bandit selected strategy'
    );

    return { strategy: bestStrategy, sampledScore: bestScore };
  }

  /**
   * Get the estimated win rate for each strategy (mean of Beta distribution).
   * Useful for logging and metrics.
   */
  getWinRates(
    taskType: string,
    complexity: string,
    strategies: string[]
  ): Record<string, number> {
    const rates: Record<string, number> = {};
    for (const strategy of strategies) {
      const k = key(taskType, complexity, strategy);
      const p = this.params.get(k) ?? { alpha: 1, beta: 1 };
      rates[strategy] = p.alpha / (p.alpha + p.beta);
    }
    return rates;
  }

  /**
   * Update the bandit after an execution result.
   *
   * @param qualityScore 0–1 quality score from the execution
   */
  update(params: {
    taskType: string;
    complexity: string;
    strategy: string;
    qualityScore: number;
  }): void {
    const { taskType, complexity, strategy, qualityScore } = params;
    const k = key(taskType, complexity, strategy);
    const current = this.params.get(k) ?? { alpha: 1, beta: 1 };

    let newAlpha = current.alpha;
    let newBeta = current.beta;

    if (qualityScore >= SUCCESS_THRESHOLD) {
      newAlpha += 1;
    } else if (qualityScore < FAILURE_THRESHOLD) {
      newBeta += 1;
    } else {
      // Partial update: interpolate between success and failure
      const successFraction = (qualityScore - FAILURE_THRESHOLD) / (SUCCESS_THRESHOLD - FAILURE_THRESHOLD);
      newAlpha += successFraction;
      newBeta += 1 - successFraction;
    }

    this.params.set(k, { alpha: newAlpha, beta: newBeta });

    // S-NEW fix: Sync to Redis for cross-instance convergence (fire-and-forget)
    this.redis?.setFireAndForget(k, { alpha: newAlpha, beta: newBeta });

    // Update Prometheus gauges
    learningBanditsAlpha.set({ task_type: taskType, complexity, strategy }, newAlpha);
    learningBanditsBeta.set({ task_type: taskType, complexity, strategy }, newBeta);
  }

  /**
   * Get observations count for a (taskType, complexity, strategy) triple.
   * Returns 0 if never observed.
   */
  /**
   * Read-only export of every niche's Beta parameters, for longitudinal
   * learning snapshots (P1-3 / LN-02). No side effects — unlike
   * takeSnapshot(), which participates in the success-story rollback cycle.
   */
  getAllParams(): Array<{ niche: BanditKey; alpha: number; beta: number }> {
    return [...this.params.entries()].map(([niche, p]) => ({
      niche,
      alpha: p.alpha,
      beta: p.beta,
    }));
  }

  getObservationCount(taskType: string, complexity: string, strategy: string): number {
    const p = this.params.get(key(taskType, complexity, strategy));
    if (!p) return 0;
    // Total observations ≈ (α + β - 2) since priors start at (1, 1)
    return Math.max(0, Math.round(p.alpha + p.beta - 2));
  }

  /**
   * Whether the bandit has enough observations to override a static recommendation.
   */
  hasConfidence(taskType: string, complexity: string, strategy: string): boolean {
    return this.getObservationCount(taskType, complexity, strategy) >= MIN_OBSERVATIONS_FOR_OVERRIDE;
  }

  /**
   * Seed bandit priors from the strategy_weights table.
   * Each row becomes a Beta(α, β) where:
   *   α = success_rate * sample_count + 1
   *   β = (1 - success_rate) * sample_count + 1
   *
   * This gives the bandit a warm start without requiring fresh samples.
   */
  async seedFromDB(): Promise<void> {
    try {
      const rows = await prisma.$queryRaw<
        Array<{
          task_type: string;
          complexity: string;
          strategy: string;
          success_rate: string;
          sample_count: number;
        }>
      >`
        SELECT task_type, complexity, strategy, success_rate, sample_count
        FROM strategy_weights
        WHERE sample_count >= 5
      `;

      for (const row of rows) {
        const successRate = parseFloat(row.success_rate);
        const n = typeof row.sample_count === 'number' ? row.sample_count : parseInt(String(row.sample_count), 10);
        const alpha = successRate * n + 1;
        const beta = (1 - successRate) * n + 1;
        const k = key(row.task_type, row.complexity, row.strategy);
        // Only update if we don't have fresher in-memory data
        if (!this.params.has(k)) {
          this.params.set(k, { alpha, beta });
        }
      }

      // Also seed informed priors for new strategies based on theoretical performance
      // This prevents cold-start bias toward 'single' when new collective strategies are available
      const theoreticalPriors: Array<{ strategy: string; successRate: number; taskTypes: string[] }> = [
        { strategy: 'blind-debate', successRate: 0.70, taskTypes: ['analysis', 'reasoning', 'code-review'] },
        { strategy: 'devil-advocate-consensus', successRate: 0.72, taskTypes: ['analysis', 'code-review', 'debugging'] },
        { strategy: 'safety-quorum', successRate: 0.80, taskTypes: ['general'] },
        { strategy: 'diversity-ensemble', successRate: 0.68, taskTypes: ['analysis', 'reasoning', 'creative'] },
        { strategy: 'stigmergic-refinement', successRate: 0.75, taskTypes: ['documentation', 'creative'] },
        { strategy: 'swarm-explore', successRate: 0.65, taskTypes: ['analysis', 'creative', 'reasoning'] },
        { strategy: 'clarification-first', successRate: 0.70, taskTypes: ['general', 'analysis', 'creative'] },
        { strategy: 'research-synthesize', successRate: 0.75, taskTypes: ['factual-qa', 'analysis', 'reasoning'] },
        { strategy: 'critique-repair', successRate: 0.80, taskTypes: ['code-generation', 'documentation', 'analysis'] },
        { strategy: 'double-diamond', successRate: 0.70, taskTypes: ['analysis', 'creative', 'general'] },
        { strategy: 'multi-hop-qa', successRate: 0.75, taskTypes: ['reasoning', 'factual-qa', 'analysis'] },
        { strategy: 'persona-exploration', successRate: 0.70, taskTypes: ['creative', 'analysis', 'general'] },
        { strategy: 'agentic', successRate: 0.65, taskTypes: ['code-generation', 'refactoring', 'testing', 'debugging'] },
      ];
      const PRIOR_STRENGTH = 3; // Equivalent to 3 observations — enough to be considered, not enough to dominate
      for (const prior of theoreticalPriors) {
        for (const taskType of prior.taskTypes) {
          for (const complexity of ['low', 'medium', 'high']) {
            const k = key(taskType, complexity, prior.strategy);
            if (!this.params.has(k)) {
              this.params.set(k, {
                alpha: prior.successRate * PRIOR_STRENGTH + 1,
                beta: (1 - prior.successRate) * PRIOR_STRENGTH + 1,
              });
            }
          }
        }
      }

      log.info({ seeded: rows.length, theoreticalPriors: theoreticalPriors.length }, 'Bandit seeded from strategy_weights DB + theoretical priors');
    } catch (err) {
      log.warn({ error: String(err) }, 'Bandit DB seed failed; using uninformative priors');
    }
  }

  private startFlushTimer(): void {
    if (typeof setInterval === 'undefined') return;
    this.flushTimer = setInterval(() => {
      this.flushToMetrics();
    }, FLUSH_INTERVAL_MS);
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  private flushToMetrics(): void {
    for (const [k, p] of this.params) {
      const [taskType, complexity, strategy] = k.split('|');
      if (!taskType || !complexity || !strategy) continue;
      learningBanditsAlpha.set({ task_type: taskType, complexity, strategy }, p.alpha);
      learningBanditsBeta.set({ task_type: taskType, complexity, strategy }, p.beta);
    }
  }

  // ─── Success-Story Auto-Rollback (OI-03) ──────────────────────────────────

  /**
   * Record an execution for reward rate tracking.
   * Called after every orchestration execution.
   */
  recordExecution(qualityScore: number, durationMs: number): void {
    this.recentExecutions.push({
      qualityScore,
      durationMs,
      timestamp: Date.now(),
    });

    // Prune old executions outside the reward window
    const cutoff = Date.now() - ROLLBACK_CONFIG.rewardWindowMs;
    this.recentExecutions = this.recentExecutions.filter(e => e.timestamp > cutoff);

    // Check for degradation after recording
    this.checkForDegradation();
  }

  /**
   * Take a snapshot of current bandit state with reward rate.
   * Called periodically (default: every 6 hours).
   */
  takeSnapshot(): SuccessStorySnapshot | null {
    const rewardRate = this.calculateCurrentRewardRate();
    if (rewardRate === null) return null; // Not enough data

    const snapshot: SuccessStorySnapshot = {
      snapshotId: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      params: new Map(
        [...this.params.entries()].map(([k, v]) => [k, { alpha: v.alpha, beta: v.beta }])
      ),
      rewardRate,
    };

    this.snapshots.push(snapshot);

    // Prune old snapshots beyond max
    if (this.snapshots.length > ROLLBACK_CONFIG.maxSnapshots) {
      this.snapshots = this.snapshots.slice(-ROLLBACK_CONFIG.maxSnapshots);
    }

    log.info({
      snapshotId: snapshot.snapshotId,
      rewardRate: rewardRate.toFixed(4),
      paramsCount: this.params.size,
      totalSnapshots: this.snapshots.length,
    }, 'Success-Story snapshot taken');

    return snapshot;
  }

  /**
   * Check if current reward rate has degraded below the best historical
   * snapshot. If so, rollback to the best snapshot.
   */
  private checkForDegradation(): void {
    if (this.snapshots.length < 2) return;
    if (this.recentExecutions.length < ROLLBACK_CONFIG.minExecutionsForCheck) return;

    // Don't rollback more than once per snapshot interval
    if (Date.now() - this.lastRollbackAt < ROLLBACK_CONFIG.snapshotIntervalMs) return;

    const currentRewardRate = this.calculateCurrentRewardRate();
    if (currentRewardRate === null) return;

    // Find the best historical snapshot
    const bestSnapshot = this.snapshots.reduce((best, snap) =>
      snap.rewardRate > best.rewardRate ? snap : best
    );

    const ratio = currentRewardRate / bestSnapshot.rewardRate;

    if (ratio < ROLLBACK_CONFIG.degradationThreshold) {
      log.error({
        currentRewardRate: currentRewardRate.toFixed(4),
        bestRewardRate: bestSnapshot.rewardRate.toFixed(4),
        ratio: ratio.toFixed(3),
        threshold: ROLLBACK_CONFIG.degradationThreshold,
        rollingBackTo: bestSnapshot.snapshotId,
      }, 'SUCCESS-STORY ROLLBACK — reward rate degraded, restoring best snapshot');

      this.rollbackToSnapshot(bestSnapshot);
      this.lastRollbackAt = Date.now();
      banditRollbacksTotal.inc();
    }
  }

  /**
   * Restore bandit state from a snapshot.
   */
  private rollbackToSnapshot(snapshot: SuccessStorySnapshot): void {
    this.params.clear();
    for (const [k, v] of snapshot.params) {
      this.params.set(k, { alpha: v.alpha, beta: v.beta });
    }

    log.warn({
      snapshotId: snapshot.snapshotId,
      snapshotAge: Date.now() - snapshot.timestamp,
      paramsRestored: snapshot.params.size,
    }, 'Bandit state rolled back to snapshot');
  }

  /**
   * Calculate current reward rate = avg_quality / avg_latency_seconds.
   * Returns null if not enough data.
   */
  private calculateCurrentRewardRate(): number | null {
    if (this.recentExecutions.length < 10) return null;

    const avgQuality = this.recentExecutions.reduce((s, e) => s + e.qualityScore, 0)
      / this.recentExecutions.length;
    const avgLatencySec = this.recentExecutions.reduce((s, e) => s + e.durationMs, 0)
      / this.recentExecutions.length / 1000;

    if (avgLatencySec === 0) return null;
    return avgQuality / avgLatencySec;
  }

  /**
   * Get current Success-Story state for monitoring/admin.
   */
  getSuccessStoryState(): {
    currentRewardRate: number | null;
    snapshotCount: number;
    bestRewardRate: number;
    recentExecutionCount: number;
    lastRollbackAt: number;
  } {
    const currentRewardRate = this.calculateCurrentRewardRate();
    const bestRewardRate = this.snapshots.length > 0
      ? Math.max(...this.snapshots.map(s => s.rewardRate))
      : 0;

    return {
      currentRewardRate,
      snapshotCount: this.snapshots.length,
      bestRewardRate,
      recentExecutionCount: this.recentExecutions.length,
      lastRollbackAt: this.lastRollbackAt,
    };
  }

  private startSnapshotTimer(): void {
    if (typeof setInterval === 'undefined') return;
    this.snapshotTimer = setInterval(() => {
      this.takeSnapshot();
    }, ROLLBACK_CONFIG.snapshotIntervalMs);
    if (this.snapshotTimer && typeof this.snapshotTimer === 'object' && 'unref' in this.snapshotTimer) {
      (this.snapshotTimer as NodeJS.Timeout).unref();
    }
  }

  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  /**
   * C3 P0.2: Random strategy selection (ablation baseline).
   * Used when bandit is ablated to isolate its contribution.
   */
  selectStrategyRandom(
    candidateStrategies: string[]
  ): { strategy: string; sampledScore: number } | null {
    if (candidateStrategies.length === 0) return null;
    const idx = Math.floor(Math.random() * candidateStrategies.length);
    return { strategy: candidateStrategies[idx], sampledScore: 0 };
  }

  /**
   * C3 P1.5: Epsilon-greedy selection (learning baseline comparison).
   */
  selectStrategyEpsilonGreedy(
    taskType: string,
    complexity: string,
    candidateStrategies: string[],
    epsilon = 0.1
  ): { strategy: string; sampledScore: number } | null {
    if (candidateStrategies.length === 0) return null;
    if (Math.random() < epsilon) {
      return this.selectStrategyRandom(candidateStrategies);
    }
    let bestStrategy = candidateStrategies[0];
    let bestRate = -1;
    for (const strategy of candidateStrategies) {
      const k = key(taskType, complexity, strategy);
      const p = this.params.get(k) ?? { alpha: 1, beta: 1 };
      const rate = p.alpha / (p.alpha + p.beta);
      if (rate > bestRate) {
        bestRate = rate;
        bestStrategy = strategy;
      }
    }
    return { strategy: bestStrategy, sampledScore: bestRate };
  }
}

// Singleton
export const strategyBandit = new StrategyBandit();
