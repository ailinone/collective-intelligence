// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CompositeEvaluator — combination + invariants.
 *
 * Pins:
 *  - structural fail blocks (no judge call wasted)
 *  - task_specific objective score wins
 *  - llm_judge contributes only when fully_validated
 *  - no comparable score → score undefined + structurally_validated_only
 *  - composite NEVER promotes structural-only into fully_validated
 *  - subResults are recorded
 *  - deterministic
 */
import { describe, it, expect, vi } from 'vitest';
import { CompositeEvaluator } from './composite-evaluator';
import { StructuralOutputEvaluator } from './structural-evaluator';
import { TaskSpecificEvaluator, type CodeRunner } from './task-specific-evaluator';
import { LLMJudgeEvaluator } from './llm-judge-evaluator';
import type { LLMJudgeClient } from './llm-judge-evaluator.types';
import type {
  EvaluationResult,
  EvaluatorInput,
  StrategyOutputEvaluator,
} from './strategy-output-evaluator';

const baseInput = (overrides: Partial<EvaluatorInput> = {}): EvaluatorInput => ({
  task: {},
  output: '',
  strategyName: 'consensus',
  ...overrides,
});

function mockEvaluator(result: Partial<EvaluationResult> & { mode: EvaluationResult['scoringMode']; verdict: EvaluationResult['verdict'] }): StrategyOutputEvaluator {
  return {
    mode: result.mode,
    id: `mock-${result.mode}`,
    async evaluate() {
      return {
        scoringMode: result.mode,
        evaluatorId: `mock-${result.mode}`,
        score: result.score,
        verdict: result.verdict,
        structural: result.structural ?? { nonEmpty: true, meetsMinLength: true, executionError: false },
        validationStatus: result.validationStatus,
        notes: result.notes,
      };
    },
  };
}

describe('CompositeEvaluator — structural gate', () => {
  it('structural fail short-circuits and judge is NEVER called', async () => {
    const judge = vi.fn();
    const ev = new CompositeEvaluator({
      structural: new StructuralOutputEvaluator(),
      taskSpecific: mockEvaluator({ mode: 'task_specific', verdict: 'pass', score: 0.9, validationStatus: 'fully_validated' }),
      llmJudge: { mode: 'llm_judge', id: 'judge', evaluate: judge },
    });
    const r = await ev.evaluate(baseInput({ output: '' })); // empty → structural fail
    expect(r.verdict).toBe('fail');
    expect(r.score).toBe(0);
    expect(judge).not.toHaveBeenCalled();
    expect(r.selectedScoreSource).toBe('structural');
  });
});

describe('CompositeEvaluator — score priority', () => {
  it('task_specific objective score wins when judge is not configured', async () => {
    const ev = new CompositeEvaluator({
      structural: new StructuralOutputEvaluator(),
      taskSpecific: mockEvaluator({ mode: 'task_specific', verdict: 'pass', score: 0.77, validationStatus: 'fully_validated' }),
    });
    const r = await ev.evaluate(baseInput({ output: 'A'.repeat(100) }));
    expect(r.score).toBe(0.77);
    expect(r.selectedScoreSource).toBe('task_specific');
    expect(r.validationStatus).toBe('fully_validated');
  });

  it('llm_judge wins when task_specific has no comparable score', async () => {
    const judgeClient: LLMJudgeClient = { judge: async () => ({ score: 0.66, verdict: 'pass' }) };
    const ev = new CompositeEvaluator({
      structural: new StructuralOutputEvaluator(),
      taskSpecific: mockEvaluator({ mode: 'task_specific', verdict: 'uncertain', score: undefined, validationStatus: 'structurally_validated_only' }),
      llmJudge: new LLMJudgeEvaluator(
        { enabled: true, judgeModelId: 'j', maxCostUsd: 0.01, timeoutMs: 1000, rubricVersion: 'v1' },
        judgeClient,
      ),
    });
    const r = await ev.evaluate(baseInput({ output: 'A'.repeat(100) }));
    expect(r.score).toBe(0.66);
    expect(r.selectedScoreSource).toBe('llm_judge');
    expect(r.validationStatus).toBe('fully_validated');
  });

  it('blends task + judge scores when BOTH are fully_validated', async () => {
    const judgeClient: LLMJudgeClient = { judge: async () => ({ score: 0.6, verdict: 'pass' }) };
    const ev = new CompositeEvaluator({
      structural: new StructuralOutputEvaluator(),
      taskSpecific: mockEvaluator({ mode: 'task_specific', verdict: 'pass', score: 0.9, validationStatus: 'fully_validated' }),
      llmJudge: new LLMJudgeEvaluator(
        { enabled: true, judgeModelId: 'j', maxCostUsd: 0.01, timeoutMs: 1000, rubricVersion: 'v1' },
        judgeClient,
      ),
      weights: { taskSpecific: 0.6, llmJudge: 0.4 },
    });
    const r = await ev.evaluate(baseInput({ output: 'A'.repeat(100) }));
    expect(r.score).toBeCloseTo(0.9 * 0.6 + 0.6 * 0.4, 5);
    expect(r.selectedScoreSource).toBe('weighted_task_judge');
  });
});

