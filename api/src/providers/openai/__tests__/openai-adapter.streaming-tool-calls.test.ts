// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for LOTE AW — Part 2a (streaming tool-call foundation).
 *
 * Two bugs fixed here, both in `chatCompletionStream`/`convertStreamChunk`:
 *
 * 1. Real OpenAI streaming sends `id` + `function.name` on the FIRST delta
 *    chunk of a tool call only; every continuation chunk carries just
 *    `{index, function: {arguments: <fragment>}}` (no `id`, no `name`). The
 *    old guard required id+name+arguments to ALL be present on EVERY chunk,
 *    so continuation-only fragments were silently dropped, truncating or
 *    corrupting multi-fragment tool-call arguments.
 *
 * 2. `chatCompletionStream` hardcoded
 *    `optimizedMaxTokens = Math.min(request.max_tokens || 2000, 4000)`,
 *    capping every streaming request's completion length at 4000 tokens
 *    regardless of what the caller asked for — a cap that does not exist on
 *    the non-streaming path.
 */
import { describe, it, expect } from 'vitest';
import { OpenAIAdapter } from '@/providers/openai/openai-adapter';
import type { ChatRequest, ChatResponse } from '@/types';

type CreateArgs = Record<string, unknown>;

/** Minimal shape of an OpenAI SDK streaming chunk, just what the adapter reads. */
interface FakeChunk {
  id: string;
  created: number;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
}

function buildAdapter(streamChunks: FakeChunk[]) {
  const calls: CreateArgs[] = [];
  const adapter = new OpenAIAdapter({ apiKey: 'test-key', maxRetries: 0 });

  async function* fakeStream() {
    for (const chunk of streamChunks) {
      yield chunk;
    }
  }

  const create = async (args: CreateArgs) => {
    calls.push({ ...args });
    return fakeStream();
  };
  const stub = { chat: { completions: { create } } };
  (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => stub;

  // Bypass catalog/DB lookups that isChatCompletionModel/usesMaxCompletionTokens
  // would otherwise attempt — none of this test's assertions concern model
  // metadata resolution, only request-building and stream-chunk conversion.
  (
    adapter as unknown as { normalizeModelName(id: string): Promise<string> }
  ).normalizeModelName = async (id: string) => id;
  (
    adapter as unknown as { isChatCompletionModel(id: string): Promise<boolean> }
  ).isChatCompletionModel = async () => true;
  (
    adapter as unknown as { usesMaxCompletionTokens(id: string): Promise<boolean> }
  ).usesMaxCompletionTokens = async () => false;

  return { adapter, calls };
}

const BASE_REQUEST: ChatRequest = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'What is the weather in NYC?' }],
};

async function collectDeltaToolCalls(
  adapter: OpenAIAdapter,
  request: ChatRequest
): Promise<ChatResponse['choices'][number]['delta']['tool_calls'][]> {
  const fragments: ChatResponse['choices'][number]['delta']['tool_calls'][] = [];
  for await (const chunk of adapter.chatCompletionStream(request)) {
    const toolCalls = chunk.choices[0]?.delta?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      fragments.push(toolCalls);
    }
  }
  return fragments;
}

describe('OpenAIAdapter.chatCompletionStream — tool-call fragment reconstruction', () => {
  it('forwards a continuation-only fragment instead of dropping it, tagged with the right index/id/name', async () => {
    const chunks: FakeChunk[] = [
      // First chunk: real OpenAI protocol — id + name present, arguments starts empty.
      {
        id: 'chatcmpl-1',
        created: 1,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                { index: 0, id: 'call_abc123', type: 'function', function: { name: 'get_weather', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      // Continuation chunk: ONLY index + a fragment of arguments. No id, no name —
      // this is exactly the shape the old guard silently dropped.
      {
        id: 'chatcmpl-1',
        created: 2,
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"location":' } }] }, finish_reason: null },
        ],
      },
      {
        id: 'chatcmpl-1',
        created: 3,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ];

    const { adapter } = buildAdapter(chunks);
    const request: ChatRequest = { ...BASE_REQUEST };
    const fragments = await collectDeltaToolCalls(adapter, request);

    // All three chunks must survive — none dropped.
    expect(fragments).toHaveLength(3);

    const [first, second, third] = fragments as Array<
      NonNullable<ChatResponse['choices'][number]['delta']['tool_calls']>
    >;

    expect(first[0]).toMatchObject({
      index: 0,
      id: 'call_abc123',
      function: { name: 'get_weather', arguments: '' },
    });

    // The continuation fragments must be forwarded (not dropped) and tagged
    // with the same index so a caller can correlate them.
    expect(second[0].index).toBe(0);
    expect(second[0].function.arguments).toBe('{"location":');
    expect(third[0].index).toBe(0);
    expect(third[0].function.arguments).toBe('"NYC"}');

    // Reconstructing via the standard OpenAI-client accumulation algorithm
    // (concatenate `arguments` per `index`) must yield the complete call.
    const reconstructedArgs = fragments
      .flatMap((f) => f ?? [])
      .filter((tc) => tc.index === 0)
      .map((tc) => tc.function.arguments)
      .join('');
    expect(reconstructedArgs).toBe('{"location":"NYC"}');
    expect(JSON.parse(reconstructedArgs)).toEqual({ location: 'NYC' });
  });

  it('keeps two interleaved parallel tool calls correctly separated by index', async () => {
    const chunks: FakeChunk[] = [
      {
        id: 'chatcmpl-2',
        created: 1,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_A', type: 'function', function: { name: 'get_weather', arguments: '' } },
                { index: 1, id: 'call_B', type: 'function', function: { name: 'get_time', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-2',
        created: 2,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: '{"tz":"EST"}' } },
                { index: 0, function: { arguments: '{"loc":"NYC"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ];

    const { adapter } = buildAdapter(chunks);
    const fragments = (await collectDeltaToolCalls(adapter, { ...BASE_REQUEST })).flatMap(
      (f) => f ?? []
    );

    const byIndex = (i: number) =>
      fragments.filter((tc) => tc.index === i).map((tc) => tc.function.arguments).join('');

    expect(byIndex(0)).toBe('{"loc":"NYC"}');
    expect(byIndex(1)).toBe('{"tz":"EST"}');
  });
});

describe('OpenAIAdapter.chatCompletionStream — max_tokens is not capped', () => {
  it('passes a large caller-requested max_tokens through uncapped, matching the non-streaming default behavior', async () => {
    const { adapter, calls } = buildAdapter([
      { id: 'chatcmpl-3', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);

    const LARGE_MAX_TOKENS = 16000;
    const request: ChatRequest = { ...BASE_REQUEST, max_tokens: LARGE_MAX_TOKENS };

    // Drain the generator so the request is actually issued.
    for await (const _chunk of adapter.chatCompletionStream(request)) {
      // no-op
    }

    expect(calls).toHaveLength(1);
    // usesMaxCompletionTokens is stubbed to false above, so this provider
    // uses the legacy `max_tokens` field.
    expect(calls[0].max_tokens).toBe(LARGE_MAX_TOKENS);
    expect(calls[0].max_tokens).not.toBe(4000);
  });

  it('still defaults to 1000 (matching the non-streaming path) when the caller omits max_tokens', async () => {
    const { adapter, calls } = buildAdapter([
      { id: 'chatcmpl-4', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);

    for await (const _chunk of adapter.chatCompletionStream({ ...BASE_REQUEST })) {
      // no-op
    }

    expect(calls[0].max_tokens).toBe(1000);
  });
});
