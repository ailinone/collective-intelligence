// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * evaluator-config / evaluator-factory contract tests.
 *
 * Pins the safety defaults — these are the rules that prevent a stray
 * deploy from accidentally calling a real LLM judge with no budget.
 */
import { describe, it, expect, vi } from 'vitest';
import { loadEvaluatorConfigFromEnv } from './evaluator-config';
import { createStrategyOutputEvaluator } from './evaluator-factory';
import { UnavailableStrategyOutputEvaluator } from './unavailable-evaluator';
import { StructuralOutputEvaluator } from './structural-evaluator';
import { TaskSpecificEvaluator } from './task-specific-evaluator';
import { LLMJudgeEvaluator } from './llm-judge-evaluator';
import { CompositeEvaluator } from './composite-evaluator';
import type { LLMJudgeClient } from './llm-judge-evaluator.types';

describe('loadEvaluatorConfigFromEnv', () => {
  it('empty env → mode=unavailable, everything disabled, budget=0', () => {
    const cfg = loadEvaluatorConfigFromEnv({});
    expect(cfg.mode).toBe('unavailable');
    expect(cfg.taskSpecificEnabled).toBe(false);
    expect(cfg.llmJudgeEnabled).toBe(false);
    expect(cfg.maxCostUsd).toBe(0);
    expect(cfg.timeoutMs).toBe(3000);
    expect(cfg.rubricVersion).toBe('strategy-output-v1');
  });

  it('invalid mode falls back to unavailable', () => {
    const cfg = loadEvaluatorConfigFromEnv({ STRATEGY_EVALUATOR_MODE: 'magic' });
    expect(cfg.mode).toBe('unavailable');
  });

  it('respects valid modes', () => {
    for (const m of ['unavailable', 'structural', 'task_specific', 'llm_judge', 'composite']) {
      const cfg = loadEvaluatorConfigFromEnv({ STRATEGY_EVALUATOR_MODE: m });
      expect(cfg.mode).toBe(m);
    }
  });

  it('respects budget + timeout overrides; rejects negative budget', () => {
    const cfg = loadEvaluatorConfigFromEnv({
      STRATEGY_EVALUATOR_MAX_COST_USD: '0.05',
      STRATEGY_EVALUATOR_TIMEOUT_MS: '5000',
    });
    expect(cfg.maxCostUsd).toBe(0.05);
    expect(cfg.timeoutMs).toBe(5000);

    const cfg2 = loadEvaluatorConfigFromEnv({ STRATEGY_EVALUATOR_MAX_COST_USD: '-1' });
    expect(cfg2.maxCostUsd).toBe(0);
  });

  it('llmJudgeModelId is trimmed; empty becomes undefined', () => {
    expect(loadEvaluatorConfigFromEnv({ STRATEGY_EVALUATOR_LLM_JUDGE_MODEL_ID: '  ' }).llmJudgeModelId).toBeUndefined();
    expect(loadEvaluatorConfigFromEnv({ STRATEGY_EVALUATOR_LLM_JUDGE_MODEL_ID: 'judge-a' }).llmJudgeModelId).toBe('judge-a');
  });
});

describe('createStrategyOutputEvaluator', () => {
  it('mode=unavailable → UnavailableEvaluator', () => {
    const e = createStrategyOutputEvaluator(loadEvaluatorConfigFromEnv({}));
    expect(e).toBeInstanceOf(UnavailableStrategyOutputEvaluator);
    expect(e.mode).toBe('unavailable');
  });

  it('mode=structural → StructuralEvaluator', () => {
    const cfg = loadEvaluatorConfigFromEnv({ STRATEGY_EVALUATOR_MODE: 'structural' });
    const e = createStrategyOutputEvaluator(cfg);
    expect(e).toBeInstanceOf(StructuralOutputEvaluator);
  });

  it('mode=task_specific → TaskSpecificEvaluator', () => {
    const cfg = loadEvaluatorConfigFromEnv({ STRATEGY_EVALUATOR_MODE: 'task_specific' });
    const e = createStrategyOutputEvaluator(cfg);
    expect(e).toBeInstanceOf(TaskSpecificEvaluator);
  });

  it('mode=llm_judge → LLMJudgeEvaluator (no client injected → unavailable at evaluate-time)', async () => {
    const cfg = loadEvaluatorConfigFromEnv({
      STRATEGY_EVALUATOR_MODE: 'llm_judge',
      STRATEGY_EVALUATOR_LLM_JUDGE_ENABLED: 'true',
      STRATEGY_EVALUATOR_LLM_JUDGE_MODEL_ID: 'judge-x',
      STRATEGY_EVALUATOR_MAX_COST_USD: '0.01',
    });
    const e = createStrategyOutputEvaluator(cfg); // no client
    expect(e).toBeInstanceOf(LLMJudgeEvaluator);
    const r = await e.evaluate({ task: {}, output: 'x'.repeat(100), strategyName: 'consensus' });
    expect(r.validationStatus).toBe('unavailable');
  });

  it('mode=composite + llmJudgeEnabled=false → judge sub-evaluator is NOT constructed (no client risk)', async () => {
    const judgeClient = { judge: vi.fn() };
    const cfg = loadEvaluatorConfigFromEnv({
      STRATEGY_EVALUATOR_MODE: 'composite',
      STRATEGY_EVALUATOR_TASK_SPECIFIC_ENABLED: 'true',
      STRATEGY_EVALUATOR_LLM_JUDGE_ENABLED: 'false',
    });
    const e = createStrategyOutputEvaluator(cfg, { llmClient: judgeClient as unknown as LLMJudgeClient });
    expect(e).toBeInstanceOf(CompositeEvaluator);
    await e.evaluate({ task: {}, output: 'A'.repeat(100), strategyName: 'consensus' });
    expect(judgeClient.judge).not.toHaveBeenCalled();
  });

  it('mode=composite + llmJudgeEnabled=true + budget=0 → judge client never called', async () => {
    const judgeClient = { judge: vi.fn() };
    const cfg = loadEvaluatorConfigFromEnv({
      STRATEGY_EVALUATOR_MODE: 'composite',
      STRATEGY_EVALUATOR_TASK_SPECIFIC_ENABLED: 'true',
      STRATEGY_EVALUATOR_LLM_JUDGE_ENABLED: 'true',
      STRATEGY_EVALUATOR_LLM_JUDGE_MODEL_ID: 'judge-x',
      STRATEGY_EVALUATOR_MAX_COST_USD: '0',
    });
    const e = createStrategyOutputEvaluator(cfg, { llmClient: judgeClient as unknown as LLMJudgeClient });
    await e.evaluate({ task: {}, output: 'A'.repeat(100), strategyName: 'consensus' });
    expect(judgeClient.judge).not.toHaveBeenCalled();
  });
});
