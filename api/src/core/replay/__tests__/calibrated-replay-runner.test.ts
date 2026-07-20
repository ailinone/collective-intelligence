// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * calibrated-replay-runner.test.ts — MVP 8B.6
 *
 * End-to-end smoke for the calibrated replay flow: train profiles →
 * pick estimator → apply calibration → run replay → metrics.
 */

import { describe, expect, it } from 'vitest';
import { scoreHistoricalContribution } from '../../contribution/historical-contribution-scorer';
import {
  computeGlobalMean,
  estimateCalibratedJudge,
  learnTaskTypeOffsets,
} from '../calibration/calibrated-expected-judge-estimator';
import { computeCalibrationMetrics } from '../calibration/calibration-metrics';
import {
  pickBestEstimator,
  type TrainEvalDatum,
} from '../calibration/expected-judge-calibrator';
import { runHistoricalReplay } from '../historical-replay-runner';
import { splitTrainHoldout } from '../historical-replay-split';
import { SYNTHETIC_REPLAY_FIXTURE } from './fixtures/synthetic-replay.fixture';
import type { HistoricalExecution } from '../../contribution/historical-execution-types';
import type {
  HistoricalReplayExecution,
} from '../historical-replay-types';

function adapt(e: HistoricalReplayExecution): HistoricalExecution {
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

describe('calibrated replay runner', () => {
  it('runs end-to-end and emits calibration metrics', () => {
    const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    const trainHistory = scoreHistoricalContribution({
      executions: split.train.map(adapt),
    });

    // Train eval data.
    const idx = new Map<string, (typeof trainHistory.modelProfiles)[number]>();
    for (const p of trainHistory.modelProfiles) idx.set(`${p.modelId}||${p.taskType}`, p);
    const data: TrainEvalDatum[] = [];
    for (const t of split.train) {
      for (const m of t.modelsUsed) {
        const p = idx.get(`${m}||${t.taskType}`);
        if (p) data.push({ profile: p, observedJudge: t.judgeScore ?? 0 });
      }
    }
    const selection = pickBestEstimator(data);
    expect(selection.chosen.name).toBeTruthy();

    const offsets = learnTaskTypeOffsets(data);
    const globalMean = computeGlobalMean(data);

    const ctx = {
      estimator: selection.chosen,
      taskTypeOffsetMap: offsets,
      globalMean,
    };

    // Patch the profiles: replace judgeMean with calibrated estimate.
    const calibratedProfiles = trainHistory.modelProfiles.map((p) =>
      Object.freeze({ ...p, judgeMean: estimateCalibratedJudge(ctx, p) }),
    );
    const calibratedHistory = Object.freeze({
      ...trainHistory,
      modelProfiles: Object.freeze(calibratedProfiles),
    });

    const replay = runHistoricalReplay({
      train: split.train,
      holdout: split.holdout,
      trainHistory: calibratedHistory,
    });
    expect(replay.rows.length).toBeGreaterThan(0);

    const metrics = computeCalibrationMetrics({
      rows: replay.rows,
      totalHoldoutRows: split.holdout.length,
    });
    expect(metrics.coverage_rate).toBeGreaterThan(0);
    expect(metrics.evaluatedRows).toBeGreaterThan(0);
  });

  it('result is deterministic across iterations', () => {
    const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    const trainHistory = scoreHistoricalContribution({
      executions: split.train.map(adapt),
    });
    const a = JSON.stringify(
      runHistoricalReplay({
        train: split.train,
        holdout: split.holdout,
        trainHistory,
      }),
    );
    const b = JSON.stringify(
      runHistoricalReplay({
        train: split.train,
        holdout: split.holdout,
        trainHistory,
      }),
    );
    expect(a).toBe(b);
  });
});