describe('CompositeEvaluator — never promotes structural to fully_validated', () => {
  it('only structural + task uncertain + judge disabled → structurally_validated_only', async () => {
    const ev = new CompositeEvaluator({
      structural: new StructuralOutputEvaluator(),
      taskSpecific: new TaskSpecificEvaluator(), // no runner → uncertain on code; we'll use plain_text
      llmJudge: new LLMJudgeEvaluator(
        { enabled: false, judgeModelId: undefined, maxCostUsd: 0, timeoutMs: 1000, rubricVersion: 'v1' },
      ),
    });
    const r = await ev.evaluate(baseInput({
      task: { taskType: 'analysis', expectedFormat: 'free_text' },
      output: 'A'.repeat(100),
    }));
    expect(r.score).toBeUndefined();
    expect(r.validationStatus).toBe('structurally_validated_only');
    expect(r.selectedScoreSource).toBe('none');
  });

  it('only structural configured → never fully_validated', async () => {
    const ev = new CompositeEvaluator({
      structural: new StructuralOutputEvaluator(),
    });
    const r = await ev.evaluate(baseInput({ output: 'A'.repeat(100) }));
    expect(r.score).toBeUndefined();
    expect(r.validationStatus).toBe('structurally_validated_only');
  });
});

describe('CompositeEvaluator — judge respect', () => {
  it('llm_judge disabled does NOT call client even with composite mode', async () => {
    const judge = vi.fn();
    const ev = new CompositeEvaluator({
      structural: new StructuralOutputEvaluator(),
      taskSpecific: mockEvaluator({ mode: 'task_specific', verdict: 'pass', score: 0.5, validationStatus: 'fully_validated' }),
      llmJudge: new LLMJudgeEvaluator(
        { enabled: false, judgeModelId: 'j', maxCostUsd: 1, timeoutMs: 1000, rubricVersion: 'v1' },
        { judge },
      ),
    });
    const r = await ev.evaluate(baseInput({ output: 'A'.repeat(100) }));
    expect(r.score).toBe(0.5);
    expect(judge).not.toHaveBeenCalled();
  });

  it('llm_judge with budget=0 does NOT call client', async () => {
    const judge = vi.fn();
    const ev = new CompositeEvaluator({
      structural: new StructuralOutputEvaluator(),
      taskSpecific: mockEvaluator({ mode: 'task_specific', verdict: 'pass', score: 0.5, validationStatus: 'fully_validated' }),
      llmJudge: new LLMJudgeEvaluator(
        { enabled: true, judgeModelId: 'j', maxCostUsd: 0, timeoutMs: 1000, rubricVersion: 'v1' },
        { judge },
      ),
    });
    await ev.evaluate(baseInput({ output: 'A'.repeat(100) }));
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('CompositeEvaluator — subResults + determinism', () => {
  it('records subResults from every sub-evaluator that ran', async () => {
    const ev = new CompositeEvaluator({
      structural: new StructuralOutputEvaluator(),
      taskSpecific: mockEvaluator({ mode: 'task_specific', verdict: 'pass', score: 0.5, validationStatus: 'fully_validated' }),
    });
    const r = await ev.evaluate(baseInput({ output: 'A'.repeat(100) }));
    expect(r.subResults?.map((s) => s.name)).toEqual(['structural', 'task_specific']);
  });

  it('is deterministic given deterministic sub-evaluators + injected runner', async () => {
    const runner: CodeRunner = { run: async () => ({ score: 0.7, verdict: 'pass' }) };
    const make = () =>
      new CompositeEvaluator({
        structural: new StructuralOutputEvaluator(),
        taskSpecific: new TaskSpecificEvaluator({ codeRunner: runner }),
      });
    const input = baseInput({
      task: { expectedFormat: 'code' },
      output: '```js\nx\n```',
    });
    const r1 = await make().evaluate(input);
    const r2 = await make().evaluate(input);
    expect(r1.score).toBe(r2.score);
    expect(r1.verdict).toBe(r2.verdict);
    expect(r1.validationStatus).toBe(r2.validationStatus);
  });
});
