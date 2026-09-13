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
 * `convertStreamChunk` had the same bug as the OpenAI-native adapter: real
 * OpenAI-compatible streaming sends `id` + `function.name` on the FIRST
 * delta chunk of a tool call only; every continuation chunk carries just
 * `{index, function: {arguments: <fragment>}}` (no `id`, no `name`). The old
 * guard required id+type+function.name to ALL be present on EVERY chunk, so
 * continuation-only fragments were silently dropped — truncating/corrupting
 * multi-fragment tool-call arguments for every hub-routed provider.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleHubAdapter } from '@/providers/openai-compatible-hub/openai-compatible-hub-adapter';
import { getModelsByProvider } from '@/services/model-catalog-service';
import type { ChatRequest, ChatResponse } from '@/types';

vi.mock('@/services/model-catalog-service', () => ({
  getModelsByProvider: vi.fn(),
}));

const mockedGetModelsByProvider = vi.mocked(getModelsByProvider);

function createAdapter(): OpenAICompatibleHubAdapter {
  return new OpenAICompatibleHubAdapter({
    name: 'orqai',
    providerName: 'orqai',
    apiKey: 'test-key',
    baseUrl: 'https://api.orq.ai/v2/router',
    enabled: true,
  });
}

/** Encodes a sequence of raw SSE `data:` payloads into one streaming Response. */
function sseResponse(payloads: Record<string, unknown>[]): Response {
  const lines = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`);
  lines.push('data: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const BASE_REQUEST: ChatRequest = {
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user', content: 'What is the weather in NYC?' }],
};

async function collectDeltaToolCalls(
  adapter: OpenAICompatibleHubAdapter,
  request: ChatRequest
): Promise<NonNullable<ChatResponse['choices'][number]['delta']['tool_calls']>[]> {
  const fragments: NonNullable<ChatResponse['choices'][number]['delta']['tool_calls']>[] = [];
  for await (const chunk of adapter.chatCompletionStream(request)) {
    const toolCalls = chunk.choices[0]?.delta?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      fragments.push(toolCalls);
    }
  }
  return fragments;
}

describe('OpenAICompatibleHubAdapter.chatCompletionStream — tool-call fragment reconstruction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetModelsByProvider.mockResolvedValue([]);
  });

  it('forwards a continuation-only fragment instead of dropping it, tagged with the right index/id/name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        {
          id: 'chatcmpl-1',
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
        // Continuation chunk: ONLY index + a fragment of arguments — no id,
        // no name. This is exactly the shape the old guard silently dropped.
        {
          id: 'chatcmpl-1',
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"location":' } }] }, finish_reason: null },
          ],
        },
        {
          id: 'chatcmpl-1',
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ])
    );

    const adapter = createAdapter();
    const fragments = await collectDeltaToolCalls(adapter, { ...BASE_REQUEST });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // All three chunks must survive — none dropped.
    expect(fragments).toHaveLength(3);

    const [first, second, third] = fragments;
    expect(first[0]).toMatchObject({
      index: 0,
      id: 'call_abc123',
      function: { name: 'get_weather', arguments: '' },
    });
    expect(second[0].index).toBe(0);
    expect(second[0].function.arguments).toBe('{"location":');
    expect(third[0].index).toBe(0);
    expect(third[0].function.arguments).toBe('"NYC"}');

    // Reconstructing via the standard OpenAI-client accumulation algorithm
    // (concatenate `arguments` per `index`) must yield the complete call.
    const reconstructedArgs = fragments
      .flat()
      .filter((tc) => tc.index === 0)
      .map((tc) => tc.function.arguments)
      .join('');
    expect(reconstructedArgs).toBe('{"location":"NYC"}');
    expect(JSON.parse(reconstructedArgs)).toEqual({ location: 'NYC' });
  });

  it('keeps two interleaved parallel tool calls correctly separated by index', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        {
          id: 'chatcmpl-2',
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
      ])
    );

    const adapter = createAdapter();
    const fragments = (await collectDeltaToolCalls(adapter, { ...BASE_REQUEST })).flat();

    const byIndex = (i: number) =>
      fragments.filter((tc) => tc.index === i).map((tc) => tc.function.arguments).join('');

    expect(byIndex(0)).toBe('{"loc":"NYC"}');
    expect(byIndex(1)).toBe('{"tz":"EST"}');
  });
});
