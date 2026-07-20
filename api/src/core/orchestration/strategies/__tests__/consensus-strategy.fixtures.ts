// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared test fixtures for ConsensusStrategy validation.
 *
 * Strategy-by-Strategy Validation 01 (2026-05-12, refactored)
 *
 * Tests in this suite must NOT call real providers, the DB, or any
 * network. All side effects are routed through the helpers below.
 *
 * Quality evaluation in tests uses `MockStrategyOutputEvaluator` —
 * deterministic, explicit, scoringMode='mock'. Tests that need to
 * exercise the production default leave the evaluator unset and assert
 * on `scoringMode='unavailable'` + `validationStatus='unavailable'`.
 */
import { vi } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelExecution,
  OrchestrationContext,
  TaskType,
} from '@/types';
import { ConsensusStrategy } from '../consensus-strategy';
import type { StrategyOutputEvaluator } from '../evaluation/strategy-output-evaluator';
import {
  MockStrategyOutputEvaluator,
  type MockEvaluatorOptions,
} from '../evaluation/mock-evaluator';
import { defaultAggOverride } from './consensus-module-mocks';

export function setAggregatorOverride(opts: {
  content?: string;
  confidence?: number;
  threwError?: boolean;
}): void {
  if (!globalThis.__consensusAggOverride) {
    globalThis.__consensusAggOverride = defaultAggOverride();
  }
  if (opts.content !== undefined) globalThis.__consensusAggOverride.content = opts.content;
  if (opts.confidence !== undefined) globalThis.__consensusAggOverride.confidence = opts.confidence;
  if (opts.threwError !== undefined) globalThis.__consensusAggOverride.threwError = opts.threwError;
}

export function resetAggregatorOverride(): void {
  globalThis.__consensusAggOverride = defaultAggOverride();
}

export function makeChatResponse(content: string, model = 'mock-model'): ChatResponse {
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

export function makeModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    id: overrides.id,
    providerId: overrides.providerId ?? `provider-${overrides.id}`,
    provider: overrides.provider ?? `provider-${overrides.id}`,
    name: overrides.name ?? overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    contextWindow: overrides.contextWindow ?? 128000,
    maxOutputTokens: overrides.maxOutputTokens ?? 4096,
    inputCostPer1k: overrides.inputCostPer1k ?? 0.001,
    outputCostPer1k: overrides.outputCostPer1k ?? 0.002,
    capabilities: overrides.capabilities ?? ['chat', 'text_generation'],
    capabilityUris: overrides.capabilityUris,
    capabilityConfidence: overrides.capabilityConfidence,
    performance:
      overrides.performance ?? {
        latencyMs: 1000,
        throughput: 100,
        quality: 0.9,
        reliability: 0.95,
      },
    status: overrides.status ?? 'active',
    balanceStatus: overrides.balanceStatus ?? 'has-credits',
    inventoryRole: overrides.inventoryRole,
    metadata: overrides.metadata,
    tags: overrides.tags,
    specializations: overrides.specializations,
  };
}

export function makeRequest(content = 'Test prompt for consensus'): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content }],
    temperature: 0.7,
    max_tokens: 1000,
  };
}

export function makeContext(
  models: Model[],
  overrides: Partial<OrchestrationContext> = {},
): OrchestrationContext {
  return {
    organizationId: 'org-test',
    userId: 'user-test',
    requestId: `req-${Math.random().toString(36).slice(2, 9)}`,
    models,
    taskType: ('analysis' as TaskType),
    contextSize: 1000,
    qualityTarget: 0.7,
    preferSpeed: false,
    ...overrides,
  };
}

export interface PresetResponse {
  content: string;
  success?: boolean;
  cost?: number;
  durationMs?: number;
  error?: string;
}

/**
 * Build a deterministic MockEvaluator from a per-modelId score map.
 * Synthesis score keyed on `synthesis`. Default fallback when no entry.
 */
export function makeMockEvaluator(opts: MockEvaluatorOptions): StrategyOutputEvaluator {
  return new MockStrategyOutputEvaluator(opts);
}

/**
 * Wire a ConsensusStrategy with mocked dependencies.
 * - `evaluator` defaults to a permissive MockEvaluator (fallback=0.5)
 *   when not provided. Pass `null` to leave the evaluator unset (so
 *   the strategy uses its production `UnavailableEvaluator` default).
 */
