// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Statistical Analysis Engine
 *
 * Pure math functions for experiment analysis. No external dependencies,
 * no database calls — just numbers in, statistics out.
 *
 * Key capabilities:
 * - Descriptive statistics (mean, median, percentiles, stddev)
 * - Confidence intervals (z-based for large n, t-based for small n)
 * - Welch's t-test (two-sample, unequal variances)
 * - Cohen's d effect size
 * - Win rate comparison
 * - Pareto dominance analysis
 * - Outlier detection (IQR method)
 * - Stability index (coefficient of variation)
 */

import type {
  DescriptiveStats,
  ConfidenceInterval,
  TTestResult,
  EffectSizeResult,
  EffectSizeCategory,
  WinRateComparison,
  ParetoPoint,
  ParetoDominanceResult,
  CompositeRegret,
  CompositeEfficiency,
} from './experiment-types';

// ─── Descriptive Statistics ────────────────────────────────────────────────

/**
 * Compute comprehensive descriptive statistics for a set of values.
 * Returns zeros for empty arrays.
 */
export function computeDescriptiveStats(values: number[]): DescriptiveStats {
  const n = values.length;
  if (n === 0) {
    return {
      n: 0, mean: 0, median: 0, stddev: 0, variance: 0,
      min: 0, max: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p99: 0, iqr: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / n;

  // Variance (Bessel's correction for sample variance)
  const variance = n > 1
    ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
    : 0;
  const stddev = Math.sqrt(variance);

  return {
    n,
    mean,
    median: percentile(sorted, 0.5),
    stddev,
    variance,
    min: sorted[0],
    max: sorted[n - 1],
    p10: percentile(sorted, 0.10),
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.50),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.90),
    p99: percentile(sorted, 0.99),
    iqr: percentile(sorted, 0.75) - percentile(sorted, 0.25),
  };
}

/** Linear interpolation percentile on a pre-sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;

  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}

// ─── Confidence Intervals ──────────────────────────────────────────────────

/**
 * Compute a confidence interval for the mean.
 * Uses z-approximation for n >= 30, t-approximation for smaller samples.
 */
export function computeConfidenceInterval(
  values: number[],
  confidence: number = 0.95,
): ConfidenceInterval {
  const n = values.length;
  if (n === 0) {
    return { mean: 0, lower: 0, upper: 0, marginOfError: 0, confidenceLevel: confidence, n: 0 };
  }

  const stats = computeDescriptiveStats(values);
  const se = stats.stddev / Math.sqrt(n);

  // Critical value: z for large samples, t-approximation for small
  const alpha = 1 - confidence;
  const critical = n >= 30
    ? zInv(1 - alpha / 2)
    : tInv(1 - alpha / 2, n - 1);

  const marginOfError = critical * se;

  return {
    mean: stats.mean,
    lower: stats.mean - marginOfError,
    upper: stats.mean + marginOfError,
    marginOfError,
    confidenceLevel: confidence,
    n,
  };
}

// ─── Welch's t-Test ────────────────────────────────────────────────────────

/**
 * Two-sample Welch's t-test for unequal variances.
 * Tests H0: mean(group1) = mean(group2).
 * Returns p-value and significance at the given confidence level.
 */
export function welchTTest(
  group1: number[],
  group2: number[],
  confidenceLevel: number = 0.95,
): TTestResult {
  const n1 = group1.length;
  const n2 = group2.length;

  if (n1 < 2 || n2 < 2) {
    return { tStatistic: 0, degreesOfFreedom: 0, pValue: 1, significant: false, confidenceLevel };
  }

  const mean1 = group1.reduce((s, v) => s + v, 0) / n1;
  const mean2 = group2.reduce((s, v) => s + v, 0) / n2;

  const var1 = group1.reduce((s, v) => s + (v - mean1) ** 2, 0) / (n1 - 1);
  const var2 = group2.reduce((s, v) => s + (v - mean2) ** 2, 0) / (n2 - 1);

  const se1 = var1 / n1;
  const se2 = var2 / n2;
  const seDiff = Math.sqrt(se1 + se2);

  if (seDiff === 0) {
    return { tStatistic: 0, degreesOfFreedom: n1 + n2 - 2, pValue: 1, significant: false, confidenceLevel };
  }

  const t = (mean1 - mean2) / seDiff;

  // Welch-Satterthwaite degrees of freedom
  const df = (se1 + se2) ** 2 / (se1 ** 2 / (n1 - 1) + se2 ** 2 / (n2 - 1));

  // Two-tailed p-value via t-distribution CDF
  const pValue = 2 * (1 - tCDF(Math.abs(t), df));

  const alpha = 1 - confidenceLevel;

  return {
    tStatistic: t,
    degreesOfFreedom: df,
    pValue: Math.max(0, Math.min(1, pValue)),
    significant: pValue < alpha,
    confidenceLevel,
  };
}

