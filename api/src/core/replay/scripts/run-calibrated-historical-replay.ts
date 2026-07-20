// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * run-calibrated-historical-replay.ts — MVP 8B.6
 *
 * Full calibrated replay pipeline:
 *
 *   1. Load the normalised export (training+holdout candidates).
 *   2. Split train/holdout by experiment_id (70/30).
 *   3. Train contribution profiles on TRAIN ONLY.
 *   4. Build train-only evaluation data for each estimator (per
 *      (model, taskType) cell in train, predict from THAT cell's
 *      profile and compare against the observed judge from the SAME
 *      cell's rows — a hold-out free, in-sample fit metric).
 *   5. Pick the best estimator by train mean absolute error.
 *   6. Compute task-type offsets and global mean (from train).
 *   7. Build the calibrated estimator context.
 *   8. Replace `historicalProfile.judgeMean` with the calibrated
 *      estimate inside the replay runner.
 *   9. Run the holdout replay.
 *  10. Compute metrics + per-task-type breakdown.
 *  11. Emit the calibration report.
 *
 * Pure inside the calibration; the script just orchestrates reads/writes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scoreHistoricalContribution } from '../../contribution/historical-contribution-scorer';
import type {
  HistoricalContributionResult,
} from '../../contribution/historical-contribution-scorer';
import type { ModelTaskPerformanceProfile } from '../../contribution/model-task-performance-profile';
import {
  estimateCalibratedJudge,
  learnTaskTypeOffsets,
  computeGlobalMean,
  type CalibratedEstimatorContext,
} from '../calibration/calibrated-expected-judge-estimator';
import {
  ALL_ESTIMATORS,
  evaluateEstimator,
  pickBestEstimator,
  type TrainEvalDatum,
} from '../calibration/expected-judge-calibrator';
import { computeCalibrationMetrics } from '../calibration/calibration-metrics';
import {
  resolveCalibrationPolicy,
} from '../calibration/calibration-policy';
import { buildCalibrationReport } from '../calibration/calibration-report';
import { buildTaskTypeCalibration } from '../calibration/tasktype-calibration';
import { runHistoricalReplay } from '../historical-replay-runner';
import { splitTrainHoldout } from '../historical-replay-split';
import type { HistoricalReplayExecution } from '../historical-replay-types';
import type { HistoricalExecution } from '../../contribution/historical-execution-types';


const ARTIFACTS_DIR = resolve(__dirname, '..', 'artifacts');
const NORMALIZED_PATH = resolve(ARTIFACTS_DIR, 'c3-history-full-export.normalized.jsonl');
const REPORT_PATH = resolve(ARTIFACTS_DIR, 'c3-calibration-report.json');

