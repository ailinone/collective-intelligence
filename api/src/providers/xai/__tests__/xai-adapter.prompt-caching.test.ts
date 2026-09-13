// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for xAI (Grok) prompt-caching support (ADR-025
 * follow-up, 2026-09-08).
 *
 * xAI's own docs (docs.x.ai/developers/advanced-api-usage/prompt-caching/
 * how-it-works, verified live 2026-09-08) document the `x-grok-conv-id` HTTP
 * header as the mechanism to route same-conversation requests to the same
 * server, maximizing cache hit rate on `/v1/chat/completions` — a real
 * gap this ADR's original 2026-09-06 pass missed. This suite covers:
 *   1. `x-grok-conv-id` is sent (non-streaming and streaming), derived the
 *      SAME way OpenAI/Mistral derive their own cache keys, so the header
 *      is stable turn-to-turn for the same conversation.
 *   2. The response's `usage.prompt_tokens_details.cached_tokens` (confirmed
 *      on the same doc page) is surfaced into
 *      `ci_provider_prompt_cache_tokens_total`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { XAIAdapter } from '../xai-adapter';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';
import { providerPromptCacheTokensTotal } from '@/observability/ci-metrics';
import type { ChatRequest } from '@/types';

function createAdapter(): XAIAdapter {
  return new XAIAdapter({ apiKey: 'test-key' });
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

async function cacheValue(outcome: 'hit' | 'miss'): Promise<number> {
  const metric = await providerPromptCacheTokensTotal.get();
  return (
    metric.values.find((v) => v.labels.provider === 'xai' && v.labels.outcome === outcome)
      ?.value ?? 0
  );
}

const BASE_REQUEST: ChatRequest = {
  model: 'grok-2-latest',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('XAIAdapter — x-grok-conv-id cache-routing header', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await distributedCircuitBreakerManager.getBreaker('xai-api').reset();
  });

  it('sends x-grok-conv-id on a non-streaming chat completion', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'x-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'grok-2-latest',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      })
    );
    const adapter = createAdapter();

    await adapter.chatCompletion(BASE_REQUEST);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(typeof headers['x-grok-conv-id']).toBe('string');
    expect(headers['x-grok-conv-id'].length).toBeGreaterThan(0);
  });

  it('derives the SAME conv id for the same conversation across two calls', async () => {
    // mockImplementation (not mockResolvedValue) — a Response body can only
    // be read once, so each of the two chatCompletion() calls below needs
    // its OWN fresh Response instance rather than sharing one.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        id: 'x-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'grok-2-latest',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      })
    );
    const adapter = createAdapter();
    const request: ChatRequest = {
      ...BASE_REQUEST,
      ailin_session_scope: { conversationId: 'conv-xai-1' },
    } as ChatRequest;

    await adapter.chatCompletion(request);
    await adapter.chatCompletion(request);

    const id1 = (fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>)['x-grok-conv-id'];
    const id2 = (fetchSpy.mock.calls[1]![1]!.headers as Record<string, string>)['x-grok-conv-id'];
    expect(id1).toBe(id2);
  });

  it('sends x-grok-conv-id on a streaming chat completion', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        sseResponse([{ id: 'x-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])
      );
    const adapter = createAdapter();

    for await (const _chunk of adapter.chatCompletionStream(BASE_REQUEST)) {
      // drain
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(typeof headers['x-grok-conv-id']).toBe('string');
  });
});

describe('XAIAdapter — cache-hit observability', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await distributedCircuitBreakerManager.getBreaker('xai-api').reset();
  });

  it('records hit/miss tokens from usage.prompt_tokens_details.cached_tokens (non-streaming)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'x-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'grok-2-latest',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 20,
          total_tokens: 520,
          prompt_tokens_details: { cached_tokens: 300 },
        },
      })
    );
    const adapter = createAdapter();
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');

    await adapter.chatCompletion(BASE_REQUEST);

    expect((await cacheValue('hit')) - hitBefore).toBe(300);
    expect((await cacheValue('miss')) - missBefore).toBe(200); // 500 - 300
  });

  it('is a no-op when prompt_tokens_details is absent (cache miss / older response shape)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'x-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'grok-2-latest',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      })
    );
    const adapter = createAdapter();
    const hitBefore = await cacheValue('hit');

    await adapter.chatCompletion(BASE_REQUEST);

    expect(await cacheValue('hit')).toBe(hitBefore);
  });

  it('records cache-hit tokens on the streaming path final usage chunk', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        { id: 'x-1', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
        {
          id: 'x-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 40,
            total_tokens: 1040,
            prompt_tokens_details: { cached_tokens: 900 },
          },
        },
      ])
    );
    const adapter = createAdapter();
    const hitBefore = await cacheValue('hit');

    for await (const _chunk of adapter.chatCompletionStream(BASE_REQUEST)) {
      // drain
    }

    expect((await cacheValue('hit')) - hitBefore).toBe(900);
  });
});