export function wireStrategy(opts: {
  responses: Record<string, PresetResponse>;
  evaluator?: StrategyOutputEvaluator | null;
  eligibleModels?: Model[];
}): {
  strategy: ConsensusStrategy;
  executeModelSpy: ReturnType<typeof vi.fn>;
  getAdapterSpy: ReturnType<typeof vi.fn>;
  emitObserverSpy: ReturnType<typeof vi.fn>;
} {
  const strategy = new ConsensusStrategy();
  type LooseStrategy = Record<string, unknown>;
  const anyStrat = strategy as unknown as LooseStrategy;

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

  const emitObserverSpy = vi.fn();
  anyStrat.emitObserverEvent = emitObserverSpy;
  anyStrat.isReasoningEnabled = () => false;
  anyStrat.selectPromptVariant = () => null;
  anyStrat.withReasoningPrompt = (prompt: string) => prompt;
  anyStrat.drainObserverChunks = async () => [];

  if (opts.eligibleModels) {
    anyStrat.getEligibleModels = (_ctx: unknown) => opts.eligibleModels;
  }

  const getAdapterSpy = vi.fn(async (_model: Model, _ctx: unknown) => ({
    getName: () => 'mock-provider',
    chatCompletion: async () => makeChatResponse('not-called-directly'),
    calculateCost: () => 0,
  }));
  anyStrat.getAdapterForModel = getAdapterSpy;

  const executeModelSpy = vi.fn(
    async (
      _adapter: unknown,
      model: Model,
      request: ChatRequest,
      role: string,
    ): Promise<ModelExecution> => {
      const preset = opts.responses[model.id];
      const success = preset?.success ?? true;
      const content = preset?.content ?? '';
      return {
        modelId: model.id,
        modelName: model.name,
        role: role as ModelExecution['role'],
        request,
        response: makeChatResponse(content, model.name),
        cost: preset?.cost ?? 0.001,
        durationMs: preset?.durationMs ?? 100,
        success,
        error: success ? undefined : (preset?.error ?? 'execution_failed'),
      };
    },
  );
  anyStrat.executeModel = executeModelSpy;
  anyStrat.executeModelWithReasoning = executeModelSpy;

  // Evaluator selection:
  //  - undefined (default) → permissive MockEvaluator (fallback 0.5)
  //  - explicit instance → use it
  //  - null → leave unset so strategy picks UnavailableEvaluator
  if (opts.evaluator === undefined) {
    strategy.setEvaluatorForTesting(
      new MockStrategyOutputEvaluator({ fallback: 0.5, synthesis: 0.7 }),
    );
  } else if (opts.evaluator !== null) {
    strategy.setEvaluatorForTesting(opts.evaluator);
  }

  // vi.fn() narrows its type to the specific signature of the impl. The
  // declared return shape uses ReturnType<typeof vi.fn> which is the
  // base Mock<any[], unknown>; cast the narrow types to that base.
  return {
    strategy,
    executeModelSpy: executeModelSpy as unknown as ReturnType<typeof vi.fn>,
    getAdapterSpy: getAdapterSpy as unknown as ReturnType<typeof vi.fn>,
    emitObserverSpy,
  };
}

export function threeHealthyModels(): Model[] {
  return [
    makeModel({ id: 'voter-a', provider: 'prov-a', name: 'Voter A' }),
    makeModel({ id: 'voter-b', provider: 'prov-b', name: 'Voter B' }),
    makeModel({ id: 'voter-c', provider: 'prov-c', name: 'Voter C' }),
  ];
}

export function healthyResponses(): Record<string, PresetResponse> {
  return {
    'voter-a': {
      content:
        'Voter A says the answer is X because of reason R1 and supporting evidence E1 which makes this response long enough to pass outlier filters.',
    },
    'voter-b': {
      content:
        'Voter B disagrees and suggests Y instead, citing reason R2 plus benchmark B2 — once again easily above the fifty-character threshold.',
    },
    'voter-c': {
      content:
        'Voter C proposes a middle ground Z that integrates both X and Y with caveat C1; this third perspective is also amply long for scoring.',
    },
  };
}
