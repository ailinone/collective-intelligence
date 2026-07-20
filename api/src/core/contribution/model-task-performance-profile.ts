// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * model-task-performance-profile.ts — MVP 8A
 *
 * Per-model, per-task-type performance summary derived from historical
 * executions. Pure type module; the aggregator lives in
 * `historical-contribution-scorer.ts`.
 *
 * The `recommendedRole` field is the policy-level summary used by the
 * Pareto optimizer to slot a model into an ensemble (anchor / support /
 * critic / budget_support / avoid / insufficient_data).
 */

export type ModelRole =
  | 'anchor'
  | 'support'
  | 'critic'
  | 'budget_support'
  | 'avoid'
  | 'insufficient_data';

export interface ModelTaskPerformanceProfile {
  readonly modelId: string;
  readonly canonicalModelId?: string;
  readonly taskType: string;
  readonly sampleCount: number;

  readonly judgeMean: number;
  readonly judgeMedian: number;
  readonly judgeP80: number;
  /** Population standard deviation of judge scores (MVP 8B.6). */
  readonly judgeStdDev: number;
  /** judgeStdDev squared — exposed for callers that prefer raw variance (MVP 8B.6). */
  readonly judgeVariance: number;

  readonly winRate: number;
  readonly lossRate: number;
  readonly zeroRate: number;
  readonly harmRate: number;

  readonly costMean: number;
  readonly costP95: number;
  /** judgeMean / max(costMean, epsilon). Capped at a finite upper bound. */
  readonly qualityPerDollar: number;

  /** [0..1] composite quality contribution score. */
  readonly contributionScore: number;
  /** [0..1] composite harm score (higher = worse). */
  readonly harmScore: number;
  /** [0..1] confidence in the contribution estimate, function of sample count. */
  readonly confidence: number;

  /**
   * [0..1] confidence for downstream calibration. Lower when sample is
   * small AND variance is high. Used by the calibrated estimators in
   * MVP 8B.6 to shrink optimistic estimates toward priors.
   */
  readonly calibrationConfidence: number;
  /**
   * Sample-count-derived weight used as an empirical-Bayes shrinkage
   * factor: sampleWeight = sampleCount / (sampleCount + k) for k ~ 5
   * (MVP 8B.6).
   */
  readonly sampleWeight: number;

  readonly recommendedRole: ModelRole;
}
