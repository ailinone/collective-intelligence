// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test 8/9: Evaluator-suite tests.
 *
 * Replaces the original "scoring.test.ts" — which exercised only the
 * length-based heuristic — with a broader contract test across the
 * four evaluator implementations: Mock, Structural, Unavailable, and
 * HeuristicTestOnly. Each evaluator declares its `mode` and is recorded
 * on the consensus artifact; this file pins each contract independently.
 */
import { describe, it, expect } from 'vitest';
import { MockStrategyOutputEvaluator } from '../evaluation/mock-evaluator';
import { StructuralOutputEvaluator } from '../evaluation/structural-evaluator';
import { UnavailableStrategyOutputEvaluator } from '../evaluation/unavailable-evaluator';
import { HeuristicTestOnlyEvaluator } from '../evaluation/heuristic-test-only-evaluator';
import { validationStatusForMode } from '../evaluation/strategy-output-evaluator';

describe('Evaluator contracts', () => {
  describe('MockStrategyOutputEvaluator', () => {
    it('declares mode="mock"', () => {
      expect(new MockStrategyOutputEvaluator().mode).toBe('mock');
    });

    it('returns the injected score for a known modelId', async () => {
      const ev = new MockStrategyOutputEvaluator({
        byModelId: { 'voter-a': 0.77, 'voter-b': 0.42 },
        fallback: 0.1,
        synthesis: 0.9,
      });
      const a = await ev.evaluate({ task: {}, output: 'x'.repeat(100), modelId: 'voter-a', strategyName: 'consensus' });
      const b = await ev.evaluate({ task: {}, output: 'x'.repeat(100), modelId: 'voter-b', strategyName: 'consensus' });
      const c = await ev.evaluate({ task: {}, output: 'x'.repeat(100), modelId: 'voter-z', strategyName: 'consensus' });
      const s = await ev.evaluate({ task: {}, output: 'x'.repeat(100), role: 'synthesis', strategyName: 'consensus' });
      expect(a.score).toBe(0.77);
      expect(b.score).toBe(0.42);
      expect(c.score).toBe(0.1);
      expect(s.score).toBe(0.9);
    });

    it('returns verdict="fail" when executionFailed=true regardless of score', async () => {
      const ev = new MockStrategyOutputEvaluator({ fallback: 0.9 });
      const r = await ev.evaluate({
        task: {}, output: '', modelId: 'voter-a',
        executionFailed: true, strategyName: 'consensus',
      });
      expect(r.verdict).toBe('fail');
      expect(r.structural.executionError).toBe(true);
    });

    it('validationStatusForMode("mock") = "fully_validated"', () => {
      expect(validationStatusForMode('mock')).toBe('fully_validated');
    });
  });

  describe('StructuralOutputEvaluator', () => {
    it('declares mode="structural" and returns score=undefined', async () => {
      const ev = new StructuralOutputEvaluator();
      const r = await ev.evaluate({ task: {}, output: 'x'.repeat(100), strategyName: 'consensus' });
      expect(ev.mode).toBe('structural');
      expect(r.score).toBeUndefined();
    });

    it('passes verdict when output meets minLength (default 50)', async () => {
      const ev = new StructuralOutputEvaluator();
      const r = await ev.evaluate({ task: {}, output: 'x'.repeat(100), strategyName: 'consensus' });
      expect(r.verdict).toBe('pass');
      expect(r.structural.nonEmpty).toBe(true);
      expect(r.structural.meetsMinLength).toBe(true);
    });

    it('fails verdict on empty / too-short / executionFailed', async () => {
      const ev = new StructuralOutputEvaluator();
      const empty = await ev.evaluate({ task: {}, output: '', strategyName: 'consensus' });
      const short = await ev.evaluate({ task: {}, output: 'tiny', strategyName: 'consensus' });
      const failed = await ev.evaluate({ task: {}, output: 'x'.repeat(100), executionFailed: true, strategyName: 'consensus' });
      expect(empty.verdict).toBe('fail');
      expect(short.verdict).toBe('fail');
      expect(failed.verdict).toBe('fail');
    });

    it('validates JSON when task.expectedFormat="json"', async () => {
      const ev = new StructuralOutputEvaluator();
      const good = await ev.evaluate({
        task: { expectedFormat: 'json' },
        output: '{"k": "v", "n": 1, "_pad": "' + 'x'.repeat(80) + '"}',
        strategyName: 'consensus',
      });
      const bad = await ev.evaluate({
        task: { expectedFormat: 'json' },
        output: 'not json at all and is longer than fifty characters to pass min length',
        strategyName: 'consensus',
      });
      expect(good.structural.jsonValid).toBe(true);
      expect(good.verdict).toBe('pass');
      expect(bad.structural.jsonValid).toBe(false);
      expect(bad.verdict).toBe('fail');
    });

    it('detects code block when task.expectedFormat="code"', async () => {
      const ev = new StructuralOutputEvaluator();
      const withCode = await ev.evaluate({
        task: { expectedFormat: 'code' },
        output: 'Here is the function:\n```js\nfunction f() { return 1; }\n```\nDone.',
        strategyName: 'consensus',
      });
      const withoutCode = await ev.evaluate({
        task: { expectedFormat: 'code' },
        output: 'I will explain the function but I am NOT going to put it in a code block, just prose like this.',
        strategyName: 'consensus',
      });
      expect(withCode.structural.codeBlockPresent).toBe(true);
      expect(withCode.verdict).toBe('pass');
      expect(withoutCode.structural.codeBlockPresent).toBe(false);
      expect(withoutCode.verdict).toBe('fail');
    });

    it('validationStatusForMode("structural") = "structurally_validated_only"', () => {
      expect(validationStatusForMode('structural')).toBe('structurally_validated_only');
    });
  });

  describe('UnavailableStrategyOutputEvaluator', () => {
    it('declares mode="unavailable" and never returns a numeric score', async () => {
      const ev = new UnavailableStrategyOutputEvaluator();
      const r = await ev.evaluate({ task: {}, output: 'x'.repeat(100), strategyName: 'consensus' });
      expect(ev.mode).toBe('unavailable');
      expect(r.score).toBeUndefined();
      expect(r.scoringMode).toBe('unavailable');
    });

    it('emits verdict="fail" on executionFailed or empty, "unknown" otherwise', async () => {
      const ev = new UnavailableStrategyOutputEvaluator();
      const failed = await ev.evaluate({ task: {}, output: '', executionFailed: true, strategyName: 'consensus' });
      const empty = await ev.evaluate({ task: {}, output: '', strategyName: 'consensus' });
      const ok = await ev.evaluate({ task: {}, output: 'plausible answer with enough characters to pass the implicit nonEmpty check', strategyName: 'consensus' });
      expect(failed.verdict).toBe('fail');
      expect(empty.verdict).toBe('fail');
      expect(ok.verdict).toBe('uncertain');
    });

    it('validationStatusForMode("unavailable") = "unavailable"', () => {
      expect(validationStatusForMode('unavailable')).toBe('unavailable');
    });
  });

  describe('HeuristicTestOnlyEvaluator', () => {
    it('declares mode="heuristic_test_only" and carries a warning note', async () => {
      const ev = new HeuristicTestOnlyEvaluator();
      const r = await ev.evaluate({ task: {}, output: 'x'.repeat(120), strategyName: 'consensus' });
      expect(ev.mode).toBe('heuristic_test_only');
      expect(r.notes).toContain('NOT real quality scoring');
    });

    it('length-bracket math is deterministic', async () => {
      const ev = new HeuristicTestOnlyEvaluator();
      const r1 = await ev.evaluate({ task: {}, output: 'x'.repeat(120), strategyName: 'consensus' });
      const r2 = await ev.evaluate({ task: {}, output: 'x'.repeat(120), strategyName: 'consensus' });
      expect(r1.score).toBe(r2.score);
    });

    it('validationStatusForMode("heuristic_test_only") = "structurally_validated_only"', () => {
      expect(validationStatusForMode('heuristic_test_only')).toBe('structurally_validated_only');
    });
  });

  describe('validationStatusForMode', () => {
    it('maps every ScoringMode to a ValidationStatus', () => {
      expect(validationStatusForMode('mock')).toBe('fully_validated');
      expect(validationStatusForMode('task_specific')).toBe('fully_validated');
      expect(validationStatusForMode('llm_judge')).toBe('fully_validated');
      expect(validationStatusForMode('composite')).toBe('fully_validated');
      expect(validationStatusForMode('structural')).toBe('structurally_validated_only');
      expect(validationStatusForMode('heuristic_test_only')).toBe('structurally_validated_only');
      expect(validationStatusForMode('unavailable')).toBe('unavailable');
    });
  });
});
