// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Statistical-integrity fixes for the confirmatory verdict (review STAT-1/2/3).
 *
 * STAT-1 — the confirmatory comparison is verifier-ARMED consensus vs the BEST
 *          single per task, not mean-of-all-collectives vs mean-of-all-singles.
 * STAT-2 — only frozen + success + non-null rows are scored (failed/warmup rows
 *          with qualityScore 0 no longer contaminate the verdict).
 * STAT-3 — a zero-variance paired sample no longer fabricates p=0; it falls back
 *          to the two-sided sign test.
 */
import { describe, it, expect } from 'vitest';
import { generateSegmentedBenchmarkReport } from '../segmented-benchmark-report';
import { pairedTTest } from '../statistical-analysis';
import { HARD_VERIFIABLE_TASK_TYPE } from '../experiment-suite';
import type { ExperimentExecutionResult } from '../experiment-types';

function row(over: Partial<ExperimentExecutionResult>): ExperimentExecutionResult {
  return {
    experimentId: 'exp', taskIndex: 0, repetition: 1, executionMode: 'single-model',
    strategy: 'single', model: 'gpt-5.4', taskType: HARD_VERIFIABLE_TASK_TYPE, complexity: 'high',
    domain: 'tech', prompt: 'p', qualityScore: 0.8, costUsd: 0.01, latencyMs: 1000, totalTokens: 500,
    success: true, modelsUsed: ['gpt-5.4'], judgeScore: 0.8, judgeRubric: 'r', faithfulnessScore: null,
    instructionFollowingScore: null, failureMode: null, phase: 'frozen', responseSummary: 'm',
    ...over,
  };
}

describe('STAT-1 — armed consensus vs BEST single (not mean-of-all)', () => {
  it('reports NO_ADVANTAGE when consensus beats the MEAN single but not the BEST single', () => {
    const results: ExperimentExecutionResult[] = [];
    for (const ti of [146, 147]) {
      // Two singles per task: a strong frontier (0.90) and a weak per-provider (0.30).
      results.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'frontier', qualityScore: 0.90 }));
      results.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'weak', qualityScore: 0.30 }));
      // Armed consensus at 0.80: beats the MEAN single (0.60) but not the BEST (0.90).
      results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.80 }));
    }
    const report = generateSegmentedBenchmarkReport('exp', results);
    const haHard = report.confirmatory.find((f) => f.regime === 'ha-hard')!;
    expect(haHard.verdict).toBe('NO_ADVANTAGE');
    expect(haHard.pairedDeltaMean).toBeCloseTo(-0.10, 5); // 0.80 - 0.90
  });

  it('ignores non-armed collective strategies (blind-debate is the control, not the thesis)', () => {
    const results: ExperimentExecutionResult[] = [];
    for (const ti of [146, 147]) {
      results.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'frontier', qualityScore: 0.60 }));
      // A blind-debate collective scoring high must NOT count toward the confirmatory verdict.
      results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: 'blind-debate', model: null, qualityScore: 0.99 }));
      // The ARMED consensus is the only collective the verdict considers — and it ties.
      results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.61 }));
    }
    const report = generateSegmentedBenchmarkReport('exp', results);
    const haHard = report.confirmatory.find((f) => f.regime === 'ha-hard')!;
    // Delta is consensus(0.61) - bestSingle(0.60) = +0.01, not the 0.99 debate score.
    expect(haHard.pairedDeltaMean).toBeCloseTo(0.01, 5);
  });
});

describe('STAT-2 — failed/warmup rows excluded from the verdict', () => {
  it('a failed row (success=false, qualityScore 0) does not drag the collective down', () => {
    const results: ExperimentExecutionResult[] = [];
    for (const ti of [146, 147, 148]) {
      results.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'frontier', qualityScore: 0.50 }));
      results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.90 }));
    }
    // Contaminating rows: a FAILED collective (0) and a WARMUP collective (0) —
    // if counted, they would erase the win.
    results.push(row({ taskIndex: 146, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0, success: false, failureMode: 'timeout' }));
    results.push(row({ taskIndex: 147, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0, phase: 'warmup' }));

    const report = generateSegmentedBenchmarkReport('exp', results);
    const haHard = report.confirmatory.find((f) => f.regime === 'ha-hard')!;
    expect(haHard.verdict).toBe('COLLECTIVE_WINS');
    expect(haHard.pairedDeltaMean).toBeCloseTo(0.40, 5); // 0.90 - 0.50, uncontaminated
  });
});

describe('STAT-3 — zero-variance paired sample uses the sign test, never p=0', () => {
  it('n=2 identical deltas → p=0.5, NOT significant (was fabricated p=0)', () => {
    const r = pairedTTest([1, 1]);
    expect(r.pValue).toBeCloseTo(0.5, 5);
    expect(r.significant).toBe(false);
  });

  it('n=6 identical positive deltas → p=0.03125, significant', () => {
    const r = pairedTTest([1, 1, 1, 1, 1, 1]);
    expect(r.pValue).toBeCloseTo(2 * Math.pow(0.5, 6), 5);
    expect(r.significant).toBe(true);
  });

  it('all-zero deltas → p=1, not significant', () => {
    const r = pairedTTest([0, 0, 0]);
    expect(r.pValue).toBe(1);
    expect(r.significant).toBe(false);
  });
});
