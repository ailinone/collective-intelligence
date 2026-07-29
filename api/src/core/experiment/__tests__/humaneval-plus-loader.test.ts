// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HumanEval+ (EvalPlus augmented tests) dataset loader — tests.
 *
 * Verifies the vendored EvalPlus HumanEvalPlus records map onto ExperimentTasks
 * that route to the SAME objective sandbox path as plain HumanEval (native
 * check() harness → binary pass@1), but with a differential-test harness over
 * ~200 augmented inputs instead of the 7 base asserts. Reads the vendored
 * fixture in fixtures/datasets/ (no network, no DB, no Python — the harness
 * string is asserted structurally; end-to-end Python execution is validated
 * separately).
 */
import { describe, it, expect } from 'vitest';
import {
  loadHumanEvalPlusTasks,
  buildHumanEvalPlusCheckSource,
  HUMANEVAL_PLUS_INDEX_BASE,
  HUMANEVAL_PLUS_MAX_TESTS,
  HUMANEVAL_INDEX_BASE,
  GSM8K_INDEX_BASE,
} from '../experiment-dataset-loader';

describe('loadHumanEvalPlusTasks', () => {
  const tasks = loadHumanEvalPlusTasks();

  it('loads the full 164-problem HumanEval+ set', () => {
    expect(tasks.length).toBe(164);
  });

  it('every task routes to sandbox execution via a native check() harness', () => {
    for (const t of tasks) {
      expect(t.codeTest?.language).toBe('python');
      expect(t.codeTest?.functionName).toBe('__ailin_check');
      // single wrapper vector: passes iff check() asserts all pass
      expect(t.codeTest?.tests).toEqual([{ args: [], expected: true }]);
      expect(typeof t.codeTest?.checkSource).toBe('string');
      expect(typeof t.codeTest?.entryPoint).toBe('string');
      expect(t.codeTest?.entryPoint!.length).toBeGreaterThan(0);
      // objective grading only — no answer_check, no judge, no tools
      expect(t.answerCheck).toBeUndefined();
      expect(t.tools).toBeUndefined();
      expect(t.domain).toBe('tech');
    }
  });

  it('uses the reserved 30000 index range, unique + disjoint from HumanEval/GSM8K', () => {
    expect(tasks[0].index).toBe(HUMANEVAL_PLUS_INDEX_BASE);
    expect(HUMANEVAL_PLUS_INDEX_BASE).toBe(30_000);
    const uniq = new Set(tasks.map((t) => t.index));
    expect(uniq.size).toBe(tasks.length);
    // 30000+ never collides with HumanEval (10000+) or GSM8K (20000+)
    expect(Math.min(...tasks.map((t) => t.index))).toBeGreaterThanOrEqual(
      HUMANEVAL_PLUS_INDEX_BASE
    );
    expect(HUMANEVAL_PLUS_INDEX_BASE).toBeGreaterThan(HUMANEVAL_INDEX_BASE);
    expect(HUMANEVAL_PLUS_INDEX_BASE).toBeGreaterThan(GSM8K_INDEX_BASE);
  });

  it('respects the limit option', () => {
    expect(loadHumanEvalPlusTasks({ limit: 10 }).length).toBe(10);
    expect(loadHumanEvalPlusTasks({ limit: 10 })[0].index).toBe(HUMANEVAL_PLUS_INDEX_BASE);
  });
});

describe('HumanEval+ differential-test harness (checkSource)', () => {
  // First problem (HumanEval/0 = has_close_elements) — inspect its generated
  // harness at the string level (no Python sandbox in unit tests).
  const tasks = loadHumanEvalPlusTasks({ limit: 1 });
  const cs = tasks[0].codeTest!.checkSource!;
  const entry = tasks[0].codeTest!.entryPoint!;

  it('defines check(candidate)', () => {
    expect(cs).toContain('def check(candidate)');
  });

  it('references the entry_point (as the reference lookup key)', () => {
    // entryLiteral is a JSON/Python string literal of the entry point name.
    expect(cs).toContain(JSON.stringify(entry));
    expect(cs).toContain('__ref_ns[');
  });

  it('parses embedded inputs via json.loads (so JSON null/true/false → None/True/False)', () => {
    expect(cs).toContain('json.loads');
    expect(cs).toContain('import json');
  });

  it('exec’s the reconstructed reference into a SEPARATE namespace dict', () => {
    expect(cs).toContain('exec(');
    expect(cs).toContain('__ref_ns = {}');
    expect(cs).toContain('exec(');
    // the reference is looked up out of the separate dict, never module scope
    expect(cs).toMatch(/__ref = __ref_ns\[/);
  });

  it('compares candidate vs reference with exception-aware, tolerance-aware matching', () => {
    expect(cs).toContain('def __match(a, b)');
    expect(cs).toContain('type(__e).__name__'); // exception → sentinel
    expect(cs).toContain('__atol'); // float tolerance path present
    expect(cs).toContain('assert __ok_r == __ok_c'); // exception/return agreement
  });
});

describe('buildHumanEvalPlusCheckSource capping', () => {
  it('caps total inputs and embeds them as a JSON constant', () => {
    // A synthetic record with many plus_input rows must be capped to
    // HUMANEVAL_PLUS_MAX_TESTS (all base first, then a prefix of plus).
    const base = Array.from({ length: 3 }, (_, i) => [i]);
    const plus = Array.from({ length: 999 }, (_, i) => [i + 1000]);
    const src = buildHumanEvalPlusCheckSource({
      task_id: 'HumanEval/synthetic',
      prompt: 'def f(x):\n    return x\n',
      entry_point: 'f',
      canonical_solution: '',
      test: '',
      base_input: base,
      plus_input: plus,
      atol: 0,
    });
    // Extract the embedded {inputs, atol} JSON and count the capped inputs.
    // The data literal is json.loads("<json>") — recover it and assert the cap.
    const m = src.match(/json\.loads\((".*?[^\\]")\)/);
    expect(m).not.toBeNull();
    const jsonText = JSON.parse(m![1]) as string; // undo the Python/JSON string literal
    const data = JSON.parse(jsonText) as { inputs: unknown[]; atol: number };
    expect(data.inputs.length).toBe(HUMANEVAL_PLUS_MAX_TESTS);
    // all 3 base inputs come first, deterministically
    expect(data.inputs.slice(0, 3)).toEqual(base);
    expect(data.atol).toBe(0);
  });
});
