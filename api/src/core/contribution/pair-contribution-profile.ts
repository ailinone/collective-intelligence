// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pair-contribution-profile.ts — MVP 8A
 *
 * Per-pair (model A, model B) historical analysis. The Pareto optimizer
 * consults this when scoring marginal contribution: pairs with high
 * `complementarityScore` get a positive marginal-gain bonus; pairs with
 * high `redundancyPenalty` get penalised.
 *
 * Pure types + a small computer. No I/O.
 */

import type { HistoricalExecution } from './historical-execution-types';

export interface PairContributionProfile {
  readonly modelA: string;
  readonly modelB: string;
  readonly taskType: string;
  readonly sampleCount: number;

  readonly judgeMean: number;
  readonly costMean: number;
  readonly qualityPerDollar: number;

  /** Fraction of pair executions that beat the single-model baseline. */
  readonly beatsSingleBaselineRate: number;
  /** Fraction that beat single-model AND cost <= 1.2 * single baseline. */
  readonly cheaperThanSingleBaselineRate: number;
  /** Fraction Pareto-winning vs single baseline (quality>= AND cost<=). */
  readonly paretoWinRate: number;

  /** [0..1] — how much pair quality exceeds the average of the two single profiles. */
  readonly complementarityScore: number;
  /** [0..1] — penalty when both models contribute the same answer (no diversity). */
  readonly redundancyPenalty: number;
  /** [0..1] — synthetic outlier/harm risk for the pair. */
  readonly riskScore: number;
}

// ─── Computer ───────────────────────────────────────────────────────────

export interface PairBaselines {
  readonly singleJudgeMean: number;
  readonly singleCostMean: number;
}

export interface PerModelStats {
  readonly judgeMean: number;
  readonly harmScore: number;
}

/**
 * Builds the pair profile from collective executions that included
 * EXACTLY the two models (no third model). Caller filters executions.
 *
 * `pairExecutions`: collective executions containing both modelA and
 * modelB (and only these two — or these two among others; we still
 * count them with a diluted weight).
 */
export function buildPairContributionProfile(
  modelA: string,
  modelB: string,
  taskType: string,
  pairExecutions: readonly HistoricalExecution[],
  baselines: PairBaselines,
  perModelStats: { readonly [modelId: string]: PerModelStats },
): PairContributionProfile {
  // Canonicalise ordering — alphabetical — so (A,B) === (B,A).
  const [m1, m2] = modelA < modelB ? [modelA, modelB] : [modelB, modelA];

  const n = pairExecutions.length;
  if (n === 0) {
    return Object.freeze({
      modelA: m1,
      modelB: m2,
      taskType,
      sampleCount: 0,
      judgeMean: 0,
      costMean: 0,
      qualityPerDollar: 0,
      beatsSingleBaselineRate: 0,
      cheaperThanSingleBaselineRate: 0,
      paretoWinRate: 0,
      complementarityScore: 0,
      redundancyPenalty: 0,
      riskScore: 0,
    });
  }

  let sumJudge = 0;
  let sumCost = 0;
  let beats = 0;
  let cheaper = 0;
  let paretoWins = 0;
  for (const ex of pairExecutions) {
    sumJudge += ex.judgeScore;
    sumCost += ex.costUsd;
    const judgeOk = ex.judgeScore >= baselines.singleJudgeMean;
    const costOk = ex.costUsd <= 1.2 * baselines.singleCostMean;
    if (judgeOk) beats += 1;
    if (judgeOk && costOk) cheaper += 1;
    if (judgeOk && ex.costUsd <= baselines.singleCostMean) paretoWins += 1;
  }

  const judgeMean = sumJudge / n;
  const costMean = sumCost / n;
  const qualityPerDollar =
    costMean > 1e-9 ? Math.min(judgeMean / costMean, 10_000) : 0;

  // Complementarity = how much pair judge exceeds the average of the two singles
  const avgSingle =
    ((perModelStats[m1]?.judgeMean ?? 0) +
      (perModelStats[m2]?.judgeMean ?? 0)) /
    2;
  const complementarity = Math.max(0, Math.min(1, judgeMean - avgSingle + 0.05));

  // Redundancy = penalty when pair judge is barely better than the
  // best individual (and both have similar harm profiles).
  const bestSingle = Math.max(
    perModelStats[m1]?.judgeMean ?? 0,
    perModelStats[m2]?.judgeMean ?? 0,
  );
  const redundancyPenalty = Math.max(0, Math.min(1, 0.5 - (judgeMean - bestSingle)));

  // Risk = average harm score of the two members + penalty for high cost variance
  const avgHarm =
    ((perModelStats[m1]?.harmScore ?? 0) + (perModelStats[m2]?.harmScore ?? 0)) /
    2;
  const riskScore = Math.min(1, avgHarm);

  return Object.freeze({
    modelA: m1,
    modelB: m2,
    taskType,
    sampleCount: n,
    judgeMean,
    costMean,
    qualityPerDollar,
    beatsSingleBaselineRate: beats / n,
    cheaperThanSingleBaselineRate: cheaper / n,
    paretoWinRate: paretoWins / n,
    complementarityScore: complementarity,
    redundancyPenalty,
    riskScore,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Returns a stable pair key (alphabetical join) for Map lookups.
 */
export function pairKey(modelA: string, modelB: string): string {
  return modelA < modelB ? `${modelA}||${modelB}` : `${modelB}||${modelA}`;
}
