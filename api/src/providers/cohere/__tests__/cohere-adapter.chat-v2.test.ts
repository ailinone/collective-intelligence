// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CohereAdapter — Chat API v2 migration + prompt-cache observability
 * (ADR-025 follow-up, 2026-09-09).
 *
 * Chat completions moved from Cohere's legacy v1 `/chat` endpoint to v2
 * `/v2/chat` (docs.cohere.com/v2/reference/chat, verified live 2026-09-09)
 * — the ONLY place Cohere reports `usage.cached_tokens`. This suite covers:
 *   - request shape: POSTs to `/v2/chat`, a single `messages` array (not
 *     v1's `message` + `chat_history` split)
 *   - non-streaming response parsing: `message.content[].text`,
 *     `finish_reason` enum mapping, `usage` (including cache observability)
 *   - streaming: `message-start` / `content-delta` / `message-end` SSE
 *     events
 *   - embeddings + health check remain on v1 (untouched by this migration)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CohereAdapter } from '../cohere-adapter';
import { providerPromptCacheTokensTotal } from '@/observability/ci-metrics';
import type { ChatRequest } from '@/types';

function makeAdapter(): CohereAdapter {
  return new CohereAdapter({
    name: 'cohere',
    enabled: true,
    apiKey: 'test-key',
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'command-r-plus',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ],
    ...overrides,
  };
}

async function cacheValue(outcome: 'hit' | 'miss'): Promise<number> {
  const metric = await providerPromptCacheTokensTotal.get();
  return (
    metric.values.find((v) => v.labels.provider === 'cohere' && v.labels.outcome === outcome)
      ?.value ?? 0
  );
}

describe('CohereAdapter — chatCompletion request shape (v2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to /v2/chat, not the legacy v1 /chat endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'r1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        finish_reason: 'COMPLETE',
        usage: { tokens: { input_tokens: 5, output_tokens: 2 } },
      })
    );

    await makeAdapter().chatCompletion(baseRequest());

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cohere.ai/v2/chat');
  });

  it('sends a single messages array (system + user), not v1 message/chat_history', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'r1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        finish_reason: 'COMPLETE',
      })
    );

    await makeAdapter().chatCompletion(baseRequest());

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ]);
    expect(body.message).toBeUndefined();
    expect(body.chat_history).toBeUndefined();
  });

  it('maps role "function" to Cohere v2\'s "tool" role', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'r1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        finish_reason: 'COMPLETE',
      })
    );

    await makeAdapter().chatCompletion(
      baseRequest({
        messages: [{ role: 'function', content: 'result', name: 'lookup' }],
      })
    );

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.messages[0].role).toBe('tool');
  });
});

describe('CohereAdapter — chatCompletion response parsing (v2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts text from message.content[].text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'r1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
        finish_reason: 'COMPLETE',
      })
    );

    const res = await makeAdapter().chatCompletion(baseRequest());
    expect(res.choices[0].message?.content).toBe('hello there');
  });

  it('maps finish_reason MAX_TOKENS -> length, TOOL_CALL -> tool_calls, COMPLETE -> stop', async () => {
    const cases: Array<[string, string]> = [
      ['COMPLETE', 'stop'],
      ['STOP_SEQUENCE', 'stop'],
      ['MAX_TOKENS', 'length'],
      ['TOOL_CALL', 'tool_calls'],
      ['ERROR', 'stop'],
    ];
    for (const [vendorReason, expected] of cases) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({
          id: 'r1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
          finish_reason: vendorReason,
        })
      );
      const res = await makeAdapter().chatCompletion(baseRequest());
      expect(res.choices[0].finish_reason).toBe(expected);
    }
  });

  it('maps usage.tokens to prompt/completion/total tokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'r1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        finish_reason: 'COMPLETE',
        usage: {
          billed_units: { input_tokens: 3, output_tokens: 1 },
          tokens: { input_tokens: 215, output_tokens: 12 },
        },
      })
    );

    const res = await makeAdapter().chatCompletion(baseRequest());
    expect(res.usage).toEqual({ prompt_tokens: 215, completion_tokens: 12, total_tokens: 227 });
  });

  it('falls back to billed_units when tokens is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'r1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        finish_reason: 'COMPLETE',
        usage: { billed_units: { input_tokens: 17, output_tokens: 12 } },
      })
    );

    const res = await makeAdapter().chatCompletion(baseRequest());
    expect(res.usage).toEqual({ prompt_tokens: 17, completion_tokens: 12, total_tokens: 29 });
  });
});

