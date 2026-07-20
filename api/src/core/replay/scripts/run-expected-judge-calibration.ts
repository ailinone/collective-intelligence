// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * run-expected-judge-calibration.ts — MVP 8B.6
 *
 * Standalone helper that ONLY runs the estimator comparison on train.
 * Used for debugging — does NOT touch the holdout. Outputs to console.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scoreHistoricalContribution } from '../../contribution/historical-contribution-scorer';
import type { ModelTaskPerformanceProfile } from '../../contribution/model-task-performance-profile';
import {
  ALL_ESTIMATORS,
  evaluateEstimator,
  type TrainEvalDatum,
} from '../calibration/expected-judge-calibrator';
import { splitTrainHoldout } from '../historical-replay-split';
import type { HistoricalReplayExecution } from '../historical-replay-types';
import type { HistoricalExecution } from '../../contribution/historical-execution-types';


const ARTIFACTS_DIR = resolve(__dirname, '..', 'artifacts');
const NORMALIZED_PATH = resolve(ARTIFACTS_DIR, 'c3-history-full-export.normalized.jsonl');

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
  const trainHistory = scoreHistoricalContribution({
    executions: split.train.map(replayToContrib),
  });

  const profileIdx = new Map<string, ModelTaskPerformanceProfile>();
  for (const p of trainHistory.modelProfiles) {
    profileIdx.set(`${p.modelId}||${p.taskType}`, p);
  }
  const data: TrainEvalDatum[] = [];
  for (const t of split.train) {
    if (typeof t.judgeScore !== 'number') continue;
    for (const modelId of t.modelsUsed) {
      const p = profileIdx.get(`${modelId}||${t.taskType}`);
      if (!p) continue;
      data.push({ profile: p, observedJudge: t.judgeScore });
    }
  }
  console.log('[calib-only] train eval data:', data.length, 'samples');
  for (const est of ALL_ESTIMATORS) {
    const ev = evaluateEstimator(est, data);
    console.log(
      `[calib-only] ${est.name.padEnd(28)} MAE=${ev.meanAbsoluteError.toFixed(4)} median=${ev.medianAbsoluteError.toFixed(4)} p80=${ev.p80AbsoluteError.toFixed(4)}`,
    );
  }
}

function replayToContrib(e: HistoricalReplayExecution): HistoricalExecution {
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
    modality: e.modality,
  };
}

main();
