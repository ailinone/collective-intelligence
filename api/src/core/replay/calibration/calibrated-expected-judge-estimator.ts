// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * calibrated-expected-judge-estimator.ts — MVP 8B.6
 *
 * Wraps a chosen `ExpectedJudgeEstimator` + a precomputed
 * `taskTypeOffsetMap` + a global mean (for empirical-Bayes shrinkage)
 * into a single callable that the replay runner uses in place of
 * `profile.judgeMean`.
 *
 * Pure. No I/O.
 */

import type { ModelTaskPerformanceProfile } from '../../contribution/model-task-performance-profile';
import type {
  ExpectedJudgeEstimator,
  TrainEvalDatum,
} from './expected-judge-calibrator';

export interface CalibratedEstimatorContext {
  readonly estimator: ExpectedJudgeEstimator;
  readonly taskTypeOffsetMap: ReadonlyMap<string, number>;
  readonly globalMean: number;
  readonly pairLiftMeanMap?: ReadonlyMap<string, number>;
}

/**
 * Returns the estimated judge for ONE model+task pair, using the
 * wrapper's context (offsets, prior, pair lifts).
 */
export function estimateCalibratedJudge(
  ctx: CalibratedEstimatorContext,
  profile: ModelTaskPerformanceProfile,
  modelId?: string,
): number {
  const taskTypeOffset = ctx.taskTypeOffsetMap.get(profile.taskType);
  const pairLiftKey = modelId ? `${modelId}||${profile.taskType}` : undefined;
  const pairLiftMean =
    pairLiftKey && ctx.pairLiftMeanMap ? ctx.pairLiftMeanMap.get(pairLiftKey) : undefined;
  return ctx.estimator.estimate({
    profile,
    taskTypeOffset,
    globalMean: ctx.globalMean,
    pairLiftMean,
  });
}

// ─── Offset learning (from TRAIN data) ──────────────────────────────────

/**
 * Learns a per-task-type offset that minimises mean(predicted − observed)
 * when the estimator is `judgeMean`. This is the "task-type calibration"
 * step: it accounts for systematic overestimation per task type.
 *
 * Output: { taskType → offset }. Apply as: estimated += offset.
 */
export function learnTaskTypeOffsets(
  data: readonly TrainEvalDatum[],
): ReadonlyMap<string, number> {
  const buckets = new Map<string, { sumDelta: number; count: number }>();
  for (const d of data) {
    const taskType = d.profile.taskType;
    let b = buckets.get(taskType);
    if (!b) {
      b = { sumDelta: 0, count: 0 };
      buckets.set(taskType, b);
    }
    // delta = observed − predicted (using mean as the "raw" predictor).
    const delta = d.observedJudge - d.profile.judgeMean;
    b.sumDelta += delta;
    b.count += 1;
  }
  const out = new Map<string, number>();
  for (const [k, v] of buckets) {
    out.set(k, v.count > 0 ? v.sumDelta / v.count : 0);
  }
  return out;
}

/**
 * Computes the global mean observed judge across train, used as the
 * empirical-Bayes prior.
 */
export function computeGlobalMean(data: readonly TrainEvalDatum[]): number {
  if (data.length === 0) return 0.5;
  let s = 0;
  for (const d of data) s += d.observedJudge;
  return s / data.length;
}
