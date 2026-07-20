// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * run-ensemble-level-calibration.ts — MVP 8B.7
 *
 * Train-only calibration helper. Reads the normalised export from
 * MVP 8B.6, splits train/holdout, builds EnsembleCalibrationExamples
 * from train ONLY, calibrates peer-lift, picks the best ensemble
 * estimator on train. Output to stdout (debug). Does NOT touch holdout.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scoreHistoricalContribution } from '../../contribution/historical-contribution-scorer';
import {
  ALL_ENSEMBLE_ESTIMATORS,
  evaluateEnsembleEstimator,
  pickBestEnsembleEstimator,
} from '../../pareto/calibration/ensemble-expected-judge-estimator';
import {
  calibratePeerLift,
  lookupPeerLift,
} from '../../pareto/calibration/peer-lift-calibrator';
import { splitTrainHoldout } from '../historical-replay-split';
import { buildCalibrationExamplesFromTrain } from './ensemble-calibration-shared';
import type { HistoricalReplayExecution } from '../historical-replay-types';


const NORMALIZED_PATH = resolve(
  __dirname,
  '..',
  'artifacts',
  'c3-history-full-export.normalized.jsonl',
);

function main(): void {
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
  console.log('[calib-only] eligible executions:', executions.length);

  const split = splitTrainHoldout(executions, {
    strategy: 'by_experiment_id',
    holdoutFraction: 0.3,
  });
  console.log(
    '[calib-only] train=',
    split.train.length,
    'holdout=',
    split.holdout.length,
  );

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

  const calibrationExamples = buildCalibrationExamplesFromTrain(
    split.train,
    trainHistory,
  );
  console.log(
    '[calib-only] calibration examples (ensembles only):',
    calibrationExamples.length,
  );

  const peerLift = calibratePeerLift({
    trainExamples: calibrationExamples,
  });
  console.log('[calib-only] globalPeerLift:', peerLift.globalPeerLift.toFixed(4));
  for (const [k, v] of Object.entries(peerLift.peerLiftByTaskType)) {
    console.log(
      `[calib-only]   peerLift[${k}]=${v.toFixed(4)} (n=${peerLift.sampleCountByTaskType[k]})`,
    );
  }

  const selection = pickBestEnsembleEstimator({
    examples: calibrationExamples,
    peerLiftLookup: (ex) =>
      lookupPeerLift(peerLift, ex.taskType, ex.effectiveStrategyId),
    uncertaintyPenaltyWeight: 0.5,
  });
  console.log('[calib-only] BEST estimator:', selection.chosen.name);
  for (const est of ALL_ENSEMBLE_ESTIMATORS) {
    const ev = evaluateEnsembleEstimator({
      estimator: est,
      examples: calibrationExamples,
      peerLiftLookup: (ex) =>
        lookupPeerLift(peerLift, ex.taskType, ex.effectiveStrategyId),
      uncertaintyPenaltyWeight: 0.5,
    });
    console.log(
      `[calib-only]   ${est.name.padEnd(34)} MAE=${ev.meanAbsoluteError.toFixed(4)} median=${ev.medianAbsoluteError.toFixed(4)} p80=${ev.p80AbsoluteError.toFixed(4)} nonFallback=${ev.nonFallbackRate.toFixed(3)}`,
    );
  }
}

main();
