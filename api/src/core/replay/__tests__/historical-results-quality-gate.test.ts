// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-results-quality-gate.test.ts — MVP 8B.6
 */

import { describe, expect, it } from 'vitest';
import { classifyRow, classifyRows } from '../harvest/historical-results-quality-gate';
import type { NormalisedRow } from '../harvest/historical-results-schema';

function row(overrides: Partial<NormalisedRow>): NormalisedRow {
  return Object.freeze({
    executionId: 'e1',
    experimentId: 'exp1',
    taskId: 'e1::0::0',
    modelsUsed: ['m1'],
    providerRoutes: [],
    judgeScoreRaw: 0.5,
    judgeScoreNormalized: 0.5,
    judgeScaleDetected: '0_1',
    judgeNormalizationApplied: false,
    judgeComparable: true,
    judgeUsed: true,
    qualityScore: null,
    heuristicScoreRaw: null,
    costUsd: 0.02,
    latencyMs: null,
    totalTokens: null,
    success: true,
    taskType: 'code',
    strategy: 'single',
    ...overrides,
  });
}

describe('classifyRow — happy path', () => {
  it('returns usable_for_training when all required fields present', () => {
    const d = classifyRow(row({}));
    expect(d.usage).toBe('usable_for_training');
    expect(d.reasons).toContain('judge_normalised_ok');
  });
});

describe('classifyRow — exclusions', () => {
  it('missing executionId → excluded', () => {
    const d = classifyRow(row({ executionId: '' }));
    expect(d.usage).toBe('excluded');
    expect(d.reasons).toContain('missing_execution_id');
  });

  it('empty modelsUsed → excluded', () => {
    const d = classifyRow(row({ modelsUsed: [] }));
    expect(d.usage).toBe('excluded');
    expect(d.reasons).toContain('missing_models_used');
  });

  it('unknown judge scale + no cost + no failure → excluded', () => {
    const d = classifyRow(
      row({
        judgeScoreRaw: null,
        judgeScoreNormalized: null,
        judgeScaleDetected: 'unknown',
        judgeComparable: false,
        costUsd: null,
      }),
    );
    expect(d.usage).toBe('excluded');
    expect(d.reasons).toContain('no_usable_signal');
  });
});

describe('classifyRow — partial usability', () => {
  it('cost present + no judge → usable_for_cost_only', () => {
    const d = classifyRow(
      row({
        judgeScoreRaw: null,
        judgeScoreNormalized: null,
        judgeScaleDetected: 'unknown',
        judgeComparable: false,
        costUsd: 0.05,
      }),
    );
    expect(d.usage).toBe('usable_for_cost_only');
  });

  it('failureMode present + no judge → usable_for_failure_analysis_only', () => {
    const d = classifyRow(
      row({
        judgeScoreRaw: null,
        judgeScoreNormalized: null,
        judgeScaleDetected: 'unknown',
        judgeComparable: false,
        costUsd: null,
        failureMode: 'provider_timeout',
      }),
    );
    expect(d.usage).toBe('usable_for_failure_analysis_only');
  });
});

describe('classifyRows — bulk', () => {
  it('produces per-usage counts', () => {
    const rows = [
      row({}),
      row({ modelsUsed: [], executionId: 'e2' }),
      // failure-analysis-only: no judge AND no cost AND failure mode set.
      row({
        executionId: 'e3',
        judgeScoreRaw: null,
        judgeScoreNormalized: null,
        judgeScaleDetected: 'unknown',
        judgeComparable: false,
        costUsd: null,
        failureMode: 'x',
      }),
    ];
    const r = classifyRows(rows);
    expect(r.counts.usable_for_training).toBe(1);
    expect(r.counts.excluded).toBe(1);
    expect(r.counts.usable_for_failure_analysis_only).toBe(1);
  });
});
