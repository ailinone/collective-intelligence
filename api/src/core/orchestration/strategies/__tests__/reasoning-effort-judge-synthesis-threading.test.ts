// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LOTE AZ (2026-09) — regression coverage for the audit finding that the
 * judge (provider-llm-judge-client.ts) and the consensus synthesis call
 * (response-aggregator.ts's coordinator ChatRequest) did NOT inherit
 * `thinking_budget`/`reasoning_effort` from the original request — a
 * high-effort original request silently got a low-/no-effort judge and
 * synthesizer.
 *
 * This test drives ConsensusStrategy end-to-end (mocked adapters/aggregator,
 * no real providers/DB/network) with a `reasoning_effort: 'high'` original
 * request and asserts:
 *   1. Every evaluator.evaluate() call (voters AND synthesis) carries
 *      `originalRequestReasoning` matching the original request's resolved
 *      effort.
 *   2. The aggregator's `aggregate()` call (the synthesis/coordinator path)
 *      receives `reasoningEffort`/`thinkingBudget` in its context.
 *   3. A request with NO reasoning signal at all forwards neither field
 *      (no fabricated signal on an unrelated request).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelExecution,
  OrchestrationContext,
  TaskType,
} from '@/types';
import type {
  EvaluationResult,
  EvaluatorInput,
  StrategyOutputEvaluator,
} from '../evaluation/strategy-output-evaluator';
import { EFFORT_THINKING_BUDGETS } from '@/utils/reasoning-effort';

// ─── Mock the response aggregator so the synthesis context is capturable ──
const aggregateMock = vi.fn(async () => ({
  response: makeChatResponse('synthesized answer above threshold for outlier detection to pass'),
  method: 'synthesis' as const,
  confidence: 0.85,
  cost: 0,
  metadata: { sourcesUsed: [], totalSources: 0, aggregationTime: 1 },
}));
vi.mock('@/core/aggregation/response-aggregator', () => ({
  getResponseAggregator: () => ({ aggregate: aggregateMock }),
}));

// Imported AFTER the mock so the strategy picks up the mocked aggregator.
import { ConsensusStrategy } from '../consensus-strategy';