// ─── Effect Size ───────────────────────────────────────────────────────────

/**
 * Cohen's d effect size: standardized mean difference between two groups.
 * Uses pooled standard deviation.
 */
export function effectSize(group1: number[], group2: number[]): EffectSizeResult {
  const n1 = group1.length;
  const n2 = group2.length;

  if (n1 < 2 || n2 < 2) {
    return { cohensD: 0, category: 'negligible' };
  }

  const mean1 = group1.reduce((s, v) => s + v, 0) / n1;
  const mean2 = group2.reduce((s, v) => s + v, 0) / n2;

  const var1 = group1.reduce((s, v) => s + (v - mean1) ** 2, 0) / (n1 - 1);
  const var2 = group2.reduce((s, v) => s + (v - mean2) ** 2, 0) / (n2 - 1);

  // Pooled standard deviation
  const pooledSD = Math.sqrt(((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2));

  if (pooledSD === 0) {
    return { cohensD: 0, category: 'negligible' };
  }

  const d = (mean1 - mean2) / pooledSD;
  const absD = Math.abs(d);

  let category: EffectSizeCategory;
  if (absD < 0.2) category = 'negligible';
  else if (absD < 0.5) category = 'small';
  else if (absD < 0.8) category = 'medium';
  else category = 'large';

  return { cohensD: d, category };
}

// ─── Win Rate ──────────────────────────────────────────────────────────────

/**
 * Compare paired scores: for each (i), which group wins?
 * Groups must be same length (paired by task).
 * Tie threshold: scores within ±0.02 are considered ties.
 */
export function computeWinRate(
  groupA: number[],
  groupB: number[],
  tieThreshold: number = 0.02,
): WinRateComparison {
  const total = Math.min(groupA.length, groupB.length);
  let aWins = 0, bWins = 0, ties = 0;

  for (let i = 0; i < total; i++) {
    const diff = groupA[i] - groupB[i];
    if (diff > tieThreshold) aWins++;
    else if (diff < -tieThreshold) bWins++;
    else ties++;
  }

  return {
    groupAWins: aWins,
    groupBWins: bWins,
    ties,
    groupAWinRate: total > 0 ? aWins / total : 0,
    groupBWinRate: total > 0 ? bWins / total : 0,
    total,
  };
}

// ─── Paired-by-task comparison (removes task-mix confounding) ────────────────

/** A single (taskIndex → value) observation for paired comparison. */
export interface TaskScore {
  taskIndex: number;
  value: number;
}

/**
 * Pair two arms' scores by taskIndex and return the per-task deltas
 * (groupA − groupB) over the COMMON task set (inner join on taskIndex).
 *
 * WHY: comparing two arms' POOLED means is confounded whenever the arms did not
 * run the exact same task mix — an arm that happened to run an easier subset
 * gets a spuriously higher mean. That confounding produced the wrong v4
 * "collective beats single" headline; like-for-like was parity. Pairing by task
 * is the fix. Repetitions within a (taskIndex) cell are AVERAGED before pairing
 * so each shared task contributes exactly one matched delta.
 */
export function pairByTaskDeltas(groupA: TaskScore[], groupB: TaskScore[]): number[] {
  const meanByTask = (rows: TaskScore[]): Map<number, number> => {
    const acc = new Map<number, { sum: number; n: number }>();
    for (const r of rows) {
      if (!Number.isFinite(r.value)) continue;
      const cur = acc.get(r.taskIndex) ?? { sum: 0, n: 0 };
      cur.sum += r.value;
      cur.n += 1;
      acc.set(r.taskIndex, cur);
    }
    const out = new Map<number, number>();
    for (const [k, { sum, n }] of acc) if (n > 0) out.set(k, sum / n);
    return out;
  };
  const a = meanByTask(groupA);
  const b = meanByTask(groupB);
  const deltas: number[] = [];
  for (const [taskIndex, av] of a) {
    const bv = b.get(taskIndex);
    if (bv !== undefined) deltas.push(av - bv);
  }
  return deltas;
}

/** Mean of a delta array (0 when empty). */
export function meanDelta(deltas: number[]): number {
  return deltas.length ? deltas.reduce((s, v) => s + v, 0) / deltas.length : 0;
}

/**
 * The sorted list of taskIndex values present in BOTH groups — the exact task
 * set `pairByTaskDeltas` computed its deltas over (same length, same inner
 * join). Exists so a report can show its audit trail (which tasks a paired
 * verdict is based on), not just the resulting numbers.
 */
export function sharedTaskIndices(groupA: readonly TaskScore[], groupB: readonly TaskScore[]): number[] {
  const aIdx = new Set(groupA.map((r) => r.taskIndex));
  const bIdx = new Set(groupB.map((r) => r.taskIndex));
  const shared: number[] = [];
  for (const i of aIdx) if (bIdx.has(i)) shared.push(i);
  return shared.sort((x, y) => x - y);
}

/**
 * Benjamini-Hochberg FDR q-values for a family of simultaneous tests.
 *
 * When a report runs MANY paired comparisons at once (e.g. ~31 strategies ×
 * ~15 scenarios ≈ 465 cells), judging each at raw p < 0.05 manufactures ~23
 * false "significant wins" by chance alone — a leaderboard built on raw
 * p-values is largely noise at the tails. BH controls the FALSE DISCOVERY RATE:
 * q_i is the smallest FDR level at which test i would be declared significant,
 * so cells with q < 0.05 form a set in which ≤5% are expected to be false
 * discoveries. Standard step-up procedure: sort ascending, q_(k) =
 * min(prev, p_(k)·m/k) walking from the largest rank down.
 *
 * Input entries may be null (test not run — e.g. INSUFFICIENT_DATA cells);
 * nulls are excluded from the family size m and returned as null, positionally
 * aligned with the input.
 */
export function benjaminiHochbergQValues(pValues: ReadonlyArray<number | null>): Array<number | null> {
  const indexed = pValues
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: number; i: number } => x.p != null && Number.isFinite(x.p));
  const m = indexed.length;
  const out: Array<number | null> = pValues.map(() => null);
  if (m === 0) return out;

  indexed.sort((a, b) => a.p - b.p);
  let prev = 1;
  const q = new Array<number>(m);
  for (let k = m - 1; k >= 0; k--) {
    prev = Math.min(prev, (indexed[k].p * m) / (k + 1));
    q[k] = prev;
  }
  indexed.forEach((x, k) => {
    out[x.i] = Math.min(1, Math.max(0, q[k]));
  });
  return out;
}

