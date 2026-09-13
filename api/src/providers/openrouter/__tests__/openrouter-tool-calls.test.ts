// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OpenRouter adapter — tool call delivery, non-streaming and streaming.
 *
 * Reproduces two defects found while auditing why a tool-calling agent in
 * `ailinone/chat` intermittently answered from its prompt instead of executing
 * its tool. Both were specific to this adapter; every other adapter was correct.
 *
 *   1. Non-streaming mapped the upstream's `tool_calls` onto the key
 *      `toolCalls`, so `finish_reason` said `tool_calls` while the standard
 *      array was absent. Observed live in production.
 *
 *   2. `chatCompletionStream` was a SIMULATED stream: it called the
 *      non-streaming `chatCompletion()` internally, re-chunked
 *      `message.content` into fake ~20-char pieces with artificial
 *      `setTimeout` delays, and delivered the entire already-parsed
 *      `tool_calls` array in one final terminal chunk. A tool-call response
 *      has EMPTY content, so `chunks` was empty, the yield loop never ran,
 *      and the generator produced NOTHING — no content, no tool calls, not
 *      even a terminal frame. Time-to-first-byte also equalled full
 *      generation latency, since nothing was actually streamed.
 *
 *      LOTE AW Part 2b replaced this with a real proxy of OpenRouter's
 *      upstream SSE stream (see `iterateOpenRouterSseEvents` /
 *      `convertOpenRouterStreamChunk`), so the streaming tests below now
 *      feed genuine SSE `data:` events through the adapter's one network
 *      seam (`makeRequest`) instead of a pre-built non-streaming JSON body.
 *
 * Intermittency came from provider selection: only requests routed to
 * OpenRouter hit this, which is why it survived since the repo's first commit.
 *
 * These run without API keys or network — the live suites skip without provider
 * credentials, which is precisely how this went unnoticed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OpenRouterAdapter } from '@/providers/openrouter/openrouter-adapter';
import type { ChatRequest } from '@/types';

const TOOL_CALL = {
  id: 'call_abc123',
  type: 'function' as const,
  function: {
    name: 'conciliar_pis_cofins',
    arguments: '{"competencia":"09.2024","operation":"audit"}',
  },
};

/** Upstream OpenRouter payload for a tool call: content is empty, by spec. */
function upstreamToolCallResponse() {
  return {
    id: 'gen-1',
    model: 'some/model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '', tool_calls: [TOOL_CALL] },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function upstreamTextResponse() {
  return {
    id: 'gen-2',
    model: 'some/model',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
}

const REQUEST: ChatRequest = {
  model: 'some/model',
  messages: [{ role: 'user', content: 'audite a competencia 09.2024' }],
};

function buildAdapter(upstream: unknown): OpenRouterAdapter {
  const adapter = new OpenRouterAdapter({
    name: 'openrouter',
    apiKey: 'test-key-not-real',
    baseURL: 'https://openrouter.test/api/v1',
    enabled: true,
    priority: 1,
  } as never);

  // Stub the single network seam. Bypass the resilience wrapper too so the test
  // exercises the response MAPPING and nothing else.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).makeRequest = async () =>
    new Response(JSON.stringify(upstream), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).executeThroughBulkhead = async (fn: () => Promise<unknown>) => fn();

  return adapter;
}

/** Format one upstream OpenAI-shaped chunk object as an SSE `data:` frame. */
function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Build an adapter whose network seam returns a real SSE body (a sequence of
 * `data: {...}` frames terminated by `data: [DONE]`), the shape
 * `chatCompletionStream` now actually parses instead of the non-streaming
 * JSON body `buildAdapter` returns.
 */
function buildStreamingAdapter(events: unknown[]): OpenRouterAdapter {
  const adapter = new OpenRouterAdapter({
    name: 'openrouter',
    apiKey: 'test-key-not-real',
    baseURL: 'https://openrouter.test/api/v1',
    enabled: true,
    priority: 1,
  } as never);

  const body = events.map(sseFrame).join('') + 'data: [DONE]\n\n';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).makeRequest = async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).executeThroughBulkhead = async (fn: () => Promise<unknown>) => fn();

  return adapter;
}

/**
 * Upstream SSE events for a tool-calling turn: the first tool_calls delta
 * announces `id`/`function.name` (OpenAI convention), and the arguments
 * arrive as two separate fragments across later chunks — exercising the same
 * fragment-reassembly contract the OpenAI adapter already implements.
 */
function toolCallStreamEvents() {
  const argsFirstHalf = '{"competencia":"09.2024",';
  const argsSecondHalf = '"operation":"audit"}';
  // Sanity: the two fragments must reconstruct the exact TOOL_CALL arguments.
  if (argsFirstHalf + argsSecondHalf !== TOOL_CALL.function.arguments) {
    throw new Error('test fixture drift: fragments no longer match TOOL_CALL.function.arguments');
  }
  return [
    {
      id: 'gen-1',
      model: 'some/model',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    },
    {
      id: 'gen-1',
      model: 'some/model',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: TOOL_CALL.id,
                type: 'function',
                function: { name: TOOL_CALL.function.name, arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'gen-1',
      model: 'some/model',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: argsFirstHalf } }] },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'gen-1',
      model: 'some/model',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: argsSecondHalf } }] },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'gen-1',
      model: 'some/model',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ];
}

