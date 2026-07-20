// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-contribution-scorer.ts — MVP 8A
 *
 * Pure, deterministic aggregator. Reads a list of HistoricalExecution
 * records and emits:
 *   - one ModelTaskPerformanceProfile per (modelId, taskType) cell
 *   - one PairContributionProfile per (modelA, modelB, taskType) cell
 *   - global baselines per strategy (single, single_budget, parallel)
 *
 * Invariants:
 *   - No I/O. No DB. No fetch. No randomness. No clock reads.
 *   - Input arrays are never mutated.
 *   - All output containers are frozen.
 *   - All sorts use stable tie-breakers (alphabetical id) so two runs
 *     over the same input produce byte-identical output.
 *
 * The scorer operates on STRUCTURE only. It never branches on a model
 * or provider NAME — every decision is a numeric comparison over the
 * computed stats. Names appear as opaque keys only.
 */

import {
  DEFAULT_JUDGE_THRESHOLDS,
  type HistoricalExecution,
  type JudgeThresholdPolicy,
} from './historical-execution-types';
import {
  buildModelHarmProfile,
  type ModelHarmProfile,
} from './model-harm-profile';
import type {
  ModelRole,
  ModelTaskPerformanceProfile,
} from './model-task-performance-profile';
import {
  buildPairContributionProfile,
  type PairBaselines,
  type PairContributionProfile,
  pairKey,
} from './pair-contribution-profile';

// ─── Public API ─────────────────────────────────────────────────────────

export interface HistoricalContributionInput {
  readonly executions: readonly HistoricalExecution[];
  /** Restrict aggregation to one taskType when set. */
  readonly taskType?: string;
  readonly complexity?: string;
  /** Minimum samples for a non-`insufficient_data` role assignment. Default 4. */
  readonly minSamples?: number;
  readonly thresholds?: JudgeThresholdPolicy;
  /**
   * The TASK modality. When set, the harm profile classifies executions
   * with a different modality as mismatches.
   */
  readonly expectedModality?: HistoricalExecution['modality'];
}

export interface HistoricalContributionResult {
  readonly modelProfiles: readonly ModelTaskPerformanceProfile[];
  readonly harmProfiles: readonly ModelHarmProfile[];
  readonly pairProfiles: readonly PairContributionProfile[];
  readonly globalBaselines: GlobalBaselines;
}

export interface GlobalBaselines {
  readonly singleModelJudgeMean: number;
  readonly singleModelCostMean: number;
  readonly singleBudgetJudgeMean: number;
  readonly singleBudgetCostMean: number;
  readonly collectiveParallelJudgeMean: number;
  readonly collectiveParallelCostMean: number;
}

const DEFAULT_MIN_SAMPLES = 4;

// ─── Main entry ─────────────────────────────────────────────────────────

export function scoreHistoricalContribution(
  input: HistoricalContributionInput,
): HistoricalContributionResult {
  const minSamples = input.minSamples ?? DEFAULT_MIN_SAMPLES;
  const thresholds = input.thresholds ?? DEFAULT_JUDGE_THRESHOLDS;

  // 1. Filter by taskType/complexity when supplied.
  const filtered = filterExecutions(input);

  // 2. Compute global baselines first — needed for win/harm classification.
  const baselines = computeGlobalBaselines(filtered);

  // 3. Build per-(model, taskType) executions buckets.
  const perModelExecs = bucketByModelAndTask(filtered);

  // 4. Build per-(modelId, taskType) profiles.
  const modelProfiles: ModelTaskPerformanceProfile[] = [];
  const harmProfiles: ModelHarmProfile[] = [];
  const perModelStats: Record<string, { judgeMean: number; harmScore: number }> = {};

  for (const [key, execs] of sortedEntries(perModelExecs)) {
    const [modelId, taskType] = splitModelTaskKey(key);
    const harm = buildModelHarmProfile(modelId, taskType, execs, input.expectedModality);
    harmProfiles.push(harm);
    const profile = buildModelProfile({
      modelId,
      taskType,
      executions: execs,
      harm,
      baselines,
      thresholds,
      minSamples,
    });
    modelProfiles.push(profile);
    perModelStats[modelId] = {
      judgeMean: profile.judgeMean,
      harmScore: harm.harmScore,
    };
  }

  // 5. Build per-pair profiles from collective:parallel executions only.
  const pairProfiles: PairContributionProfile[] = [];
  const pairBuckets = bucketByPair(filtered);
  const pairBaselines: PairBaselines = {
    singleJudgeMean: baselines.singleModelJudgeMean,
    singleCostMean: baselines.singleModelCostMean,
  };
  for (const [key, execs] of sortedEntries(pairBuckets)) {
    const [a, b, taskType] = splitPairKey(key);
    pairProfiles.push(
      buildPairContributionProfile(a, b, taskType, execs, pairBaselines, perModelStats),
    );
  }

  return Object.freeze({
    modelProfiles: Object.freeze(modelProfiles),
    harmProfiles: Object.freeze(harmProfiles),
    pairProfiles: Object.freeze(pairProfiles),
    globalBaselines: baselines,
  });
}