/**
 * One-sample t-test of a per-task delta array against 0 (paired/matched design).
 * `significant` means the mean per-task delta differs from zero — the honest
 * test for "does the collective beat the single on the SAME tasks". Requires ≥2
 * shared tasks.
 */
export function pairedTTest(deltas: number[], confidenceLevel: number = 0.95): TTestResult {
  const n = deltas.length;
  if (n < 2) {
    return { tStatistic: 0, degreesOfFreedom: 0, pValue: 1, significant: false, confidenceLevel };
  }
  const mean = meanDelta(deltas);
  const variance = deltas.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const alpha = 1 - confidenceLevel;
  if (sd === 0) {
    const nonZero = Math.abs(mean) > 1e-12;
    if (!nonZero) {
      // Every task moved by exactly 0 → no effect.
      return { tStatistic: 0, degreesOfFreedom: n - 1, pValue: 1, significant: false, confidenceLevel };
    }
    // Zero WITHIN-sample variance: the t-statistic is undefined (se = 0). The old
    // code fabricated pValue = 0 — "infinite confidence" from as few as n = 2
    // identical deltas, which is exactly what binary 0/1 scores produce (two
    // tasks both flip 0→1 → deltas [1,1] → sd 0 → a fake "perfectly significant"
    // result). Fall back to the two-sided SIGN TEST, which assumes no variance:
    // under H0 the chance all n deltas share a sign is 2·0.5^n. n=2 → 0.5 (NOT
    // significant); n=5 → 0.0625; n=6 → 0.03125. Honest, and never 0. (review STAT-3)
    const signP = Math.min(1, 2 * Math.pow(0.5, n));
    return {
      tStatistic: mean > 0 ? 1e6 : -1e6, // finite sentinel (Infinity → JSON null)
      degreesOfFreedom: n - 1,
      pValue: signP,
      significant: signP < alpha,
      confidenceLevel,
    };
  }
  const se = sd / Math.sqrt(n);
  const t = mean / se;
  const df = n - 1;
  const pValue = 2 * (1 - tCDF(Math.abs(t), df));
  return {
    tStatistic: t,
    degreesOfFreedom: df,
    pValue: Math.max(0, Math.min(1, pValue)),
    significant: pValue < alpha,
    confidenceLevel,
  };
}

