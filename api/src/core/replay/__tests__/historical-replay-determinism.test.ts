// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-determinism.test.ts — MVP 8B.5
 *
 * Same input → same output across all replay layers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { scoreHistoricalContribution } from '../../contribution/historical-contribution-scorer';
import { loadFromJsonl } from '../historical-replay-loader';
import { computeReplayMetrics } from '../historical-replay-metrics';
import { runHistoricalReplay } from '../historical-replay-runner';
import { splitTrainHoldout } from '../historical-replay-split';
import { SYNTHETIC_REPLAY_FIXTURE, asJsonl } from './fixtures/synthetic-replay.fixture';
import type { HistoricalExecution } from '../../contribution/historical-execution-types';
import type { HistoricalReplayExecution } from '../historical-replay-types';

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('historical-replay — determinism', () => {
  it('loadFromJsonl is deterministic', () => {
    const j = asJsonl();
    const a = JSON.stringify(loadFromJsonl(j));
    const b = JSON.stringify(loadFromJsonl(j));
    expect(a).toBe(b);
  });

  it('splitTrainHoldout is deterministic', () => {
    const a = JSON.stringify(splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE));
    const b = JSON.stringify(splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE));
    expect(a).toBe(b);
  });

  it('runHistoricalReplay is deterministic across 100 iters', () => {
    const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    const trainHistory = scoreHistoricalContribution({
      executions: split.train.map(adapt),
    });
    const args = { train: split.train, holdout: split.holdout, trainHistory };
    const first = JSON.stringify(runHistoricalReplay(args));
    for (let i = 0; i < 100; i += 1) {
      expect(JSON.stringify(runHistoricalReplay(args))).toBe(first);
    }
  });

  it('does not call Date.now during runner', () => {
    const spy = vi.spyOn(Date, 'now');
    const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    const trainHistory = scoreHistoricalContribution({
      executions: split.train.map(adapt),
    });
    runHistoricalReplay({ train: split.train, holdout: split.holdout, trainHistory });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not call Math.random during runner', () => {
    const spy = vi.spyOn(Math, 'random');
    const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    const trainHistory = scoreHistoricalContribution({
      executions: split.train.map(adapt),
    });
    runHistoricalReplay({ train: split.train, holdout: split.holdout, trainHistory });
    expect(spy).not.toHaveBeenCalled();
  });

  it('metrics aggregation is deterministic', () => {
    const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    const trainHistory = scoreHistoricalContribution({
      executions: split.train.map(adapt),
    });
    const run = runHistoricalReplay({
      train: split.train,
      holdout: split.holdout,
      trainHistory,
    });
    const a = JSON.stringify(
      computeReplayMetrics({
        rows: run.rows,
        totalHoldoutRows: split.holdout.length,
        excludedDueToMissingBaseline: 0,
      }),
    );
    const b = JSON.stringify(
      computeReplayMetrics({
        rows: run.rows,
        totalHoldoutRows: split.holdout.length,
        excludedDueToMissingBaseline: 0,
      }),
    );
    expect(a).toBe(b);
  });

  it('input arrays are not mutated by the runner', () => {
    const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    const trainHistory = scoreHistoricalContribution({
      executions: split.train.map(adapt),
    });
    const beforeTrain = JSON.stringify(split.train);
    const beforeHoldout = JSON.stringify(split.holdout);
    runHistoricalReplay({ train: split.train, holdout: split.holdout, trainHistory });
    expect(JSON.stringify(split.train)).toBe(beforeTrain);
    expect(JSON.stringify(split.holdout)).toBe(beforeHoldout);
  });
});
