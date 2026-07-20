// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — Ailin¹ Collective Cost Guardrail (F0.4)
 *
 * Validates the pre-flight cost projection that prevents a coordination
 * round from overshooting the configured `maxCostUsd` budget.
 *
 * Approach:
 *   - Build minimal `Model` and `ChatRequest` fixtures with explicit
 *     cost-per-1k values so the math is testable without DB access.
 *   - Build a `CoordinationState` with controlled `totalCostUsd` and
 *     `limits.maxCostUsd` to drive the comparison.
 *   - Assert both per-model breakdown and the aggregate decision.
 */

import { describe, it, expect } from 'vitest';
import type { Model, ChatRequest } from '@/types';
import type { CoordinationState, CoordinationLimits } from '../coordination-types';
import { estimateRoundCost, wouldExceedCostLimit } from '../collective-cost-guardrail';

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'test-model',
    providerId: 'test-provider',
    provider: 'test-provider',
    name: 'test-model',
    displayName: 'Test Model',
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001, // $0.001 / 1k input tokens
    outputCostPer1k: 0.002, // $0.002 / 1k output tokens
    capabilities: ['chat'],
    performance: {
      latencyMs: 500,
      throughput: 50,
      quality: 0.85,
      reliability: 0.99,
    },
    status: 'active',
    ...overrides,
  };
}

function makeRequest(content: string, maxTokens?: number): ChatRequest {
  return {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content },
    ],
    max_tokens: maxTokens,
  };
}

function makeState(overrides: {
  totalCostUsd?: number;
  maxCostUsd?: number;
} = {}): CoordinationState {
  const limits: CoordinationLimits = {
    maxRounds: 3,
    minConvergenceScore: 0.82,
    maxDecisionFlipRate: 0.15,
    maxDissent: 0.35,
    stopOnCriticalRisk: true,
    minValidSignalsPerRound: 2,
    detectStagnation: true,
    maxCostUsd: overrides.maxCostUsd,
  };
  return {
    runId: 'run-test',
    strategy: 'sensitivity-consensus',
    round: 0,
    variables: {},
    convergence: {
      score: 0,
      decisionFlipRate: 1,
      dissent: 1,
      confidenceTrend: [],
      stableVariables: [],
      unstableVariables: [],
    },
    risks: [],
    history: [],
    limits,
    totalCostUsd: overrides.totalCostUsd ?? 0,
    totalLatencyMs: 0,
    totalTokens: 0,
  };
}

