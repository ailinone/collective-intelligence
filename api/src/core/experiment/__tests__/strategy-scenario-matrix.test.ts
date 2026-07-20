// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy × Scenario matrix — per-strategy W/T/L vs best single, FDR-corrected.
 *
 * Proves the properties the matrix exists to guarantee, including the fixes
 * from the adversarial review of this module:
 *   1. Cells are paired against the BEST SINGLE MODEL'S MEAN per task (review
 *      fix: NOT the raw max across every single-model row, which mixes models
 *      AND repetitions and fabricated FDR-significant LOSS labels against a
 *      strategy that matches or beats every single model on average).
 *   2. WIN/LOSS require an FDR-corrected significant delta whose confidence
 *      interval also clears ±TIE_MARGIN — a directional delta that doesn't
 *      clear the bar is UNDECIDED, never a win or a loss.
 *   3. TIE requires the WHOLE confidence interval inside ±TIE_MARGIN (review
 *      fix), not just the point estimate — a noisy 2-task sample near zero is
 *      UNDECIDED, not a proven draw.
 *   4. Rows respect the canonical eligibility filter (frozen/success/non-null),
 *      and every cell/scoreboard row also reports successRate against ALL
 *      attempted executions (review fix), so a strategy cannot look flawless
 *      purely because its failures were excluded from scoring.
 *   5. The cost context compares the strategy to the SAME best-single rows the
 *      quality delta uses (review fix), not the mean of every single model.
 *   6. The scoreboard tallies verdicts per strategy with a deterministic final
 *      tiebreak (review fix) so equal-record rows don't depend on input order.
 *   7. A non-finite (NaN) quality score is excluded before pairing, so
 *      sharedTaskCount always agrees with the deltas actually used.
 * Plus the Benjamini-Hochberg helper itself.
 */
import { describe, it, expect } from 'vitest';
import { generateStrategyScenarioMatrix } from '../strategy-scenario-matrix';
import { benjaminiHochbergQValues } from '../statistical-analysis';
import { HARD_VERIFIABLE_TASK_TYPE } from '../experiment-suite';
import type { ExperimentExecutionResult } from '../experiment-types';

function row(over: Partial<ExperimentExecutionResult>): ExperimentExecutionResult {
  return {
    experimentId: 'exp-m', taskIndex: 0, repetition: 1, executionMode: 'single-model',
    strategy: 'single', model: 'gpt-5.4', taskType: 'reasoning', complexity: 'high', domain: 'tech',
    prompt: 'p', qualityScore: 0.8, costUsd: 0.01, latencyMs: 1000, totalTokens: 500, success: true,
    modelsUsed: ['gpt-5.4'], judgeScore: 0.8, judgeRubric: 'r', faithfulnessScore: null,
    instructionFollowingScore: null, failureMode: null, phase: 'frozen', responseSummary: 'm',
    ablationDisabled: [], ablationCondition: null, scoringPolicy: 'benchmark', judgeUsed: true,
    heuristicScoreRaw: null,
    ...over,
  };
}

function scenarioRows(
  taskIndices: number[],
  singles: Array<{ model: string; score: number }>,
  strategies: Array<{ strategy: string; score: number }>,
  over: Partial<ExperimentExecutionResult> = {},
): ExperimentExecutionResult[] {
  const rows: ExperimentExecutionResult[] = [];
  for (const ti of taskIndices) {
    for (const s of singles) {
      rows.push(row({ taskIndex: ti, executionMode: 'single-model', model: s.model, qualityScore: s.score, ...over }));
    }
    for (const c of strategies) {
      rows.push(row({ taskIndex: ti, executionMode: 'collective', strategy: c.strategy, model: null, qualityScore: c.score, ...over }));
    }
  }
  return rows;
}

describe('benjaminiHochbergQValues', () => {
  it('computes standard step-up q-values, aligned positionally, nulls passed through', () => {
    const q = benjaminiHochbergQValues([0.01, null, 0.04, 0.03]);
    // m=3, sorted: 0.01(k=1), 0.03(k=2), 0.04(k=3)
    // q3 = 0.04*3/3 = 0.04; q2 = min(0.04, 0.03*3/2=0.045) = 0.04; q1 = min(0.04, 0.01*3/1=0.03) = 0.03
    expect(q[1]).toBeNull();
    expect(q[0]).toBeCloseTo(0.03, 10);
    expect(q[3]).toBeCloseTo(0.04, 10);
    expect(q[2]).toBeCloseTo(0.04, 10);
  });

  it('a single tiny p-value in a big family survives; borderline ones do not', () => {
    const family: Array<number | null> = [0.0001, ...Array.from({ length: 99 }, () => 0.5)];
    const q = benjaminiHochbergQValues(family);
    expect(q[0]!).toBeLessThan(0.05); // 0.0001*100/1 = 0.01
    expect(q[1]!).toBeGreaterThan(0.05);
  });
});

