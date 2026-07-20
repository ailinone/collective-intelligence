// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-metrics.test.ts — MVP 8B.5
 *
 * Validates the metrics aggregator + per-task breakdown.
 */

import { describe, expect, it } from 'vitest';
import {
  computeMetricsByTaskType,
  computeReplayMetrics,
} from '../historical-replay-metrics';
import type { ReplayRowResult, SelectorProjection } from '../historical-replay-types';

function proj(
  selectorId: SelectorProjection['selectorId'],
  judge: number,
  cost: number,
  fallback = false,
): SelectorProjection {
  return Object.freeze({
    selectorId,
    selectedModelIds: Object.freeze([]),
    expectedJudge: judge,
    expectedCostUsd: cost,
    fallback,
  });
}

function row(
  args: Partial<ReplayRowResult> & {
    taskType?: string;
    paretoJudge: number;
    paretoCost: number;
    structuralJudge: number;
    structuralCost: number;
    baselineJudge: number;
    baselineCost: number;
    fallback?: boolean;
  },
): ReplayRowResult {
  return Object.freeze({
    executionId: 'e',
    taskId: 't',
    taskType: args.taskType ?? 'code',
    complexity: 'medium',
    baseline: Object.freeze({
      taskId: 't',
      taskType: args.taskType ?? 'code',
      singleJudge: args.baselineJudge,
      singleCostUsd: args.baselineCost,
      comparableExecutions: 5,
    }),
    selectors: Object.freeze({
      actual_historical: proj('actual_historical', 0.5, 0.02),
      single_top: proj('single_top', args.baselineJudge, args.baselineCost),
      single_budget: proj('single_budget', args.baselineJudge - 0.05, args.baselineCost * 0.5),
      structural_naive: proj('structural_naive', args.structuralJudge, args.structuralCost),
      pareto_aware: proj('pareto_aware', args.paretoJudge, args.paretoCost, args.fallback ?? false),
    }),
    pareto_meets_quality_thesis: args.paretoJudge >= args.baselineJudge,
    pareto_meets_cost_thesis: args.paretoCost <= args.baselineCost,
    pareto_meets_both:
      args.paretoJudge >= args.baselineJudge &&
      args.paretoCost <= args.baselineCost,
    harmful_model_avoided: false,
    modality_mismatch_avoided: false,
    pareto_single_fallback: args.fallback ?? false,
    ...args,
  });
}

describe('computeReplayMetrics', () => {
  it('empty input → zero metrics with correct totals', () => {
    const m = computeReplayMetrics({
      rows: [],
      totalHoldoutRows: 20,
      excludedDueToMissingBaseline: 20,
    });
    expect(m.evaluatedRows).toBe(0);
    expect(m.totalHoldoutRows).toBe(20);
    expect(m.excludedDueToMissingBaseline).toBe(20);
    expect(m.quality_and_cost_success_rate).toBe(0);
  });

  it('aggregates pareto_meets_both into quality_and_cost_success_rate', () => {
    const rows = [
      row({ paretoJudge: 0.8, paretoCost: 0.01, structuralJudge: 0.7, structuralCost: 0.02, baselineJudge: 0.6, baselineCost: 0.022 }),
      row({ paretoJudge: 0.5, paretoCost: 0.01, structuralJudge: 0.7, structuralCost: 0.02, baselineJudge: 0.6, baselineCost: 0.022 }),
      row({ paretoJudge: 0.8, paretoCost: 0.05, structuralJudge: 0.7, structuralCost: 0.02, baselineJudge: 0.6, baselineCost: 0.022 }),
    ];
    const m = computeReplayMetrics({
      rows,
      totalHoldoutRows: 3,
      excludedDueToMissingBaseline: 0,
    });
    expect(m.evaluatedRows).toBe(3);
    expect(m.quality_and_cost_success_rate).toBeCloseTo(1 / 3, 3);
    expect(m.coverage_rate).toBe(1);
  });

  it('avg_expected_judge_delta + median_expected_judge_delta', () => {
    const rows = [
      row({ paretoJudge: 0.8, paretoCost: 0.01, structuralJudge: 0.6, structuralCost: 0.02, baselineJudge: 0.5, baselineCost: 0.02 }),
      row({ paretoJudge: 0.9, paretoCost: 0.01, structuralJudge: 0.6, structuralCost: 0.02, baselineJudge: 0.5, baselineCost: 0.02 }),
    ];
    const m = computeReplayMetrics({
      rows,
      totalHoldoutRows: 2,
      excludedDueToMissingBaseline: 0,
    });
    expect(m.avg_expected_judge_delta).toBeCloseTo(0.25, 3);
    expect(m.median_expected_judge_delta).toBeCloseTo(0.25, 3);
  });

  it('single_fallback_rate counts pareto_single_fallback rows', () => {
    const rows = [
      row({ paretoJudge: 0.4, paretoCost: 0.02, structuralJudge: 0.6, structuralCost: 0.02, baselineJudge: 0.5, baselineCost: 0.02, fallback: true }),
      row({ paretoJudge: 0.6, paretoCost: 0.01, structuralJudge: 0.6, structuralCost: 0.02, baselineJudge: 0.5, baselineCost: 0.02, fallback: false }),
    ];
    const m = computeReplayMetrics({
      rows,
      totalHoldoutRows: 2,
      excludedDueToMissingBaseline: 0,
    });
    expect(m.single_fallback_rate).toBe(0.5);
  });
});

describe('computeMetricsByTaskType', () => {
  it('groups rows by taskType and computes per-type means', () => {
    const rows = [
      row({ taskType: 'code', paretoJudge: 0.8, paretoCost: 0.01, structuralJudge: 0.6, structuralCost: 0.02, baselineJudge: 0.5, baselineCost: 0.02 }),
      row({ taskType: 'code', paretoJudge: 0.7, paretoCost: 0.01, structuralJudge: 0.6, structuralCost: 0.02, baselineJudge: 0.5, baselineCost: 0.02 }),
      row({ taskType: 'analysis', paretoJudge: 0.5, paretoCost: 0.02, structuralJudge: 0.5, structuralCost: 0.02, baselineJudge: 0.5, baselineCost: 0.02 }),
    ];
    const t = computeMetricsByTaskType(rows);
    expect(t.length).toBe(2);
    const code = t.find((x) => x.taskType === 'code');
    const analysis = t.find((x) => x.taskType === 'analysis');
    expect(code).toBeDefined();
    expect(analysis).toBeDefined();
    expect(code!.holdoutCount).toBe(2);
    expect(analysis!.holdoutCount).toBe(1);
    expect(code!.paretoExpectedJudgeMean).toBeCloseTo(0.75, 3);
  });

  it('output is sorted by taskType alphabetically (deterministic)', () => {
    const rows = [
      row({ taskType: 'z', paretoJudge: 0.5, paretoCost: 0.01, structuralJudge: 0.5, structuralCost: 0.01, baselineJudge: 0.5, baselineCost: 0.01 }),
      row({ taskType: 'a', paretoJudge: 0.5, paretoCost: 0.01, structuralJudge: 0.5, structuralCost: 0.01, baselineJudge: 0.5, baselineCost: 0.01 }),
    ];
    const t = computeMetricsByTaskType(rows);
    expect(t[0].taskType).toBe('a');
    expect(t[1].taskType).toBe('z');
  });
});
