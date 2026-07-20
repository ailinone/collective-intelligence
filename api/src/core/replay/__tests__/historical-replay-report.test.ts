// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-report.test.ts — MVP 8B.5
 *
 * Tests the report assembler + approval gate.
 */

import { describe, expect, it } from 'vitest';
import { buildReplayReport } from '../historical-replay-report';
import type { HistoricalReplaySplit, ReplayMetrics } from '../historical-replay-types';

function emptySplit(): HistoricalReplaySplit {
  return Object.freeze({
    train: Object.freeze([]),
    holdout: Object.freeze([]),
    splitStrategy: 'by_experiment_id',
    trainExperimentIds: Object.freeze([]),
    holdoutExperimentIds: Object.freeze([]),
    leakageWarnings: Object.freeze([]),
  });
}

function metrics(overrides: Partial<ReplayMetrics> = {}): ReplayMetrics {
  return {
    totalHoldoutRows: 100,
    evaluatedRows: 100,
    excludedDueToMissingBaseline: 0,
    pareto_win_rate: 0.7,
    quality_ge_single_rate: 0.8,
    cost_le_single_rate: 0.7,
    quality_and_cost_success_rate: 0.6,
    avg_expected_judge_delta: 0.1,
    avg_expected_cost_delta: -0.01,
    median_expected_judge_delta: 0.1,
    median_expected_cost_delta: -0.01,
    expected_quality_per_dollar_delta: 5,
    single_fallback_rate: 0.2,
    unjustified_collective_avoided_total: 5,
    modality_mismatch_avoided_total: 3,
    harmful_model_avoided_total: 7,
    multi_mini_pool_avoided_total: 4,
    expensive_consensus_avoided_total: 2,
    cheap_good_preserved_total: 6,
    pair_winner_selected_total: 8,
    insufficient_data_rejected_total: 3,
    expected_vs_observed_judge_error: 0.1,
    cost_prediction_error: 0.01,
    coverage_rate: 1.0,
    ...overrides,
  };
}

describe('buildReplayReport — approval gates', () => {
  it('approves a clean report', () => {
    const r = buildReplayReport({
      exportMetadata: {
        exportedAt: '2026-05-12T00:00:00Z',
        source: 'fixture',
        rowCounts: { executions: 100, experiments: 5 },
        filters: { onlyWithJudgeScore: true, onlyCompletedExecutions: false },
        schemaVersion: '8b5-v1',
      },
      split: emptySplit(),
      globalMetrics: metrics(),
      metricsByTaskType: [],
      nowIso: '2026-05-12T16:00:00Z',
    });
    expect(r.approval.approved).toBe(true);
  });

  it('rejects when quality_and_cost_success_rate < 0.5', () => {
    const r = buildReplayReport({
      exportMetadata: {
        exportedAt: 't',
        source: 'fixture',
        rowCounts: { executions: 100, experiments: 5 },
        filters: { onlyWithJudgeScore: true, onlyCompletedExecutions: false },
        schemaVersion: '8b5-v1',
      },
      split: emptySplit(),
      globalMetrics: metrics({ quality_and_cost_success_rate: 0.3 }),
      metricsByTaskType: [],
      nowIso: 't',
    });
    expect(r.approval.approved).toBe(false);
    expect(
      r.approval.reasons.some((s) => s.indexOf('quality_and_cost_success_rate_below_0_5') !== -1),
    ).toBe(true);
  });

  it('rejects when holdout is below 20 rows', () => {
    const r = buildReplayReport({
      exportMetadata: {
        exportedAt: 't',
        source: 'fixture',
        rowCounts: { executions: 100, experiments: 5 },
        filters: { onlyWithJudgeScore: true, onlyCompletedExecutions: false },
        schemaVersion: '8b5-v1',
      },
      split: emptySplit(),
      globalMetrics: metrics({ totalHoldoutRows: 10 }),
      metricsByTaskType: [],
      nowIso: 't',
    });
    expect(r.approval.approved).toBe(false);
    expect(
      r.approval.reasons.some((s) => s.indexOf('holdout_too_small') !== -1),
    ).toBe(true);
  });

  it('rejects when single_fallback_rate is excessive', () => {
    const r = buildReplayReport({
      exportMetadata: {
        exportedAt: 't',
        source: 'fixture',
        rowCounts: { executions: 100, experiments: 5 },
        filters: { onlyWithJudgeScore: true, onlyCompletedExecutions: false },
        schemaVersion: '8b5-v1',
      },
      split: emptySplit(),
      globalMetrics: metrics({ single_fallback_rate: 0.9 }),
      metricsByTaskType: [],
      nowIso: 't',
    });
    expect(r.approval.approved).toBe(false);
    expect(
      r.approval.reasons.some((s) => s.indexOf('single_fallback_rate_excessive') !== -1),
    ).toBe(true);
  });

  it('rejects when expected_vs_observed_judge_error > 0.30', () => {
    const r = buildReplayReport({
      exportMetadata: {
        exportedAt: 't',
        source: 'fixture',
        rowCounts: { executions: 100, experiments: 5 },
        filters: { onlyWithJudgeScore: true, onlyCompletedExecutions: false },
        schemaVersion: '8b5-v1',
      },
      split: emptySplit(),
      globalMetrics: metrics({ expected_vs_observed_judge_error: 0.45 }),
      metricsByTaskType: [],
      nowIso: 't',
    });
    expect(r.approval.approved).toBe(false);
    expect(
      r.approval.reasons.some((s) => s.indexOf('expected_vs_observed_judge_error_high') !== -1),
    ).toBe(true);
  });

  it('rejects when split has leakage warnings', () => {
    const split = Object.freeze({
      ...emptySplit(),
      leakageWarnings: Object.freeze(['experiment_id_in_both:foo']),
    });
    const r = buildReplayReport({
      exportMetadata: {
        exportedAt: 't',
        source: 'fixture',
        rowCounts: { executions: 100, experiments: 5 },
        filters: { onlyWithJudgeScore: true, onlyCompletedExecutions: false },
        schemaVersion: '8b5-v1',
      },
      split,
      globalMetrics: metrics(),
      metricsByTaskType: [],
      nowIso: 't',
    });
    expect(r.approval.approved).toBe(false);
    expect(
      r.approval.reasons.some((s) => s.indexOf('leakage_detected') !== -1),
    ).toBe(true);
  });
});

describe('buildReplayReport — output shape', () => {
  it('result is frozen', () => {
    const r = buildReplayReport({
      exportMetadata: {
        exportedAt: 't',
        source: 'fixture',
        rowCounts: { executions: 100, experiments: 5 },
        filters: { onlyWithJudgeScore: true, onlyCompletedExecutions: false },
        schemaVersion: '8b5-v1',
      },
      split: emptySplit(),
      globalMetrics: metrics(),
      metricsByTaskType: [],
      nowIso: 't',
    });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.approval)).toBe(true);
  });
});