// ─── Filtering ──────────────────────────────────────────────────────────

function filterExecutions(
  input: HistoricalContributionInput,
): readonly HistoricalExecution[] {
  const { executions, taskType, complexity } = input;
  if (taskType === undefined && complexity === undefined) return executions;
  const out: HistoricalExecution[] = [];
  for (const ex of executions) {
    if (taskType !== undefined && ex.taskType !== taskType) continue;
    if (complexity !== undefined && ex.complexity !== complexity) continue;
    out.push(ex);
  }
  return out;
}

// ─── Baselines ──────────────────────────────────────────────────────────

function computeGlobalBaselines(
  executions: readonly HistoricalExecution[],
): GlobalBaselines {
  const single = filterByStrategy(executions, 'single');
  const singleBudget = filterByStrategy(executions, 'single_budget');
  const parallel = filterByStrategy(executions, 'parallel');

  return Object.freeze({
    singleModelJudgeMean: mean(single.map((e) => e.judgeScore)),
    singleModelCostMean: mean(single.map((e) => e.costUsd)),
    singleBudgetJudgeMean: mean(singleBudget.map((e) => e.judgeScore)),
    singleBudgetCostMean: mean(singleBudget.map((e) => e.costUsd)),
    collectiveParallelJudgeMean: mean(parallel.map((e) => e.judgeScore)),
    collectiveParallelCostMean: mean(parallel.map((e) => e.costUsd)),
  });
}

function filterByStrategy(
  executions: readonly HistoricalExecution[],
  strategy: HistoricalExecution['strategyId'],
): HistoricalExecution[] {
  const out: HistoricalExecution[] = [];
  for (const ex of executions) if (ex.effectiveStrategyId === strategy) out.push(ex);
  return out;
}

// ─── Bucketing ──────────────────────────────────────────────────────────

const MTK_SEP = '';
function modelTaskKey(modelId: string, taskType: string): string {
  return `${modelId}${MTK_SEP}${taskType}`;
}
function splitModelTaskKey(key: string): [string, string] {
  const i = key.indexOf(MTK_SEP);
  return [key.slice(0, i), key.slice(i + 1)];
}

function bucketByModelAndTask(
  executions: readonly HistoricalExecution[],
): Map<string, HistoricalExecution[]> {
  const buckets = new Map<string, HistoricalExecution[]>();
  for (const ex of executions) {
    for (const modelId of ex.modelsUsed) {
      const key = modelTaskKey(modelId, ex.taskType);
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push(ex);
    }
  }
  return buckets;
}

const PAIR_SEP = '';
function pairBucketKey(a: string, b: string, taskType: string): string {
  return `${pairKey(a, b)}${PAIR_SEP}${taskType}`;
}
function splitPairKey(key: string): [string, string, string] {
  const i = key.indexOf(PAIR_SEP);
  const head = key.slice(0, i);
  const tail = key.slice(i + 1);
  const j = head.indexOf('||');
  return [head.slice(0, j), head.slice(j + 2), tail];
}