/** Upstream SSE events for an ordinary text turn, split across two chunks. */
function textStreamEvents() {
  return [
    {
      id: 'gen-2',
      model: 'some/model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }],
    },
    {
      id: 'gen-2',
      model: 'some/model',
      choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
    },
    {
      id: 'gen-2',
      model: 'some/model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
  ];
}

describe('OpenRouterAdapter tool call delivery', () => {
  describe('non-streaming', () => {
    let response: Awaited<ReturnType<OpenRouterAdapter['chatCompletion']>>;

    beforeEach(async () => {
      response = await buildAdapter(upstreamToolCallResponse()).chatCompletion(REQUEST);
    });

    it('delivers tool calls under the OpenAI-standard `tool_calls` key', () => {
      expect(response.choices[0]?.message?.tool_calls).toEqual([TOOL_CALL]);
    });

    it('does not emit the internal camelCase `toolCalls` key on the wire', () => {
      const message = response.choices[0]?.message as Record<string, unknown>;
      expect(Object.keys(message)).not.toContain('toolCalls');
    });

    it('does not emit a stray camelCase `finishReason` key', () => {
      const choice = response.choices[0] as unknown as Record<string, unknown>;
      expect(Object.keys(choice)).not.toContain('finishReason');
      expect(choice.finish_reason).toBe('tool_calls');
    });

    it('never claims finish_reason=tool_calls without delivering the calls', () => {
      const choice = response.choices[0];
      if (choice?.finish_reason === 'tool_calls') {
        expect(choice.message?.tool_calls?.length ?? 0).toBeGreaterThan(0);
      }
    });

    it('omits tool_calls entirely for an ordinary text response', async () => {
      const text = await buildAdapter(upstreamTextResponse()).chatCompletion(REQUEST);
      const message = text.choices[0]?.message as Record<string, unknown>;
      expect(message).not.toHaveProperty('tool_calls');
      expect(message.content).toBe('hello world');
      expect(text.choices[0]?.finish_reason).toBe('stop');
    });
  });

  describe('streaming', () => {
    async function collect(events: unknown[]) {
      const chunks = [];
      for await (const chunk of buildStreamingAdapter(events).chatCompletionStream(REQUEST)) {
        chunks.push(chunk);
      }
      return chunks;
    }

    it('yields at least a terminal frame for a tool-call response (empty content)', async () => {
      // The original bug: a tool-call response has empty `content`, so the
      // old re-chunking implementation produced zero chunks and an entirely
      // empty stream. The client saw nothing at all.
      const chunks = await collect(toolCallStreamEvents());
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('delivers the tool calls in the stream, reassembled from fragments', async () => {
      const chunks = await collect(toolCallStreamEvents());
      const deltas = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);

      // First delta announces id + name (OpenAI convention); every
      // continuation delta carries only an `arguments` fragment tagged with
      // the same `index` — never a repeated id/name.
      expect(deltas.length).toBeGreaterThanOrEqual(3);
      expect(deltas[0]).toMatchObject({
        id: TOOL_CALL.id,
        type: 'function',
        index: 0,
        function: { name: TOOL_CALL.function.name },
      });
      for (const delta of deltas) {
        expect(delta.index).toBe(0);
        expect(delta.id).toBe(TOOL_CALL.id);
        expect(delta.function.name).toBe(TOOL_CALL.function.name);
      }

      // Reassembling via the standard OpenAI-client `arguments += delta`
      // pattern must reproduce the exact final arguments string.
      const reassembledArgs = deltas.map((d) => d.function.arguments).join('');
      expect(reassembledArgs).toBe(TOOL_CALL.function.arguments);
    });

    it('delivers argument fragments incrementally, not as one final blob', async () => {
      // Proves this is a real chunk-by-chunk proxy, not the old
      // buffer-then-fake-chunk simulation: more than one delta must carry a
      // non-empty arguments fragment.
      const chunks = await collect(toolCallStreamEvents());
      const fragmentsWithArgs = chunks
        .flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
        .filter((tc) => tc.function.arguments.length > 0);
      expect(fragmentsWithArgs.length).toBeGreaterThanOrEqual(2);
    });

    it('sets finish_reason exactly once, on the final frame', async () => {
      const chunks = await collect(toolCallStreamEvents());
      const withFinish = chunks.filter((c) => c.choices[0]?.finish_reason);
      expect(withFinish).toHaveLength(1);
      expect(withFinish[0]).toBe(chunks[chunks.length - 1]);
      expect(withFinish[0]?.choices[0]?.finish_reason).toBe('tool_calls');
    });

    it('still streams ordinary text content in order', async () => {
      const chunks = await collect(textStreamEvents());
      const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
      expect(text).toBe('hello world');
      expect(chunks[chunks.length - 1]?.choices[0]?.finish_reason).toBe('stop');
    });

    it('carries usage on the terminal frame', async () => {
      const chunks = await collect(toolCallStreamEvents());
      expect(chunks[chunks.length - 1]?.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
    });
  });
});