/** Cohen's d for a paired design: mean delta / SD of deltas. */
export function pairedCohensD(deltas: number[]): EffectSizeResult {
  const n = deltas.length;
  if (n < 2) return { cohensD: 0, category: 'negligible' };
  const mean = meanDelta(deltas);
  const variance = deltas.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) {
    return Math.abs(mean) > 1e-12
      ? { cohensD: mean > 0 ? 2 : -2, category: 'large' }
      : { cohensD: 0, category: 'negligible' };
  }
  const d = mean / sd;
  const absD = Math.abs(d);
  let category: EffectSizeCategory;
  if (absD < 0.2) category = 'negligible';
  else if (absD < 0.5) category = 'small';
  else if (absD < 0.8) category = 'medium';
  else category = 'large';
  return { cohensD: d, category };
}

// ─── Regret ────────────────────────────────────────────────────────────────

/**
 * Compute regret: how much better the best alternative would have been.
 * Regret is always non-negative (if chosen is best, regret = 0).
 */
export function computeRegret(
  chosenScore: number,
  alternativeScores: number[],
): { avgRegret: number; maxRegret: number; bestAlternative: number } {
  if (alternativeScores.length === 0) {
    return { avgRegret: 0, maxRegret: 0, bestAlternative: chosenScore };
  }

  const bestAlternative = Math.max(...alternativeScores);
  const maxRegret = Math.max(0, bestAlternative - chosenScore);

  const totalRegret = alternativeScores.reduce(
    (sum, alt) => sum + Math.max(0, alt - chosenScore),
    0,
  );
  const avgRegret = totalRegret / alternativeScores.length;

  return { avgRegret, maxRegret, bestAlternative };
}

// ─── Stability Index ───────────────────────────────────────────────────────

/**
 * Stability index based on coefficient of variation (CV).
 * Returns 1 - CV, clamped to [0, 1]. Higher = more stable.
 * A CV of 0 means perfect stability (index = 1).
 */
export function computeStabilityIndex(values: number[]): number {
  if (values.length < 2) return 1.0;

  const stats = computeDescriptiveStats(values);
  if (stats.mean === 0) return stats.stddev === 0 ? 1.0 : 0.0;

  const cv = stats.stddev / Math.abs(stats.mean);
  return Math.max(0, Math.min(1, 1 - cv));
}

// ─── Cost Efficiency ───────────────────────────────────────────────────────

/**
 * Quality per dollar: how much quality you get for each dollar spent.
 * Higher is better.
 */
export function computeCostEfficiency(quality: number, cost: number): number {
  if (cost <= 0) return quality > 0 ? Infinity : 0;
  return quality / cost;
}

