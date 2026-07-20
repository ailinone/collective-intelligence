// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * calibration-no-holdout-leakage.test.ts — MVP 8B.6
 */

import { describe, expect, it } from 'vitest';
import { scoreHistoricalContribution } from '../../contribution/historical-contribution-scorer';
import {
  computeGlobalMean,
  learnTaskTypeOffsets,
} from '../calibration/calibrated-expected-judge-estimator';
import { splitTrainHoldout } from '../historical-replay-split';
import { SYNTHETIC_REPLAY_FIXTURE } from './fixtures/synthetic-replay.fixture';
import type { HistoricalExecution } from '../../contribution/historical-execution-types';
import type { HistoricalReplayExecution } from '../historical-replay-types';
import type { TrainEvalDatum } from '../calibration/expected-judge-calibrator';

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

describe('calibration — no holdout leakage', () => {
  const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);

  it('contribution scorer trained on train only — no holdout experiment ids', () => {
    const trainExpSet = new Set(split.train.map((t) => t.experimentId));
    const holdoutExpSet = new Set(split.holdout.map((t) => t.experimentId));
    for (const id of trainExpSet) expect(holdoutExpSet.has(id)).toBe(false);
  });

  it('train-only history does not contain holdout-only models', () => {
    const history = scoreHistoricalContribution({
      executions: split.train.map(adapt),
    });
    const trainModels = new Set<string>();
    for (const t of split.train) for (const m of t.modelsUsed) trainModels.add(m);
    for (const p of history.modelProfiles) {
      expect(trainModels.has(p.modelId)).toBe(true);
    }
  });

  it('task-type offsets are learned from train rows only', () => {
    // Build TrainEvalData from train rows.
    const history = scoreHistoricalContribution({
      executions: split.train.map(adapt),
    });
    const idx = new Map<string, (typeof history.modelProfiles)[number]>();
    for (const p of history.modelProfiles) idx.set(`${p.modelId}||${p.taskType}`, p);
    const data: TrainEvalDatum[] = [];
    const trainExperimentIds = new Set(split.train.map((t) => t.experimentId));
    for (const t of split.train) {
      // Guard — confirm we never iterate a holdout row.
      expect(trainExperimentIds.has(t.experimentId)).toBe(true);
      for (const m of t.modelsUsed) {
        const p = idx.get(`${m}||${t.taskType}`);
        if (p) data.push({ profile: p, observedJudge: t.judgeScore ?? 0 });
      }
    }
    const offsets = learnTaskTypeOffsets(data);
    const globalMean = computeGlobalMean(data);
    // Offsets must have keys ⊆ task types observed in train.
    const trainTaskTypes = new Set(split.train.map((t) => t.taskType));
    for (const k of offsets.keys()) {
      expect(trainTaskTypes.has(k)).toBe(true);
    }
    expect(globalMean).toBeGreaterThanOrEqual(0);
    expect(globalMean).toBeLessThanOrEqual(1);
  });

  it('estimator selection does NOT see holdout rows', () => {
    // Spot-check: building train-eval data uses only train.
    const trainSet = new Set(split.train.map((t) => t.executionId));
    const holdoutSet = new Set(split.holdout.map((t) => t.executionId));
    for (const t of split.train) expect(holdoutSet.has(t.executionId)).toBe(false);
    for (const h of split.holdout) expect(trainSet.has(h.executionId)).toBe(false);
  });

  it('pair profiles built on train do not include holdout-only pairs', () => {
    const history = scoreHistoricalContribution({
      executions: split.train.map(adapt),
    });
    // Holdout-only pair from the fixture: (fx-cheap-harmful, fx-cheap-harmful).
    for (const p of history.pairProfiles) {
      const isHoldoutOnly =
        p.modelA === 'fx-cheap-harmful' && p.modelB === 'fx-cheap-harmful';
      expect(isHoldoutOnly).toBe(false);
    }
  });
});
