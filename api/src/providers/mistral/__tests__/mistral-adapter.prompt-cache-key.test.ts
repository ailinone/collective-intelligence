// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for Mistral prompt-caching support (ADR-025 follow-up,
 * 2026-09-08).
 *
 * Mistral's own API reference documents `prompt_cache_key` as a chat-
 * completions request field with the SAME contract as OpenAI's field of the
 * same name (docs.mistral.ai/studio-api/conversations/advanced/prompt-caching,
 * verified live 2026-09-08) — a genuine gap this ADR's original 2026-09-06
 * pass missed, not a deliberate exclusion. This suite covers:
 *   1. `prompt_cache_key` is forwarded (non-streaming and streaming), derived
 *      the SAME way `openai-adapter.ts` already derives it
 *      (`deriveSessionKey`), so a conversation gets the SAME key regardless
 *      of which of the two providers answers it.
 *   2. The response's `usage.prompt_tokens_details.cached_tokens` (confirmed
 *      on the same doc page) is surfaced into
 *      `ci_provider_prompt_cache_tokens_total` via `recordProviderPromptCacheUsage`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MistralAdapter } from '../mistral-adapter';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';
import { providerPromptCacheTokensTotal } from '@/observability/ci-metrics';
import type { ChatRequest } from '@/types';

function createAdapter(): MistralAdapter {
  return new MistralAdapter({ apiKey: 'test-key' });
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
    metric.values.find((v) => v.labels.provider === 'mistral' && v.labels.outcome === outcome)
      ?.value ?? 0
  );
}

const BASE_REQUEST: ChatRequest = {
  model: 'mistral-large-latest',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('MistralAdapter — prompt_cache_key forwarding', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await distributedCircuitBreakerManager.getBreaker('mistral-api').reset();
  });

  it('sends prompt_cache_key on a non-streaming chat completion', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'cmpl-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mistral-large-latest',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      })
    );
    const adapter = createAdapter();

    await adapter.chatCompletion(BASE_REQUEST);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(typeof payload.prompt_cache_key).toBe('string');
    expect((payload.prompt_cache_key as string).length).toBeGreaterThan(0);
  });

  it('derives the SAME prompt_cache_key for the same conversation across two calls', async () => {
    // mockImplementation (not mockResolvedValue) — a Response body can only
    // be read once, so each of the two chatCompletion() calls below needs
    // its OWN fresh Response instance rather than sharing one.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        id: 'cmpl-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mistral-large-latest',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      })
    );
    const adapter = createAdapter();
    const request: ChatRequest = {
      ...BASE_REQUEST,
      ailin_session_scope: { conversationId: 'conv-123' },
    } as ChatRequest;

    await adapter.chatCompletion(request);
    await adapter.chatCompletion(request);

    const key1 = (JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)) as Record<string, unknown>)
      .prompt_cache_key;
    const key2 = (JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body)) as Record<string, unknown>)
      .prompt_cache_key;
    expect(key1).toBe(key2);
  });

  it('sends prompt_cache_key on a streaming chat completion', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        sseResponse([{ id: 'cmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])
      );
    const adapter = createAdapter();

    for await (const _chunk of adapter.chatCompletionStream(BASE_REQUEST)) {
      // drain
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(typeof payload.prompt_cache_key).toBe('string');
  });
});

describe('MistralAdapter — cache-hit observability', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await distributedCircuitBreakerManager.getBreaker('mistral-api').reset();
  });

  it('records hit/miss tokens from usage.prompt_tokens_details.cached_tokens (non-streaming)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'cmpl-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mistral-large-latest',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1013,
          completion_tokens: 30,
          total_tokens: 1043,
          prompt_tokens_details: { cached_tokens: 1008 },
        },
      })
    );
    const adapter = createAdapter();
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');

    await adapter.chatCompletion(BASE_REQUEST);

    expect((await cacheValue('hit')) - hitBefore).toBe(1008);
    expect((await cacheValue('miss')) - missBefore).toBe(5); // 1013 - 1008
  });

  it('is a no-op when the response carries no prompt_tokens_details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'cmpl-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mistral-large-latest',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      })
    );
    const adapter = createAdapter();
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');

    await adapter.chatCompletion(BASE_REQUEST);

    expect(await cacheValue('hit')).toBe(hitBefore);
    expect(await cacheValue('miss')).toBe(missBefore);
  });

  it('records cache-hit tokens on the streaming path final usage chunk', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        { id: 'cmpl-1', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
        {
          id: 'cmpl-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 10,
            total_tokens: 210,
            prompt_tokens_details: { cached_tokens: 64 },
          },
        },
      ])
    );
    const adapter = createAdapter();
    const hitBefore = await cacheValue('hit');

    for await (const _chunk of adapter.chatCompletionStream(BASE_REQUEST)) {
      // drain
    }

    expect((await cacheValue('hit')) - hitBefore).toBe(64);
  });
});
