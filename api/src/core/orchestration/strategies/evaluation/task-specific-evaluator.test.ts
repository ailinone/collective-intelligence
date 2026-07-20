// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * TaskSpecificEvaluator — unit contract tests.
 *
 * Pins the critical guarantees:
 *  - empty / failed → score 0, fail
 *  - code without code-block when code is required → fail
 *  - code with structure but NO runner → uncertain, score undefined,
 *    validationStatus = structurally_validated_only
 *  - code WITH runner that emits objective score → fully_validated
 *  - JSON invalid → fail
 *  - JSON valid without schema → score undefined, structural-only
 *  - JSON valid with schema match → fully_validated, score numeric
 *  - plain_text without rubric → uncertain, score undefined
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TaskSpecificEvaluator,
  type CodeRunner,
  inferTaskKind,
  matchesMinimalSchema,
  extractCode,
} from './task-specific-evaluator';

const baseInput = (overrides: Partial<{ output: string; taskType: string; expectedFormat: 'json' | 'code' | 'reasoning' | 'free_text'; jsonSchema: unknown; codeLanguage: string; executionFailed: boolean }> = {}) => ({
  task: {
    taskType: overrides.taskType,
    expectedFormat: overrides.expectedFormat,
    jsonSchema: overrides.jsonSchema,
    codeLanguage: overrides.codeLanguage,
  },
  output: overrides.output ?? '',
  executionFailed: overrides.executionFailed,
  modelId: 'voter-a',
  strategyName: 'consensus',
});