function main(): void {
  console.log('[calib] reading normalised export…');
  const lines = readFileSync(NORMALIZED_PATH, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const executions: HistoricalReplayExecution[] = [];
  for (const l of lines) {
    try {
      executions.push(JSON.parse(l) as HistoricalReplayExecution);
    } catch {
      // skip parse errors
    }
  }
  console.log('[calib] loaded', executions.length, 'eligible executions');

  // Split.
  const split = splitTrainHoldout(executions, {
    strategy: 'by_experiment_id',
    holdoutFraction: 0.3,
  });
  console.log(
    '[calib] split: train=',
    split.train.length,
    'over',
    split.trainExperimentIds.length,
    'experiments | holdout=',
    split.holdout.length,
    'over',
    split.holdoutExperimentIds.length,
  );

  // Train contribution profiles on train ONLY.
  const trainHistory = scoreHistoricalContribution({
    executions: split.train.map(replayToContributionExecution),
  });
  console.log('[calib] train profiles:', trainHistory.modelProfiles.length, 'cells');

  // Build train evaluation data: per train row, find its profile and
  // pair with observed judge. The profile was built FROM train rows so
  // this is in-sample but we use it only to pick the estimator (the
  // holdout is untouched). For more rigour, we also report the
  // estimator's error broken down by task-type so reviewers can see
  // if the choice is robust across types.
  const trainEvalData = buildTrainEvalData(split.train, trainHistory);
  console.log('[calib] train eval data:', trainEvalData.length, 'samples');

  // Pick best estimator on train.
  const selection = pickBestEstimator(trainEvalData);
  console.log('[calib] best estimator:', selection.chosen.name);
  for (const e of selection.evaluations) {
    console.log(
      `[calib]   ${e.estimatorName.padEnd(28)} MAE=${e.meanAbsoluteError.toFixed(4)}  median=${e.medianAbsoluteError.toFixed(4)}  p80=${e.p80AbsoluteError.toFixed(4)}  n=${e.sampleCount}`,
    );
  }

  // Task-type offsets + global mean from train.
  const taskTypeOffsetMap = learnTaskTypeOffsets(trainEvalData);
  const globalMean = computeGlobalMean(trainEvalData);
  console.log('[calib] globalMean:', globalMean.toFixed(4));
  for (const [k, v] of taskTypeOffsetMap) {
    console.log(`[calib]   offset[${k}] = ${v.toFixed(4)}`);
  }

  // Apply calibrator: replace judgeMean in each train profile so the
  // replay runner picks up the calibrated estimate.
  const ctx: CalibratedEstimatorContext = {
    estimator: selection.chosen,
    taskTypeOffsetMap,
    globalMean,
  };
  const calibratedHistory = applyCalibrationToHistory(trainHistory, ctx);

  // Run replay on holdout with calibrated history.
  const replay = runHistoricalReplay({
    train: split.train,
    holdout: split.holdout,
    trainHistory: calibratedHistory,
  });
  console.log('[calib] evaluated rows:', replay.rows.length);

  // Metrics.
  const calibratedMetrics = computeCalibrationMetrics({
    rows: replay.rows,
    totalHoldoutRows: split.holdout.length,
  });

  // Per-task-type breakdown.
  const trainCountsByTaskType = countByTaskType(split.train);
  const errorByTaskType = errorByTaskTypeFor(
    selection.chosen,
    trainEvalData,
  );
  const taskTypeRecords = buildTaskTypeCalibration({
    rows: replay.rows,
    trainCountsByTaskType,
    errorByTaskType,
    bestEstimatorName: selection.chosen.name,
    policy: resolveCalibrationPolicy(),
  });

  // Final report.
  const report = buildCalibrationReport({
    chosenEstimator: selection.chosen.name,
    evaluations: selection.evaluations,
    calibratedMetrics,
    metricsByTaskType: taskTypeRecords,
    policy: resolveCalibrationPolicy(),
    nowIso: new Date().toISOString(),
  });

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log('[calib] wrote', REPORT_PATH);
  console.log(
    '[calib] APPROVAL:',
    report.approval.approved ? 'APPROVED' : 'REJECTED',
  );
  for (const r of report.approval.reasons) console.log('         -', r);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function replayToContributionExecution(
  e: HistoricalReplayExecution,
): HistoricalExecution {
  return {
    executionId: e.executionId,
    experimentId: e.experimentId,
    taskId: e.taskId,
    taskType: e.taskType,
    complexity: e.complexity ?? 'medium',
    strategyId: e.strategyId,
    effectiveStrategyId: e.effectiveStrategyId ?? e.strategyId,
    modelsUsed: e.modelsUsed,
    judgeScore: typeof e.judgeScore === 'number' ? e.judgeScore : 0,
    costUsd: typeof e.costUsd === 'number' ? e.costUsd : 0,
    success: e.success,
    degraded: e.degraded,
    degradationReason: e.degradationReason ?? undefined,
    failureMode: e.failureMode ?? undefined,
    modality: e.modality,
  };
}

/**
 * For each train row, find the corresponding profile (modelId × taskType)
 * and pair it with the observed judge for that row. When the row is a
 * collective, expand to one TrainEvalDatum per (member, observed judge).
 */
function buildTrainEvalData(
  train: readonly HistoricalReplayExecution[],
  history: HistoricalContributionResult,
): TrainEvalDatum[] {
  const profileIdx = new Map<string, ModelTaskPerformanceProfile>();
  for (const p of history.modelProfiles) {
    profileIdx.set(`${p.modelId}||${p.taskType}`, p);
  }
  const out: TrainEvalDatum[] = [];
  for (const t of train) {
    if (typeof t.judgeScore !== 'number') continue;
    for (const modelId of t.modelsUsed) {
      const p = profileIdx.get(`${modelId}||${t.taskType}`);
      if (!p) continue;
      out.push({ profile: p, observedJudge: t.judgeScore });
    }
  }
  return out;
}

function applyCalibrationToHistory(
  history: HistoricalContributionResult,
  ctx: CalibratedEstimatorContext,
): HistoricalContributionResult {
  const replaced = history.modelProfiles.map((p) =>
    Object.freeze({
      ...p,
      judgeMean: estimateCalibratedJudge(ctx, p),
    }),
  );
  return Object.freeze({
    ...history,
    modelProfiles: Object.freeze(replaced),
  });
}

function countByTaskType(
  rows: readonly HistoricalReplayExecution[],
): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.taskType, (m.get(r.taskType) ?? 0) + 1);
  return m;
}

function errorByTaskTypeFor(
  estimator: { estimate(input: { profile: ModelTaskPerformanceProfile; globalMean?: number; taskTypeOffset?: number; pairLiftMean?: number }): number; name: string },
  data: readonly TrainEvalDatum[],
): ReadonlyMap<string, number> {
  const buckets = new Map<string, { sumErr: number; count: number }>();
  for (const d of data) {
    const predicted = estimator.estimate({
      profile: d.profile,
      globalMean: d.globalMean,
      taskTypeOffset: d.taskTypeOffset,
      pairLiftMean: d.pairLiftMean,
    });
    const err = Math.abs(predicted - d.observedJudge);
    const tt = d.profile.taskType;
    let b = buckets.get(tt);
    if (!b) {
      b = { sumErr: 0, count: 0 };
      buckets.set(tt, b);
    }
    b.sumErr += err;
    b.count += 1;
  }
  const out = new Map<string, number>();
  for (const [k, v] of buckets) {
    out.set(k, v.count > 0 ? v.sumErr / v.count : 0);
  }
  return out;
}

void ALL_ESTIMATORS;
void evaluateEstimator;

main();