describe('generateStrategyScenarioMatrix', () => {
  it('pairs against the BEST single per task — a strategy that beats the mean but not the best does not WIN', () => {
    // 6 tasks: strong single 0.90, weak single 0.30 (mean 0.60); consensus 0.80.
    const results = scenarioRows(
      [146, 147, 148, 149, 150, 151],
      [{ model: 'frontier', score: 0.90 }, { model: 'weak', score: 0.30 }],
      [{ strategy: 'consensus', score: 0.80 }],
      { taskType: HARD_VERIFIABLE_TASK_TYPE },
    );
    const m = generateStrategyScenarioMatrix('exp-m', results);
    const cell = m.cells.find((c) => c.strategy === 'consensus' && c.scenario === 'ha-hard')!;
    expect(cell.pairedDeltaMean).toBeCloseTo(-0.10, 5); // 0.80 − best(0.90)
    expect(cell.verdict).not.toBe('WIN');
    expect(cell.scenarioKind).toBe('confirmatory-regime');
  });

  it('labels a genuine, FDR-surviving paired win as WIN with full audit trail', () => {
    // 8 shared tasks, consistent +0.30 with tiny jitter (sd>0 so the t-test is real).
    const tasks = [146, 147, 148, 149, 150, 151, 152, 153];
    const results: ExperimentExecutionResult[] = [];
    tasks.forEach((ti, i) => {
      results.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'frontier', qualityScore: 0.50, taskType: HARD_VERIFIABLE_TASK_TYPE }));
      results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.80 + (i % 2 ? 0.01 : -0.01), taskType: HARD_VERIFIABLE_TASK_TYPE }));
    });
    const m = generateStrategyScenarioMatrix('exp-m', results);
    const cell = m.cells.find((c) => c.strategy === 'consensus')!;
    expect(cell.verdict).toBe('WIN');
    expect(cell.qValue).not.toBeNull();
    expect(cell.qValue!).toBeLessThan(0.05);
    expect(cell.sharedTaskIndices).toEqual(tasks);
  });

  it('a directional delta WITHOUT significance is UNDECIDED, never a WIN (n=2 identical deltas → sign-test p=0.5)', () => {
    const results = scenarioRows(
      [10, 11],
      [{ model: 'frontier', score: 0.50 }],
      [{ strategy: 'debate', score: 0.80 }],
    );
    const m = generateStrategyScenarioMatrix('exp-m', results);
    const cell = m.cells.find((c) => c.strategy === 'debate')!;
    expect(cell.pairedDeltaMean).toBeCloseTo(0.30, 5);
    expect(cell.verdict).toBe('UNDECIDED');
  });

  it('TIE requires the whole CI inside the margin, not just the point estimate (review fix)', () => {
    // Low-variance case: constant +0.01 deltas → CI collapses to the point
    // estimate (sd=0) → provably a tie.
    const tie = scenarioRows(
      [10, 11, 12],
      [{ model: 'frontier', score: 0.80 }],
      [{ strategy: 'consensus', score: 0.81 }],
    );
    const single = scenarioRows(
      [20],
      [{ model: 'frontier', score: 0.50 }],
      [{ strategy: 'war-room', score: 0.90 }],
      { complexity: 'medium' },
    );
    // Noisy n=2 case: point-estimate delta is tiny (+0.005) but the two
    // per-task deltas are +0.25/-0.24 — a wide CI that does NOT fit inside
    // ±0.02. Before the fix this was mislabeled TIE from the point estimate
    // alone; it must now be UNDECIDED (the data are equally consistent with a
    // ±0.25 effect as with a real draw).
    const noisyNearZero = [
      row({ taskIndex: 30, executionMode: 'single-model', model: 'frontier', qualityScore: 0.50, complexity: 'low' }),
      row({ taskIndex: 30, executionMode: 'collective', strategy: 'noisy-tie', model: null, qualityScore: 0.75, complexity: 'low' }),
      row({ taskIndex: 31, executionMode: 'single-model', model: 'frontier', qualityScore: 0.50, complexity: 'low' }),
      row({ taskIndex: 31, executionMode: 'collective', strategy: 'noisy-tie', model: null, qualityScore: 0.26, complexity: 'low' }),
    ];
    const m = generateStrategyScenarioMatrix('exp-m', [...tie, ...single, ...noisyNearZero]);
    expect(m.cells.find((c) => c.strategy === 'consensus')!.verdict).toBe('TIE');
    expect(m.cells.find((c) => c.strategy === 'war-room')!.verdict).toBe('INSUFFICIENT_DATA');
    const noisyCell = m.cells.find((c) => c.strategy === 'noisy-tie')!;
    expect(noisyCell.pairedDeltaMean).toBeCloseTo(0.005, 5);
    expect(noisyCell.verdict).toBe('UNDECIDED');
  });

  it('P1 review fix: a strategy exactly matching the best single MODEL\'s mean is never LOSS, even with noisy repetitions', () => {
    // 10 tasks, 3 repetitions of ONE single model per task with within-task
    // noise (0.65/0.75/0.85, mean 0.75), and a collective strategy scoring a
    // CONSTANT 0.75 on every task — exactly the single model's true mean.
    // Before the fix, bestSinglePerTask took the raw per-row MAX (≈0.85 every
    // task, an inflated "luckiest draw" ceiling), so the strategy's constant
    // 0.75 registered a systematic -0.10 delta with near-zero variance,
    // reaching a fabricated FDR-significant LOSS. The fixed baseline
    // rep-averages the single model FIRST (0.75), so the delta is ~0 and the
    // strategy is never penalized for matching the single model's true mean.
    const tasks = Array.from({ length: 10 }, (_, i) => 200 + i);
    const results: ExperimentExecutionResult[] = [];
    for (const ti of tasks) {
      for (const rep of [1, 2, 3]) {
        const score = rep === 1 ? 0.65 : rep === 2 ? 0.75 : 0.85;
        results.push(row({ taskIndex: ti, repetition: rep, executionMode: 'single-model', model: 'frontier', qualityScore: score }));
      }
      results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.75 }));
    }
    const m = generateStrategyScenarioMatrix('exp-m', results);
    const cell = m.cells.find((c) => c.strategy === 'consensus')!;
    expect(cell.verdict).not.toBe('LOSS');
    expect(cell.pairedDeltaMean).toBeCloseTo(0, 5); // matches the single MODEL's true mean, not its luckiest draw
  });

  it('P1 review fix: a strategy matching the truly-best model is never LOSS just because a WORSE model had one lucky repetition', () => {
    // Two single models on every task: A has ONE rep at 0.80 (its true, only,
    // performance); B has TWO reps [0.60, 0.95] on EVERY task (B's true mean
    // is 0.775 — genuinely worse than A on every task, but one of its reps
    // occasionally beats A by luck). The strategy matches A (the REAL best
    // model) constantly at 0.80.
    // Before the fix, the raw per-row max baseline picked B's LUCKY 0.95 rep
    // on every task (max(0.80, 0.60, 0.95) = 0.95), giving a constant -0.15
    // delta with zero variance -> a fabricated, FDR-surviving LOSS against a
    // strategy that in truth matches the single best REAL model. The fixed
    // baseline rep-averages B first (0.775), so max(A=0.80, B=0.775) = 0.80 —
    // exactly what the strategy scores, so the delta is 0.
    const tasks = Array.from({ length: 12 }, (_, i) => 300 + i);
    const results: ExperimentExecutionResult[] = [];
    for (const ti of tasks) {
      results.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'A', qualityScore: 0.80 }));
      results.push(row({ taskIndex: ti, repetition: 1, executionMode: 'single-model', model: 'B', qualityScore: 0.60 }));
      results.push(row({ taskIndex: ti, repetition: 2, executionMode: 'single-model', model: 'B', qualityScore: 0.95 }));
      results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.80 }));
    }
    const m = generateStrategyScenarioMatrix('exp-m', results);
    const cell = m.cells.find((c) => c.strategy === 'consensus')!;
    expect(cell.verdict).not.toBe('LOSS');
    expect(cell.pairedDeltaMean).toBeCloseTo(0, 5);
  });

  it('FDR: one strategy with a real effect survives; many borderline strategies do not each get a WIN', () => {
    const tasks = Array.from({ length: 6 }, (_, i) => 30 + i);
    const results: ExperimentExecutionResult[] = [];
    for (const ti of tasks) {
      results.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'frontier', qualityScore: 0.50 }));
    }
    // One strong strategy: large consistent effect.
    tasks.forEach((ti, i) => {
      results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: 'strong', model: null, qualityScore: 0.90 + (i % 2 ? 0.01 : -0.01) }));
    });
    // Many borderline strategies: small noisy positive deltas (raw p just under
    // 0.05 territory would be luck; here the effect is weak/noisy on purpose).
    for (let s = 0; s < 12; s++) {
      tasks.forEach((ti, i) => {
        const jitter = (i % 3 === 0 ? 0.10 : i % 3 === 1 ? -0.02 : 0.04);
        results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: `noisy-${s}`, model: null, qualityScore: 0.50 + jitter }));
      });
    }
    const m = generateStrategyScenarioMatrix('exp-m', results);
    expect(m.cells.find((c) => c.strategy === 'strong')!.verdict).toBe('WIN');
    const noisyWins = m.cells.filter((c) => c.strategy.startsWith('noisy-') && c.verdict === 'WIN');
    expect(noisyWins).toHaveLength(0);
  });

  it('respects the canonical eligibility filter — failed/warmup rows do not enter any cell delta', () => {
    const clean = scenarioRows(
      [40, 41, 42],
      [{ model: 'frontier', score: 0.50 }],
      [{ strategy: 'consensus', score: 0.90 }],
    );
    const contamination = [
      row({ taskIndex: 40, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0, success: false, failureMode: 'timeout' }),
      row({ taskIndex: 41, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0, phase: 'warmup' }),
    ];
    const m = generateStrategyScenarioMatrix('exp-m', [...clean, ...contamination]);
    const cell = m.cells.find((c) => c.strategy === 'consensus')!;
    expect(cell.pairedDeltaMean).toBeCloseTo(0.40, 5); // uncontaminated 0.90−0.50
  });

  it('review fix: successRate counts ALL attempted executions, not just measured ones — a flaky strategy cannot hide its failures', () => {
    const clean = scenarioRows(
      [40, 41, 42],
      [{ model: 'frontier', score: 0.50 }],
      [{ strategy: 'flaky', score: 0.90 }],
    );
    // 2 more attempts that failed outright — excluded from the quality delta
    // (correctly), but must still count in the denominator of successRate.
    const failures = [
      row({ taskIndex: 43, executionMode: 'collective', strategy: 'flaky', model: null, qualityScore: 0, success: false, failureMode: 'timeout' }),
      row({ taskIndex: 44, executionMode: 'collective', strategy: 'flaky', model: null, qualityScore: 0, success: false, failureMode: 'timeout' }),
    ];
    const m = generateStrategyScenarioMatrix('exp-m', [...clean, ...failures]);
    const cell = m.cells.find((c) => c.strategy === 'flaky')!;
    expect(cell.attemptedExecutions).toBe(5); // 3 measured + 2 failed
    expect(cell.successRate).toBeCloseTo(0.6, 5);
    // The failures must not appear in the paired quality comparison.
    expect(cell.sharedTaskCount).toBe(3);
  });

  it('review fix: cost context is measured against the SAME best-single rows the quality delta uses, not the mean of every single', () => {
    // A cheap weak single ($0.001) never sets the quality bar; the frontier
    // single ($0.05) does. bestSingleAvgCostUsd must reflect the frontier
    // rows' cost, not an average diluted by the cheap arm.
    const results: ExperimentExecutionResult[] = [];
    for (const ti of [70, 71, 72]) {
      results.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'frontier', qualityScore: 0.90, costUsd: 0.05 }));
      results.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'cheap', qualityScore: 0.20, costUsd: 0.001 }));
      results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.85, costUsd: 0.30 }));
    }
    const m = generateStrategyScenarioMatrix('exp-m', results);
    const cell = m.cells.find((c) => c.strategy === 'consensus')!;
    expect(cell.bestSingleAvgCostUsd).toBeCloseTo(0.05, 5);
    expect(cell.bestSingleAvgCostUsd).not.toBeCloseTo((0.05 + 0.001) / 2, 3);
  });

  it('scoreboard tallies verdicts per strategy and sorts winners first', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => 50 + i);
    const results: ExperimentExecutionResult[] = [];
    tasks.forEach((ti, i) => {
      results.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'frontier', qualityScore: 0.50 }));
      results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: 'winner', model: null, qualityScore: 0.85 + (i % 2 ? 0.01 : -0.01) }));
      results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: 'loser', model: null, qualityScore: 0.15 + (i % 2 ? 0.01 : -0.01) }));
    });
    const m = generateStrategyScenarioMatrix('exp-m', results);
    expect(m.scoreboard[0].strategy).toBe('winner');
    expect(m.scoreboard[0].wins).toBeGreaterThanOrEqual(1);
    const loser = m.scoreboard.find((s) => s.strategy === 'loser')!;
    expect(loser.losses).toBeGreaterThanOrEqual(1);
    expect(loser.overallPairedDeltaMean).toBeLessThan(0);
    expect(m.scoreboard[0].overallSharedTaskCount).toBe(8);
    expect(m.scoreboard[0].overallSuccessRate).toBeCloseTo(1, 5);
  });

  it('review fix: scoreboard breaks ties deterministically by strategy name', () => {
    // Two strategies with IDENTICAL win/tie/loss/delta records — order must
    // not depend on which one appears first in the input array.
    const buildIdentical = (name: string): ExperimentExecutionResult[] => {
      const rows: ExperimentExecutionResult[] = [];
      for (const ti of [80, 81, 82]) {
        rows.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'frontier', qualityScore: 0.50 }));
        rows.push(row({ taskIndex: ti, executionMode: 'collective', strategy: name, model: null, qualityScore: 0.55 }));
      }
      return rows;
    };
    // Insert 'zebra' before 'alpha' in the raw input — a naive Map-insertion-
    // order sort would keep zebra first; the fix must place alpha first.
    const m = generateStrategyScenarioMatrix('exp-m', [...buildIdentical('zebra'), ...buildIdentical('alpha')]);
    const zebraIdx = m.scoreboard.findIndex((s) => s.strategy === 'zebra');
    const alphaIdx = m.scoreboard.findIndex((s) => s.strategy === 'alpha');
    expect(alphaIdx).toBeLessThan(zebraIdx);
  });

  it('tier1 and adaptive arms appear as their own scoreboard rows; single-budget does not', () => {
    const results: ExperimentExecutionResult[] = [];
    for (const ti of [60, 61, 62]) {
      results.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'frontier', qualityScore: 0.50 }));
      results.push(row({ taskIndex: ti, executionMode: 'collective-tier1', strategy: 'consensus', model: null, qualityScore: 0.60 }));
      results.push(row({ taskIndex: ti, executionMode: 'adaptive', strategy: 'auto', model: null, qualityScore: 0.55 }));
      results.push(row({ taskIndex: ti, executionMode: 'single-budget', strategy: 'single', model: 'cheap', qualityScore: 0.40 }));
    }
    const m = generateStrategyScenarioMatrix('exp-m', results);
    expect(m.strategies).toContain('consensus (tier1)');
    expect(m.strategies).toContain('adaptive');
    expect(m.strategies.some((s) => s.includes('cheap'))).toBe(false);
  });

  it('a NaN quality score is excluded before pairing, keeping sharedTaskCount consistent with the deltas actually used', () => {
    const results: ExperimentExecutionResult[] = [];
    for (const ti of [90, 91, 92]) {
      results.push(row({ taskIndex: ti, executionMode: 'single-model', model: 'frontier', qualityScore: 0.50 }));
      results.push(row({ taskIndex: ti, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.90 }));
    }
    // A NaN row for a FOURTH task — must not inflate sharedTaskCount/sharedTaskIndices.
    results.push(row({ taskIndex: 93, executionMode: 'single-model', model: 'frontier', qualityScore: Number.NaN }));
    results.push(row({ taskIndex: 93, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: Number.NaN }));
    const m = generateStrategyScenarioMatrix('exp-m', results);
    const cell = m.cells.find((c) => c.strategy === 'consensus')!;
    expect(cell.sharedTaskIndices).toEqual([90, 91, 92]);
    expect(cell.sharedTaskCount).toBe(3);
  });
});
