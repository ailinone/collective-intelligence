// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for Vertex AI prompt-cache observability (ADR-025
 * follow-up, 2026-09-09).
 *
 * Vertex AI's Gemini models get implicit context caching enabled by default
 * for Gemini 2.5+ — no request-side field to set. The response's own
 * `UsageMetadata.cachedContentTokenCount` (confirmed live against Vertex
 * AI's `GenerateContentResponse.UsageMetadata` reference, 2026-09-09 — same
 * field name as the standalone Gemini API `google-adapter.ts` already
 * surfaces) reports how many prompt tokens were served from cache. This
 * suite covers BOTH `chatCompletion()` (non-streaming) and
 * `chatCompletionStream()` surfacing that field into
 * `ci_provider_prompt_cache_tokens_total`, deriving the miss count as
 * `promptTokenCount - cachedContentTokenCount` since Vertex only reports the
 * hit count directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VertexAIAdapter } from '@/providers/vertex-ai/vertex-ai-adapter';
import { providerPromptCacheTokensTotal } from '@/observability/ci-metrics';
import type { ChatRequest } from '@/types';

function createAdapter(): VertexAIAdapter {
  return new VertexAIAdapter({
    apiKey: 'test-key',
    projectId: 'test-project',
    useExpressMode: true,
  });
}

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

function jsonResponse(usageMetadata?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      ...(usageMetadata ? { usageMetadata } : {}),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function sseResponse(usageMetadata?: Record<string, unknown>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            ...(usageMetadata ? { usageMetadata } : {}),
          })}\n\n`
        )
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function cacheValue(outcome: 'hit' | 'miss'): Promise<number> {
  const metric = await providerPromptCacheTokensTotal.get();
  return (
    metric.values.find((v) => v.labels.provider === 'vertex-ai' && v.labels.outcome === outcome)
      ?.value ?? 0
  );
}

describe('VertexAIAdapter — prompt-cache observability (cachedContentTokenCount)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('non-streaming: records hit tokens and derives miss tokens when cachedContentTokenCount is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ promptTokenCount: 5000, candidatesTokenCount: 100, totalTokenCount: 5100, cachedContentTokenCount: 4096 })
    );
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');

    await createAdapter().chatCompletion(baseRequest());

    expect((await cacheValue('hit')) - hitBefore).toBe(4096);
    expect((await cacheValue('miss')) - missBefore).toBe(904); // 5000 - 4096
  });

  it('non-streaming: is a no-op when cachedContentTokenCount is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 })
    );
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');

    await createAdapter().chatCompletion(baseRequest());

    expect(await cacheValue('hit')).toBe(hitBefore);
    expect(await cacheValue('miss')).toBe(missBefore);
  });

  it('non-streaming: does not change the returned ChatResponse.usage shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ promptTokenCount: 5000, candidatesTokenCount: 100, totalTokenCount: 5100, cachedContentTokenCount: 4096 })
    );

    const result = await createAdapter().chatCompletion(baseRequest());

    expect(result.usage).toEqual({ prompt_tokens: 5000, completion_tokens: 100, total_tokens: 5100 });
  });

  it('streaming: records hit/miss tokens from the usage-bearing SSE chunk', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse({ promptTokenCount: 2000, candidatesTokenCount: 50, cachedContentTokenCount: 1024 })
    );
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of createAdapter().chatCompletionStream(baseRequest())) {
      // drain
    }

    expect((await cacheValue('hit')) - hitBefore).toBe(1024);
    expect((await cacheValue('miss')) - missBefore).toBe(976); // 2000 - 1024
  });

  it('streaming: is a no-op when no chunk carries usageMetadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseResponse());
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of createAdapter().chatCompletionStream(baseRequest())) {
      // drain
    }

    expect(await cacheValue('hit')).toBe(hitBefore);
    expect(await cacheValue('miss')).toBe(missBefore);
  });
});
