// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LiveBench reasoning dataset loader — tests.
 *
 * Verifies the vendored LiveBench reasoning rows map onto ExperimentTasks graded
 * by the ORACLE-FREE `groundTruthScorer` path: each carries a self-contained
 * Python scorer (LiveBench's own vendored logic) exposing
 * `__ailin_scorer(ground_truth, llm_answer)` plus the held-out ground truth, and
 * NO forwarded field (no answerCheck) — so the ground truth is scored but never
 * handed to the collective. Reads the vendored fixtures in fixtures/datasets/ and
 * fixtures/livebench_scorers/ (no network, no DB, no Python — the scorer string is
 * asserted structurally; end-to-end Python execution is validated separately).
 */
import { describe, it, expect } from 'vitest';
import {
  loadLiveBenchReasoningTasks,
  LIVEBENCH_REASONING_INDEX_BASE,
  HUMANEVAL_INDEX_BASE,
  GSM8K_INDEX_BASE,
  HUMANEVAL_PLUS_INDEX_BASE,
} from '../experiment-dataset-loader';

describe('loadLiveBenchReasoningTasks', () => {
  const tasks = loadLiveBenchReasoningTasks();

  it('loads the faithful 150-row set (50 each: zebra_puzzle, spatial, web_of_lies_v2)', () => {
    // The old-format zebra_puzzle block (50 rows) is excluded — its scorer is
    // unfaithful on hyphenated ground truths (see loader docstring).
    expect(tasks.length).toBe(150);
    const byDomain = new Map<string, number>();
    for (const t of tasks) byDomain.set(t.domain, (byDomain.get(t.domain) ?? 0) + 1);
    expect(byDomain.get('zebra_puzzle')).toBe(50);
    expect(byDomain.get('spatial')).toBe(50);
    expect(byDomain.get('web_of_lies_v2')).toBe(50);
    // exactly those three subtasks, nothing else
    expect(new Set(byDomain.keys())).toEqual(
      new Set(['zebra_puzzle', 'spatial', 'web_of_lies_v2'])
    );
  });

  it('uses the reserved 40000 index range, unique + disjoint from the other benchmarks', () => {
    expect(LIVEBENCH_REASONING_INDEX_BASE).toBe(40_000);
    expect(tasks[0].index).toBe(LIVEBENCH_REASONING_INDEX_BASE);
    const uniq = new Set(tasks.map((t) => t.index));
    expect(uniq.size).toBe(tasks.length);
    expect(Math.min(...tasks.map((t) => t.index))).toBeGreaterThanOrEqual(
      LIVEBENCH_REASONING_INDEX_BASE
    );
    // 40000+ never collides with HumanEval (10000+) / GSM8K (20000+) / HumanEval+ (30000+)
    expect(LIVEBENCH_REASONING_INDEX_BASE).toBeGreaterThan(HUMANEVAL_INDEX_BASE);
    expect(LIVEBENCH_REASONING_INDEX_BASE).toBeGreaterThan(GSM8K_INDEX_BASE);
    expect(LIVEBENCH_REASONING_INDEX_BASE).toBeGreaterThan(HUMANEVAL_PLUS_INDEX_BASE);
  });

  it('every task is a reasoning task with a groundTruthScorer and a real prompt', () => {
    for (const t of tasks) {
      expect(t.taskType).toBe('reasoning');
      expect(typeof t.prompt).toBe('string');
      // turns[0] is a full LiveBench reasoning prompt — always substantial
      expect(t.prompt.length).toBeGreaterThan(50);
      expect(t.groundTruthScorer).toBeDefined();
      expect(typeof t.groundTruthScorer!.scorerSource).toBe('string');
      expect(typeof t.groundTruthScorer!.groundTruth).toBe('string');
      expect(t.groundTruthScorer!.groundTruth.length).toBeGreaterThan(0);
    }
  });

  it('is ORACLE-FREE at the task shape: NO forwarded objective field', () => {
    // answerCheck is the FORWARDED field (→ ailin_constraints.answer_check). The
    // reasoning axis must NOT use it — the ground truth rides groundTruthScorer,
    // which the runner never adds to ailin_constraints (mirrors codeTest).
    for (const t of tasks) {
      expect(t.answerCheck).toBeUndefined();
      expect(t.codeTest).toBeUndefined();
      expect(t.tools).toBeUndefined();
    }
  });

  it('scorerSource is self-contained and exposes the canonical __ailin_scorer entrypoint', () => {
    for (const t of tasks) {
      const src = t.groundTruthScorer!.scorerSource;
      // canonical wrapper the runner's generic driver calls
      expect(src).toContain('def __ailin_scorer(ground_truth, llm_answer):');
      expect(src).toContain('return float(_fn(ground_truth, llm_answer))');
      // vendored util helpers prepended (self-contained — no livebench package)
      expect(src).toContain('def last_boxed_only_string');
      expect(src).toContain('def remove_boxed');
      // the livebench import line is STRIPPED (would ImportError in the sandbox)
      expect(src).not.toMatch(/^from\s+livebench\.process_results\.util\s+import/m);
    }
  });

  it('routes each subtask to LiveBench’s own vendored scorer function', () => {
    const zebra = tasks.find((t) => t.domain === 'zebra_puzzle')!;
    const spatial = tasks.find((t) => t.domain === 'spatial')!;
    const wol = tasks.find((t) => t.domain === 'web_of_lies_v2')!;

    // zebra defers to LiveBench's release-date selector (new <solution> scorer)
    expect(zebra.groundTruthScorer!.scorerSource).toContain('def zebra_puzzle_process_results');
    expect(zebra.groundTruthScorer!.scorerSource).toContain(
      '_fn = get_zebra_puzzle_evaluator("2024-11-25")'
    );

    expect(spatial.groundTruthScorer!.scorerSource).toContain('def spatial_process_results');
    expect(spatial.groundTruthScorer!.scorerSource).toContain('_fn = spatial_process_results');

    expect(wol.groundTruthScorer!.scorerSource).toContain('def web_of_lies_process_results');
    expect(wol.groundTruthScorer!.scorerSource).toContain('_fn = web_of_lies_process_results');
  });

  it('excludes the retired old-format zebra_puzzle (release < 2024-11-25)', () => {
    // No kept zebra task may reference the unfaithful old evaluator directly, and
    // none may bind the old release date into the selector.
    for (const t of tasks.filter((x) => x.domain === 'zebra_puzzle')) {
      expect(t.groundTruthScorer!.scorerSource).not.toContain(
        'get_zebra_puzzle_evaluator("2024-06-24")'
      );
    }
  });

  it('respects the limit option', () => {
    expect(loadLiveBenchReasoningTasks({ limit: 10 }).length).toBe(10);
    expect(loadLiveBenchReasoningTasks({ limit: 10 })[0].index).toBe(
      LIVEBENCH_REASONING_INDEX_BASE
    );
  });
});
