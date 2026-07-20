// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * calibration-tasktype-breakdown.test.ts — MVP 8B.6
 */

import { describe, expect, it } from 'vitest';
import { buildTaskTypeCalibration } from '../calibration/tasktype-calibration';
import {
  DEFAULT_CALIBRATION_POLICY,
} from '../calibration/calibration-policy';
import type { ReplayRowResult } from '../historical-replay-types';

function makeRow(taskType: string, paretoBoth: boolean, fallback: boolean): ReplayRowResult {
  return Object.freeze({
    executionId: `e-${taskType}-${Math.random().toString(36).slice(2)}`,
    taskId: 't',
    taskType,
    complexity: 'medium',
    baseline: Object.freeze({
      taskId: 't',
      taskType,
      singleJudge: 0.5,
      singleCostUsd: 0.02,
      comparableExecutions: 5,
    }),
    selectors: Object.freeze({
      actual_historical: Object.freeze({
        selectorId: 'actual_historical',
        selectedModelIds: Object.freeze([]),
        expectedJudge: 0.5,
        expectedCostUsd: 0.02,
        fallback: false,
      }),
      single_top: Object.freeze({
        selectorId: 'single_top',
        selectedModelIds: Object.freeze([]),
        expectedJudge: 0.5,
        expectedCostUsd: 0.02,
        fallback: false,
      }),
      structural_naive: Object.freeze({
        selectorId: 'structural_naive',
        selectedModelIds: Object.freeze([]),
        expectedJudge: 0.6,
        expectedCostUsd: 0.02,
        fallback: false,
      }),
      pareto_aware: Object.freeze({
        selectorId: 'pareto_aware',
        selectedModelIds: Object.freeze([]),
        expectedJudge: paretoBoth ? 0.7 : 0.3,
        expectedCostUsd: paretoBoth ? 0.01 : 0.05,
        fallback,
      }),
    }),
    pareto_meets_quality_thesis: paretoBoth,
    pareto_meets_cost_thesis: paretoBoth,
    pareto_meets_both: paretoBoth,
    harmful_model_avoided: false,
    modality_mismatch_avoided: false,
    pareto_single_fallback: fallback,
  });
}

describe('buildTaskTypeCalibration', () => {
  it('approves code-generation with low error AND good success rate', () => {
    const rows: ReplayRowResult[] = [];
    for (let i = 0; i < 50; i += 1) rows.push(makeRow('code-generation', true, false));

    const t = buildTaskTypeCalibration({
      rows,
      trainCountsByTaskType: new Map([['code-generation', 100]]),
      errorByTaskType: new Map([['code-generation', 0.2]]),
      bestEstimatorName: 'variancePenalizedMean',
      policy: DEFAULT_CALIBRATION_POLICY,
    });
    expect(t.length).toBe(1);
    expect(t[0].status).toBe('approved');
    expect(t[0].approvedForCollective).toBe(true);
  });

  it('blocks code-generation when error too high', () => {
    const rows: ReplayRowResult[] = [];
    for (let i = 0; i < 50; i += 1) rows.push(makeRow('code-generation', true, false));
    const t = buildTaskTypeCalibration({
      rows,
      trainCountsByTaskType: new Map([['code-generation', 100]]),
      errorByTaskType: new Map([['code-generation', 0.4]]),
      bestEstimatorName: 'variancePenalizedMean',
      policy: DEFAULT_CALIBRATION_POLICY,
    });
    expect(t[0].status).toBe('judge_error_too_high');
    expect(t[0].approvedForCollective).toBe(false);
  });

  it('marks insufficient_data when sample is small', () => {
    const rows: ReplayRowResult[] = [];
    for (let i = 0; i < 5; i += 1) rows.push(makeRow('reasoning', false, true));
    const t = buildTaskTypeCalibration({
      rows,
      trainCountsByTaskType: new Map([['reasoning', 10]]),
      errorByTaskType: new Map([['reasoning', 0.1]]),
      bestEstimatorName: 'variancePenalizedMean',
      policy: DEFAULT_CALIBRATION_POLICY,
    });
    expect(t[0].status).toBe('insufficient_data');
  });

  it('marks quality_thesis_failed when success rate is low', () => {
    const rows: ReplayRowResult[] = [];
    for (let i = 0; i < 50; i += 1) rows.push(makeRow('analysis', false, false));
    const t = buildTaskTypeCalibration({
      rows,
      trainCountsByTaskType: new Map([['analysis', 100]]),
      errorByTaskType: new Map([['analysis', 0.2]]),
      bestEstimatorName: 'variancePenalizedMean',
      policy: DEFAULT_CALIBRATION_POLICY,
    });
    expect(t[0].status).toBe('quality_thesis_failed');
  });
});
