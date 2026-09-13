// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Proves the real hook wiring (2026-09-07 bucket-fair selection fix, design
 * §2b): a genuinely successful model execution through
 * BaseStrategy.executeModel() increments the real UsageCountTracker singleton
 * — the exact signal `dynamic-model-selector.ts` now sorts candidate
 * retrieval by. Drives the REAL executeModel (same pattern as the sibling
 * bound-model-execution-abort.test.ts), not a reimplementation of the hook.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { BaseStrategy, type StrategyMetadata } from '@/core/orchestration/base-strategy';
import { ProviderAdapter, type ProviderConfig } from '@/providers/base/provider-adapter';
import { __resetUsageCountTrackerForTests } from '@/core/selection/usage-count-tracker';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingResponse,
  Model,
  ModelRole,
  OrchestrationResult,
  Provider,
} from '@/types';
import type {
  ImageEditResponse,
  ImageVariationResponse,
  ModerationResponse,
} from '@/types/model-client';
import type { HealthCheckResult } from '@/providers/base/provider-adapter';

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'usage-hook-model',
    providerId: 'usage-hook-provider',
    provider: 'usage-hook-provider',
    name: 'usage-hook-model',
    displayName: 'Usage Hook Model',
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: ['chat'],
    performance: { latencyMs: 500, throughput: 50, quality: 0.8, reliability: 0.95 },
    status: 'active',
    ...overrides,
  };
}

function makeRequest(): ChatRequest {
  return {
    model: 'usage-hook-model',
    messages: [{ role: 'user', content: 'ping' }],
  } as ChatRequest;
}

/** Adapter that succeeds immediately with a real, usable assistant message. */
class SucceedingAdapter extends ProviderAdapter {
  constructor(name = 'usage-hook-provider') {
    super(name, 'Usage Hook Test', { apiKey: 'unused' } as ProviderConfig);
  }
  async getProvider(): Promise<Provider> {
    throw new Error('not used');
  }
  async getModels(): Promise<Model[]> {
    return [];
  }
  async chatCompletion(): Promise<ChatResponse> {
    return {
      id: 'chatcmpl-usage-hook',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'usage-hook-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'pong' },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    } as ChatResponse;
  }
  async *chatCompletionStream(): AsyncGenerator<ChatResponse, void, unknown> {
    throw new Error('not used');
  }
  async generateEmbeddings(): Promise<EmbeddingResponse> {
    throw new Error('not used');
  }
  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, checkedAt: new Date() };
  }
  calculateCost(): number {
    return 0.001;
  }
  normalizeModelName(modelName: string): string {
    return modelName;
  }
  async imageEdit(): Promise<ImageEditResponse> {
    throw new Error('not used');
  }
  async imageVariation(): Promise<ImageVariationResponse> {
    throw new Error('not used');
  }
  async moderate(): Promise<ModerationResponse> {
    throw new Error('not used');
  }
}

class TestStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'usage-hook-test-strategy',
      name: 'single',
      displayName: 'Test',
      description: 'test-only strategy for the usage-count-tracker hook',
      minModels: 1,
      maxModels: 1,
      estimatedCostMultiplier: 1,
      estimatedQualityBoost: 0,
      estimatedDurationMultiplier: 1,
      suitableFor: [],
    };
  }
  async execute(): Promise<OrchestrationResult> {
    throw new Error('not used');
  }

  public callExecuteModel(
    adapter: ProviderAdapter,
    model: Model,
    request: ChatRequest,
    role: ModelRole = 'primary'
  ) {
    return this.executeModel(adapter, model, request, role);
  }
}

describe('usage-count-tracker hook — real success path', () => {
  afterEach(() => {
    __resetUsageCountTrackerForTests();
  });

  it('a genuinely successful executeModel() increments the real usage-count buffer for (model.id, model.providerId)', async () => {
    const tracker = __resetUsageCountTrackerForTests();
    const strategy = new TestStrategy();
    const adapter = new SucceedingAdapter();
    const model = makeModel();

    expect(tracker.__getBufferedCountForTests(model.id, model.providerId)).toBe(0);

    const execution = await strategy.callExecuteModel(adapter, model, makeRequest());

    expect(execution.success).toBe(true);
    expect(tracker.__getBufferedCountForTests(model.id, model.providerId)).toBe(1);
  });

  it('two successful executions accumulate to 2 before any flush', async () => {
    const tracker = __resetUsageCountTrackerForTests();
    const strategy = new TestStrategy();
    const adapter = new SucceedingAdapter();
    const model = makeModel({ id: 'usage-hook-model-2', providerId: 'usage-hook-provider-2' });

    await strategy.callExecuteModel(adapter, model, makeRequest());
    await strategy.callExecuteModel(adapter, model, makeRequest());

    expect(tracker.__getBufferedCountForTests(model.id, model.providerId)).toBe(2);
  });

  it('does NOT increment on a failed execution (adapter throws)', async () => {
    const tracker = __resetUsageCountTrackerForTests();
    class FailingAdapter extends SucceedingAdapter {
      async chatCompletion(): Promise<ChatResponse> {
        throw new Error('simulated provider failure');
      }
    }
    const strategy = new TestStrategy();
    const adapter = new FailingAdapter('usage-hook-failing-provider');
    const model = makeModel({ id: 'usage-hook-fail-model', providerId: 'usage-hook-failing-provider' });

    const execution = await strategy.callExecuteModel(adapter, model, makeRequest());

    expect(execution.success).toBe(false);
    expect(tracker.__getBufferedCountForTests(model.id, model.providerId)).toBe(0);
  });
});
