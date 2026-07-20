// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * calibration-determinism.test.ts — MVP 8B.6
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { scoreHistoricalContribution } from '../../contribution/historical-contribution-scorer';
import {
  computeGlobalMean,
  learnTaskTypeOffsets,
} from '../calibration/calibrated-expected-judge-estimator';
import {
  pickBestEstimator,
  type TrainEvalDatum,
} from '../calibration/expected-judge-calibrator';
import { harvestHistoricalResults } from '../harvest/historical-results-harvester';
import { computeCalibrationMetrics } from '../calibration/calibration-metrics';
import { runHistoricalReplay } from '../historical-replay-runner';
import { splitTrainHoldout } from '../historical-replay-split';
import { SYNTHETIC_REPLAY_FIXTURE } from './fixtures/synthetic-replay.fixture';
import type { HistoricalRawRow } from '../harvest/historical-results-schema';
import type { HistoricalExecution } from '../../contribution/historical-execution-types';
import type { HistoricalReplayExecution } from '../historical-replay-types';

afterEach(() => vi.restoreAllMocks());

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

describe('calibration — determinism', () => {
  it('harvest pipeline is deterministic', () => {
    const raw: HistoricalRawRow[] = [
      { id: 'e1', experiment_id: 'exp1', task_type: 'code', models_used: ['m'], judge_score: 0.7, cost_usd: 0.02, success: true },
      { id: 'e2', experiment_id: 'exp1', task_type: 'code', models_used: ['m'], judge_score: 0.6, cost_usd: 0.02, success: true },
    ];
    const a = JSON.stringify(harvestHistoricalResults(raw));
    const b = JSON.stringify(harvestHistoricalResults(raw));
    expect(a).toBe(b);
  });

  it('estimator selection is deterministic on the same data', () => {
    const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    const history = scoreHistoricalContribution({ executions: split.train.map(adapt) });
    const idx = new Map<string, (typeof history.modelProfiles)[number]>();
    for (const p of history.modelProfiles) idx.set(`${p.modelId}||${p.taskType}`, p);
    const data: TrainEvalDatum[] = [];
    for (const t of split.train) {
      for (const m of t.modelsUsed) {
        const p = idx.get(`${m}||${t.taskType}`);
        if (p) data.push({ profile: p, observedJudge: t.judgeScore ?? 0 });
      }
    }
    const a = JSON.stringify(pickBestEstimator(data));
    const b = JSON.stringify(pickBestEstimator(data));
    expect(a).toBe(b);
  });

  it('full pipeline (harvest → split → train → calibrate → replay → metrics) is deterministic', () => {
    const raw: HistoricalRawRow[] = SYNTHETIC_REPLAY_FIXTURE.map((e) => ({
      id: e.executionId,
      experiment_id: e.experimentId,
      task_id: e.taskId,
      task_type: e.taskType,
      strategy: e.strategyId,
      models_used: e.modelsUsed,
      judge_score: e.judgeScore,
      cost_usd: e.costUsd,
      success: e.success,
      created_at: e.createdAt,
      modality: e.modality,
    }));

    function runOnce(): unknown {
      const harvest = harvestHistoricalResults(raw);
      const split = splitTrainHoldout(harvest.trainingAndHoldoutCandidates);
      const trainHistory = scoreHistoricalContribution({
        executions: split.train.map(adapt),
      });
      const idx = new Map<string, (typeof trainHistory.modelProfiles)[number]>();
      for (const p of trainHistory.modelProfiles) idx.set(`${p.modelId}||${p.taskType}`, p);
      const data: TrainEvalDatum[] = [];
      for (const t of split.train) {
        for (const m of t.modelsUsed) {
          const p = idx.get(`${m}||${t.taskType}`);
          if (p) data.push({ profile: p, observedJudge: t.judgeScore ?? 0 });
        }
      }
      const sel = pickBestEstimator(data);
      const offsets = learnTaskTypeOffsets(data);
      const globalMean = computeGlobalMean(data);
      void sel; void offsets; void globalMean;
      const replay = runHistoricalReplay({
        train: split.train,
        holdout: split.holdout,
        trainHistory,
      });
      return computeCalibrationMetrics({
        rows: replay.rows,
        totalHoldoutRows: split.holdout.length,
      });
    }

    const a = JSON.stringify(runOnce());
    for (let i = 0; i < 50; i += 1) {
      expect(JSON.stringify(runOnce())).toBe(a);
    }
  });

  it('does not call Date.now during pipeline', () => {
    const spy = vi.spyOn(Date, 'now');
    const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    const history = scoreHistoricalContribution({ executions: split.train.map(adapt) });
    const idx = new Map<string, (typeof history.modelProfiles)[number]>();
    for (const p of history.modelProfiles) idx.set(`${p.modelId}||${p.taskType}`, p);
    const data: TrainEvalDatum[] = [];
    for (const t of split.train) {
      for (const m of t.modelsUsed) {
        const p = idx.get(`${m}||${t.taskType}`);
        if (p) data.push({ profile: p, observedJudge: t.judgeScore ?? 0 });
      }
    }
    pickBestEstimator(data);
    learnTaskTypeOffsets(data);
    computeGlobalMean(data);
    expect(spy).not.toHaveBeenCalled();
  });
});
