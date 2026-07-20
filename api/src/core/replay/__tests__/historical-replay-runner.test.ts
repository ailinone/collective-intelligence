// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-runner.test.ts — MVP 8B.5
 *
 * End-to-end smoke for the runner: train profiles → run replay →
 * row results with all 5 selectors populated.
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

describe('runHistoricalReplay — smoke', () => {
  const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
  const trainHistory = scoreHistoricalContribution({
    executions: split.train.map(adapt),
  });
  const result = runHistoricalReplay({
    train: split.train,
    holdout: split.holdout,
    trainHistory,
  });

  it('produces a non-empty row list', () => {
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('every row has all 5 selector projections', () => {
    for (const r of result.rows) {
      expect(r.selectors.actual_historical).toBeDefined();
      expect(r.selectors.single_top).toBeDefined();
      expect(r.selectors.single_budget).toBeDefined();
      expect(r.selectors.structural_naive).toBeDefined();
      expect(r.selectors.pareto_aware).toBeDefined();
    }
  });

  it('every row reports verdict booleans', () => {
    for (const r of result.rows) {
      expect(typeof r.pareto_meets_quality_thesis).toBe('boolean');
      expect(typeof r.pareto_meets_cost_thesis).toBe('boolean');
      expect(typeof r.pareto_meets_both).toBe('boolean');
      expect(typeof r.harmful_model_avoided).toBe('boolean');
      expect(typeof r.modality_mismatch_avoided).toBe('boolean');
      expect(typeof r.pareto_single_fallback).toBe('boolean');
    }
  });

  it('output is frozen', () => {
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rows)).toBe(true);
  });

  it('actual_historical projection mirrors the holdout row', () => {
    for (const r of result.rows) {
      const h = split.holdout.find((x) => x.executionId === r.executionId);
      expect(h).toBeDefined();
      expect(r.selectors.actual_historical.expectedJudge).toBe(
        h!.judgeScore ?? 0,
      );
    }
  });

  it('pareto_aware never selects models outside the train candidate set', () => {
    const trainModels = new Set<string>();
    for (const t of split.train) for (const m of t.modelsUsed) trainModels.add(m);
    for (const r of result.rows) {
      for (const m of r.selectors.pareto_aware.selectedModelIds) {
        expect(trainModels.has(m)).toBe(true);
      }
    }
  });
});
