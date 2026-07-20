// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * run-ensemble-calibrated-replay.ts — MVP 8B.7
 *
 * Full ensemble-calibrated replay:
 *   1. Load normalised export.
 *   2. Split train/holdout (by experimentId).
 *   3. Train contribution profiles on TRAIN.
 *   4. Build EnsembleCalibrationExamples from TRAIN.
 *   5. Calibrate peer-lift on TRAIN.
 *   6. Pick best ensemble estimator on TRAIN (composite MAE+fallback).
 *   7. Calibrate marginal-gain policy on TRAIN.
 *   8. Apply EnsembleCalibratedOptimizer to HOLDOUT.
 *   9. Compute metrics + per-task-type approval.
 *  10. Emit final report.
 *
 * Pure orchestration; the script is just glue around the offline layer.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scoreContributionAwareCandidate, type ContributionAwareCandidate, type ContributionAwareScore } from '../../contribution/contribution-aware-candidate-scorer';
import { scoreHistoricalContribution } from '../../contribution/historical-contribution-scorer';
import {
  ALL_ENSEMBLE_ESTIMATORS,
  evaluateEnsembleEstimator,
  pickBestEnsembleEstimator,
} from '../../pareto/calibration/ensemble-expected-judge-estimator';
import {
  calibrateMarginalGain,
  DEFAULT_MARGINAL_GAIN_POLICY,
} from '../../pareto/calibration/marginal-gain-calibrator';
import {
  optimizeEnsembleCalibrated,
} from '../../pareto/calibration/ensemble-calibrated-optimizer';
import {
  resolveEnsembleLiftPolicy,
} from '../../pareto/calibration/ensemble-lift-policy';
import {
  calibratePeerLift,
  lookupPeerLift,
} from '../../pareto/calibration/peer-lift-calibrator';
import { decideTaskTypeApproval } from '../../pareto/calibration/tasktype-ensemble-approval';
import { buildEnsembleCalibrationReport } from '../../pareto/calibration/ensemble-calibration-report';
import type {
  EnsembleCalibrationMetrics,
} from '../../pareto/calibration/ensemble-calibration-types';
import { splitTrainHoldout } from '../historical-replay-split';
import { buildCalibrationExamplesFromTrain } from './ensemble-calibration-shared';
import type { HistoricalReplayExecution } from '../historical-replay-types';
import type { ModelTaskPerformanceProfile } from '../../contribution/model-task-performance-profile';


const ARTIFACTS_DIR = resolve(__dirname, '..', 'artifacts');
const NORMALIZED_PATH = resolve(
  ARTIFACTS_DIR,
  'c3-history-full-export.normalized.jsonl',
);
const REPORT_PATH = resolve(ARTIFACTS_DIR, 'c3-ensemble-calibration-report.json');