function makeChatResponse(content: string, model = 'mock-model'): ChatResponse {
  return {
    id: `resp-${Math.random().toString(36).slice(2, 9)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null },
    ],
  };
}

function makeModel(id: string): Model {
  return {
    id,
    providerId: `provider-${id}`,
    provider: `provider-${id}`,
    name: id,
    displayName: id,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat', 'text_generation'],
    performance: { latencyMs: 1000, throughput: 100, quality: 0.9, reliability: 0.95 },
    status: 'active',
    balanceStatus: 'has-credits',
  };
}

function makeContext(models: Model[]): OrchestrationContext {
  return {
    organizationId: 'org-test',
    userId: 'user-test',
    requestId: `req-${Math.random().toString(36).slice(2, 9)}`,
    models,
    taskType: 'analysis' as TaskType,
    contextSize: 1000,
    qualityTarget: 0.7,
    preferSpeed: false,
  };
}

/** Captures every `originalRequestReasoning` an evaluate() call carried. */
function makeCapturingEvaluator(): {
  evaluator: StrategyOutputEvaluator;
  calls: Array<{ role?: string; originalRequestReasoning: EvaluatorInput['originalRequestReasoning'] }>;
} {
  const calls: Array<{
    role?: string;
    originalRequestReasoning: EvaluatorInput['originalRequestReasoning'];
  }> = [];
  const evaluator: StrategyOutputEvaluator = {
    mode: 'mock',
    id: 'capturing-test-evaluator',
    async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
      calls.push({ role: input.role, originalRequestReasoning: input.originalRequestReasoning });
      return {
        scoringMode: 'mock',
        evaluatorId: 'capturing-test-evaluator',
        score: 0.8,
        verdict: 'pass',
        structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
        validationStatus: 'fully_validated',
      };
    },
  };
  return { evaluator, calls };
}

function wireStrategy(models: Model[], evaluator: StrategyOutputEvaluator): ConsensusStrategy {
  const strategy = new ConsensusStrategy();
  const anyStrat = strategy as unknown as Record<string, unknown>;

  const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => silentLogger,
  };
  anyStrat.log = silentLogger;
  anyStrat.emitObserverEvent = () => {};
  anyStrat.isReasoningEnabled = () => false;
  anyStrat.selectPromptVariant = () => null;
  anyStrat.withReasoningPrompt = (prompt: string) => prompt;
  anyStrat.drainObserverChunks = async () => [];
  anyStrat.getEligibleModels = () => models;
  anyStrat.selectDiverseModels = async () => models;
  anyStrat.getAdapterForModel = async () => ({
    getName: () => 'mock-provider',
    chatCompletion: async () => makeChatResponse('voter content'),
    calculateCost: () => 0.001,
  });
  anyStrat.executeModel = async (
    _adapter: unknown,
    model: Model,
    request: ChatRequest,
    role: string
  ): Promise<ModelExecution> => ({
    modelId: model.id,
    modelName: model.name,
    role: role as ModelExecution['role'],
    request,
    response: makeChatResponse(
      `${model.name} votes with a sufficiently long rationale to pass any filters and outlier checks.`,
      model.name
    ),
    cost: 0.001,
    durationMs: 100,
    success: true,
  });
  anyStrat.executeModelWithReasoning = anyStrat.executeModel;

  strategy.setEvaluatorForTesting(evaluator);
  return strategy;
}

describe('Judge/synthesis reasoning-effort threading (LOTE AZ) — consensus', () => {
  beforeEach(() => {
    aggregateMock.mockClear();
  });

  it('forwards the resolved effort to every voter AND synthesis evaluate() call', async () => {
    const models = [makeModel('m1'), makeModel('m2'), makeModel('m3')];
    const { evaluator, calls } = makeCapturingEvaluator();
    const strategy = wireStrategy(models, evaluator);

    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Explain the tradeoffs in depth.' }],
      reasoning_effort: 'high',
    };

    await strategy.execute(request, makeContext(models));

    expect(calls.length).toBeGreaterThanOrEqual(4); // 3 voters + 1 synthesis
    for (const call of calls) {
      expect(call.originalRequestReasoning?.effort).toBe('high');
      expect(call.originalRequestReasoning?.thinkingBudget).toBe(EFFORT_THINKING_BUDGETS.high);
    }
    // At least one of the calls is explicitly the synthesis role.
    expect(calls.some((c) => c.role === 'synthesis')).toBe(true);
  });

  it('forwards reasoningEffort/thinkingBudget to the aggregator (coordinator/synthesis) context', async () => {
    const models = [makeModel('m1'), makeModel('m2'), makeModel('m3')];
    const { evaluator } = makeCapturingEvaluator();
    const strategy = wireStrategy(models, evaluator);

    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Explain the tradeoffs in depth.' }],
      reasoning_effort: 'medium',
    };

    await strategy.execute(request, makeContext(models));

    expect(aggregateMock).toHaveBeenCalled();
    const contextArg = aggregateMock.mock.calls[0][2] as {
      reasoningEffort?: string;
      thinkingBudget?: number;
    };
    expect(contextArg.reasoningEffort).toBe('medium');
    expect(contextArg.thinkingBudget).toBe(EFFORT_THINKING_BUDGETS.medium);
  });

  it('forwards nothing when the original request carries no reasoning signal at all', async () => {
    const models = [makeModel('m1'), makeModel('m2'), makeModel('m3')];
    const { evaluator, calls } = makeCapturingEvaluator();
    const strategy = wireStrategy(models, evaluator);

    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Plain request, no effort signal.' }],
    };

    await strategy.execute(request, makeContext(models));

    for (const call of calls) {
      expect(call.originalRequestReasoning).toBeUndefined();
    }
    const contextArg = aggregateMock.mock.calls[0][2] as {
      reasoningEffort?: string;
      thinkingBudget?: number;
    };
    expect(contextArg.reasoningEffort).toBeUndefined();
    expect(contextArg.thinkingBudget).toBeUndefined();
  });
});