function bucketByPair(
  executions: readonly HistoricalExecution[],
): Map<string, HistoricalExecution[]> {
  const buckets = new Map<string, HistoricalExecution[]>();
  for (const ex of executions) {
    if (ex.effectiveStrategyId !== 'parallel') continue;
    const models = ex.modelsUsed;
    for (let i = 0; i < models.length; i += 1) {
      for (let j = i + 1; j < models.length; j += 1) {
        const key = pairBucketKey(models[i], models[j], ex.taskType);
        let arr = buckets.get(key);
        if (!arr) {
          arr = [];
          buckets.set(key, arr);
        }
        arr.push(ex);
      }
    }
  }
  return buckets;
}

// ─── Profile builder ────────────────────────────────────────────────────

interface ModelProfileArgs {
  readonly modelId: string;
  readonly taskType: string;
  readonly executions: readonly HistoricalExecution[];
  readonly harm: ModelHarmProfile;
  readonly baselines: GlobalBaselines;
  readonly thresholds: JudgeThresholdPolicy;
  readonly minSamples: number;
}

function buildModelProfile(args: ModelProfileArgs): ModelTaskPerformanceProfile {
  const { modelId, taskType, executions, harm, baselines, thresholds, minSamples } = args;
  const n = executions.length;
  const judges = executions.map((e) => e.judgeScore).slice().sort(numAsc);
  const costs = executions.map((e) => e.costUsd).slice().sort(numAsc);

  const judgeMeanV = mean(judges);
  const judgeMedianV = percentile(judges, 0.5);
  const judgeP80V = percentile(judges, 0.8);
  const judgeStdDevV = stddev(judges, judgeMeanV);
  const judgeVarianceV = judgeStdDevV * judgeStdDevV;
  const costMeanV = mean(costs);
  const costP95V = percentile(costs, 0.95);
  const qualityPerDollarV =
    costMeanV > 1e-9 ? Math.min(judgeMeanV / costMeanV, 10_000) : 0;

  const baselineSingleJudge = baselines.singleModelJudgeMean;
  const winFloor = Math.max(thresholds.winFloor, baselineSingleJudge);
  let wins = 0;
  let losses = 0;
  let zeros = 0;
  let successes = 0;
  for (const ex of executions) {
    if (ex.success !== false) successes += 1;
    if (ex.judgeScore >= winFloor) wins += 1;
    if (ex.judgeScore < thresholds.lossCeiling) losses += 1;
    if (ex.judgeScore <= thresholds.zeroCeiling) zeros += 1;
  }

  const winRate = n > 0 ? wins / n : 0;
  const lossRate = n > 0 ? losses / n : 0;
  const zeroRate = n > 0 ? zeros / n : 0;
  const successRate = n > 0 ? successes / n : 0;
  const harmRate = computeHarmRate(executions, baselines);

  const confidence = computeConfidence(n, minSamples);
  const contributionScore = computeContributionScore({
    judgeMean: judgeMeanV,
    winRate,
    harmRate,
    confidence,
  });
  const recommendedRole = pickRole({
    n,
    minSamples,
    judgeMean: judgeMeanV,
    harmRate,
    harmScore: harm.harmScore,
    qualityPerDollar: qualityPerDollarV,
    zeroRate,
    winRate,
  });

  void successRate; // exposed in tests via re-computation if needed

  // MVP 8B.6 — calibration weights.
  // sampleWeight: empirical-Bayes shrinkage factor.
  // calibrationConfidence: confidence × variance penalty.
  const sampleWeight = n / (n + 5);
  const variancePenalty = Math.max(0, 1 - judgeStdDevV * 1.5);
  const calibrationConfidence = Math.max(0, Math.min(1, confidence * variancePenalty));

  return Object.freeze({
    modelId,
    taskType,
    sampleCount: n,
    judgeMean: judgeMeanV,
    judgeMedian: judgeMedianV,
    judgeP80: judgeP80V,
    judgeStdDev: judgeStdDevV,
    judgeVariance: judgeVarianceV,
    winRate,
    lossRate,
    zeroRate,
    harmRate,
    costMean: costMeanV,
    costP95: costP95V,
    qualityPerDollar: qualityPerDollarV,
    contributionScore,
    harmScore: harm.harmScore,
    confidence,
    calibrationConfidence,
    sampleWeight,
    recommendedRole,
  });
}

