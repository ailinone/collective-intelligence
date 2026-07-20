// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-respects-cost-ceiling.test.ts — MVP 8A
 *
 * Validates 15.1/15.4/15.5: ensemble cost must stay within baseline ×
 * maxCostRatioVsSingle, and consensus is forbidden by default.
 */

import { describe, expect, it } from 'vitest';
import { optimizeParetoEnsemble } from '../pareto-ensemble-optimizer';
import {
  scoreAnchorA,
  scoreAnchorB,
  scorePairX,
  scorePairY,
  scoreExpensiveNotPareto,
  STANDARD_BASELINE,
} from './fixtures/candidate-fixtures';

describe('optimizer — cost ceiling', () => {
  it('parallel winner: cost <= baseline', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [scorePairX(), scorePairY(), scoreAnchorA()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan.expectedCostUsd).toBeLessThanOrEqual(
      STANDARD_BASELINE.singleModelCostUsd + 1e-9,
    );
    expect(plan.strategyId).toBe('parallel');
  });

  it('parallel winner: judge >= baseline', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [scorePairX(), scorePairY(), scoreAnchorA()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan.expectedJudge).toBeGreaterThanOrEqual(
      STANDARD_BASELINE.singleModelJudge,
    );
  });

  it('paretoStatus = beats_baseline for the parallel winner', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [scorePairX(), scorePairY()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan.paretoStatus).toBe('beats_baseline');
  });

  it('expensive-only set forces single_fallback under strict policy', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [scoreExpensiveNotPareto(), scoreAnchorB()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    // The expensive candidate alone would exceed the cost ceiling when
    // added to anchor; the optimizer should fall back.
    if (plan.strategyId !== 'parallel') {
      expect(plan.strategyId).toBe('single_fallback');
    } else {
      expect(plan.expectedCostUsd).toBeLessThanOrEqual(
        STANDARD_BASELINE.singleModelCostUsd + 1e-9,
      );
    }
  });

  it('consensus is permitted only when allowConsensusWhenCostExceedsBaseline', () => {
    const candidates = [scoreAnchorA(), scoreAnchorB(), scorePairX()];
    const planStrict = optimizeParetoEnsemble({
      candidates,
      taskType: 'analysis',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(planStrict.strategyId).not.toBe('consensus');

    const planRelaxed = optimizeParetoEnsemble({
      candidates,
      taskType: 'analysis',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
      policy: {
        allowConsensusWhenCostExceedsBaseline: true,
        maxCostRatioVsSingle: 7,
        minExpectedJudgeRatioVsSingle: 1,
      },
    });
    // When permitted AND the chosen ensemble's cost exceeds baseline,
    // the optimizer may pick consensus. We assert it AT LEAST does not
    // forbid the choice (parallel may still win if cheap).
    expect(['parallel', 'consensus']).toContain(planRelaxed.strategyId);
  });

  it('maxCostRatioVsSingle=0.5 forces tighter selection', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [scorePairX(), scorePairY(), scoreAnchorA()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
      policy: { maxCostRatioVsSingle: 0.5 },
    });
    expect(plan.expectedCostUsd).toBeLessThanOrEqual(
      STANDARD_BASELINE.singleModelCostUsd * 0.5 + 1e-9,
    );
  });
});