describe('TaskSpecificEvaluator', () => {
  describe('common gates', () => {
    it('declares mode="task_specific"', () => {
      expect(new TaskSpecificEvaluator().mode).toBe('task_specific');
    });

    it('execution_failed → fail, score=0, fully_validated', async () => {
      const ev = new TaskSpecificEvaluator();
      const r = await ev.evaluate(baseInput({ output: 'x'.repeat(100), executionFailed: true }));
      expect(r.verdict).toBe('fail');
      expect(r.score).toBe(0);
      expect(r.validationStatus).toBe('fully_validated');
    });

    it('empty output → fail, score=0', async () => {
      const ev = new TaskSpecificEvaluator();
      const r = await ev.evaluate(baseInput({ output: '' }));
      expect(r.verdict).toBe('fail');
      expect(r.score).toBe(0);
    });
  });

  describe('code-generation', () => {
    it('expected code but no code block → fail (no high score from appearance)', async () => {
      const ev = new TaskSpecificEvaluator();
      const r = await ev.evaluate(baseInput({
        output: 'I will explain how to do this but I am NOT giving you the code here.',
        expectedFormat: 'code',
      }));
      expect(r.verdict).toBe('fail');
      expect(r.score).toBe(0);
      expect(r.structural.codeBlockPresent).toBe(false);
    });

    it('code block present but NO runner → uncertain + score undefined + structural-only', async () => {
      const ev = new TaskSpecificEvaluator();
      const r = await ev.evaluate(baseInput({
        output: 'Here:\n```js\nfunction f() { return 1; }\n```',
        expectedFormat: 'code',
      }));
      expect(r.verdict).toBe('uncertain');
      expect(r.score).toBeUndefined();
      expect(r.validationStatus).toBe('structurally_validated_only');
      expect(r.structural.codeBlockPresent).toBe(true);
    });

    it('code with runner that emits a numeric score → fully_validated', async () => {
      const runner: CodeRunner = {
        run: vi.fn(async () => ({ score: 0.85, verdict: 'pass', notes: '3/3 tests passed' })),
      };
      const ev = new TaskSpecificEvaluator({ codeRunner: runner });
      const r = await ev.evaluate(baseInput({
        output: '```js\nfunction f() { return 1; }\n```',
        expectedFormat: 'code',
      }));
      expect(r.verdict).toBe('pass');
      expect(r.score).toBe(0.85);
      expect(r.validationStatus).toBe('fully_validated');
      expect(runner.run).toHaveBeenCalledOnce();
    });

    it('runner that returns uncertain + no score → structural-only', async () => {
      const runner: CodeRunner = {
        run: async () => ({ score: undefined, verdict: 'uncertain', notes: 'no testable surface' }),
      };
      const ev = new TaskSpecificEvaluator({ codeRunner: runner });
      const r = await ev.evaluate(baseInput({
        output: '```js\nfunction f() { return 1; }\n```',
        expectedFormat: 'code',
      }));
      expect(r.verdict).toBe('uncertain');
      expect(r.score).toBeUndefined();
      expect(r.validationStatus).toBe('structurally_validated_only');
    });
  });

  describe('json', () => {
    it('invalid JSON → fail, score=0', async () => {
      const ev = new TaskSpecificEvaluator();
      const r = await ev.evaluate(baseInput({
        output: 'not json',
        expectedFormat: 'json',
      }));
      expect(r.verdict).toBe('fail');
      expect(r.score).toBe(0);
      expect(r.structural.jsonValid).toBe(false);
    });

    it('valid JSON without schema → pass, score undefined, structural-only', async () => {
      const ev = new TaskSpecificEvaluator();
      const r = await ev.evaluate(baseInput({
        output: '{"k": "v", "n": 1}',
        expectedFormat: 'json',
      }));
      expect(r.verdict).toBe('pass');
      expect(r.score).toBeUndefined();
      expect(r.structural.jsonValid).toBe(true);
      expect(r.validationStatus).toBe('structurally_validated_only');
    });

    it('valid JSON with matching schema → fully_validated, numeric score', async () => {
      const ev = new TaskSpecificEvaluator();
      const r = await ev.evaluate(baseInput({
        output: '{"name": "alice", "age": 30}',
        expectedFormat: 'json',
        jsonSchema: { type: 'object', required: ['name', 'age'] },
      }));
      expect(r.verdict).toBe('pass');
      expect(r.score).toBe(0.9);
      expect(r.structural.schemaValid).toBe(true);
      expect(r.validationStatus).toBe('fully_validated');
    });

    it('valid JSON with schema mismatch → fail', async () => {
      const ev = new TaskSpecificEvaluator();
      const r = await ev.evaluate(baseInput({
        output: '{"name": "alice"}',
        expectedFormat: 'json',
        jsonSchema: { type: 'object', required: ['name', 'age'] },
      }));
      expect(r.verdict).toBe('fail');
      expect(r.score).toBe(0);
      expect(r.structural.schemaValid).toBe(false);
    });
  });

  describe('plain_text and unknown', () => {
    it('plain_text without rubric → uncertain, no score, structural-only', async () => {
      const ev = new TaskSpecificEvaluator();
      const r = await ev.evaluate(baseInput({
        output: 'A'.repeat(100),
        expectedFormat: 'free_text',
      }));
      expect(r.verdict).toBe('uncertain');
      expect(r.score).toBeUndefined();
      expect(r.validationStatus).toBe('structurally_validated_only');
    });

    it('unknown task kind → uncertain, structural-only', async () => {
      const ev = new TaskSpecificEvaluator();
      const r = await ev.evaluate(baseInput({
        output: 'A'.repeat(100),
      }));
      expect(r.verdict).toBe('uncertain');
      expect(r.score).toBeUndefined();
      expect(r.validationStatus).toBe('structurally_validated_only');
    });
  });

  describe('pure helpers', () => {
    it('inferTaskKind maps expectedFormat first, then taskType, then unknown', () => {
      expect(inferTaskKind({ expectedFormat: 'json' })).toBe('json');
      expect(inferTaskKind({ expectedFormat: 'code' })).toBe('code-generation');
      expect(inferTaskKind({ expectedFormat: 'free_text' })).toBe('plain_text');
      expect(inferTaskKind({ taskType: 'code-generation' })).toBe('code-generation');
      expect(inferTaskKind({ taskType: 'json-output' })).toBe('json');
      expect(inferTaskKind({ taskType: 'analysis' })).toBe('plain_text');
      expect(inferTaskKind({})).toBe('unknown');
    });

    it('extractCode pulls the fenced body', () => {
      expect(extractCode('```js\nx\n```')).toBe('x');
      expect(extractCode('```\nfoo\n```')).toBe('foo');
      expect(extractCode('no fence')).toBe('no fence');
    });

    it('matchesMinimalSchema accepts permissive schema, rejects missing required', () => {
      expect(matchesMinimalSchema({ a: 1 }, { type: 'object', required: ['a'] })).toBe(true);
      expect(matchesMinimalSchema({ a: 1 }, { type: 'object', required: ['a', 'b'] })).toBe(false);
      expect(matchesMinimalSchema('hello', { type: 'object' })).toBe(false);
      expect(matchesMinimalSchema([1, 2], { type: 'array' })).toBe(true);
    });
  });
});
