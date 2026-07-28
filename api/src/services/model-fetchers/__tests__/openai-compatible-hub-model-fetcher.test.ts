// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleHubModelFetcher } from '@/services/model-fetchers/openai-compatible-hub-model-fetcher';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

describe('openai-compatible-hub-model-fetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps execution bound to hub adapter while preserving original provider metadata', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'openai/gpt-4o',
            display_name: 'GPT-4o via Hub',
            context_window: 128000,
            max_output_tokens: 16384,
            supported_parameters: ['tools', 'response_format'],
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
          },
        ],
      })
    );

    const fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: 'orqai',
      apiKey: 'live-hub-key',
      baseUrl: 'https://api.orq.ai/v2/router',
    });

    const models = await fetcher.getModels();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('openai/gpt-4o');
    expect(models[0].capabilities).toContain('chat');
    expect(models[0].capabilities).toContain('function_calling');

    const metadata = (models[0].metadata ?? {}) as Record<string, unknown>;
    expect(metadata.provider).toBe('orqai');
    expect(metadata.originalProvider).toBe('openai');
    expect(metadata.executionProvider).toBe('orqai');
    expect(metadata.executionProviders).toEqual(['orqai', 'openai']);
  });

  it('tries alternate model-list endpoints until one succeeds', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404))
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            {
              id: 'anthropic/claude-3-5-sonnet',
              context_window: 200000,
              max_output_tokens: 8192,
            },
          ],
        })
      );

    const fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: 'heliconeai',
      apiKey: 'live-hub-key',
      baseUrl: 'https://ai-gateway.helicone.ai/v1',
      modelListPaths: ['/does-not-exist', '/models'],
    });

    const models = await fetcher.getModels();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('anthropic/claude-3-5-sonnet');
    expect(models[0].metadata?.executionProvider).toBe('heliconeai');
  });

  describe('explicit User-Agent header (featherless-ai WAF regression)', () => {
    it('sends a non-default User-Agent instead of undici\'s "node" default', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 'recursal/EagleX_1-7T', context_window: 16384 }] })
      );

      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'featherless-ai',
        apiKey: 'live-hub-key',
        baseUrl: 'https://api.featherless.ai/v1',
      });

      await fetcher.getModels();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers['User-Agent']).toBeTruthy();
      expect(headers['User-Agent']).not.toBe('node');
    });

    it('sends the explicit User-Agent on every attempted path, not just the first', async () => {
      // Regression: a WAF blocking the default UA 404s on EVERY path this
      // fetcher tries (all indistinguishable from "path doesn't exist"), so
      // the header must be present on each retry, not just the initial call.
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({}, 404))
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'm1', context_window: 4096 }] }));

      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'featherless-ai',
        apiKey: 'live-hub-key',
        baseUrl: 'https://api.featherless.ai/v1',
        modelListPaths: ['/models', '/v1/models'],
      });

      await fetcher.getModels();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      for (const call of fetchSpy.mock.calls) {
        const headers = call[1]?.headers as Record<string, string>;
        expect(headers['User-Agent']).not.toBe('node');
      }
    });
  });

  it('normalizes provider@model identifiers to provider/model for runtime execution', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'alibaba@qvq-max',
            display_name: 'QVQ Max',
            context_window: 131072,
            max_output_tokens: 8192,
          },
        ],
      })
    );

    const fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: 'orqai',
      apiKey: 'live-hub-key',
      baseUrl: 'https://api.orq.ai',
      modelListPaths: ['/v2/models'],
    });

    const models = await fetcher.getModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('alibaba/qvq-max');
    expect(models[0].name).toBe('alibaba/qvq-max');

    const metadata = (models[0].metadata ?? {}) as Record<string, unknown>;
    expect(metadata.originalProvider).toBe('alibaba');
    expect(metadata.executionProvider).toBe('orqai');
    expect(metadata.rawModelId).toBe('alibaba@qvq-max');
    expect(metadata.executionProviders).toEqual(['orqai', 'alibaba']);
  });

  it('keeps bare model id when hub returns bare ids and infers original provider from owned_by', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'claude-sonnet-4',
            owned_by: 'anthropic',
            context_window: 200000,
            max_output_tokens: 8192,
          },
        ],
      })
    );

    const fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: 'heliconeai',
      apiKey: 'live-hub-key',
      baseUrl: 'https://ai-gateway.helicone.ai/v1',
      modelListPaths: ['/models'],
    });

    const models = await fetcher.getModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('claude-sonnet-4');

    const metadata = (models[0].metadata ?? {}) as Record<string, unknown>;
    expect(metadata.originalProvider).toBe('anthropic');
    expect(metadata.executionProvider).toBe('heliconeai');
    expect(metadata.executionProviders).toEqual(['heliconeai', 'anthropic']);
  });

  describe('apiKeyOptional (vllm/lm-studio/xinference self-hosted servers)', () => {
    it('still skips discovery with no key when apiKeyOptional is unset/false (unchanged default behavior)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'some-required-key-provider',
        apiKey: '',
        baseUrl: 'https://api.example.com',
      });
      const models = await fetcher.getModels();
      expect(models).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('proceeds with discovery on an empty key when apiKeyOptional is true, and omits the Authorization header', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 'qwen2.5:7b' }] })
      );
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'vllm',
        apiKey: '',
        apiKeyOptional: true,
        baseUrl: 'http://localhost:8000/v1',
      });
      const models = await fetcher.getModels();
      expect(models).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    it('still skips discovery when apiKeyOptional is true but the key looks like a mock/test value', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'vllm',
        apiKey: 'mock-key',
        apiKeyOptional: true,
        baseUrl: 'http://localhost:8000/v1',
      });
      const models = await fetcher.getModels();
      expect(models).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('absolute-URL modelListPaths override (github-models catalog endpoint)', () => {
    it('uses the absolute URL as-is instead of concatenating it onto baseUrl', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 'openai/gpt-4o' }] })
      );
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'github-models',
        apiKey: 'ghp_live',
        baseUrl: 'https://models.github.ai/inference',
        modelListPaths: ['https://models.github.ai/catalog/models'],
      });
      const models = await fetcher.getModels();
      expect(models).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://models.github.ai/catalog/models',
        expect.any(Object),
      );
    });
  });

  describe('pricing unit normalization', () => {
    async function fetchWithPricing(pricing: Record<string, unknown>) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'some/model',
              context_window: 32768,
              max_output_tokens: 4096,
              pricing,
            },
          ],
        })
      );
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'phala',
        apiKey: 'live-hub-key',
        baseUrl: 'https://api.example.com',
      });
      const models = await fetcher.getModels();
      expect(models).toHaveLength(1);
      return models[0].pricing;
    }

    it('scales a $/1k-token price (OpenAI-legacy convention) to $/1M without 1000x inflation', async () => {
      // 0.00025 $/1k-tokens == $0.25/Mtok — previously misclassified as
      // $/token and scaled x1e6 to an implausible $250/Mtok.
      const pricing = await fetchWithPricing({ prompt: 0.00025, completion: 0.0005 });
      expect(pricing?.inputCostPer1M).toBeCloseTo(0.25, 5);
      expect(pricing?.outputCostPer1M).toBeCloseTo(0.5, 5);
    });

    it('scales a genuine $/token price to $/1M', async () => {
      // 0.000003 $/token == $3/Mtok (OpenRouter-style convention).
      const pricing = await fetchWithPricing({ prompt: 0.000003, completion: 0.000015 });
      expect(pricing?.inputCostPer1M).toBeCloseTo(3, 5);
      expect(pricing?.outputCostPer1M).toBeCloseTo(15, 5);
    });

    it('passes through an already-normalized $/1M price unscaled', async () => {
      const pricing = await fetchWithPricing({ prompt: 12, completion: 36 });
      expect(pricing?.inputCostPer1M).toBe(12);
      expect(pricing?.outputCostPer1M).toBe(36);
    });

    it('clamps an implausible computed price to 0 (unknown) instead of persisting corruption', async () => {
      // 0.5 lands in the $/1k-token bucket and scales to $500/Mtok — far
      // above any real price; must be rejected as a unit-detection failure,
      // not accepted as fact.
      const pricing = await fetchWithPricing({ prompt: 0.5, completion: 0.8 });
      expect(pricing?.inputCostPer1M).toBe(0);
      expect(pricing?.outputCostPer1M).toBe(0);
    });
  });

  describe('zai (GLM) provider metadata gap-fill', () => {
    async function fetchZaiModel(id: string) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          data: [{ id }], // bigmodel.cn's real /v1/models response: no context/pricing fields at all
        })
      );
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'zai',
        apiKey: 'live-hub-key',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      });
      const models = await fetcher.getModels();
      expect(models).toHaveLength(1);
      return models[0];
    }

    it('fills in real context window and pricing when the provider omits both', async () => {
      const model = await fetchZaiModel('glm-5.2');
      expect(model.contextWindow).toBe(1_048_576);
      expect(model.pricing?.inputCostPer1M).toBeCloseTo(0.965, 5);
      expect(model.pricing?.outputCostPer1M).toBeCloseTo(3.032, 5);
    });

    it('does not gap-fill a model id not in the override table', async () => {
      const model = await fetchZaiModel('glm-6-hypothetical');
      expect(model.contextWindow).toBe(8192);
      expect(model.pricing?.inputCostPer1M).toBe(0);
      expect(model.pricing?.outputCostPer1M).toBe(0);
    });

    it('never overrides a real, provider-supplied context/price', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'glm-5.2',
              context_window: 8192, // genuinely tiny variant the provider actually reports
              pricing: { prompt: 2, completion: 6 }, // already-normalized $/1M
            },
          ],
        })
      );
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'zai',
        apiKey: 'live-hub-key',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      });
      const models = await fetcher.getModels();

      expect(models[0].contextWindow).toBe(8192);
      expect(models[0].pricing?.inputCostPer1M).toBe(2);
      expect(models[0].pricing?.outputCostPer1M).toBe(6);
    });

    it('does not gap-fill the same model id under a different provider', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 'glm-5.2' }] })
      );
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'some-other-hub',
        apiKey: 'live-hub-key',
        baseUrl: 'https://api.example.com',
      });
      const models = await fetcher.getModels();

      expect(models[0].contextWindow).toBe(8192);
      expect(models[0].pricing?.inputCostPer1M).toBe(0);
    });
  });
});
