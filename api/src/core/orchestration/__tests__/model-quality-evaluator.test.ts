// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2 §11 — Deterministic evaluator tests.
 *
 * Each rubric kind is exercised with:
 *   - a correct answer → high score
 *   - a malformed/wrong answer → low score
 *   - determinism: same input → same output
 *   - no provider calls
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateTaskOutput,
  type BenchmarkTask,
} from '@/core/orchestration/quality-benchmark/model-quality-evaluator';

const codingTask: BenchmarkTask = {
  taskId: 'coding_parse_money_br',
  prompt: '',
  expectedFormat: 'code',
  maxTokens: 220,
  dimensionWeights: { coding: 0.5, instruction_following: 0.3, structured_output: 0.2 },
  rubric: {
    kind: 'codeUnitTest',
    languageHint: 'typescript',
    functionName: 'parseMoneyBR',
    cases: [
      { input: '1234,56', expected: 1234.56 },
      { input: '0,99', expected: 0.99 },
      { input: 'not money', expected: null },
    ],
    partialCredit: true,
  },
};

const jsonTask: BenchmarkTask = {
  taskId: 'strict_json_extraction',
  prompt: '',
  expectedFormat: 'json',
  maxTokens: 220,
  dimensionWeights: { structured_output: 0.5, instruction_following: 0.3, factuality: 0.2 },
  rubric: {
    kind: 'jsonSchema',
    requiredKeys: ['name', 'age', 'skills'],
    expectedValues: {
      name: { kind: 'stringContains', values: ['Maria'] },
      age: { kind: 'exactNumber', value: 28 },
      skills: { kind: 'arrayContainsAll', values: ['TypeScript'] },
    },
    partialCredit: true,
  },
};

const letterTask: BenchmarkTask = {
  taskId: 'reasoning_constraint_selection',
  prompt: '',
  expectedFormat: 'letter_with_reason',
  maxTokens: 220,
  dimensionWeights: { reasoning: 0.5, instruction_following: 0.3, factuality: 0.2 },
  rubric: {
    kind: 'singleLetterChoice',
    correctLetter: 'B',
    mustMentionInReasoning: ['latency', 'tool', 'cost'],
    partialCredit: true,
  },
};

const bulletsTask: BenchmarkTask = {
  taskId: 'synthesis_tradeoff_summary',
  prompt: '',
  expectedFormat: 'bullets',
  maxTokens: 220,
  dimensionWeights: { synthesis: 0.4, instruction_following: 0.4, structured_output: 0.2 },
  rubric: {
    kind: 'structuredBullets',
    expectedBulletCount: 3,
    bulletPrefix: '-',
    maxWordsPerBullet: 30,
    mustMentionTerms: [
      ['read-through', 'synchronous'],
      ['write-behind', 'async'],
      ['refresh-ahead', 'predictive'],
    ],
    partialCredit: true,
  },
};

const bugFixTask: BenchmarkTask = {
  taskId: 'critique_repair_micro',
  prompt: '',
  expectedFormat: 'two_line',
  maxTokens: 220,
  dimensionWeights: { coding: 0.4, reasoning: 0.3, structured_output: 0.3 },
  rubric: {
    kind: 'twoLineBugFix',
    bugKeywords: ['empty', 'zero', 'NaN', 'reduce', 'initial'],
    fixKeywords: ['reduce(', '0', 'initial'],
    partialCredit: true,
  },
};