// ─── Quality Per Second ────────────────────────────────────────────────────

/**
 * Quality gained per second of execution time.
 * Higher is better — measures time-efficiency.
 */
export function computeQualityPerSecond(quality: number, latencyMs: number): number {
  if (latencyMs <= 0) return quality > 0 ? Infinity : 0;
  return quality / (latencyMs / 1000);
}

// ─── Composite Regret ──────────────────────────────────────────────────────

/**
 * Multi-objective regret across quality, cost, and latency.
 * Each dimension's regret is normalized and weighted.
 *
 * Quality regret: max(0, bestQuality - chosenQuality) / bestQuality
 * Cost regret: max(0, chosenCost - bestCost) / max(chosenCost, bestCost)
 * Latency regret: max(0, chosenLatency - bestLatency) / max(chosenLatency, bestLatency)
 */
export function computeCompositeRegret(
  chosen: { quality: number; cost: number; latency: number },
  alternatives: Array<{ quality: number; cost: number; latency: number }>,
  weights: { quality: number; cost: number; latency: number } = { quality: 0.5, cost: 0.3, latency: 0.2 },
): CompositeRegret {
  if (alternatives.length === 0) {
    return { qualityRegret: 0, costRegret: 0, latencyRegret: 0, compositeRegret: 0, weights };
  }

  const bestQuality = Math.max(chosen.quality, ...alternatives.map(a => a.quality));
  const bestCost = Math.min(chosen.cost, ...alternatives.map(a => a.cost));
  const bestLatency = Math.min(chosen.latency, ...alternatives.map(a => a.latency));

  const qualityRegret = bestQuality > 0 ? Math.max(0, bestQuality - chosen.quality) / bestQuality : 0;
  const costRegret = Math.max(chosen.cost, bestCost) > 0
    ? Math.max(0, chosen.cost - bestCost) / Math.max(chosen.cost, bestCost) : 0;
  const latencyRegret = Math.max(chosen.latency, bestLatency) > 0
    ? Math.max(0, chosen.latency - bestLatency) / Math.max(chosen.latency, bestLatency) : 0;

  const compositeRegret = weights.quality * qualityRegret + weights.cost * costRegret + weights.latency * latencyRegret;

  return { qualityRegret, costRegret, latencyRegret, compositeRegret, weights };
}

// ─── Composite Efficiency ──────────────────────────────────────────────────

/**
 * Multi-objective efficiency score combining quality, cost, and latency.
 * Formula: quality^wq / (cost^wc × latencySec^wl)
 * Higher is better.
 */
export function computeCompositeEfficiency(
  quality: number,
  cost: number,
  latencyMs: number,
  weights: { quality: number; cost: number; latency: number } = { quality: 1.0, cost: 0.5, latency: 0.3 },
): CompositeEfficiency {
  const latencySec = latencyMs / 1000;
  const qualityPerDollar = computeCostEfficiency(quality, cost);
  const qualityPerSecond = computeQualityPerSecond(quality, latencyMs);

  const costTerm = Math.max(cost, 0.0001);
  const latencyTerm = Math.max(latencySec, 0.001);

  const compositeScore = Math.pow(quality, weights.quality) /
    (Math.pow(costTerm, weights.cost) * Math.pow(latencyTerm, weights.latency));

  return { qualityPerDollar, qualityPerSecond, compositeScore, weights };
}

// ─── Pareto Dominance ──────────────────────────────────────────────────────

/**
 * Compute Pareto frontier for multi-objective optimization.
 * A point is non-dominated if no other point is better in ALL objectives.
 * Objectives: quality ↑, cost ↓, latency ↓, successRate ↑
 */
export function computeParetoDominance(points: ParetoPoint[]): ParetoDominanceResult {
  if (points.length === 0) return { frontier: [], dominated: [] };

  const frontier: ParetoPoint[] = [];
  const dominated: ParetoPoint[] = [];

  for (let i = 0; i < points.length; i++) {
    let isDominated = false;

    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      if (dominates(points[j], points[i])) {
        isDominated = true;
        break;
      }
    }

    if (isDominated) dominated.push(points[i]);
    else frontier.push(points[i]);
  }

  return { frontier, dominated };
}

