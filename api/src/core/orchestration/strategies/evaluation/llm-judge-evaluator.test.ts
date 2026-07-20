// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LLMJudgeEvaluator — safety + contract tests.
 *
 * The most important asserts here: the judge MUST NOT call any client
 * unless every gate passes (enabled, judgeModelId, maxCostUsd>0, client
 * injected). Anything else returns unavailable + score=undefined.
 */
import { describe, it, expect, vi } from 'vitest';
import { LLMJudgeEvaluator } from './llm-judge-evaluator';
import type {
  LLMJudgeClient,
  LLMJudgeEvaluatorConfig,
} from './llm-judge-evaluator.types';

const baseConfig: LLMJudgeEvaluatorConfig = {
  enabled: true,
  judgeModelId: 'judge-model-x',
  maxCostUsd: 0.01,
  timeoutMs: 1000,
  rubricVersion: 'strategy-output-v1',
};

const baseInput = {
  task: { taskType: 'analysis' },
  output: 'A reasonable answer that is long enough to be valid for testing.',
  strategyName: 'consensus',
  role: 'voter' as const,
};

function clientThatShouldNotBeCalled(): LLMJudgeClient {
  return {
    judge: vi.fn(async () => {
      throw new Error('client was called when it should not have been');
    }),
  };
}

describe('LLMJudgeEvaluator — safety gates', () => {
  it('enabled=false → unavailable, client NEVER called', async () => {
    const client = clientThatShouldNotBeCalled();
    const ev = new LLMJudgeEvaluator({ ...baseConfig, enabled: false }, client);
    const r = await ev.evaluate(baseInput);
    expect(r.score).toBeUndefined();
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('llm_judge_disabled');
    expect(client.judge).not.toHaveBeenCalled();
  });

  it('missing judgeModelId → unavailable, client NEVER called', async () => {
    const client = clientThatShouldNotBeCalled();
    const ev = new LLMJudgeEvaluator({ ...baseConfig, judgeModelId: undefined }, client);
    const r = await ev.evaluate(baseInput);
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('judge_model_id_missing');
    expect(client.judge).not.toHaveBeenCalled();
  });

  it('maxCostUsd=0 → unavailable, client NEVER called', async () => {
    const client = clientThatShouldNotBeCalled();
    const ev = new LLMJudgeEvaluator({ ...baseConfig, maxCostUsd: 0 }, client);
    const r = await ev.evaluate(baseInput);
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('budget_zero_or_invalid');
    expect(client.judge).not.toHaveBeenCalled();
  });

  it('no client injected → unavailable', async () => {
    const ev = new LLMJudgeEvaluator(baseConfig); // no client
    const r = await ev.evaluate(baseInput);
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('judge_client_unavailable');
  });
});

describe('LLMJudgeEvaluator — happy path with mock client', () => {
  it('returns fully_validated when judge responds with a valid result', async () => {
    const client: LLMJudgeClient = {
      judge: async () => ({
        score: 0.82,
        verdict: 'pass',
        confidence: 0.7,
        shortRationale: 'meets rubric',
        subScores: { correctness: 0.9, completeness: 0.7 },
      }),
    };
    const ev = new LLMJudgeEvaluator(baseConfig, client);
    const r = await ev.evaluate(baseInput);
    expect(r.score).toBe(0.82);
    expect(r.verdict).toBe('pass');
    expect(r.validationStatus).toBe('fully_validated');
    expect(r.notes).toContain('strategy-output-v1');
  });

  it('rubricVersion appears in result notes', async () => {
    const client: LLMJudgeClient = {
      judge: async () => ({ score: 0.5, verdict: 'pass' }),
    };
    const ev = new LLMJudgeEvaluator({ ...baseConfig, rubricVersion: 'rubric-v42' }, client);
    const r = await ev.evaluate(baseInput);
    expect(r.notes).toContain('rubric-v42');
    expect(r.evaluatorId).toBe('llm-judge-rubric-v42');
  });

  it('execution_failed short-circuits before calling judge', async () => {
    const client = clientThatShouldNotBeCalled();
    const ev = new LLMJudgeEvaluator(baseConfig, client);
    const r = await ev.evaluate({ ...baseInput, output: '', executionFailed: true });
    expect(r.verdict).toBe('fail');
    expect(r.score).toBe(0);
    expect(client.judge).not.toHaveBeenCalled();
  });
});

describe('LLMJudgeEvaluator — defensive parsing', () => {
  it('malformed judge response (NaN score) → uncertain + unavailable', async () => {
    const client: LLMJudgeClient = {
      judge: async () => ({ score: NaN, verdict: 'pass' } as unknown as { score: number; verdict: 'pass' }),
    };
    const ev = new LLMJudgeEvaluator(baseConfig, client);
    const r = await ev.evaluate(baseInput);
    expect(r.score).toBeUndefined();
    expect(r.verdict).toBe('uncertain');
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('malformed');
  });

  it('out-of-range score → uncertain + unavailable', async () => {
    const client: LLMJudgeClient = {
      judge: async () => ({ score: 1.5, verdict: 'pass' }),
    };
    const ev = new LLMJudgeEvaluator(baseConfig, client);
    const r = await ev.evaluate(baseInput);
    expect(r.score).toBeUndefined();
    expect(r.validationStatus).toBe('unavailable');
  });

  it('judge throws → uncertain + unavailable, never crashes the strategy', async () => {
    const client: LLMJudgeClient = {
      judge: async () => { throw new Error('provider 503'); },
    };
    const ev = new LLMJudgeEvaluator(baseConfig, client);
    const r = await ev.evaluate(baseInput);
    expect(r.verdict).toBe('uncertain');
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('provider 503');
  });

  it('timeout returns uncertain + unavailable (no crash)', async () => {
    const client: LLMJudgeClient = {
      judge: () => new Promise(() => { /* never resolves */ }),
    };
    const ev = new LLMJudgeEvaluator({ ...baseConfig, timeoutMs: 50 }, client);
    const r = await ev.evaluate(baseInput);
    expect(r.verdict).toBe('uncertain');
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toMatch(/judge_timeout_after_\d+ms/);
  });
});
