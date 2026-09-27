// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DocumentJudgeEvaluator — safety + contract tests.
 *
 * Mirrors llm-judge-evaluator.test.ts's structure: the judge MUST NOT call
 * any client unless every gate passes (enabled, judgeModelId, maxCostUsd>0,
 * client injected). The one addition over LLMJudgeEvaluator: a valid result
 * carries `issues` through onto `EvaluationResult.issues` unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { DocumentJudgeEvaluator } from './document-judge-evaluator';
import type { DocumentJudgeClient, DocumentJudgeEvaluatorConfig } from './document-judge-evaluator.types';

const baseConfig: DocumentJudgeEvaluatorConfig = {
  enabled: true,
  judgeModelId: 'judge-model-x',
  maxCostUsd: 0.01,
  timeoutMs: 1000,
  rubricVersion: 'document-critic-v1',
  criticRole: 'factual_accuracy',
};

const baseInput = {
  task: { taskType: 'document_review' },
  output: '[page 1]\nRevenue was $10M.\n\n[page 2]\nThe total above was $12M.',
  strategyName: 'document-review',
  role: 'voter' as const,
};

function clientThatShouldNotBeCalled(): DocumentJudgeClient {
  return {
    judgeDocument: vi.fn(async () => {
      throw new Error('client was called when it should not have been');
    }),
  };
}

describe('DocumentJudgeEvaluator — safety gates', () => {
  it('enabled=false → unavailable, client NEVER called', async () => {
    const client = clientThatShouldNotBeCalled();
    const ev = new DocumentJudgeEvaluator({ ...baseConfig, enabled: false }, client);
    const r = await ev.evaluate(baseInput);
    expect(r.score).toBeUndefined();
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('document_judge_disabled');
    expect(r.issues).toEqual([]);
    expect(client.judgeDocument).not.toHaveBeenCalled();
  });

  it('missing judgeModelId → unavailable, client NEVER called', async () => {
    const client = clientThatShouldNotBeCalled();
    const ev = new DocumentJudgeEvaluator({ ...baseConfig, judgeModelId: undefined }, client);
    const r = await ev.evaluate(baseInput);
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('judge_model_id_missing');
    expect(client.judgeDocument).not.toHaveBeenCalled();
  });

  it('maxCostUsd=0 → unavailable, client NEVER called', async () => {
    const client = clientThatShouldNotBeCalled();
    const ev = new DocumentJudgeEvaluator({ ...baseConfig, maxCostUsd: 0 }, client);
    const r = await ev.evaluate(baseInput);
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('budget_zero_or_invalid');
    expect(client.judgeDocument).not.toHaveBeenCalled();
  });

  it('no client injected → unavailable', async () => {
    const ev = new DocumentJudgeEvaluator(baseConfig); // no client
    const r = await ev.evaluate(baseInput);
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('document_judge_client_unavailable');
  });

  it('empty document text → fail, client NEVER called', async () => {
    const client = clientThatShouldNotBeCalled();
    const ev = new DocumentJudgeEvaluator(baseConfig, client);
    const r = await ev.evaluate({ ...baseInput, output: '   ' });
    expect(r.verdict).toBe('fail');
    expect(r.issues).toEqual([]);
    expect(client.judgeDocument).not.toHaveBeenCalled();
  });
});

describe('DocumentJudgeEvaluator — happy path with mock client', () => {
  it('returns fully_validated with issues carried through unchanged', async () => {
    const client: DocumentJudgeClient = {
      judgeDocument: async () => ({
        score: 0.4,
        verdict: 'fail',
        confidence: 0.75,
        shortRationale: 'numbers do not reconcile',
        issues: [{ location: 2, severity: 'critical', description: 'total contradicts page 1' }],
      }),
    };
    const ev = new DocumentJudgeEvaluator(baseConfig, client);
    const r = await ev.evaluate(baseInput);
    expect(r.score).toBe(0.4);
    expect(r.verdict).toBe('fail');
    expect(r.validationStatus).toBe('fully_validated');
    expect(r.issues).toEqual([{ location: 2, severity: 'critical', description: 'total contradicts page 1' }]);
    expect(r.notes).toContain('critic=factual_accuracy');
  });

  it('malformed raw result (issues not an array) → unavailable, never fabricated', async () => {
    const client: DocumentJudgeClient = {
      // @ts-expect-error deliberately malformed for the test
      judgeDocument: async () => ({ score: 0.5, verdict: 'pass', issues: 'not-an-array' }),
    };
    const ev = new DocumentJudgeEvaluator(baseConfig, client);
    const r = await ev.evaluate(baseInput);
    expect(r.validationStatus).toBe('unavailable');
    expect(r.issues).toEqual([]);
  });
});