describe('estimateRoundCost', () => {
  it('returns zero cost when models list is empty', () => {
    const state = makeState({ maxCostUsd: 1.0 });
    const result = estimateRoundCost([], makeRequest('hello'), state);
    expect(result.estimatedRoundCostUsd).toBe(0);
    expect(result.perModel).toEqual([]);
    expect(result.exceedsLimit).toBe(false);
  });

  it('produces a per-model breakdown with stable order', () => {
    const models = [
      makeModel({ id: 'a', inputCostPer1k: 0.001, outputCostPer1k: 0.002 }),
      makeModel({ id: 'b', inputCostPer1k: 0.005, outputCostPer1k: 0.010 }),
    ];
    const result = estimateRoundCost(models, makeRequest('hi', 1000), makeState());
    expect(result.perModel).toHaveLength(2);
    expect(result.perModel[0].modelId).toBe('a');
    expect(result.perModel[1].modelId).toBe('b');
    // Model `b` is 5× more expensive — its estimated cost must reflect that.
    expect(result.perModel[1].estimatedCostUsd).toBeGreaterThan(
      result.perModel[0].estimatedCostUsd,
    );
  });

  it('counts already-spent cost in the projected total', () => {
    const models = [makeModel()];
    const state = makeState({ totalCostUsd: 0.40, maxCostUsd: 0.50 });
    const result = estimateRoundCost(models, makeRequest('x', 100), state);
    expect(result.alreadySpentUsd).toBe(0.40);
    expect(result.projectedTotalUsd).toBeCloseTo(0.40 + result.estimatedRoundCostUsd, 6);
  });

  it('flags exceedsLimit when projected × 1.10 > maxCostUsd', () => {
    // Model with high output cost, large max_tokens to push estimated cost up.
    const expensive = makeModel({ outputCostPer1k: 1.0 }); // $1 / 1k output tokens
    const state = makeState({ totalCostUsd: 0, maxCostUsd: 0.01 });
    const result = estimateRoundCost([expensive], makeRequest('hi', 1000), state);
    // 1000 output tokens × $1/1k = $1.00 — well over $0.01 budget.
    expect(result.estimatedRoundCostUsd).toBeGreaterThan(state.limits.maxCostUsd ?? 0);
    expect(result.exceedsLimit).toBe(true);
  });

  it('does NOT flag exceedsLimit when projected stays under the cap', () => {
    const cheap = makeModel({ inputCostPer1k: 0.0001, outputCostPer1k: 0.0002 });
    const state = makeState({ totalCostUsd: 0, maxCostUsd: 1.0 });
    const result = estimateRoundCost([cheap], makeRequest('hi', 100), state);
    expect(result.exceedsLimit).toBe(false);
  });

  it('treats undefined maxCostUsd as no cap', () => {
    const expensive = makeModel({ outputCostPer1k: 100 });
    const state = makeState({ totalCostUsd: 0 }); // maxCostUsd absent
    const result = estimateRoundCost([expensive], makeRequest('hi', 4096), state);
    expect(result.limitUsd).toBeUndefined();
    expect(result.exceedsLimit).toBe(false);
  });

  it('respects request.max_tokens when present', () => {
    const m = makeModel();
    const small = estimateRoundCost([m], makeRequest('x', 100), makeState());
    const large = estimateRoundCost([m], makeRequest('x', 2000), makeState());
    expect(large.estimatedRoundCostUsd).toBeGreaterThan(small.estimatedRoundCostUsd);
  });

  it('falls back to model.maxOutputTokens when request omits max_tokens', () => {
    const m = makeModel({ maxOutputTokens: 256 });
    const result = estimateRoundCost([m], makeRequest('x'), makeState());
    expect(result.perModel[0].estimatedOutputTokens).toBeLessThanOrEqual(256);
  });

  it('handles models with missing cost fields gracefully (treats as free)', () => {
    // Self-hosted models legitimately have 0 cost — guard must not crash.
    const free = makeModel({ inputCostPer1k: 0, outputCostPer1k: 0 });
    const result = estimateRoundCost([free], makeRequest('x', 1000), makeState({ maxCostUsd: 0.001 }));
    expect(result.estimatedRoundCostUsd).toBe(0);
    expect(result.exceedsLimit).toBe(false);
  });

  it('correctly accumulates input tokens across all messages', () => {
    const m = makeModel();
    const longRequest: ChatRequest = {
      model: 'test-model',
      messages: [
        { role: 'system', content: 'a'.repeat(1000) },
        { role: 'user', content: 'b'.repeat(2000) },
      ],
      max_tokens: 100,
    };
    const result = estimateRoundCost([m], longRequest, makeState());
    // 3000 chars / 4 chars-per-token = 750 input tokens (+ 32 overhead)
    expect(result.perModel[0].estimatedInputTokens).toBeGreaterThanOrEqual(750);
    expect(result.perModel[0].estimatedInputTokens).toBeLessThanOrEqual(800);
  });

  it('handles array message content (multimodal text parts)', () => {
    const m = makeModel();
    const request: ChatRequest = {
      model: 'test-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first part' },
            { type: 'text', text: 'second part' },
          ],
        },
      ],
      max_tokens: 100,
    };
    const result = estimateRoundCost([m], request, makeState());
    expect(result.perModel[0].estimatedInputTokens).toBeGreaterThan(0);
  });
});

describe('wouldExceedCostLimit', () => {
  it('returns the same boolean as estimateRoundCost(...).exceedsLimit', () => {
    const expensive = makeModel({ outputCostPer1k: 1.0 });
    const state = makeState({ maxCostUsd: 0.001 });
    expect(wouldExceedCostLimit([expensive], makeRequest('x', 1000), state)).toBe(true);
  });

  it('returns false when no limit is set', () => {
    const m = makeModel({ outputCostPer1k: 1000 });
    expect(wouldExceedCostLimit([m], makeRequest('x', 4096), makeState())).toBe(false);
  });
});