function main(): void {
  console.log('[8b7] loading normalised export…');
  const lines = readFileSync(NORMALIZED_PATH, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const executions: HistoricalReplayExecution[] = [];
  for (const l of lines) {
    try {
      executions.push(JSON.parse(l) as HistoricalReplayExecution);
    } catch {
      // skip
    }
  }
  console.log('[8b7] loaded', executions.length, 'eligible executions');

  const split = splitTrainHoldout(executions, {
    strategy: 'by_experiment_id',
    holdoutFraction: 0.3,
  });
  console.log(
    '[8b7] train=',
    split.train.length,
    'over',
    split.trainExperimentIds.length,
    'exp | holdout=',
    split.holdout.length,
    'over',
    split.holdoutExperimentIds.length,
  );

  // Train contribution profiles on TRAIN.
  const trainHistory = scoreHistoricalContribution({
    executions: split.train.map((e) => ({
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
      modality: e.modality,
    })),
  });

  // Build calibration examples.
  const calibrationExamples = buildCalibrationExamplesFromTrain(
    split.train,
    trainHistory,
  );
  console.log('[8b7] calibration examples:', calibrationExamples.length);

  // Peer-lift.
  const peerLift = calibratePeerLift({ trainExamples: calibrationExamples });
  console.log('[8b7] globalPeerLift:', peerLift.globalPeerLift.toFixed(4));
  for (const [k, v] of Object.entries(peerLift.peerLiftByTaskType)) {
    console.log(
      `[8b7]   peerLift[${k}]=${v.toFixed(4)} (n=${peerLift.sampleCountByTaskType[k]})`,
    );
  }

  // Pick best estimator on TRAIN.
  const peerLiftLookup = (ex: typeof calibrationExamples[number]) =>
    lookupPeerLift(peerLift, ex.taskType, ex.effectiveStrategyId);
  const sel = pickBestEnsembleEstimator({
    examples: calibrationExamples,
    peerLiftLookup,
    uncertaintyPenaltyWeight: 0.5,
  });
  console.log('[8b7] BEST ensemble estimator:', sel.chosen.name);
  for (const ev of sel.evaluations) {
    console.log(
      `[8b7]   ${ev.estimatorName.padEnd(34)} MAE=${ev.meanAbsoluteError.toFixed(4)} median=${ev.medianAbsoluteError.toFixed(4)} p80=${ev.p80AbsoluteError.toFixed(4)} nonFallback=${ev.nonFallbackRate.toFixed(3)}`,
    );
  }

  // Marginal-gain policy calibration (grid search on train).
  const gainCal = calibrateMarginalGain({
    trainExamples: calibrationExamples,
    peerLift,
    estimator: sel.chosen,
  });
  console.log(
    '[8b7] chosen marginal-gain policy:',
    `maxTotal=${gainCal.chosenPolicy.maxTotalGain}`,
    `maxPerModel=${gainCal.chosenPolicy.maxPerModelGain}`,
    `uncertaintyPenalty=${gainCal.chosenPolicy.uncertaintyPenaltyWeight}`,
    `MAE=${gainCal.chosenEvaluation.meanAbsoluteError.toFixed(4)}`,
  );

  // Build final policy and apply to HOLDOUT.
  const liftPolicy = resolveEnsembleLiftPolicy({
    estimatorName: sel.chosen.name,
    maxTotalLift: gainCal.chosenPolicy.maxTotalGain,
    maxPerAdditionalModelLift: gainCal.chosenPolicy.maxPerModelGain,
    uncertaintyPenaltyWeight: gainCal.chosenPolicy.uncertaintyPenaltyWeight,
  });

  // Build holdout candidates per row (synthetic ContributionAwareScore
  // from each model's profile + cost estimate; matches the 8B.6 replay
  // runner approach but uses the train profiles only).
  const trainHistoryProfileIdx = new Map<string, ModelTaskPerformanceProfile>();
  for (const p of trainHistory.modelProfiles) {
    trainHistoryProfileIdx.set(`${p.modelId}||${p.taskType}`, p);
  }

  const holdoutResults = runHoldoutReplay({
    split,
    profilesByModel: trainHistoryProfileIdx,
    peerLiftCalibration: peerLift,
    liftPolicy,
    estimator: sel.chosen,
    trainBaselines: computeBaselinesByTask(split.train),
  });

  const metrics = aggregateMetrics(holdoutResults, split.holdout.length);
  console.log('[8b7] calibrated metrics:');
  console.log('   expected_vs_observed_judge_error =', metrics.expectedVsObservedJudgeError.toFixed(4));
  console.log('   non_fallback_rate              =', metrics.nonFallbackRate.toFixed(4));
  console.log('   fallback_rate                  =', metrics.fallbackRate.toFixed(4));
  console.log('   quality_ge_single_rate         =', metrics.qualityGeSingleRate.toFixed(4));
  console.log('   cost_le_single_rate            =', metrics.costLeSingleRate.toFixed(4));
  console.log('   quality_and_cost_success_rate  =', metrics.qualityAndCostSuccessRate.toFixed(4));
  console.log('   cost_prediction_error          = $', metrics.costPredictionError.toFixed(4));
  console.log('   coverage_rate                  =', metrics.coverageRate.toFixed(4));

  // Per-task-type approvals.
  const approvals = buildTaskTypeApprovals(holdoutResults, split, liftPolicy);

  // Re-evaluate the chosen estimator on train (for the report).
  const estimatorEvaluations = ALL_ENSEMBLE_ESTIMATORS.map((est) =>
    evaluateEnsembleEstimator({
      estimator: est,
      examples: calibrationExamples,
      peerLiftLookup,
      uncertaintyPenaltyWeight: liftPolicy.uncertaintyPenaltyWeight,
    }),
  );

  const report = buildEnsembleCalibrationReport({
    chosenEstimator: sel.chosen,
    estimatorEvaluations,
    peerLift,
    marginalGainCalibration: gainCal,
    liftPolicy,
    calibratedMetrics: metrics,
    approvalsByTaskType: approvals,
    nowIso: new Date().toISOString(),
  });

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log('[8b7] wrote', REPORT_PATH);
  console.log(
    '[8b7] APPROVAL:',
    report.approval.approved ? 'APPROVED' : 'REJECTED',
  );
  for (const r of report.approval.reasons) console.log('         -', r);
  void DEFAULT_MARGINAL_GAIN_POLICY;
}

// ─── Holdout replay ─────────────────────────────────────────────────────

interface HoldoutRowResult {
  readonly taskType: string;
  readonly observedJudge: number;
  readonly observedCost: number;
  readonly singleBaselineJudge: number;
  readonly singleBaselineCost: number;
  readonly expectedJudge: number;
  readonly expectedCost: number;
  readonly isFallback: boolean;
  readonly fallbackReason?: string;
  readonly memberCount: number;
}

interface RunHoldoutInput {
  readonly split: ReturnType<typeof splitTrainHoldout>;
  readonly profilesByModel: ReadonlyMap<string, ModelTaskPerformanceProfile>;
  readonly peerLiftCalibration: ReturnType<typeof calibratePeerLift>;
  readonly liftPolicy: ReturnType<typeof resolveEnsembleLiftPolicy>;
  readonly estimator: ReturnType<typeof pickBestEnsembleEstimator>['chosen'];
  readonly trainBaselines: ReadonlyMap<string, { judgeMean: number; costMean: number }>;
}

function runHoldoutReplay(input: RunHoldoutInput): readonly HoldoutRowResult[] {
  const out: HoldoutRowResult[] = [];
  for (const h of input.split.holdout) {
    if (typeof h.judgeScore !== 'number') continue;
    if (typeof h.costUsd !== 'number') continue;
    const baseline = input.trainBaselines.get(h.taskType);
    if (!baseline) continue;

    // Build candidates from the TRAIN models for this task type.
    const taskModels = uniqueTrainModelsForTask(input.split.train, h.taskType);
    if (taskModels.length === 0) continue;

    const candidates: ContributionAwareScore[] = [];
    for (const modelId of taskModels) {
      const profile = input.profilesByModel.get(`${modelId}||${h.taskType}`);
      if (!profile) continue;
      const candidate: ContributionAwareCandidate = {
        routeId: `replay::${modelId}`,
        modelId,
        taskType: h.taskType,
        taskModality: h.modality ?? 'text',
        capabilities: ['chat'],
        modality: h.modality ?? 'text',
        routeKind: 'native',
        estimatedCostUsd: profile.costMean > 0 ? profile.costMean : baseline.costMean,
        structuralScore: profile.judgeMean,
        historicalProfile: profile,
      };
      candidates.push(scoreContributionAwareCandidate(candidate));
    }
    if (candidates.length === 0) continue;

    const result = optimizeEnsembleCalibrated({
      candidates,
      baseline: {
        singleModelJudge: baseline.judgeMean,
        singleModelCostUsd: baseline.costMean,
      },
      taskType: h.taskType,
      strategyId: h.effectiveStrategyId ?? h.strategyId,
      peerLiftCalibration: input.peerLiftCalibration,
      liftPolicy: input.liftPolicy,
      estimator: input.estimator,
    });

    const isFallback = result.ensemblePlan.strategyId === 'single_fallback';
    out.push({
      taskType: h.taskType,
      observedJudge: h.judgeScore,
      observedCost: h.costUsd,
      singleBaselineJudge: baseline.judgeMean,
      singleBaselineCost: baseline.costMean,
      expectedJudge: result.ensemblePlan.expectedJudge,
      expectedCost: result.ensemblePlan.expectedCostUsd,
      isFallback,
      fallbackReason: result.fallbackReason,
      memberCount: result.ensemblePlan.selectedModelIds.length,
    });
  }
  return out;
}

// ─── Aggregations ───────────────────────────────────────────────────────

function uniqueTrainModelsForTask(
  train: readonly HistoricalReplayExecution[],
  taskType: string,
): readonly string[] {
  const set = new Set<string>();
  for (const t of train) {
    if (t.taskType !== taskType) continue;
    for (const m of t.modelsUsed) set.add(m);
  }
  return [...set].sort();
}

function computeBaselinesByTask(
  train: readonly HistoricalReplayExecution[],
): Map<string, { judgeMean: number; costMean: number }> {
  const out = new Map<string, { judgeMean: number; costMean: number }>();
  const buckets = new Map<string, { judges: number[]; costs: number[] }>();
  for (const t of train) {
    if (t.strategyId !== 'single') continue;
    if (typeof t.judgeScore !== 'number') continue;
    let b = buckets.get(t.taskType);
    if (!b) {
      b = { judges: [], costs: [] };
      buckets.set(t.taskType, b);
    }
    b.judges.push(t.judgeScore);
    if (typeof t.costUsd === 'number') b.costs.push(t.costUsd);
  }
  for (const [k, v] of buckets) {
    if (v.judges.length === 0) continue;
    out.set(k, {
      judgeMean: avg(v.judges),
      costMean: avg(v.costs),
    });
  }
  return out;
}

function aggregateMetrics(
  rows: readonly HoldoutRowResult[],
  totalHoldoutRows: number,
): EnsembleCalibrationMetrics {
  const n = rows.length;
  if (n === 0) {
    return Object.freeze({
      evaluatedRows: 0,
      expectedVsObservedJudgeError: 0,
      medianError: 0,
      p80Error: 0,
      nonFallbackRate: 0,
      fallbackRate: 0,
      qualityAndCostSuccessRate: 0,
      qualityGeSingleRate: 0,
      costLeSingleRate: 0,
      costPredictionError: 0,
      taskTypeErrors: {},
      fallbackReasonDistribution: {},
      coverageRate: 0,
      pairWinnerSelectedTotal: 0,
      cheapGoodPreservedTotal: 0,
      unjustifiedCollectiveAvoidedTotal: 0,
      expensiveConsensusAvoidedTotal: 0,
      harmfulModelAvoidedTotal: 0,
      modalityMismatchAvoidedTotal: 0,
      multiMiniPoolAvoidedTotal: 0,
    });
  }
  const judgeErrors: number[] = [];
  const costErrors: number[] = [];
  const taskBuckets: Record<string, number[]> = {};
  const fallbackReasons: Record<string, number> = {};
  let qualityOk = 0;
  let costOk = 0;
  let both = 0;
  let fallback = 0;
  let pairWinner = 0;
  let cheapGood = 0;

  for (const r of rows) {
    const judgeError = Math.abs(r.expectedJudge - r.observedJudge);
    const costError = Math.abs(r.expectedCost - r.observedCost);
    judgeErrors.push(judgeError);
    costErrors.push(costError);
    let bucket = taskBuckets[r.taskType];
    if (!bucket) {
      bucket = [];
      taskBuckets[r.taskType] = bucket;
    }
    bucket.push(judgeError);

    if (r.isFallback) {
      fallback += 1;
      const reason = r.fallbackReason ?? 'unknown';
      fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
    }
    if (r.expectedJudge >= r.singleBaselineJudge) qualityOk += 1;
    if (r.expectedCost <= r.singleBaselineCost) costOk += 1;
    if (r.expectedJudge >= r.singleBaselineJudge && r.expectedCost <= r.singleBaselineCost) {
      both += 1;
    }
    if (
      !r.isFallback &&
      r.memberCount >= 2 &&
      r.expectedJudge >= r.singleBaselineJudge
    ) {
      pairWinner += 1;
    }
    if (
      !r.isFallback &&
      r.expectedCost < r.singleBaselineCost * 0.5 &&
      r.expectedJudge >= r.singleBaselineJudge
    ) {
      cheapGood += 1;
    }
  }
  judgeErrors.sort((a, b) => a - b);
  const taskTypeErrors: Record<string, number> = {};
  for (const [k, errs] of Object.entries(taskBuckets)) {
    taskTypeErrors[k] = avg(errs);
  }
  return Object.freeze({
    evaluatedRows: n,
    expectedVsObservedJudgeError: avg(judgeErrors),
    medianError: percentile(judgeErrors, 0.5),
    p80Error: percentile(judgeErrors, 0.8),
    nonFallbackRate: (n - fallback) / n,
    fallbackRate: fallback / n,
    qualityAndCostSuccessRate: both / n,
    qualityGeSingleRate: qualityOk / n,
    costLeSingleRate: costOk / n,
    costPredictionError: avg(costErrors),
    taskTypeErrors,
    fallbackReasonDistribution: fallbackReasons,
    coverageRate: totalHoldoutRows > 0 ? n / totalHoldoutRows : 0,
    pairWinnerSelectedTotal: pairWinner,
    cheapGoodPreservedTotal: cheapGood,
    unjustifiedCollectiveAvoidedTotal: 0,
    expensiveConsensusAvoidedTotal: 0,
    harmfulModelAvoidedTotal: 0,
    modalityMismatchAvoidedTotal: 0,
    multiMiniPoolAvoidedTotal: 0,
  });
}

function buildTaskTypeApprovals(
  rows: readonly HoldoutRowResult[],
  split: ReturnType<typeof splitTrainHoldout>,
  liftPolicy: ReturnType<typeof resolveEnsembleLiftPolicy>,
): readonly ReturnType<typeof decideTaskTypeApproval>[] {
  const buckets = new Map<string, HoldoutRowResult[]>();
  for (const r of rows) {
    let b = buckets.get(r.taskType);
    if (!b) {
      b = [];
      buckets.set(r.taskType, b);
    }
    b.push(r);
  }
  // Per-task train counts.
  const trainCounts = new Map<string, number>();
  for (const t of split.train) {
    trainCounts.set(t.taskType, (trainCounts.get(t.taskType) ?? 0) + 1);
  }
  const out: ReturnType<typeof decideTaskTypeApproval>[] = [];
  for (const [taskType, items] of [...buckets.entries()].sort()) {
    const judgeErrors = items.map((r) => Math.abs(r.expectedJudge - r.observedJudge));
    const success = items.filter(
      (r) => r.expectedJudge >= r.singleBaselineJudge && r.expectedCost <= r.singleBaselineCost,
    ).length;
    const cost = items.filter((r) => r.expectedCost <= r.singleBaselineCost).length;
    const quality = items.filter((r) => r.expectedJudge >= r.singleBaselineJudge).length;
    const fallback = items.filter((r) => r.isFallback).length;
    out.push(
      decideTaskTypeApproval({
        taskType,
        trainSamples: trainCounts.get(taskType) ?? 0,
        holdoutSamples: items.length,
        expectedVsObservedJudgeError: avg(judgeErrors),
        qualityAndCostSuccessRate: success / items.length,
        costLeSingleRate: cost / items.length,
        qualityGeSingleRate: quality / items.length,
        nonFallbackRate: 1 - fallback / items.length,
        fallbackRate: fallback / items.length,
        policy: liftPolicy,
      }),
    );
  }
  return out;
}

function avg(arr: readonly number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
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

main();