// ─── Role assignment ────────────────────────────────────────────────────

interface RoleArgs {
  readonly n: number;
  readonly minSamples: number;
  readonly judgeMean: number;
  readonly harmRate: number;
  readonly harmScore: number;
  readonly qualityPerDollar: number;
  readonly zeroRate: number;
  readonly winRate: number;
}

function pickRole(a: RoleArgs): ModelRole {
  if (a.n < a.minSamples) return 'insufficient_data';
  // AVOID — strong negative signals dominate everything.
  if (a.harmScore >= 0.4) return 'avoid';
  if (a.zeroRate >= 0.4) return 'avoid';
  if (a.harmRate >= 0.4) return 'avoid';
  if (a.judgeMean <= 0.2) return 'avoid';
  // ANCHOR — high quality, low harm.
  if (a.judgeMean >= 0.6 && a.harmRate <= 0.2 && a.winRate >= 0.3) return 'anchor';
  // BUDGET_SUPPORT — moderate quality, very high q/$.
  if (a.judgeMean >= 0.45 && a.qualityPerDollar >= 200 && a.harmRate <= 0.25) {
    return 'budget_support';
  }
  // SUPPORT — moderate quality, acceptable harm.
  if (a.judgeMean >= 0.4 && a.harmRate <= 0.3) return 'support';
  // CRITIC — low-medium judge but stable (low harm). Useful for review.
  if (a.judgeMean >= 0.3 && a.harmRate <= 0.2) return 'critic';
  return 'avoid';
}

// ─── Contribution computation ───────────────────────────────────────────

interface ContribArgs {
  readonly judgeMean: number;
  readonly winRate: number;
  readonly harmRate: number;
  readonly confidence: number;
}

function computeContributionScore(a: ContribArgs): number {
  const raw =
    0.45 * a.judgeMean + 0.3 * a.winRate - 0.4 * a.harmRate;
  const scaled = Math.max(0, Math.min(1, raw));
  return scaled * a.confidence + (1 - a.confidence) * 0.3; // shrink toward prior 0.3
}

function computeHarmRate(
  executions: readonly HistoricalExecution[],
  baselines: GlobalBaselines,
): number {
  if (executions.length === 0) return 0;
  let bad = 0;
  for (const ex of executions) {
    const isCollective =
      ex.effectiveStrategyId !== 'single' &&
      ex.effectiveStrategyId !== 'single_budget';
    const droppedBelowBaseline =
      ex.judgeScore < baselines.singleModelJudgeMean * 0.6;
    const degraded = ex.degraded === true;
    const failed = ex.success === false;
    if ((isCollective && droppedBelowBaseline) || degraded || failed) bad += 1;
  }
  return bad / executions.length;
}

function computeConfidence(n: number, minSamples: number): number {
  if (n <= 0) return 0;
  // Logistic-ish growth: at minSamples we land at ~0.5; saturates near 1.
  const k = 0.2;
  const x = (n - minSamples) * k;
  return 1 / (1 + Math.exp(-x));
}

// ─── Math helpers ───────────────────────────────────────────────────────

function mean(arr: readonly number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function stddev(arr: readonly number[], meanValue: number): number {
  if (arr.length === 0) return 0;
  let sumSq = 0;
  for (const v of arr) {
    const diff = v - meanValue;
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / arr.length);
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * Math.max(0, Math.min(1, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function numAsc(a: number, b: number): number {
  return a - b;
}

function sortedEntries<V>(m: Map<string, V>): Array<[string, V]> {
  const entries = [...m.entries()];
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries;
}