/**
 * Does point A dominate point B?
 * A dominates B iff A is better in at least one objective and not worse in any.
 * Better: quality ↑, successRate ↑, cost ↓, latency ↓
 */
function dominates(a: ParetoPoint, b: ParetoPoint): boolean {
  const betterQuality = a.quality >= b.quality;
  const betterCost = a.cost <= b.cost;
  const betterLatency = a.latency <= b.latency;
  const betterSuccess = a.successRate >= b.successRate;

  const allBetterOrEqual = betterQuality && betterCost && betterLatency && betterSuccess;
  const strictlyBetterInOne =
    a.quality > b.quality || a.cost < b.cost || a.latency < b.latency || a.successRate > b.successRate;

  return allBetterOrEqual && strictlyBetterInOne;
}

// ─── Outlier Detection ─────────────────────────────────────────────────────

/**
 * Detect outliers using the IQR method.
 * Outliers are values below Q1 - 1.5*IQR or above Q3 + 1.5*IQR.
 * Returns indices of outlier values.
 */
export function detectOutliers(values: number[], multiplier: number = 1.5): number[] {
  if (values.length < 4) return [];

  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;

  const lower = q1 - multiplier * iqr;
  const upper = q3 + multiplier * iqr;

  const outlierIndices: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] < lower || values[i] > upper) {
      outlierIndices.push(i);
    }
  }

  return outlierIndices;
}

// ─── Math Helpers ──────────────────────────────────────────────────────────

/**
 * Inverse of the standard normal CDF (z-score for a given probability).
 * Rational approximation (Abramowitz & Stegun 26.2.23).
 */
function zInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  // Rational approximation for 0 < p < 1
  const t = p < 0.5 ? Math.sqrt(-2 * Math.log(p)) : Math.sqrt(-2 * Math.log(1 - p));

  const c0 = 2.515517;
  const c1 = 0.802853;
  const c2 = 0.010328;
  const d1 = 1.432788;
  const d2 = 0.189269;
  const d3 = 0.001308;

  const z = t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t);

  return p < 0.5 ? -z : z;
}

/**
 * Inverse of the t-distribution CDF.
 * Uses normal approximation corrected for small df.
 */
function tInv(p: number, df: number): number {
  if (df >= 30) return zInv(p);

  // Cornish-Fisher expansion for small df
  const z = zInv(p);
  const g1 = (z ** 3 + z) / (4 * df);
  const g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2);

  return z + g1 + g2;
}

/**
 * CDF of the t-distribution at x with df degrees of freedom.
 * Uses the regularized incomplete beta function.
 */
function tCDF(x: number, df: number): number {
  if (df <= 0) return 0;

  const t2 = x * x;
  const betaX = df / (df + t2);

  // Use regularized incomplete beta function
  const ibeta = regularizedIncompleteBeta(betaX, df / 2, 0.5);

  return x >= 0
    ? 1 - 0.5 * ibeta
    : 0.5 * ibeta;
}

/**
 * Regularized incomplete beta function I_x(a, b).
 * Computed via continued fraction expansion (Lentz's method).
 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use symmetry relation when x > (a+1)/(a+b+2) for better convergence
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedIncompleteBeta(1 - x, b, a);
  }

  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  // Continued fraction (modified Lentz)
  let f = 1;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  f = d;

  for (let m = 1; m <= 200; m++) {
    // Even step
    let numerator = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    f *= c * d;

    // Odd step
    numerator = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = c * d;
    f *= delta;

    if (Math.abs(delta - 1) < 1e-10) break;
  }

  return front * f;
}

/**
 * Natural log of the gamma function (Stirling's approximation + Lanczos).
 */
function lnGamma(z: number): number {
  if (z <= 0) return 0;

  // Lanczos approximation (g=7)
  const coefficients = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }

  z -= 1;
  let x = coefficients[0];
  for (let i = 1; i < coefficients.length; i++) {
    x += coefficients[i] / (z + i);
  }

  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
