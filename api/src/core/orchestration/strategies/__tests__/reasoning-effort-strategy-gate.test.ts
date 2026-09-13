// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression coverage for `BaseStrategy.isReasoningEnabled()` — the single
 * gate every one of the 30 orchestration strategies uses to decide between
 * `executeModelWithReasoning()` (native-thinking `thinking_budget` injection
 * for models like DeepSeek-R1/QwQ, plus the chain-of-thought prompt fallback
 * for every other model) and plain `executeModel()`.
 *
 * Before this fix, `isReasoningEnabled()` checked ONLY
 * `ailin_constraints.enable_reasoning === true` — it did not consult the
 * canonical `resolveReasoningEffort()` (LOTE AZ, `@/utils/reasoning-effort`)
 * at all. A caller that set ONLY `reasoning_effort` (the public, documented,
 * schema-validated field every provider adapter reads — see
 * reasoning-effort-propagation.test.ts and reasoning-effort-judge-synthesis-
 * threading.test.ts for the alias-resolution and judge/synthesis threading
 * halves of this contract) with no `enable_reasoning` boolean got `false`
 * here. Every strategy then called plain `executeModel()`, which for a
 * native-thinking model NEVER injects `thinking_budget` — the caller's
 * explicit effort request silently did nothing for that model, even though
 * it structurally survived alias resolution and reached the strategy intact.
 *
 * This drives ConsensusStrategy (mocked adapters/aggregator, no real
 * providers/DB/network) — a genuine MULTI-MODEL strategy, not a single-model
 * call — with a mixed roster of a native-thinking model and a plain model,
 * so the assertion covers propagation through an actual multi-model
 * collective, not just one voter.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChatRequest, ChatResponse, Model, ModelExecution, OrchestrationContext, TaskType } from '@/types';
import { EFFORT_THINKING_BUDGETS } from '@/utils/reasoning-effort';

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

/** `deepseek-r1` matches `modelHasNativeThinking()`'s name-regex heuristic —
 *  a real native-thinking voter, not a hardcoded id the resolver special-cases. */
function nativeThinkingModel(): Model {
  return {
    id: 'deepseek-r1',
    providerId: 'provider-native',
    provider: 'provider-native',
    name: 'deepseek-r1',
    displayName: 'DeepSeek R1',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat', 'text_generation'],
    performance: { latencyMs: 1000, throughput: 100, quality: 0.9, reliability: 0.95 },
    status: 'active',
    balanceStatus: 'has-credits',
  } as Model;
}

function plainModel(id: string): Model {
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
  } as Model;
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

/** Wires a real (non-stubbed) `isReasoningEnabled` — the point of this suite
 *  — while stubbing everything else needed to drive `execute()` fully
 *  offline. `executeModel` and `executeModelWithReasoning` are kept as
 *  DISTINCT spies (unlike the judge/synthesis threading suite, which aliases
 *  them together) so each voter's actual code path is observable. */
