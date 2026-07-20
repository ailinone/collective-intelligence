// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Report head-to-head is PAIRED by task, not pooled (review STAT-4).
 *
 * The old report ran welchTTest on pooled score arrays and win-rate by array
 * position — task-mix confounded (an arm that drew easier tasks looked better,
 * the mechanism behind the wrong v4 "+0.059" headline). This drives generateReport
 * through the public API with a deliberately confounded dataset and asserts the
 * head-to-head qualityDelta equals the PAIRED delta (shared tasks only), not the
 * pooled mean difference.
 */
import { describe, it, expect } from 'vitest';
import { generateReport } from '../experiment-report';
import type { ExperimentExecutionResult } from '../experiment-types';

function row(over: Partial<ExperimentExecutionResult>): ExperimentExecutionResult {
  return {
    experimentId: 'exp', taskIndex: 0, repetition: 1, executionMode: 'single-model',
    strategy: 'single', model: 'gpt-5.4', taskType: 'reasoning', complexity: 'high', domain: 'tech',
    prompt: 'p', qualityScore: 0.8, costUsd: 0.01, latencyMs: 1000, totalTokens: 500, success: true,
    modelsUsed: ['gpt-5.4'], judgeScore: 0.8, judgeRubric: 'r', faithfulnessScore: null,
    instructionFollowingScore: null, failureMode: null, phase: 'frozen', responseSummary: 'm',
    ablationDisabled: [], ablationCondition: null, scoringPolicy: 'benchmark', judgeUsed: true,
    heuristicScoreRaw: null,
    ...over,
  };
}

describe('generateReport head-to-head — paired, not pooled (STAT-4)', () => {
  it('reports the PAIRED quality delta on shared tasks, ignoring the confounding extra single task', () => {
    const results: ExperimentExecutionResult[] = [
      // Single ran an EXTRA hard task (0.30) the collective never attempted —
      // this is what dragged pooled means around.
      row({ taskIndex: 1, executionMode: 'single-model', qualityScore: 0.90 }),
      row({ taskIndex: 2, executionMode: 'single-model', qualityScore: 0.90 }),
      row({ taskIndex: 3, executionMode: 'single-model', qualityScore: 0.30 }),
      // Collective only ran the two easy shared tasks.
      row({ taskIndex: 1, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.60 }),
      row({ taskIndex: 2, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.60 }),
    ];

    const report = generateReport('exp', 'Paired vs Pooled', results);
    const h2h = report.detailedResults.headToHead.find(
      (c) => c.groupA === 'single-model' && c.groupB === 'collective',
    );
    expect(h2h).toBeDefined();

    // PAIRED delta over shared tasks {1,2}: single 0.90 − collective 0.60 = +0.30.
    // POOLED would be mean(single 0.90,0.90,0.30)=0.70 − 0.60 = +0.10 — the wrong,
    // task-mix-confounded number.
    expect(h2h!.qualityDelta).toBeCloseTo(0.30, 5);
    expect(h2h!.qualityDelta).not.toBeCloseTo(0.10, 2);

    // Win rate is paired too: single wins both shared tasks.
    expect(h2h!.winRate.total).toBe(2);
    expect(h2h!.winRate.groupAWinRate).toBeCloseTo(1, 5);
  });
});