describe('CohereAdapter — prompt-cache observability (usage.cached_tokens)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('records hit tokens and derives miss tokens when cached_tokens is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'r1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        finish_reason: 'COMPLETE',
        usage: { tokens: { input_tokens: 1000, output_tokens: 20 }, cached_tokens: 800 },
      })
    );
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');

    await makeAdapter().chatCompletion(baseRequest());

    expect((await cacheValue('hit')) - hitBefore).toBe(800);
    expect((await cacheValue('miss')) - missBefore).toBe(200);
  });

  it('is a no-op when cached_tokens is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'r1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        finish_reason: 'COMPLETE',
        usage: { tokens: { input_tokens: 5, output_tokens: 1 } },
      })
    );
    const hitBefore = await cacheValue('hit');

    await makeAdapter().chatCompletion(baseRequest());

    expect(await cacheValue('hit')).toBe(hitBefore);
  });

  it('does not change the returned ChatResponse.usage shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'r1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        finish_reason: 'COMPLETE',
        usage: { tokens: { input_tokens: 1000, output_tokens: 20 }, cached_tokens: 800 },
      })
    );

    const res = await makeAdapter().chatCompletion(baseRequest());
    expect(res.usage).toEqual({ prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 });
  });
});

describe('CohereAdapter — chatCompletionStream (v2 SSE events)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('yields text deltas from content-delta events and a final chunk from message-end', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify({ type: 'message-start', id: 'stream-1' })}\n\n`,
        `data: ${JSON.stringify({ type: 'content-start' })}\n\n`,
        `data: ${JSON.stringify({ type: 'content-delta', delta: { message: { content: { text: 'Hel' } } } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content-delta', delta: { message: { content: { text: 'lo' } } } })}\n\n`,
        `data: ${JSON.stringify({ type: 'content-end' })}\n\n`,
        `data: ${JSON.stringify({
          type: 'message-end',
          delta: {
            finish_reason: 'COMPLETE',
            usage: { tokens: { input_tokens: 10, output_tokens: 2 }, cached_tokens: 8 },
          },
        })}\n\n`,
      ])
    );

    const chunks = [];
    for await (const chunk of makeAdapter().chatCompletionStream(baseRequest())) {
      chunks.push(chunk);
    }

    const textChunks = chunks.filter((c) => c.choices[0].delta?.content);
    expect(textChunks.map((c) => c.choices[0].delta?.content)).toEqual(['Hel', 'lo']);
    expect(textChunks.every((c) => c.id === 'stream-1')).toBe(true);

    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.choices[0].finish_reason).toBe('stop');
    expect(finalChunk.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });

  it('records cache-hit tokens from the message-end usage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify({ type: 'message-start', id: 'stream-2' })}\n\n`,
        `data: ${JSON.stringify({
          type: 'message-end',
          delta: {
            finish_reason: 'COMPLETE',
            usage: { tokens: { input_tokens: 2000, output_tokens: 50 }, cached_tokens: 1900 },
          },
        })}\n\n`,
      ])
    );
    const hitBefore = await cacheValue('hit');

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of makeAdapter().chatCompletionStream(baseRequest())) {
      // drain
    }

    expect((await cacheValue('hit')) - hitBefore).toBe(1900);
  });
});

describe('CohereAdapter — embeddings + health check stay on v1', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('generateEmbeddings still posts to v1 /embed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ embeddings: [[0.1, 0.2]] })
    );

    await makeAdapter().generateEmbeddings({ input: 'hello' });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cohere.ai/v1/embed');
  });

  it('healthCheck still posts to v1 /check-api-key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({}));

    await makeAdapter().healthCheck();

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cohere.ai/v1/check-api-key');
  });
});

describe('CohereAdapter — chatV2BaseURL derivation with a custom baseUrl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('appends /v2 to a custom baseUrl with no version segment', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'r1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        finish_reason: 'COMPLETE',
      })
    );
    const adapter = new CohereAdapter({
      name: 'cohere',
      enabled: true,
      apiKey: 'k',
      baseUrl: 'https://my-proxy.example.com',
    });

    await adapter.chatCompletion(baseRequest());

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://my-proxy.example.com/v2/chat');
  });
});
