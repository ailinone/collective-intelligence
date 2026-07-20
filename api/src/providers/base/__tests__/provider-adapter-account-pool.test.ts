// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic unit tests for the account-pool mechanism on the base
 * ProviderAdapter (scale-to-100k Phase 2) — getAllApiKeys()/nextPoolIndex(),
 * and the OpenAI adapter's reference use of them (clientPool rotation).
 *
 * No network calls: constructing an OpenAI SDK client does not make a
 * request, and the base-class rotation logic is pure/stateless-except-a-
 * counter, so none of this needs a live API key or Redis.
 */

import { describe, it, expect } from 'vitest';
import { ProviderAdapter, type ProviderConfig } from '@/providers/base/provider-adapter';
import { OpenAIAdapter } from '@/providers/openai/openai-adapter';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  Provider,
} from '@/types';
import type {
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
} from '@/types/model-client';
import type { HealthCheckResult } from '@/providers/base/provider-adapter';

// Minimal concrete adapter — exercises only the base class's pool
// mechanism, not any provider-specific request logic.
class FakeAdapter extends ProviderAdapter {
  constructor(config: ProviderConfig) {
    super('fake-provider', 'Fake Provider', config);
  }
  async getProvider(): Promise<Provider> { throw new Error('not used in this test'); }
  async getModels(): Promise<Model[]> { return []; }
  async chatCompletion(): Promise<ChatResponse> { throw new Error('not used in this test'); }
  async *chatCompletionStream(): AsyncGenerator<ChatResponse, void, unknown> { throw new Error('not used in this test'); }
  async generateEmbeddings(): Promise<EmbeddingResponse> { throw new Error('not used in this test'); }
  async healthCheck(): Promise<HealthCheckResult> { return { healthy: true, checkedAt: new Date() }; }
  calculateCost(): number { return 0; }
  normalizeModelName(modelName: string): string { return modelName; }
  async imageEdit(): Promise<ImageEditResponse> { throw new Error('not used in this test'); }
  async imageVariation(): Promise<ImageVariationResponse> { throw new Error('not used in this test'); }
  async moderate(): Promise<ModerationResponse> { throw new Error('not used in this test'); }

  // Expose the protected mechanism for direct testing.
  public exposeGetAllApiKeys(): string[] {
    return this.getAllApiKeys();
  }
  public exposeNextPoolIndex(poolSize: number): number {
    return this.nextPoolIndex(poolSize);
  }
}

describe('ProviderAdapter account pool mechanism', () => {
  it('getAllApiKeys returns just the primary key when no pool is configured', () => {
    const adapter = new FakeAdapter({ apiKey: 'sk-only' });
    expect(adapter.exposeGetAllApiKeys()).toEqual(['sk-only']);
  });

  it('getAllApiKeys merges apiKey + apiKeyPool, deduplicated', () => {
    const adapter = new FakeAdapter({
      apiKey: 'sk-primary',
      apiKeyPool: ['sk-primary', 'sk-second', 'sk-third', 'sk-second'],
    });
    expect(adapter.exposeGetAllApiKeys()).toEqual(['sk-primary', 'sk-second', 'sk-third']);
  });

  it('getAllApiKeys drops empty/missing keys from the pool', () => {
    const adapter = new FakeAdapter({
      apiKey: 'sk-primary',
      apiKeyPool: ['', 'sk-second'],
    });
    expect(adapter.exposeGetAllApiKeys()).toEqual(['sk-primary', 'sk-second']);
  });

  it('nextPoolIndex round-robins across the pool size', () => {
    const adapter = new FakeAdapter({ apiKey: 'sk-only' });
    const seen = Array.from({ length: 7 }, () => adapter.exposeNextPoolIndex(3));
    expect(seen).toEqual([0, 1, 2, 0, 1, 2, 0]);
  });
});

describe('OpenAIAdapter account pool (reference implementation)', () => {
  it('builds one SDK client per unique pooled key', () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'sk-primary',
      apiKeyPool: ['sk-primary', 'sk-second', 'sk-third'],
      maxRetries: 0,
    });
    const clientPool = (adapter as unknown as { clientPool: unknown[] }).clientPool;
    expect(clientPool).toHaveLength(3);
    // Distinct client instances — not the same object rebound 3 times.
    expect(new Set(clientPool).size).toBe(3);
  });

  it('builds a single-client pool (no rotation) when no apiKeyPool is configured', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-only', maxRetries: 0 });
    const clientPool = (adapter as unknown as { clientPool: unknown[] }).clientPool;
    expect(clientPool).toHaveLength(1);
  });

  it('getRequestClient round-robins across the pool', () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'sk-primary',
      apiKeyPool: ['sk-primary', 'sk-second', 'sk-third'],
      maxRetries: 0,
    });
    const getRequestClient = (adapter as unknown as { getRequestClient: () => unknown }).getRequestClient.bind(
      adapter
    );
    const sequence = Array.from({ length: 6 }, () => getRequestClient());
    // Cycles with period 3: [A, B, C, A, B, C]
    expect(sequence[0]).toBe(sequence[3]);
    expect(sequence[1]).toBe(sequence[4]);
    expect(sequence[2]).toBe(sequence[5]);
    expect(sequence[0]).not.toBe(sequence[1]);
    expect(sequence[1]).not.toBe(sequence[2]);
  });

  it('getRequestClient always returns the same single client when no pool is configured', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-only', maxRetries: 0 });
    const getRequestClient = (adapter as unknown as { getRequestClient: () => unknown }).getRequestClient.bind(
      adapter
    );
    const a = getRequestClient();
    const b = getRequestClient();
    expect(a).toBe(b);
  });
});

describe('OpenAIAdapter estimateTokenCost (TPM budget feed, issue #152)', () => {
  function estimate(adapter: OpenAIAdapter, request: unknown): number {
    return (adapter as unknown as { estimateTokenCost: (r: unknown) => number }).estimateTokenCost(request);
  }

  it('estimates prompt tokens (~4 chars/token) plus requested max_tokens', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-only', maxRetries: 0 });
    const request = { messages: [{ role: 'user', content: 'a'.repeat(400) }], max_tokens: 500 };
    // 400 chars / 4 = 100 prompt tokens + 500 max_tokens = 600
    expect(estimate(adapter, request)).toBe(600);
  });

  it('sums content length across all messages', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-only', maxRetries: 0 });
    const request = {
      messages: [
        { role: 'system', content: 'a'.repeat(40) },
        { role: 'user', content: 'b'.repeat(60) },
      ],
      max_tokens: 100,
    };
    // (40+60)/4 = 25 prompt tokens + 100 = 125
    expect(estimate(adapter, request)).toBe(125);
  });

  it('defaults completion tokens to 1000 when max_tokens is omitted', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-only', maxRetries: 0 });
    const request = { messages: [{ role: 'user', content: 'hi' }] };
    expect(estimate(adapter, request)).toBe(1 + 1000); // ceil(2/4)=1 prompt token + 1000 default
  });
});
