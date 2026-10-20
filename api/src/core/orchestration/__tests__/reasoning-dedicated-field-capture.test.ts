// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ci#750 — dedicated reasoning channel (owner decision 2026-10-04).
 *
 * With adapters no longer inlining reasoning into `content` via synthetic
 * `<think>` tags (the direct streaming/non-streaming leak), BaseStrategy's
 * `executeModelWithReasoning` must capture the model's chain of thought from
 * the DEDICATED `message.reasoning_content` field when present, thread it into
 * `execution.reasoning` (which feeds `reasoning_traces` to the
 * synthesizer/judge), and leave `content` untouched — it is already clean.
 * The legacy inline-tag path stays as a fallback for models/callers that
 * still emit `<reasoning>`/`<think>` tags in the content.
 *
 * `executeModel` is stubbed — no real providers/DB/network.
 */
import { describe, it, expect } from 'vitest';
import type { ChatRequest, Model, ModelExecution } from '@/types';
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

function wireStrategyReturning(responseMessage: Record<string, unknown>): ConsensusStrategy {
  const strategy = new ConsensusStrategy();
  const anyStrat = strategy as unknown as Record<string, unknown>;

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
    response: {
      id: 'resp-1',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model.id,
      choices: [
        {
          index: 0,
          message: responseMessage as ModelExecution['response']['choices'][number]['message'],
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
    },
    cost: 0,
    durationMs: 10,
    success: true,
  });

  return strategy;
}

async function run(strategy: ConsensusStrategy, request: ChatRequest): Promise<ModelExecution> {
  const anyStrat = strategy as unknown as {
    executeModelWithReasoning: (
      adapter: unknown,
      model: Model,
      request: ChatRequest,
      role?: string
    ) => Promise<ModelExecution>;
  };
  return anyStrat.executeModelWithReasoning({}, nativeThinkingModel(), request);
}

describe('BaseStrategy.executeModelWithReasoning — dedicated reasoning_content capture (ci#750)', () => {
  it('threads message.reasoning_content into execution.reasoning and leaves clean content untouched', async () => {
    const strategy = wireStrategyReturning({
      role: 'assistant',
      content: 'The answer is 391.',
      reasoning_content: 'step one, step two',
    });

    const execution = await run(strategy, baseRequest({ reasoning_effort: 'medium' }));

    expect(execution.reasoning).toBe('step one, step two');
    expect(execution.reasoningTokens).toBeGreaterThan(0);
    expect(execution.response.choices[0]?.message?.content).toBe('The answer is 391.');
  });

  it('still falls back to inline <think> tag extraction when no dedicated field is present', async () => {
    const strategy = wireStrategyReturning({
      role: 'assistant',
      content: '<think>legacy inline chain</think>The answer is 391.',
    });

    const execution = await run(strategy, baseRequest({ reasoning_effort: 'medium' }));

    expect(execution.reasoning).toBe('legacy inline chain');
    expect(execution.response.choices[0]?.message?.content).toBe('The answer is 391.');
  });

  it('sets no reasoning when the response has neither the dedicated field nor inline tags', async () => {
    const strategy = wireStrategyReturning({
      role: 'assistant',
      content: 'plain answer',
    });

    const execution = await run(strategy, baseRequest({ reasoning_effort: 'medium' }));

    expect(execution.reasoning).toBeUndefined();
    expect(execution.response.choices[0]?.message?.content).toBe('plain answer');
  });
});
