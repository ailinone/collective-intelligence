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
});
