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
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
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

  it('normalizes provider@nested/path identifiers fully instead of leaving them half-converted', async () => {
    // Root-caused 2026-09-12: the old check bailed out early on seeing ANY
    // '/' anywhere in the raw id, so `groq@meta-llama/llama-4-scout-...`
    // was left as `vendor@nested/path` — never reaching the '@' -> '/'
    // conversion at all. That caused 25 of 27 DB rows to be misdiagnosed as
    // "missing" when they were only unnormalized (the live/current form is
    // fully slash-delimited, e.g. `groq/meta-llama/llama-4-scout-...`).
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: 'groq@meta-llama/llama-4-scout-17b-16e-instruct' },
          { id: 'togetherai@deepseek-ai/DeepSeek-V3' },
        ],
      })
    );

    const fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: 'orqai',
      apiKey: 'live-hub-key',
      baseUrl: 'https://api.orq.ai',
      modelListPaths: ['/v2/router/models'],
    });

    const models = await fetcher.getModels();

    expect(models.map((m) => m.id)).toEqual([
      'groq/meta-llama/llama-4-scout-17b-16e-instruct',
      'togetherai/deepseek-ai/DeepSeek-V3',
    ]);

    const metadata0 = (models[0].metadata ?? {}) as Record<string, unknown>;
    expect(metadata0.originalProvider).toBe('groq');
    const metadata1 = (models[1].metadata ?? {}) as Record<string, unknown>;
    expect(metadata1.originalProvider).toBe('togetherai');
  });

  it('does not touch a version-suffix "@" that follows an existing "/" (Vertex/ORQ-style ids)', async () => {
    // Live-verified 2026-09-12 against ORQ.ai's /v2/router/models: ids like
    // `google/claude-opus-4-1@20250805` are already fully-routable as-is.
    // The '@' here is a version suffix, not a provider separator (the '/'
    // comes first) — converting it would corrupt an id that already works.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'google/claude-opus-4-1@20250805' }] })
    );

    const fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: 'orqai',
      apiKey: 'live-hub-key',
      baseUrl: 'https://api.orq.ai',
      modelListPaths: ['/v2/router/models'],
    });

    const models = await fetcher.getModels();
    expect(models[0].id).toBe('google/claude-opus-4-1@20250805');
  });

  it('pins @-normalization edge cases: multiple @, empty segments, unicode', async () => {
    // 2026-09-12 review follow-up: the nested-@ rewrite (first '@' before any
    // '/' converts) was only tested on the happy shapes. These pin the
    // boundary behavior so a future refactor cannot silently change it:
    //   - only the FIRST '@' ever converts; later '@'s are left alone
    //   - empty provider/model segments ('@x', 'x@') are returned untouched
    //     (the provider && model guard), never converted to '/x' or 'x/'
    //   - non-ascii provider tokens normalize exactly like ascii ones
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: 'acme@meta-llama@tuesday/llama-4-scout' },
          { id: '@no-provider' },
          { id: 'no-model@' },
          { id: '供應商@meta-llama/llama-4-scout' },
        ],
      })
    );

    const fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: 'orqai',
      apiKey: 'live-hub-key',
      baseUrl: 'https://api.orq.ai',
      modelListPaths: ['/v2/router/models'],
    });

    const models = await fetcher.getModels();

    expect(models.map((m) => m.id)).toEqual([
      'acme/meta-llama@tuesday/llama-4-scout',
      '@no-provider',
      'no-model@',
      '供應商/meta-llama/llama-4-scout',
    ]);
  });

  it('treats workspace@provider/model as provider@nested/path (documented trade-off)', async () => {
    // `workspace@provider/model` and `provider@nested/path` are
    // syntactically indistinguishable. Pre-2026-09-12 both were left
    // untouched (any '/' aborted normalization); now both convert the first
    // '@' to '/'. This is deliberate: the only live-verified producer of the
    // ambiguous shape is ORQ.ai's router listing, where the first segment IS
    // the vendor (`groq@meta-llama/...`), and no hub covered by this fetcher
    // is known to emit workspace-scoped ids. extractOriginalProviderFromId
    // (fetcher) and model-capability-inference.ts still parse the raw
    // `workspace@provider/model` shape for ids that did not pass through this
    // normalizer; this test pins what discovery-side normalization does to
    // the shape so the trade-off stays a visible, intended decision.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'tenant-acme@anthropic/claude-4-sonnet' }] })
    );

    const fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: 'orqai',
      apiKey: 'live-hub-key',
      baseUrl: 'https://api.orq.ai',
      modelListPaths: ['/v2/router/models'],
    });

    const models = await fetcher.getModels();
    expect(models[0].id).toBe('tenant-acme/anthropic/claude-4-sonnet');

    const metadata = (models[0].metadata ?? {}) as Record<string, unknown>;
    expect(metadata.originalProvider).toBe('tenant-acme');
  });

  describe('ORQ.ai Platform API opaque-UUID id (refId fallback)', () => {
    // Root-caused 2026-09-12, live-verified against api.orq.ai/v2/models
    // with a real key: 100% of 244 rows key `id` as an opaque internal
    // UUID, with the real "vendor/model" identity in a separate `refId`
    // field (always exactly `${provider}/${model_id}`). The generic
    // extractor picked `id` first and never looked at `refId`, so discovery
    // wrote raw UUIDs as model ids (confirmed real prod rows, e.g.
    // `metadata.originalProvider: 'deepseek'` paired with id
    // `04cf3186-7df2-43e1-a3f6-5e2ae5b0c2bf`). Discovery now prefers
    // /v2/router/models (a directly-compatible plain OpenAI list) and only
    // falls through to this endpoint as a last resort — this guard makes
    // that fallback safe too.
    it('uses refId instead of an opaque-UUID id (real /v2/models shape)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'e48808a5-afa1-4428-a080-259340e89ab0',
              model_id: 'codestral-latest',
              provider: 'mistral',
              refId: 'mistral/codestral-latest',
              display_name: 'Codestral 25.08',
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
      expect(models[0].id).not.toBe('e48808a5-afa1-4428-a080-259340e89ab0');
      expect(models[0].id).toBe('mistral/codestral-latest');

      const metadata = (models[0].metadata ?? {}) as Record<string, unknown>;
      expect(metadata.originalProvider).toBe('mistral');
    });

    it('falls back to the raw id when no refId is present, even if id looks UUID-shaped', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 'e48808a5-afa1-4428-a080-259340e89ab0' }] })
      );

      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'orqai',
        apiKey: 'live-hub-key',
        baseUrl: 'https://api.orq.ai',
        modelListPaths: ['/v2/models'],
      });

      const models = await fetcher.getModels();
      expect(models[0].id).toBe('e48808a5-afa1-4428-a080-259340e89ab0');
    });

    it('does not use refId when the id is a normal human-readable slug (no other hub is affected)', async () => {
      // Guards the narrow scoping: a hub that happens to carry an unrelated
      // `refId` field alongside a normal, already-good id must be
      // completely unaffected by this fallback.
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'some/normal-model-id', refId: 'something-unrelated' }],
        })
      );

      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'some-other-hub',
        apiKey: 'live-hub-key',
        baseUrl: 'https://api.example.com',
      });

      const models = await fetcher.getModels();
      expect(models[0].id).toBe('some/normal-model-id');
    });
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
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'qwen2.5:7b' }] }));
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
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'openai/gpt-4o' }] }));
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
        expect.any(Object)
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
      // Re-verified 2026-09-09 against OpenRouter's live /api/v1/models — Z.AI
      // cut GLM-5.2's price after GLM-5.3 shipped; see the gap-fill table's
      // header comment in openai-compatible-hub-model-fetcher.ts.
      expect(model.pricing?.inputCostPer1M).toBeCloseTo(0.28, 5);
      expect(model.pricing?.outputCostPer1M).toBeCloseTo(0.88, 5);
    });

    it('fills in glm-5.3 and glm-5.3-flash (added 2026-09-09, previously missing from the table)', async () => {
      const flagship = await fetchZaiModel('glm-5.3');
      expect(flagship.contextWindow).toBe(1_048_576);
      expect(flagship.pricing?.inputCostPer1M).toBeCloseTo(1.4, 5);
      expect(flagship.pricing?.outputCostPer1M).toBeCloseTo(4.4, 5);

      const flash = await fetchZaiModel('glm-5.3-flash');
      expect(flash.contextWindow).toBe(1_310_720);
      expect(flash.pricing?.inputCostPer1M).toBeCloseTo(0.075, 5);
      expect(flash.pricing?.outputCostPer1M).toBeCloseTo(0.25, 5);
    });

    it('fills in the corrected glm-4.6 and glm-5 pricing (2026-09-09 re-verification)', async () => {
      const glm46 = await fetchZaiModel('glm-4.6');
      expect(glm46.contextWindow).toBe(204_800);
      expect(glm46.pricing?.inputCostPer1M).toBeCloseTo(0.43, 5);
      expect(glm46.pricing?.outputCostPer1M).toBeCloseTo(1.75, 5);

      const glm5 = await fetchZaiModel('glm-5');
      expect(glm5.contextWindow).toBe(204_800);
      expect(glm5.pricing?.inputCostPer1M).toBeCloseTo(0.6, 5);
      expect(glm5.pricing?.outputCostPer1M).toBeCloseTo(1.92, 5);
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

  describe('wafer serverless vendor blob (LOTE AC)', () => {
    function fetchWaferModel() {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'GLM-5.2',
              object: 'model',
              created: 1781740800,
              owned_by: 'wafer',
              max_model_len: 1048576,
              zdr_supported: true,
              wafer: {
                display_name: 'GLM-5.2',
                context_length: 1048576,
                capabilities: {
                  vision: false,
                  tools: true,
                  reasoning: true,
                },
                pricing: {
                  input_cents_per_million: 126,
                  output_cents_per_million: 396,
                  cache_read_cents_per_million: 23,
                },
              },
            },
          ],
        })
      );
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'wafer',
        apiKey: 'live-hub-key',
        baseUrl: 'https://pass.wafer.ai/v1',
      });
      return fetcher.getModels();
    }

    it('reads the hard context cap from top-level max_model_len', async () => {
      const models = await fetchWaferModel();
      expect(models[0].contextWindow).toBe(1048576);
    });

    it('converts wafer.pricing cents-per-million to USD per 1M', async () => {
      const models = await fetchWaferModel();
      expect(models[0].pricing?.inputCostPer1M).toBeCloseTo(1.26, 6);
      expect(models[0].pricing?.outputCostPer1M).toBeCloseTo(3.96, 6);
      expect(models[0].pricing?.currency).toBe('USD');
    });

    it('seeds capabilities from the wafer.capabilities booleans', async () => {
      const models = await fetchWaferModel();
      expect(models[0].capabilities).toContain('reasoning');
      expect(models[0].capabilities).toContain('tool_use');
      expect(models[0].capabilities).toContain('function_calling');
      expect(models[0].capabilities).not.toContain('vision');
    });

    it('does not misread owned_by "wafer" as an upstream original provider', async () => {
      const models = await fetchWaferModel();
      const metadata = (models[0].metadata ?? {}) as Record<string, unknown>;
      expect(metadata.executionProviders).toEqual(['wafer']);
    });
  });

  describe('nested context_window object (Poe-style hubs, 2026-09)', () => {
    // Poe's real /v1/models nests the per-model output cap under a
    // `context_window` OBJECT rather than a top-level scalar — live-verified
    // 2026-09 (e.g. gpt-4o: `context_window: { context_length: 128000,
    // max_output_tokens: 8192 }`, with `context_length` ALSO duplicated at
    // the top level, but max_output_tokens is not). Before this fix, the
    // top-level key lookup silently skipped the object value (correct — it's
    // not a scalar) but nothing then looked inside it, so every Poe model's
    // maxOutputTokens fell back to the generic 4096 default regardless of
    // the vendor's real published value.
    it('reads max_output_tokens out of a nested context_window object', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'claude-haiku-4.5',
              context_window: { context_length: 192000, max_output_tokens: 64000 },
              context_length: 192000,
            },
          ],
        })
      );
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'poe',
        apiKey: 'live-hub-key',
        baseUrl: 'https://api.poe.com/v1',
      });
      const models = await fetcher.getModels();
      expect(models[0].contextWindow).toBe(192000);
      expect(models[0].maxOutputTokens).toBe(64000);
    });

    it('falls back to the generic default when context_window is null (no fabricated value)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'claude-code', context_window: null, context_length: null }],
        })
      );
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'poe',
        apiKey: 'live-hub-key',
        baseUrl: 'https://api.poe.com/v1',
      });
      const models = await fetcher.getModels();
      expect(models[0].contextWindow).toBe(8192);
      expect(models[0].maxOutputTokens).toBe(4096);
    });

    it('does not override a genuine top-level max_output_tokens with the nested one', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'some-model',
              max_output_tokens: 32000,
              context_window: { context_length: 100000, max_output_tokens: 999 },
            },
          ],
        })
      );
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'poe',
        apiKey: 'live-hub-key',
        baseUrl: 'https://api.poe.com/v1',
      });
      const models = await fetcher.getModels();
      expect(models[0].maxOutputTokens).toBe(32000);
    });
  });

  describe('nested architecture.{input,output}_modalities object (Poe-style hubs, 2026-09)', () => {
    // Live-verified 2026-09: Poe's real /v1/models declares modalities under
    // `architecture: { input_modalities, output_modalities, modality }`, not
    // at the top level. Before this fix that nested, provider-declared signal
    // was dropped entirely, so vision detection fell back to a text-keyword
    // regex over the description — which misses any vision-capable model
    // whose description doesn't happen to say "image"/"vision" (confirmed
    // live for Poe's `claude-haiku-4.5`).
    it('reads vision from a nested architecture.input_modalities even when the description never says "image"', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'claude-haiku-4.5',
              description:
                "Anthropic's fastest and most efficient model, delivering near-frontier intelligence. Matches Sonnet 4 on reasoning, coding, and computer-use tasks. Supports 200k tokens of context.",
              architecture: {
                input_modalities: ['text', 'image'],
                output_modalities: ['text'],
                modality: 'text,image->text',
              },
            },
          ],
        })
      );
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'poe',
        apiKey: 'live-hub-key',
        baseUrl: 'https://api.poe.com/v1',
      });
      const models = await fetcher.getModels();
      expect(models[0].capabilities).toContain('vision');
      expect(models[0].capabilities).toContain('multimodal');
    });

    it('still reads modalities from the top-level shape (no regression for existing hubs)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'top-level-model',
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
            },
          ],
        })
      );
      const fetcher = new OpenAICompatibleHubModelFetcher({
        providerName: 'some-hub',
        apiKey: 'live-hub-key',
        baseUrl: 'https://example.test/v1',
      });
      const models = await fetcher.getModels();
      expect(models[0].capabilities).toContain('vision');
    });
  });
});
