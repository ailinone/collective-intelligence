// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LOTE AZ (2026-09) — regression coverage for base-strategy.ts's
 * `executeModelWithReasoning` native-thinking budget, which used to be a
 * single hardcoded `request.thinking_budget || 2000` for every caller
 * regardless of effort. It now scales via `resolveReasoningEffort()`
 * (see @/utils/reasoning-effort for the documented per-tier rationale).
 *
 * `executeModel` is stubbed to just capture the request it was actually
 * handed — the point of this test is what `thinking_budget` value reaches
 * the execution layer, not the execution itself. No real providers/DB/network.
 */
import { describe, it, expect } from 'vitest';
import type { ChatRequest, Model, ModelExecution } from '@/types';
import { EFFORT_THINKING_BUDGETS } from '@/utils/reasoning-effort';
import { ConsensusStrategy } from '../strategies/consensus-strategy';

function nativeThinkingModel(): Model {
  return {
    id: 'deepseek-r1',
    providerId: 'mock',
    provider: 'mock',
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

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

/** Wire a minimal concrete BaseStrategy subclass, capturing the request
 *  `executeModel` actually received. */
function wireStrategyCapturingRequest(): {
  strategy: ConsensusStrategy;
  getCapturedRequest: () => ChatRequest | undefined;
} {
  const strategy = new ConsensusStrategy();
  const anyStrat = strategy as unknown as Record<string, unknown>;
  let captured: ChatRequest | undefined;

  anyStrat.executeModel = async (
    _adapter: unknown,
    model: Model,
    request: ChatRequest,
    role: string
  ): Promise<ModelExecution> => {
    captured = request;
    return {
      modelId: model.id,
      modelName: model.name,
      role: role as ModelExecution['role'],
      request,
      response: {
        id: 'resp-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model.id,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', logprobs: null },
        ],
      },
      cost: 0,
      durationMs: 10,
      success: true,
    };
  };

  return { strategy, getCapturedRequest: () => captured };
}

describe('BaseStrategy.executeModelWithReasoning — native-thinking budget scaling (LOTE AZ)', () => {
  it('scales to EFFORT_THINKING_BUDGETS.low for reasoning_effort=low', async () => {
    const { strategy, getCapturedRequest } = wireStrategyCapturingRequest();
    const anyStrat = strategy as unknown as {
      executeModelWithReasoning: (
        adapter: unknown,
        model: Model,
        request: ChatRequest,
        role?: string
      ) => Promise<ModelExecution>;
    };
    await anyStrat.executeModelWithReasoning({}, nativeThinkingModel(), baseRequest({ reasoning_effort: 'low' }));
    expect(getCapturedRequest()?.thinking_budget).toBe(EFFORT_THINKING_BUDGETS.low);
  });

  it('scales to EFFORT_THINKING_BUDGETS.high for reasoning_effort=high', async () => {
    const { strategy, getCapturedRequest } = wireStrategyCapturingRequest();
    const anyStrat = strategy as unknown as {
      executeModelWithReasoning: (
        adapter: unknown,
        model: Model,
        request: ChatRequest,
        role?: string
      ) => Promise<ModelExecution>;
    };
    await anyStrat.executeModelWithReasoning({}, nativeThinkingModel(), baseRequest({ reasoning_effort: 'high' }));
    expect(getCapturedRequest()?.thinking_budget).toBe(EFFORT_THINKING_BUDGETS.high);
  });

  it('defaults to EFFORT_THINKING_BUDGETS.medium (4096) — no more hardcoded 2000 — when only enable_reasoning is set', async () => {
    const { strategy, getCapturedRequest } = wireStrategyCapturingRequest();
    const anyStrat = strategy as unknown as {
      executeModelWithReasoning: (
        adapter: unknown,
        model: Model,
        request: ChatRequest,
        role?: string
      ) => Promise<ModelExecution>;
    };
    await anyStrat.executeModelWithReasoning(
      {},
      nativeThinkingModel(),
      baseRequest({ ailin_constraints: { enable_reasoning: true } })
    );
    expect(getCapturedRequest()?.thinking_budget).toBe(4096);
    expect(getCapturedRequest()?.thinking_budget).not.toBe(2000);
  });

  it('an explicit numeric thinking_budget still wins verbatim over reasoning_effort', async () => {
    const { strategy, getCapturedRequest } = wireStrategyCapturingRequest();
    const anyStrat = strategy as unknown as {
      executeModelWithReasoning: (
        adapter: unknown,
        model: Model,
        request: ChatRequest,
        role?: string
      ) => Promise<ModelExecution>;
    };
    await anyStrat.executeModelWithReasoning(
      {},
      nativeThinkingModel(),
      baseRequest({ reasoning_effort: 'low', thinking_budget: 12345 })
    );
    expect(getCapturedRequest()?.thinking_budget).toBe(12345);
  });

  it('with zero reasoning signal at all, falls back to the medium tier (not the old bare 2000)', async () => {
    const { strategy, getCapturedRequest } = wireStrategyCapturingRequest();
    const anyStrat = strategy as unknown as {
      executeModelWithReasoning: (
        adapter: unknown,
        model: Model,
        request: ChatRequest,
        role?: string
      ) => Promise<ModelExecution>;
    };
    await anyStrat.executeModelWithReasoning({}, nativeThinkingModel(), baseRequest());
    expect(getCapturedRequest()?.thinking_budget).toBe(EFFORT_THINKING_BUDGETS.medium);
  });
});
