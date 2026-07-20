// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test: q3_collectiveWinsWhere / q4_collectiveNotWorth (2026-07-16 fix).
 *
 * These fields answer the exact question an operator asks when trying to
 * segregate collective wins from losses ("where does it win?"). They were
 * still comparing POOLED means within each (taskType/complexity) scenario
 * bucket — the SAME task-mix confounding q2/q6 were fixed for at the top
 * level (the v4 ERRATA lesson): an arm that ran an easier subset of tasks
 * WITHIN a scenario bucket could "win" the bucket on task-mix alone, not
 * genuine capability.
 *
 * This constructs exactly that trap: within one scenario, the collective only
 * ran the EASY shared task (and skipped a HARD task the single ran), so the
 * POOLED bucket mean falsely shows a large collective advantage. Paired by
 * task, the only shared comparison is a small, single-task, non-significant
 * delta — the fixed code must NOT classify this as a "win".
 */
import { describe, it, expect } from 'vitest';
import { generateGoNoGoReport } from '../go-no-go-engine';
import type { ExperimentExecutionResult } from '../experiment-types';

function row(over: Partial<ExperimentExecutionResult>): ExperimentExecutionResult {
  return {
    experimentId: 'exp-scenario-slice',
    taskIndex: 0,
    repetition: 1,
    executionMode: 'single-model',
    strategy: 'single',
    model: 'gpt-5.4',
    taskType: 'reasoning',
    complexity: 'high',
    domain: 'tech',
    prompt: 'p',
    qualityScore: 0.8,
    costUsd: 0.01,
    latencyMs: 1000,
    totalTokens: 500,
    success: true,
    modelsUsed: ['gpt-5.4'],
    judgeScore: 0.8,
    judgeRubric: 'r',
    faithfulnessScore: null,
    instructionFollowingScore: null,
    failureMode: null,
    phase: 'frozen',
    responseSummary: 'mock',
    ...over,
  };
}

describe('go-no-go per-scenario slice — paired, not pooled (2026-07-16)', () => {
  it('does NOT classify a scenario as a collective win when the "win" is only a task-mix artefact', () => {
    // Scenario "reasoning/high": single ran BOTH task 501 (easy, 0.90) and task
    // 502 (hard, 0.40, dragging its pooled mean down); collective ONLY ran the
    // easy task 501 (0.95) — it never attempted the hard one. Pooled bucket
    // means: single=0.65, collective=0.95 → old pooled logic reports a HUGE
    // (+0.30) spurious "collective win" for this scenario. Paired, the only
    // shared task (501) has a tiny +0.05 delta with n=1 — not enough to judge.
    const results: ExperimentExecutionResult[] = [
      row({ taskIndex: 501, executionMode: 'single-model', model: 'gpt-5.4', qualityScore: 0.90 }),
      row({ taskIndex: 502, executionMode: 'single-model', model: 'gpt-5.4', qualityScore: 0.40 }),
      row({ taskIndex: 501, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.95 }),
      // no collective row for task 502 — the arm never ran it.
    ];

    const report = generateGoNoGoReport('exp-scenario-slice', results);
    const q = report.mandatoryQuestions;

    expect(q.q3_collectiveWinsWhere).not.toContain('reasoning/high');
    // Sanity: prove the trap is real — the pooled means WOULD have crossed the
    // win threshold, so this is genuinely testing the pooled-vs-paired fix and
    // not a vacuous assertion.
    const pooledSingle = (0.90 + 0.40) / 2;
    const pooledCollective = 0.95;
    expect(pooledCollective - pooledSingle).toBeGreaterThan(0.07); // DEFAULT_THRESHOLDS.minQualityGainForCollective
  });

  it('DOES classify a scenario as a collective win with a genuine, consistent, multi-task paired advantage', () => {
    const results: ExperimentExecutionResult[] = [
      row({ taskIndex: 601, executionMode: 'single-model', model: 'gpt-5.4', qualityScore: 0.70 }),
      row({ taskIndex: 602, executionMode: 'single-model', model: 'gpt-5.4', qualityScore: 0.68 }),
      row({ taskIndex: 603, executionMode: 'single-model', model: 'gpt-5.4', qualityScore: 0.72 }),
      row({ taskIndex: 601, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.85 }),
      row({ taskIndex: 602, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.83 }),
      row({ taskIndex: 603, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.87 }),
    ];

    const report = generateGoNoGoReport('exp-scenario-slice', results);
    const q = report.mandatoryQuestions;

    expect(q.q3_collectiveWinsWhere).toContain('reasoning/high');
  });

  it('omits a scenario from BOTH buckets when fewer than 2 tasks are shared (no meaningful paired signal)', () => {
    const results: ExperimentExecutionResult[] = [
      row({ taskIndex: 701, executionMode: 'single-model', model: 'gpt-5.4', qualityScore: 0.50 }),
      row({ taskIndex: 701, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.95 }),
    ];

    const report = generateGoNoGoReport('exp-scenario-slice', results);
    const q = report.mandatoryQuestions;

    expect(q.q3_collectiveWinsWhere).not.toContain('reasoning/high');
    expect(q.q4_collectiveNotWorth).not.toContain('reasoning/high');
  });
});
