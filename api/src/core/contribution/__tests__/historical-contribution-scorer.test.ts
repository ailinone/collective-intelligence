// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-contribution-scorer.test.ts — MVP 8A
 *
 * Validates the aggregator: per-model profiles + global baselines.
 * Uses the canonical fixture set.
 */

import { describe, expect, it } from 'vitest';
import { scoreHistoricalContribution } from '../historical-contribution-scorer';
import {
  FX,
  HISTORICAL_EXECUTIONS_FIXTURE,
} from './fixtures/historical-executions.fixture';

function findProfile(
  profiles: ReturnType<typeof scoreHistoricalContribution>['modelProfiles'],
  modelId: string,
  taskType: string,
): ReturnType<typeof scoreHistoricalContribution>['modelProfiles'][number] | undefined {
  return profiles.find((p) => p.modelId === modelId && p.taskType === taskType);
}

describe('scoreHistoricalContribution — global baselines', () => {
  const result = scoreHistoricalContribution({
    executions: HISTORICAL_EXECUTIONS_FIXTURE,
  });

  it('computes singleModelJudgeMean from single-strategy rows', () => {
    expect(result.globalBaselines.singleModelJudgeMean).toBeGreaterThan(0);
    expect(result.globalBaselines.singleModelJudgeMean).toBeLessThan(1);
  });

  it('computes singleModelCostMean', () => {
    expect(result.globalBaselines.singleModelCostMean).toBeGreaterThan(0);
  });

  it('computes collectiveParallelJudgeMean and CostMean', () => {
    expect(result.globalBaselines.collectiveParallelJudgeMean).toBeGreaterThan(0);
    expect(result.globalBaselines.collectiveParallelCostMean).toBeGreaterThan(0);
  });

  it('singleBudget baselines reflect cheap-fast single rows', () => {
    expect(result.globalBaselines.singleBudgetJudgeMean).toBeGreaterThan(0);
    expect(result.globalBaselines.singleBudgetCostMean).toBeLessThan(
      result.globalBaselines.singleModelCostMean,
    );
  });
});

describe('scoreHistoricalContribution — per-model profiles', () => {
  const result = scoreHistoricalContribution({
    executions: HISTORICAL_EXECUTIONS_FIXTURE,
  });

  it('emits a profile for each (model, taskType) cell observed', () => {
    expect(result.modelProfiles.length).toBeGreaterThan(0);
    for (const p of result.modelProfiles) {
      expect(p.modelId).toBeTruthy();
      expect(p.taskType).toBeTruthy();
      expect(p.sampleCount).toBeGreaterThan(0);
    }
  });

  it('anchor model has recommendedRole=anchor', () => {
    const p = findProfile(result.modelProfiles, FX.ANCHOR_A, 'code-generation');
    expect(p).toBeDefined();
    expect(['anchor', 'support']).toContain(p!.recommendedRole);
    expect(p!.judgeMean).toBeGreaterThan(0.5);
  });

  it('cheap-good model: budget_support OR support role', () => {
    const p = findProfile(result.modelProfiles, FX.CHEAP_GOOD, 'code-generation');
    expect(p).toBeDefined();
    expect(['budget_support', 'support']).toContain(p!.recommendedRole);
    expect(p!.qualityPerDollar).toBeGreaterThan(100);
  });

  it('cheap-harmful model: avoid role', () => {
    const p = findProfile(result.modelProfiles, FX.CHEAP_HARMFUL, 'code-generation');
    expect(p).toBeDefined();
    expect(p!.recommendedRole).toBe('avoid');
    expect(p!.harmRate).toBeGreaterThan(0.3);
  });

  it('multi-mini models: avoid role', () => {
    for (const m of [FX.MINI_A, FX.MINI_B, FX.MINI_C]) {
      const p = findProfile(result.modelProfiles, m, 'code-generation');
      expect(p, `profile missing for ${m}`).toBeDefined();
      expect(p!.recommendedRole).toBe('avoid');
    }
  });

  it('expensive-bad model: avoid OR support but low score', () => {
    const p = findProfile(result.modelProfiles, FX.EXPENSIVE_BAD, 'code-generation');
    expect(p).toBeDefined();
    expect(p!.contributionScore).toBeLessThan(0.6);
  });
});

describe('scoreHistoricalContribution — pair profiles', () => {
  const result = scoreHistoricalContribution({
    executions: HISTORICAL_EXECUTIONS_FIXTURE,
  });

  it('emits at least one pair profile for the validated parallel combo', () => {
    const pair = result.pairProfiles.find(
      (p) =>
        (p.modelA === FX.PAIR_WINNER_X && p.modelB === FX.PAIR_WINNER_Y) ||
        (p.modelA === FX.PAIR_WINNER_Y && p.modelB === FX.PAIR_WINNER_X),
    );
    expect(pair, 'expected pair winner profile').toBeDefined();
    expect(pair!.judgeMean).toBeGreaterThan(0.8);
    expect(pair!.beatsSingleBaselineRate).toBeGreaterThan(0.5);
  });

  it('pair-loser combo has low judgeMean', () => {
    const pair = result.pairProfiles.find(
      (p) =>
        (p.modelA === FX.PAIR_LOSER_P && p.modelB === FX.PAIR_LOSER_Q) ||
        (p.modelA === FX.PAIR_LOSER_Q && p.modelB === FX.PAIR_LOSER_P),
    );
    expect(pair, 'expected pair loser profile').toBeDefined();
    expect(pair!.judgeMean).toBeLessThan(0.3);
  });
});

describe('scoreHistoricalContribution — task filter', () => {
  it('taskType filter narrows the result set', () => {
    const visionOnly = scoreHistoricalContribution({
      executions: HISTORICAL_EXECUTIONS_FIXTURE,
      taskType: 'image-understanding',
    });
    expect(visionOnly.modelProfiles.length).toBeGreaterThan(0);
    for (const p of visionOnly.modelProfiles) {
      expect(p.taskType).toBe('image-understanding');
    }
  });
});

describe('scoreHistoricalContribution — frozen outputs', () => {
  const result = scoreHistoricalContribution({
    executions: HISTORICAL_EXECUTIONS_FIXTURE,
  });
  it('result is frozen', () => {
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('globalBaselines is frozen', () => {
    expect(Object.isFrozen(result.globalBaselines)).toBe(true);
  });
});
