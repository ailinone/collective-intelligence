// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for DeepSeek prompt-cache observability (ADR-025
 * follow-up, 2026-09-08).
 *
 * DeepSeek's context caching on disk is confirmed fully automatic — "enabled
 * by default for all users... without needing to modify their code"
 * (api-docs.deepseek.com/guides/kv_cache, verified live 2026-09-08) — so
 * there is nothing to add on the request-building side. The real, valuable
 * follow-up is observability: DeepSeek's response `usage` object reports
 * BOTH `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` directly.
 *
 * This suite also covers a real, separate bug this investigation uncovered:
 * the streaming path's `convertStreamChunk` explicitly reconstructed a
 * narrowed usage object (`prompt_tokens`/`completion_tokens`/`total_tokens`
 * only), silently discarding both cache fields even when DeepSeek's own SSE
 * chunk carried them. The fix records them into
 * `ci_provider_prompt_cache_tokens_total` BEFORE that narrowing happens.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter } from '../deepseek-adapter';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';
import { providerPromptCacheTokensTotal } from '@/observability/ci-metrics';
import type { ChatRequest } from '@/types';

function createAdapter(): DeepSeekAdapter {
  return new DeepSeekAdapter({ apiKey: 'test-key' });
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
    metric.values.find((v) => v.labels.provider === 'deepseek' && v.labels.outcome === outcome)
      ?.value ?? 0
  );
}

const BASE_REQUEST: ChatRequest = {
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('DeepSeekAdapter — prompt-cache observability (non-streaming)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await distributedCircuitBreakerManager.getBreaker('deepseek-api').reset();
  });

  it('records both prompt_cache_hit_tokens and prompt_cache_miss_tokens directly (no derivation needed)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'ds-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          total_tokens: 1050,
          prompt_cache_hit_tokens: 700,
          prompt_cache_miss_tokens: 300,
        },
      })
    );
    const adapter = createAdapter();
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');

    await adapter.chatCompletion(BASE_REQUEST);

    expect((await cacheValue('hit')) - hitBefore).toBe(700);
    expect((await cacheValue('miss')) - missBefore).toBe(300);
  });

  it('is a no-op when neither cache field is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'ds-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
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
});

describe('DeepSeekAdapter — prompt-cache observability (streaming) — fixes the drop bug', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await distributedCircuitBreakerManager.getBreaker('deepseek-api').reset();
  });

  it('records cache fields from the final usage-bearing SSE chunk, previously silently dropped', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        { id: 'ds-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
        {
          id: 'ds-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 2000,
            completion_tokens: 80,
            total_tokens: 2080,
            prompt_cache_hit_tokens: 1500,
            prompt_cache_miss_tokens: 500,
          },
        },
      ])
    );
    const adapter = createAdapter();
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');

    for await (const _chunk of adapter.chatCompletionStream(BASE_REQUEST)) {
      // drain
    }

    expect((await cacheValue('hit')) - hitBefore).toBe(1500);
    expect((await cacheValue('miss')) - missBefore).toBe(500);
  });

  it('still returns only the fixed 3-field Usage shape on the streamed chunk (no type widening)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        {
          id: 'ds-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 2000,
            completion_tokens: 80,
            total_tokens: 2080,
            prompt_cache_hit_tokens: 1500,
            prompt_cache_miss_tokens: 500,
          },
        },
      ])
    );
    const adapter = createAdapter();
    const usages: unknown[] = [];

    for await (const chunk of adapter.chatCompletionStream(BASE_REQUEST)) {
      if (chunk.usage) usages.push(chunk.usage);
    }

    expect(usages).toEqual([{ prompt_tokens: 2000, completion_tokens: 80, total_tokens: 2080 }]);
  });
});
