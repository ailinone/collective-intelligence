// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cost-accounting integrity invariant (TIER 0 — COST #3).
 *
 * Pins the invariant that makes the C3 cost thesis measurable:
 *
 *   For the consensus strategy,
 *     result.totalCost === sum(result.modelsUsed.map(e => e.cost))
 *
 * i.e. EVERY billable sub-call that contributes to the reported request cost
 * is ALSO a tracked ModelExecution in `modelsUsed`. Before the COST #2 fix the
 * consensus synthesizer/coordinator was a real paid LLM call whose cost was
 * dropped from `totalCost` and absent from `modelsUsed`, so the two diverged.
 *
 * The adapters are mocked so the voters and the synthesizer have KNOWN costs;
 * the test asserts the synthesizer cost is both (a) folded into totalCost and
 * (b) present as a coordinator ModelExecution, keeping the two sides equal.
 *
 * No real providers / DB / network — all side effects are injected.
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
import type { AggregatedResponse } from '@/core/aggregation/response-aggregator';

// ─── Mock the response aggregator so the synthesizer cost is deterministic ──
const SYNTHESIZER_COST = 0.0042;
const aggregateMock = vi.fn();
vi.mock('@/core/aggregation/response-aggregator', () => ({
  getResponseAggregator: () => ({ aggregate: aggregateMock }),
}));

// Imported AFTER the mock so the strategy picks up the mocked aggregator.
import { ConsensusStrategy } from '../strategies/consensus-strategy';

const EPSILON = 1e-9;

function makeChatResponse(content: string, model = 'mock-model'): ChatResponse {
  return {
    id: `resp-${Math.random().toString(36).slice(2, 9)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
  };
}

function makeModel(id: string, provider: string): Model {
  return {
    id,
    providerId: provider,
    provider,
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

function makeRequest(content = 'Decide between options A and B.'): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content }],
    temperature: 0.7,
    max_tokens: 1000,
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

const VOTER_COST = 0.001;

/** Wire a ConsensusStrategy with deterministic voter costs + a mocked aggregator. */
function wireStrategy(models: Model[]): ConsensusStrategy {
  const strategy = new ConsensusStrategy();
  const anyStrat = strategy as unknown as Record<string, unknown>;

  const silentLogger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    trace: () => {}, fatal: () => {}, child: () => silentLogger,
  };
  anyStrat.log = silentLogger;
  anyStrat.emitObserverEvent = () => {};
  anyStrat.isReasoningEnabled = () => false;
  anyStrat.selectPromptVariant = () => null;
  anyStrat.withReasoningPrompt = (prompt: string) => prompt;
  anyStrat.drainObserverChunks = async () => [];
  anyStrat.getEligibleModels = () => models;
  // Select all provided models as voters (skip diversity round-robin nuance).
  anyStrat.selectDiverseModels = async () => models;

  anyStrat.getAdapterForModel = async () => ({
    getName: () => 'mock-provider',
    chatCompletion: async () => makeChatResponse('voter content'),
    calculateCost: () => VOTER_COST,
  });

  // Each voter is a successful execution with a known cost.
  anyStrat.executeModel = async (
    _adapter: unknown,
    model: Model,
    request: ChatRequest,
    role: string,
  ): Promise<ModelExecution> => ({
    modelId: model.id,
    modelName: model.name,
    role: role as ModelExecution['role'],
    request,
    response: makeChatResponse(
      `${model.name} votes with a sufficiently long rationale to pass any filters.`,
      model.name,
    ),
    cost: VOTER_COST,
    durationMs: 100,
    success: true,
  });
  anyStrat.executeModelWithReasoning = anyStrat.executeModel;

  return strategy;
}

describe('Cost-accounting invariant (COST #3) — consensus', () => {
  beforeEach(() => {
    aggregateMock.mockReset();
  });

  it('totalCost equals sum(modelsUsed.cost) — synthesizer cost is tracked, not dropped', async () => {
    const models = [
      makeModel('voter-a', 'prov-a'),
      makeModel('voter-b', 'prov-b'),
      makeModel('voter-c', 'prov-c'),
    ];

    // Aggregator returns a synthesized response PLUS the billable coordinator
    // cost/usage/identity (the COST #2 fields on AggregatedResponse).
    const aggregated: AggregatedResponse = {
      response: makeChatResponse('Synthesized consensus answer integrating all voters.'),
      method: 'synthesis',
      confidence: 0.85,
      cost: SYNTHESIZER_COST,
      usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 },
      coordinator: { id: 'coordinator-x', name: 'Coordinator X' },
      metadata: { sourcesUsed: ['voter-a', 'voter-b', 'voter-c'], totalSources: 3, aggregationTime: 5 },
    };
    aggregateMock.mockResolvedValue(aggregated);

    const strategy = wireStrategy(models);
    const result = await strategy.execute(makeRequest(), makeContext(models));

    const summed = result.modelsUsed.reduce((s, e) => s + e.cost, 0);

    // Core invariant: every billable sub-call counted in totalCost is a tracked execution.
    expect(Math.abs(result.totalCost - summed)).toBeLessThan(EPSILON);

    // The synthesizer must be present as a coordinator ModelExecution with its cost.
    const synth = result.modelsUsed.find((e) => e.role === 'coordinator');
    expect(synth).toBeDefined();
    expect(synth?.cost).toBeCloseTo(SYNTHESIZER_COST, 9);
    expect(synth?.modelId).toBe('coordinator-x');

    // totalCost must include BOTH the voters and the synthesizer.
    expect(result.totalCost).toBeCloseTo(3 * VOTER_COST + SYNTHESIZER_COST, 9);

    // Regression guard: the old code summed only the voters (synthesizer dropped).
    expect(result.totalCost).toBeGreaterThan(3 * VOTER_COST);
  });

  it('invariant still holds when the synthesizer made no paid call (cost 0, no coordinator)', async () => {
    const models = [
      makeModel('voter-a', 'prov-a'),
      makeModel('voter-b', 'prov-b'),
      makeModel('voter-c', 'prov-c'),
    ];

    // Fallback synthesis: no coordinator LLM call → cost undefined / 0.
    const aggregated: AggregatedResponse = {
      response: makeChatResponse('Simple concatenation fallback synthesis.'),
      method: 'synthesis',
      confidence: 0.7,
      cost: 0,
      metadata: { sourcesUsed: ['voter-a', 'voter-b', 'voter-c'], totalSources: 3, aggregationTime: 1 },
    };
    aggregateMock.mockResolvedValue(aggregated);

    const strategy = wireStrategy(models);
    const result = await strategy.execute(makeRequest(), makeContext(models));

    const summed = result.modelsUsed.reduce((s, e) => s + e.cost, 0);
    expect(Math.abs(result.totalCost - summed)).toBeLessThan(EPSILON);
    // Only the three voters contribute; no zero-cost coordinator row is required.
    expect(result.totalCost).toBeCloseTo(3 * VOTER_COST, 9);
  });
});
