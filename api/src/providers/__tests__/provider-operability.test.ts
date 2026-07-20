// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import type { Model } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { resolveModelOperability, isAdapterMethodImplemented, isAdapterMethodOverridden } from '@/providers/provider-operability';
import { ProviderAdapter as BaseProviderAdapter } from '@/providers/base/provider-adapter';
import { OpenRouterAdapter } from '@/providers/openrouter/openrouter-adapter';
import type { ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse, Provider } from '@/types';
import type {
  HealthCheckResult,
} from '@/providers/base/provider-adapter';
import type {
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
} from '@/types/model-client';

function buildModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'provider-a/model-alpha',
    providerId: 'openrouter',
    provider: 'openrouter',
    name: 'provider-a/model-alpha',
    displayName: 'Model Alpha via Router',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
    capabilities: ['chat', 'reasoning'],
    performance: {
      latencyMs: 800,
      throughput: 60,
      quality: 0.9,
      reliability: 0.95,
    },
    status: 'active',
    ...overrides,
  };
}

describe('provider-operability', () => {
  it('falls back from execution provider alias to original provider when adapter exists', () => {
    const model = buildModel({
      metadata: {
        executionProvider: 'open-router',
        originalProvider: 'open-ai',
      },
    });

    const lookup = (name: string): ProviderAdapter | undefined =>
      name === 'openai' ? ({} as ProviderAdapter) : undefined;

    const result = resolveModelOperability(model, lookup);

    expect(result.runnable).toBe(true);
    expect(result.executionProvider).toBe('openrouter');
    expect(result.originProvider).toBe('openai');
    expect(result.resolvedProvider).toBe('openai');
    expect(result.fallbackChain).toEqual(['openrouter', 'openai']);
  });

  it('accepts explicit adapter candidates from metadata with provider alias normalization', () => {
    const model = buildModel({
      provider: 'unknown-provider',
      metadata: {
        executionProvider: 'unknown-provider',
        originalProvider: 'unknown-provider',
        adapterCandidates: ['vertexai', 'google-ai-studio'],
      },
    });

    const lookup = (name: string): ProviderAdapter | undefined =>
      name === 'vertex-ai' ? ({} as ProviderAdapter) : undefined;

    const result = resolveModelOperability(model, lookup);

    expect(result.runnable).toBe(true);
    expect(result.resolvedProvider).toBe('vertex-ai');
    expect(result.fallbackChain).toEqual([
      'unknown-provider',
      'vertex-ai',
      'google',
      'openrouter',
    ]);
  });

  it('returns non-operational when no candidate provider has an adapter', () => {
    const model = buildModel({
      provider: 'unknown-provider',
      metadata: {
        executionProvider: 'unknown-provider',
      },
    });

    const result = resolveModelOperability(model, () => undefined);

    expect(result.runnable).toBe(false);
    expect(result.resolvedProvider).toBeNull();
    expect(result.nonOperationalReasons).toContain('no_registered_execution_provider');
  });

  // Phase 6 root-cause fix invariant (2026-04-30): the strict semantics of
  // ModelOperability are that `nonOperationalReasons` contains ONLY blocking
  // reasons. Informational trace ("origin_provider_unknown",
  // "provider_not_registered:X" attempts that came before a successful
  // resolution) belongs in `warnings`. The two buckets must never overlap,
  // and `runnable === true ⇒ nonOperationalReasons.length === 0` is invariant.
  it('runnable models have an empty nonOperationalReasons array (strict-blocker invariant)', () => {
    const model = buildModel({
      providerId: 'openrouter',
      provider: 'openai',
      metadata: {},
    });

    const lookup = (name: string): ProviderAdapter | undefined =>
      name === 'openrouter' ? ({} as ProviderAdapter) : undefined;

    const result = resolveModelOperability(model, lookup);

    expect(result.runnable).toBe(true);
    expect(result.nonOperationalReasons).toEqual([]);
  });

  it('routes informational diagnostics to warnings, never to nonOperationalReasons, when a fallback resolves', () => {
    // executionProvider has no adapter, but the fallback chain resolves
    // via originProvider → openai. The failed-attempt trace
    // ("provider_not_registered:openrouter") is informational — NOT a blocker.
    const model = buildModel({
      providerId: 'openrouter',
      provider: 'openai',
      metadata: {
        executionProvider: 'openrouter',
        originalProvider: 'openai',
      },
    });

    const lookup = (name: string): ProviderAdapter | undefined =>
      name === 'openai' ? ({} as ProviderAdapter) : undefined;

    const result = resolveModelOperability(model, lookup);

    expect(result.runnable).toBe(true);
    expect(result.resolvedProvider).toBe('openai');
    expect(result.nonOperationalReasons).toEqual([]);
    expect(result.warnings).toContain('provider_not_registered:openrouter');
  });

  it('promotes failed-attempt trace to nonOperationalReasons only when no provider resolves', () => {
    const model = buildModel({
      providerId: 'unknown-a',
      provider: 'unknown-b',
      metadata: {
        executionProvider: 'unknown-c',
      },
    });

    const result = resolveModelOperability(model, () => undefined);

    expect(result.runnable).toBe(false);
    expect(result.nonOperationalReasons).toEqual(
      expect.arrayContaining([
        'provider_not_registered:unknown-c',
        'provider_not_registered:unknown-a',
        'provider_not_registered:unknown-b',
        'no_registered_execution_provider',
      ])
    );
    // When the walk fails, nothing is informational — every trace is a blocker.
    expect(result.warnings).toEqual([]);
  });

  it('reports unknown origin/execution providers as warnings, not as blockers, when chain resolves', () => {
    // Model has no provider info at all. Defaults push originProvider /
    // executionProvider to the literal string "unknown". Adapter lookup
    // for "unknown" hits a registered shim.
    const model = buildModel({
      providerId: undefined,
      provider: undefined as unknown as string,
      metadata: {},
    });

    const lookup = (name: string): ProviderAdapter | undefined =>
      name === 'unknown' ? ({} as ProviderAdapter) : undefined;

    const result = resolveModelOperability(model, lookup);

    expect(result.runnable).toBe(true);
    expect(result.nonOperationalReasons).toEqual([]);
    // Both unknown-origin and unknown-execution warnings should be informational.
    expect(result.warnings).toEqual(
      expect.arrayContaining(['origin_provider_unknown', 'execution_provider_unknown'])
    );
  });

  it('normalizes cloud-hub aliases with dotted provider names', () => {
    const model = buildModel({
      provider: 'unknown-provider',
      metadata: {
        executionProvider: 'orq.ai',
        adapterCandidates: ['eden.ai', 'helicone.ai'],
      },
    });

    const lookup = (name: string): ProviderAdapter | undefined =>
      name === 'edenai' ? ({} as ProviderAdapter) : undefined;

    const result = resolveModelOperability(model, lookup);

    expect(result.executionProvider).toBe('orqai');
    expect(result.fallbackChain).toEqual([
      'orqai',
      'edenai',
      'heliconeai',
      'openrouter',
      'unknown-provider',
    ]);
    expect(result.resolvedProvider).toBe('edenai');
    expect(result.runnable).toBe(true);
  });

  it('prefers providerId as execution provider when metadata is absent', () => {
    const model = buildModel({
      providerId: 'openrouter',
      provider: 'openai',
      metadata: {},
    });

    const lookup = (name: string): ProviderAdapter | undefined =>
      name === 'openrouter' ? ({} as ProviderAdapter) : undefined;

    const result = resolveModelOperability(model, lookup);

    expect(result.executionProvider).toBe('openrouter');
    expect(result.resolvedProvider).toBe('openrouter');
    expect(result.fallbackChain).toEqual(['openrouter', 'openai']);
    expect(result.runnable).toBe(true);
  });

  it('recognizes OpenRouter audio methods as overridden implementations', () => {
    const adapter = new OpenRouterAdapter({ apiKey: 'test-key' });

    expect(isAdapterMethodImplemented(adapter, 'textToSpeech')).toBe(true);
    expect(isAdapterMethodOverridden(adapter, 'textToSpeech')).toBe(true);
    expect(isAdapterMethodImplemented(adapter, 'speechToText')).toBe(true);
    expect(isAdapterMethodOverridden(adapter, 'speechToText')).toBe(true);
  });

  it('treats base vision fallback as implemented but not overridden', () => {
    class AdapterWithBaseVision extends BaseProviderAdapter {
      constructor() {
        super('fake', 'Fake', { apiKey: 'test' });
      }
      async getProvider(): Promise<Provider> {
        return {
          id: 'fake',
          name: 'fake',
          displayName: 'Fake',
          status: 'active',
          health: { status: 'healthy', lastCheck: new Date() },
          models: [],
        };
      }
      async getModels(): Promise<Model[]> {
        return [];
      }
      async chatCompletion(_request: ChatRequest): Promise<ChatResponse> {
        return {
          id: 'resp',
          object: 'chat.completion',
          created: 0,
          model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      }
      async *chatCompletionStream(): AsyncGenerator<ChatResponse, void, unknown> {
        yield {
          id: 'resp',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
        };
      }
      async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
        return {
          object: 'list',
          data: [],
          model: 'fake-model',
          usage: { prompt_tokens: 0, total_tokens: 0 },
        };
      }
      async healthCheck(): Promise<HealthCheckResult> {
        return { healthy: true, checkedAt: new Date() };
      }
      calculateCost(): number {
        return 0;
      }
      normalizeModelName(modelName: string): string {
        return modelName;
      }
      async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
        throw new Error('not needed');
      }
      async imageVariation(
        _model: Model,
        _request: ImageVariationRequest
      ): Promise<ImageVariationResponse> {
        throw new Error('not needed');
      }
      async moderate(_model: Model, _request: ModerationRequest): Promise<ModerationResponse> {
        return {
          flagged: false,
          categories: {
            sexual: false,
            hate: false,
            harassment: false,
            'self-harm': false,
            'sexual/minors': false,
            'hate/threatening': false,
            'violence/graphic': false,
            'self-harm/intent': false,
            'self-harm/instructions': false,
            'harassment/threatening': false,
            violence: false,
          },
          category_scores: {
            sexual: 0,
            hate: 0,
            harassment: 0,
            'self-harm': 0,
            'sexual/minors': 0,
            'hate/threatening': 0,
            'violence/graphic': 0,
            'self-harm/intent': 0,
            'self-harm/instructions': 0,
            'harassment/threatening': 0,
            violence: 0,
          },
          raw: {},
        };
      }
    }

    const adapter = new AdapterWithBaseVision();
    expect(isAdapterMethodImplemented(adapter, 'vision')).toBe(true);
    expect(isAdapterMethodOverridden(adapter, 'vision')).toBe(false);
    expect(isAdapterMethodImplemented(adapter, 'webSearch')).toBe(false);
  });
});
