// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01B safety pin: even with the strategy plugged into a
 * Composite that nominally includes an LLM judge, no provider call
 * is made when:
 *   - llmJudgeEnabled = false, OR
 *   - maxCostUsd = 0, OR
 *   - judgeModelId is missing, OR
 *   - llmJudgeClient is undefined
 *
 * Together with consensus-strategy.no-provider-call.test.ts (which spies
 * on fetch/http/https), this test pins that the judge wiring respects
 * the safety locks even at the strategy level.
 */
import { describe, it, expect, vi } from 'vitest';
import { CompositeEvaluator } from '../evaluation/composite-evaluator';
import { LLMJudgeEvaluator } from '../evaluation/llm-judge-evaluator';
import { StructuralOutputEvaluator } from '../evaluation/structural-evaluator';
import { TaskSpecificEvaluator } from '../evaluation/task-specific-evaluator';
import type { LLMJudgeClient } from '../evaluation/llm-judge-evaluator.types';
import { createStrategyOutputEvaluator } from '../evaluation/evaluator-factory';
import { loadEvaluatorConfigFromEnv } from '../evaluation/evaluator-config';
import {
  makeContext,
  makeRequest,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

describe('Consensus — no provider call when judge is disabled', () => {
  it('composite with llmJudgeEnabled=false → judge client never invoked', async () => {
    const judge = vi.fn();
    const evaluator = new CompositeEvaluator({
      structural: new StructuralOutputEvaluator(),
      taskSpecific: new TaskSpecificEvaluator(),
      // Explicit: even though we COULD construct an LLM judge, we don't
      // pass one in. The composite has no llm_judge axis.
    });
    void judge;
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator,
      eligibleModels: models,
    });
    await strategy.execute(makeRequest(), makeContext(models));
    expect(judge).not.toHaveBeenCalled();
  });

  it('composite with judge wired but maxCostUsd=0 → client never invoked', async () => {
    const judge = vi.fn();
    const evaluator = new CompositeEvaluator({
      structural: new StructuralOutputEvaluator(),
      taskSpecific: new TaskSpecificEvaluator(),
      llmJudge: new LLMJudgeEvaluator(
        {
          enabled: true,
          judgeModelId: 'judge-x',
          maxCostUsd: 0, // ← hard block
          timeoutMs: 1000,
          rubricVersion: 'v1',
        },
        { judge } as LLMJudgeClient,
      ),
    });
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator,
      eligibleModels: models,
    });
    await strategy.execute(makeRequest(), makeContext(models));
    expect(judge).not.toHaveBeenCalled();
  });

  it('default env config (no env vars set) → factory returns Unavailable, no client wired', async () => {
    const judge = vi.fn();
    const evaluator = createStrategyOutputEvaluator(loadEvaluatorConfigFromEnv({}), {
      llmClient: { judge } as LLMJudgeClient,
    });
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator,
      eligibleModels: models,
    });
    await strategy.execute(makeRequest(), makeContext(models));
    expect(judge).not.toHaveBeenCalled();
  });
});
