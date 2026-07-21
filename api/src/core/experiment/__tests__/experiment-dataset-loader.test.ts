// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Public-benchmark dataset loader — tests.
 *
 * Verifies HumanEval and GSM8K records map onto ExperimentTasks that route to
 * the existing OBJECTIVE graders (sandbox execution / numeric_equals), so a
 * benchmark run needs no LLM judge. Reads the vendored fixtures in
 * fixtures/datasets/ (no network, no DB).
 */
import { describe, it, expect } from 'vitest';
import {
  parseGsm8kAnswer,
  buildGsm8kPrompt,
  buildHumanEvalPrompt,
  loadGsm8kTasks,
  loadHumanEvalTasks,
  HUMANEVAL_INDEX_BASE,
  GSM8K_INDEX_BASE,
} from '../experiment-dataset-loader';

describe('parseGsm8kAnswer', () => {
  it('extracts the integer after ####', () => {
    expect(parseGsm8kAnswer('...blah blah\n#### 18')).toBe(18);
  });
  it('strips thousands separators and $', () => {
    expect(parseGsm8kAnswer('#### $1,024')).toBe(1024);
  });
  it('returns null when there is no #### marker', () => {
    expect(parseGsm8kAnswer('the answer is 42')).toBeNull();
  });
  it('returns null for a non-numeric final answer', () => {
    expect(parseGsm8kAnswer('#### forty-two')).toBeNull();
  });
});

describe('prompt builders', () => {
  it('GSM8K prompt requests a strict FINAL: <number> line', () => {
    const p = buildGsm8kPrompt('How many apples?');
    expect(p).toContain('How many apples?');
    expect(p).toContain('FINAL: <number>');
  });
  it('HumanEval prompt asks for ONLY the function and fences the stub', () => {
    const p = buildHumanEvalPrompt('def foo(x):\n    """doc"""');
    expect(p).toContain('```python');
    expect(p.toLowerCase()).toContain('only');
    expect(p).toContain('def foo(x):');
  });
});

describe('loadGsm8kTasks', () => {
  const tasks = loadGsm8kTasks();

  it('loads a non-trivial number of tasks from the vendored fixture', () => {
    expect(tasks.length).toBeGreaterThan(50);
  });

  it('every task routes to objective numeric_equals grading (no judge)', () => {
    for (const t of tasks) {
      expect(t.answerCheck?.kind).toBe('numeric_equals');
      expect(typeof t.answerCheck?.expected).toBe('number');
      expect(t.answerCheck?.tolerance).toBe(0);
      expect(t.codeTest).toBeUndefined();
      expect(t.tools).toBeUndefined();
      expect(t.domain).toBe('math');
    }
  });

  it('uses the reserved index range and unique indices', () => {
    expect(tasks[0].index).toBe(GSM8K_INDEX_BASE);
    const uniq = new Set(tasks.map((t) => t.index));
    expect(uniq.size).toBe(tasks.length);
    expect(Math.min(...tasks.map((t) => t.index))).toBeGreaterThanOrEqual(GSM8K_INDEX_BASE);
  });

  it('respects the limit option deterministically', () => {
    const five = loadGsm8kTasks({ limit: 5 });
    expect(five.length).toBeLessThanOrEqual(5);
    expect(five[0].index).toBe(GSM8K_INDEX_BASE);
  });
});

describe('loadHumanEvalTasks', () => {
  const tasks = loadHumanEvalTasks();

  it('loads the full 164-problem HumanEval set', () => {
    expect(tasks.length).toBe(164);
  });

  it('every task routes to sandbox execution via the native check() harness', () => {
    for (const t of tasks) {
      expect(t.codeTest?.language).toBe('python');
      expect(t.codeTest?.functionName).toBe('__ailin_check');
      // single wrapper vector: passes iff check() asserts all pass
      expect(t.codeTest?.tests).toEqual([{ args: [], expected: true }]);
      expect(typeof t.codeTest?.checkSource).toBe('string');
      expect(t.codeTest?.checkSource).toContain('def check(');
      expect(typeof t.codeTest?.entryPoint).toBe('string');
      expect(t.answerCheck).toBeUndefined();
      expect(t.domain).toBe('tech');
    }
  });

  it('uses the reserved index range and unique indices, disjoint from GSM8K', () => {
    expect(tasks[0].index).toBe(HUMANEVAL_INDEX_BASE);
    const uniq = new Set(tasks.map((t) => t.index));
    expect(uniq.size).toBe(tasks.length);
    // reserved ranges (10000 / 20000) never collide with the built-in suite (≲200)
    expect(Math.max(...tasks.map((t) => t.index))).toBeLessThan(GSM8K_INDEX_BASE);
  });

  it('respects the limit option', () => {
    expect(loadHumanEvalTasks({ limit: 10 }).length).toBe(10);
  });
});