describe('01C.1B-J2 §11 — Model quality evaluator', () => {
  describe('codeUnitTest', () => {
    it('high score for correct parseMoneyBR implementation', () => {
      const output = `function parseMoneyBR(input) {
        if (typeof input !== 'string' || input.trim() === '') return null;
        const cleaned = input.replace(/^R\\$\\s*/, '').trim();
        if (!/^[0-9.,]+$/.test(cleaned)) return null;
        const noDots = cleaned.replace(/\\./g, '');
        const normalized = noDots.replace(',', '.');
        const n = Number(normalized);
        return isFinite(n) ? n : null;
      }`;
      const r = evaluateTaskOutput(codingTask, output);
      expect(r.score).toBeGreaterThan(0.6);
      expect(r.dimensionScores.coding).toBeGreaterThan(0.5);
    });

    it('low score for broken function (compile error)', () => {
      const output = `function parseMoneyBR(input { return broken syntax }`;
      const r = evaluateTaskOutput(codingTask, output);
      expect(r.score).toBeLessThan(0.5);
    });

    it('low score for missing function', () => {
      const output = `here is some text without code`;
      const r = evaluateTaskOutput(codingTask, output);
      expect(r.dimensionScores.coding).toBe(0);
    });

    it('handles markdown code fences', () => {
      const output = '```typescript\nfunction parseMoneyBR(input) { return null; }\n```';
      const r = evaluateTaskOutput(codingTask, output);
      expect(r.notes).toContain('extracted_from_code_fence');
      // Compiles but returns null for all cases except the null-expected one
      expect(r.dimensionScores.coding).toBeGreaterThan(0);
      expect(r.dimensionScores.coding).toBeLessThan(1);
    });

    it('is deterministic: same output → same score', () => {
      const output = `function parseMoneyBR(input) { return input === '0,99' ? 0.99 : null; }`;
      const r1 = evaluateTaskOutput(codingTask, output);
      const r2 = evaluateTaskOutput(codingTask, output);
      expect(r1.score).toBe(r2.score);
      expect(r1.dimensionScores).toEqual(r2.dimensionScores);
    });
  });

  describe('jsonSchema', () => {
    it('high score for valid JSON with correct values', () => {
      const output = '{"name": "Maria Silva", "age": 28, "skills": ["TypeScript", "Python", "PostgreSQL"]}';
      const r = evaluateTaskOutput(jsonTask, output);
      expect(r.score).toBeGreaterThan(0.8);
    });

    it('low score for invalid JSON', () => {
      const output = 'this is not json at all';
      const r = evaluateTaskOutput(jsonTask, output);
      expect(r.dimensionScores.structured_output).toBe(0);
    });

    it('partial score for valid JSON but wrong values (format earns weight, factuality=0)', () => {
      const output = '{"name": "Bob", "age": 99, "skills": ["Rust"]}';
      const r = evaluateTaskOutput(jsonTask, output);
      // Weighted: structured_output(0.5) + instruction_following(0.3) + factuality(0.2)
      // With format perfect but values wrong: 1.0*0.5 + 1.0*0.3 + 0*0.2 = 0.8
      // This is correct — rubric rewards good format even when factuality fails.
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(0.8);
      expect(r.dimensionScores.factuality).toBe(0);
      expect(r.dimensionScores.structured_output).toBeGreaterThan(0.5);
    });

    it('penalizes markdown fences (instruction said no markdown)', () => {
      const noFenceOutput = '{"name": "Maria", "age": 28, "skills": ["TypeScript"]}';
      const withFenceOutput = '```json\n{"name": "Maria", "age": 28, "skills": ["TypeScript"]}\n```';
      const r1 = evaluateTaskOutput(jsonTask, noFenceOutput);
      const r2 = evaluateTaskOutput(jsonTask, withFenceOutput);
      expect(r1.dimensionScores.instruction_following).toBeGreaterThan(r2.dimensionScores.instruction_following);
    });
  });

  describe('singleLetterChoice', () => {
    it('high score for correct letter with reasoning terms', () => {
      const output = 'B. This option satisfies the latency constraint (150ms < 200ms), supports tool use, and has acceptable cost.';
      const r = evaluateTaskOutput(letterTask, output);
      expect(r.score).toBeGreaterThan(0.7);
      expect(r.dimensionScores.reasoning).toBeGreaterThan(0);
    });

    it('low score for wrong letter', () => {
      const output = 'A. Latency is fine because of cost and tool use.';
      const r = evaluateTaskOutput(letterTask, output);
      expect(r.dimensionScores.reasoning).toBe(0);
      expect(r.dimensionScores.factuality).toBe(0);
    });

    it('low score for no letter at all', () => {
      const output = 'I cannot decide, all options have issues.';
      const r = evaluateTaskOutput(letterTask, output);
      expect(r.score).toBeLessThan(0.3);
    });
  });

  describe('structuredBullets', () => {
    it('high score for 3 well-formed bullets with required terms', () => {
      const output = `- Read-through cache uses synchronous fetch on miss, adding latency but simple.
- Write-behind cache async writes to backing store fast but risks data loss.
- Refresh-ahead cache predictive refresh before expiry, low miss rate but complex.`;
      const r = evaluateTaskOutput(bulletsTask, output);
      expect(r.score).toBeGreaterThan(0.7);
    });

    it('penalizes wrong bullet count', () => {
      const output = `- Only one bullet here about read-through synchronous fetch.`;
      const r = evaluateTaskOutput(bulletsTask, output);
      expect(r.dimensionScores.structured_output).toBeLessThan(0.6);
    });
  });

  describe('twoLineBugFix', () => {
    it('high score for correct bug identification and fix', () => {
      const output = `Bug: reduce with empty array returns no initial value, causing NaN division.
Fix: return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;`;
      const r = evaluateTaskOutput(bugFixTask, output);
      expect(r.score).toBeGreaterThan(0.5);
    });

    it('low score for missing format prefixes', () => {
      const output = 'The code looks fine to me.';
      const r = evaluateTaskOutput(bugFixTask, output);
      expect(r.dimensionScores.structured_output).toBeLessThan(0.3);
    });
  });

  describe('determinism + safety', () => {
    it('returns score=0 for empty output', () => {
      const r = evaluateTaskOutput(codingTask, '');
      expect(r.score).toBe(0);
      expect(r.passed).toBe(false);
    });

    it('returns score=0 for non-string output', () => {
      // @ts-expect-error testing runtime behavior
      const r = evaluateTaskOutput(codingTask, null);
      expect(r.score).toBe(0);
    });

    it('never throws on adversarial input', () => {
      const adversarial = '```' + '$'.repeat(1000) + '`/etc/passwd' + '\\u0000\\n';
      expect(() => evaluateTaskOutput(codingTask, adversarial)).not.toThrow();
    });
  });
});
