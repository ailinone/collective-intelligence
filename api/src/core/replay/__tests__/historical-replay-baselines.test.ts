// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-baselines.test.ts — MVP 8B.5
 *
 * Verifies baselines are computed from TRAIN only and contain the
 * expected fields (singleJudge, singleCostUsd, optional budget baseline,
 * actualHistoricalJudge mirror).
 */

import { describe, expect, it } from 'vitest';
import { scoreHistoricalContribution } from '../../contribution/historical-contribution-scorer';
import { runHistoricalReplay } from '../historical-replay-runner';
import { splitTrainHoldout } from '../historical-replay-split';
import { SYNTHETIC_REPLAY_FIXTURE } from './fixtures/synthetic-replay.fixture';
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

describe('baselines', () => {
  const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
  const trainHistory = scoreHistoricalContribution({
    executions: split.train.map(adapt),
  });
  const result = runHistoricalReplay({
    train: split.train,
    holdout: split.holdout,
    trainHistory,
  });

  it('every evaluated row has a baseline with singleJudge and singleCostUsd', () => {
    expect(result.rows.length).toBeGreaterThan(0);
    for (const r of result.rows) {
      expect(typeof r.baseline.singleJudge).toBe('number');
      expect(typeof r.baseline.singleCostUsd).toBe('number');
    }
  });

  it('baseline carries actualHistoricalJudge when the holdout had one', () => {
    const withActual = result.rows.filter(
      (r) => r.baseline.actualHistoricalJudge !== undefined,
    );
    expect(withActual.length).toBeGreaterThan(0);
  });

  it('singleBudgetJudge is set when train had enough single rows', () => {
    const withBudget = result.rows.filter(
      (r) => r.baseline.singleBudgetJudge !== undefined,
    );
    expect(withBudget.length).toBeGreaterThan(0);
  });

  it('singleBudgetCostUsd <= singleCostUsd when both are present', () => {
    for (const r of result.rows) {
      if (
        r.baseline.singleBudgetCostUsd !== undefined &&
        r.baseline.singleCostUsd !== undefined
      ) {
        expect(r.baseline.singleBudgetCostUsd).toBeLessThanOrEqual(
          r.baseline.singleCostUsd + 1e-9,
        );
      }
    }
  });

  it('comparableExecutions count is positive when baseline is filled', () => {
    for (const r of result.rows) {
      if (r.baseline.singleJudge > 0) {
        expect(r.baseline.comparableExecutions).toBeGreaterThan(0);
      }
    }
  });
});
