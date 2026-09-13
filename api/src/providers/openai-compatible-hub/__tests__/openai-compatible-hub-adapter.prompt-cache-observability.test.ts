// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for hub-routed prompt-cache observability (ADR-025
 * follow-up, 2026-09-09).
 *
 * `recordHubCacheUsage()` on the SHARED `OpenAICompatibleHubAdapter` tolerates
 * TWO real, independently-verified wire shapes rather than being gated on a
 * single `providerName`:
 *
 * 1. A flat `usage.cached_tokens` field — Moonshot/Kimi's automatic context
 *    caching (platform.kimi.ai/docs/api/chat, verified live 2026-09-08).
 * 2. A nested `usage.prompt_tokens_details.cached_tokens` field — confirmed
 *    live 2026-09-09 for every one of: Groq
 *    (console.groq.com/docs/prompt-caching, GPT-OSS models, fully
 *    automatic), Azure OpenAI
 *    (learn.microsoft.com/.../prompt-caching, automatic by default), Cerebras
 *    (inference-docs.cerebras.ai/capabilities/prompt-caching, automatic for
 *    every model), and SambaNova
 *    (sambanova.ai/blog/prompt-caching-on-sambacloud, automatic "Automatic
 *    Prefix Caching").
 *
 * This suite exercises both shapes across `chatCompletion()`'s two request
 * paths (explicit model, and the auto-fallback candidate loop) plus the
 * streaming path — the SAME coverage matrix for each shape, since a single
 * shared private method backs all of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleHubAdapter } from '@/providers/openai-compatible-hub/openai-compatible-hub-adapter';
import { getModelsByProvider } from '@/services/model-catalog-service';
import { providerPromptCacheTokensTotal } from '@/observability/ci-metrics';
import type { Model } from '@/types';

vi.mock('@/services/model-catalog-service', () => ({
  getModelsByProvider: vi.fn(),
}));

const mockedGetModelsByProvider = vi.mocked(getModelsByProvider);

function buildCatalogModel(providerName: string, name: string): Model {
  return {
    id: name,
    provider: providerName,
    name,
    displayName: name,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat'],
    performance: { latencyMs: 500, throughput: 100, quality: 0.8, reliability: 0.9 },
    status: 'active',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Model;
}

function createAdapter(providerName: string): OpenAICompatibleHubAdapter {
  return new OpenAICompatibleHubAdapter({
    name: providerName,
    providerName,
    apiKey: 'test-key',
    baseUrl: `https://api.${providerName}.example/v1`,
    enabled: true,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(payloads: Record<string, unknown>[]): Response {
  const lines = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`);
  lines.push('data: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function cacheValue(provider: string, outcome: 'hit' | 'miss'): Promise<number> {
  const metric = await providerPromptCacheTokensTotal.get();
  return (
    metric.values.find((v) => v.labels.provider === provider && v.labels.outcome === outcome)
      ?.value ?? 0
  );
}

describe('OpenAICompatibleHubAdapter (Moonshot) — flat usage.cached_tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records hit/miss tokens on the explicit-model chatCompletion path', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('moonshot', 'kimi-k3')]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'kimi-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'kimi-k3',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040, cached_tokens: 800 },
      })
    );
    const adapter = createAdapter('moonshot');
    const hitBefore = await cacheValue('moonshot', 'hit');
    const missBefore = await cacheValue('moonshot', 'miss');

    await adapter.chatCompletion({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] } as any);

    expect((await cacheValue('moonshot', 'hit')) - hitBefore).toBe(800);
    expect((await cacheValue('moonshot', 'miss')) - missBefore).toBe(200); // 1000 - 800
  });

  it('records hit tokens on the auto-fallback candidate loop path (no model specified)', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('moonshot', 'kimi-k3')]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'kimi-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'kimi-k3',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520, cached_tokens: 256 },
      })
    );
    const adapter = createAdapter('moonshot');
    const hitBefore = await cacheValue('moonshot', 'hit');

    await adapter.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] } as any);

    expect((await cacheValue('moonshot', 'hit')) - hitBefore).toBe(256);
  });

  it('is a no-op when the response has no cached_tokens field', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('moonshot', 'kimi-k3')]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'kimi-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'kimi-k3',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      })
    );
    const adapter = createAdapter('moonshot');
    const hitBefore = await cacheValue('moonshot', 'hit');

    await adapter.chatCompletion({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] } as any);

    expect(await cacheValue('moonshot', 'hit')).toBe(hitBefore);
  });

  it('records hit tokens from the streaming path final usage chunk', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('moonshot', 'kimi-k3')]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        { id: 'kimi-1', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
        {
          id: 'kimi-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2000, completion_tokens: 80, total_tokens: 2080, cached_tokens: 1900 },
        },
      ])
    );
    const adapter = createAdapter('moonshot');
    const hitBefore = await cacheValue('moonshot', 'hit');

    for await (const _chunk of adapter.chatCompletionStream({
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'hi' }],
    } as any)) {
      // drain
    }

    expect((await cacheValue('moonshot', 'hit')) - hitBefore).toBe(1900);
  });
});

describe.each(['groq', 'azure', 'cerebras', 'sambanova'])(
  'OpenAICompatibleHubAdapter (%s) — nested usage.prompt_tokens_details.cached_tokens',
  (providerName) => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('records hit/miss tokens on the explicit-model chatCompletion path', async () => {
      mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel(providerName, 'model-a')]);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          id: 'resp-1',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'model-a',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 4641,
            completion_tokens: 40,
            total_tokens: 4681,
            prompt_tokens_details: { cached_tokens: 4608 },
          },
        })
      );
      const adapter = createAdapter(providerName);
      const hitBefore = await cacheValue(providerName, 'hit');
      const missBefore = await cacheValue(providerName, 'miss');

      await adapter.chatCompletion({
        model: 'model-a',
        messages: [{ role: 'user', content: 'hi' }],
      } as any);

      expect((await cacheValue(providerName, 'hit')) - hitBefore).toBe(4608);
      expect((await cacheValue(providerName, 'miss')) - missBefore).toBe(33); // 4641 - 4608
    });

    it('is a no-op when prompt_tokens_details is absent', async () => {
      mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel(providerName, 'model-a')]);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          id: 'resp-1',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'model-a',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        })
      );
      const adapter = createAdapter(providerName);
      const hitBefore = await cacheValue(providerName, 'hit');

      await adapter.chatCompletion({
        model: 'model-a',
        messages: [{ role: 'user', content: 'hi' }],
      } as any);

      expect(await cacheValue(providerName, 'hit')).toBe(hitBefore);
    });

    it('records hit tokens from the streaming path final usage chunk', async () => {
      mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel(providerName, 'model-a')]);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        sseResponse([
          { id: 'resp-1', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
          {
            id: 'resp-1',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 2000,
              completion_tokens: 80,
              total_tokens: 2080,
              prompt_tokens_details: { cached_tokens: 1900 },
            },
          },
        ])
      );
      const adapter = createAdapter(providerName);
      const hitBefore = await cacheValue(providerName, 'hit');

      for await (const _chunk of adapter.chatCompletionStream({
        model: 'model-a',
        messages: [{ role: 'user', content: 'hi' }],
      } as any)) {
        // drain
      }

      expect((await cacheValue(providerName, 'hit')) - hitBefore).toBe(1900);
    });
  }
);