function wireStrategy(models: Model[]): {
  strategy: ConsensusStrategy;
  executeModelCalls: ChatRequest[];
  executeModelWithReasoningCalls: ChatRequest[];
} {
  const strategy = new ConsensusStrategy();
  const anyStrat = strategy as unknown as Record<string, unknown>;
  const executeModelCalls: ChatRequest[] = [];
  const executeModelWithReasoningCalls: ChatRequest[] = [];

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
  anyStrat.selectPromptVariant = () => null;
  anyStrat.drainObserverChunks = async () => [];
  anyStrat.getEligibleModels = () => models;
  anyStrat.selectDiverseModels = async () => models;
  anyStrat.getAdapterForModel = async () => ({
    getName: () => 'mock-provider',
    chatCompletion: async () => makeChatResponse('voter content'),
    calculateCost: () => 0.001,
  });

  const respond = (model: Model, role: string, request: ChatRequest): ModelExecution => ({
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

  // Real (base-strategy) executeModelWithReasoning delegates to this
  // executeModel eventually, but we only need to observe WHICH of the two
  // entry points each voter actually went through — so both are stubbed as
  // terminal spies rather than letting the real one call the other.
  anyStrat.executeModel = async (
    _adapter: unknown,
    model: Model,
    request: ChatRequest,
    role: string
  ): Promise<ModelExecution> => {
    executeModelCalls.push(request);
    return respond(model, role, request);
  };

  // Mirrors the REAL executeModelWithReasoning's native-thinking budget
  // injection (base-strategy.ts) closely enough to prove the value that
  // reaches it, without re-importing the full base-strategy implementation.
  anyStrat.executeModelWithReasoning = async (
    _adapter: unknown,
    model: Model,
    request: ChatRequest,
    role: string
  ): Promise<ModelExecution> => {
    const isNative = /deepseek-r1|qwq|thinking|reasoner/.test(model.name.toLowerCase());
    const reqForExecution: ChatRequest = isNative
      ? {
          ...request,
          thinking_budget:
            request.thinking_budget ??
            (request.reasoning_effort ? EFFORT_THINKING_BUDGETS[request.reasoning_effort] : EFFORT_THINKING_BUDGETS.medium),
        }
      : request;
    executeModelWithReasoningCalls.push(reqForExecution);
    return respond(model, role, reqForExecution);
  };

  strategy.setEvaluatorForTesting({
    mode: 'mock',
    id: 'gate-test-evaluator',
    async evaluate() {
      return {
        scoringMode: 'mock',
        evaluatorId: 'gate-test-evaluator',
        score: 0.8,
        verdict: 'pass',
        structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
        validationStatus: 'fully_validated',
      };
    },
  });

  return { strategy, executeModelCalls, executeModelWithReasoningCalls };
}

describe('BaseStrategy.isReasoningEnabled — strategy-level routing gate (regression)', () => {
  it('routes every voter through executeModelWithReasoning, and injects thinking_budget on the native-thinking one, from reasoning_effort ALONE (no enable_reasoning)', async () => {
    const models = [nativeThinkingModel(), plainModel('gpt-plain'), plainModel('claude-plain')];
    const { strategy, executeModelCalls, executeModelWithReasoningCalls } = wireStrategy(models);

    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Explain the tradeoffs in depth.' }],
      reasoning_effort: 'high',
      // Deliberately NO ailin_constraints.enable_reasoning — this is the
      // exact caller shape the old boolean-only gate silently dropped.
    };

    await strategy.execute(request, makeContext(models));

    // All 3 voters went through the reasoning-aware path — none fell back
    // to plain executeModel just because enable_reasoning was never set.
    expect(executeModelCalls.length).toBe(0);
    expect(executeModelWithReasoningCalls.length).toBe(3);

    const nativeCall = executeModelWithReasoningCalls.find((r) => r.thinking_budget !== undefined);
    expect(nativeCall?.thinking_budget).toBe(EFFORT_THINKING_BUDGETS.high);
  });

  it('falls back to plain executeModel for every voter when the request carries no reasoning signal at all', async () => {
    // 3 models: ConsensusStrategy.execute hard-requires >=3 eligible models
    // (minModels=3) — a 2-model roster throws before any voter runs.
    const models = [nativeThinkingModel(), plainModel('gpt-plain'), plainModel('claude-plain')];
    const { strategy, executeModelCalls, executeModelWithReasoningCalls } = wireStrategy(models);

    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
    };

    await strategy.execute(request, makeContext(models));

    expect(executeModelWithReasoningCalls.length).toBe(0);
    expect(executeModelCalls.length).toBe(3);
  });

  it('still routes through executeModelWithReasoning for the legacy enable_reasoning-only boolean (backward compatible)', async () => {
    // 3 models: ConsensusStrategy.execute hard-requires >=3 eligible models
    // (minModels=3) — a 2-model roster throws before any voter runs.
    const models = [nativeThinkingModel(), plainModel('gpt-plain'), plainModel('claude-plain')];
    const { strategy, executeModelCalls, executeModelWithReasoningCalls } = wireStrategy(models);

    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Explain the tradeoffs in depth.' }],
      ailin_constraints: { enable_reasoning: true },
    };

    await strategy.execute(request, makeContext(models));

    expect(executeModelCalls.length).toBe(0);
    expect(executeModelWithReasoningCalls.length).toBe(3);
    const nativeCall = executeModelWithReasoningCalls.find((r) => r.thinking_budget !== undefined);
    expect(nativeCall?.thinking_budget).toBe(EFFORT_THINKING_BUDGETS.medium);
  });
});
