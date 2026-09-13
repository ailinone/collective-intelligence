// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GoogleAdapter — streaming function-call support (LOTE AW Part 2b).
 *
 * Prior to this fix, `chatCompletionStream`'s request builder never included
 * a `tools` field at all — Gemini function calling was entirely unreachable
 * on the streaming path regardless of what the model supported. Auditing the
 * non-streaming path (`chatCompletion`) for a reference implementation to
 * mirror found the SAME gap there too: neither path ever sent `tools` to
 * Gemini, and neither ever parsed a `functionCall` response part. This fix
 * wires tool conversion into both request builders and parses `functionCall`
 * parts from the streaming response into OpenAI-compatible `tool_calls`
 * deltas (see `convertToolsToGemini` / `extractGoogleFunctionCalls`).
 *
 * These tests simulate a Gemini streaming response (the shape
 * `model.generateContentStream(...)`'s `.stream` async iterable yields) and
 * assert the adapter now produces `tool_calls` deltas and a corrected
 * `finish_reason`.
 */
import { describe, it, expect } from 'vitest';
import { GoogleAdapter } from '@/providers/google/google-adapter';
import type { ChatRequest, ToolCall } from '@/types';

interface FakeGeminiChunk {
  candidates: Array<{
    content?: { parts: Array<{ text?: string; functionCall?: { name: string; args: object } }> };
    finishReason?: string;
  }>;
}

async function* fakeGeminiStream(
  chunks: FakeGeminiChunk[]
): AsyncGenerator<FakeGeminiChunk, void, unknown> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** A single function call delivered whole in one chunk (Gemini does not fragment args). */
function singleFunctionCallChunks(): FakeGeminiChunk[] {
  return [
    {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'get_weather', args: { city: 'Lisbon' } } }],
          },
        },
      ],
    },
    {
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
    },
  ];
}

/** Text first, then a function call — a common Gemini turn shape. */
function textThenFunctionCallChunks(): FakeGeminiChunk[] {
  return [
    { candidates: [{ content: { parts: [{ text: 'Checking the weather now.' }] } }] },
    {
      candidates: [
        { content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Porto' } } }] } },
      ],
    },
    { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] },
  ];
}

/** Two function calls delivered together in one chunk (parallel calling). */
function parallelFunctionCallChunks(): FakeGeminiChunk[] {
  return [
    {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'get_weather', args: { city: 'Lisbon' } } },
              { functionCall: { name: 'get_time', args: { tz: 'UTC' } } },
            ],
          },
        },
      ],
    },
    { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] },
  ];
}

function buildAdapter(chunks: FakeGeminiChunk[]) {
  const adapter = new GoogleAdapter({ apiKey: 'AIzaTestKeyNotReal000000000000000' });
  const fakeModel = {
    generateContentStream: async () => ({ stream: fakeGeminiStream(chunks) }),
  };
  const fakeClient = { getGenerativeModel: () => fakeModel };
  (adapter as unknown as { client: unknown }).client = fakeClient;
  (adapter as unknown as { clientPool: unknown[] }).clientPool = [fakeClient];
  (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => fakeClient;
  (adapter as unknown as { normalizeModelName(m: string): Promise<string> }).normalizeModelName =
    async (m: string) => m;
  (
    adapter as unknown as {
      executeThroughBulkhead<T>(fn: () => Promise<T>): Promise<T>;
    }
  ).executeThroughBulkhead = async (fn) => fn();
  return adapter;
}

const REQUEST: ChatRequest = {
  model: 'gemini-2.5-pro',
  stream: true,
  messages: [{ role: 'user', content: "what's the weather in Lisbon?" }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
  ],
};

describe('GoogleAdapter streaming — functionCall parsing', () => {
  it('emits a complete tool_calls delta for a function call (Gemini does not fragment args)', async () => {
    const adapter = buildAdapter(singleFunctionCallChunks());
    const toolCalls: ToolCall[] = [];
    for await (const chunk of adapter.chatCompletionStream(REQUEST)) {
      if (chunk.choices[0]?.delta?.tool_calls) {
        toolCalls.push(...chunk.choices[0].delta.tool_calls);
      }
    }

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ type: 'function', index: 0 });
    expect(typeof toolCalls[0].id).toBe('string');
    expect(toolCalls[0].id.length).toBeGreaterThan(0);
    expect(toolCalls[0].function.name).toBe('get_weather');
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ city: 'Lisbon' });
  });

  it('corrects finish_reason to tool_calls even though Gemini itself reports STOP', async () => {
    const adapter = buildAdapter(singleFunctionCallChunks());
    const chunks = [];
    for await (const chunk of adapter.chatCompletionStream(REQUEST)) {
      chunks.push(chunk);
    }
    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk?.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('still streams preceding text content unaffected', async () => {
    const adapter = buildAdapter(textThenFunctionCallChunks());
    let text = '';
    const toolCalls: ToolCall[] = [];
    for await (const chunk of adapter.chatCompletionStream(REQUEST)) {
      if (typeof chunk.choices[0]?.delta?.content === 'string') {
        text += chunk.choices[0].delta.content;
      }
      if (chunk.choices[0]?.delta?.tool_calls) {
        toolCalls.push(...chunk.choices[0].delta.tool_calls);
      }
    }
    expect(text).toBe('Checking the weather now.');
    expect(toolCalls).toHaveLength(1);
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ city: 'Porto' });
  });

  it('assigns distinct sequential indices to parallel function calls in one chunk', async () => {
    const adapter = buildAdapter(parallelFunctionCallChunks());
    const toolCalls: ToolCall[] = [];
    for await (const chunk of adapter.chatCompletionStream(REQUEST)) {
      if (chunk.choices[0]?.delta?.tool_calls) {
        toolCalls.push(...chunk.choices[0].delta.tool_calls);
      }
    }

    expect(toolCalls).toHaveLength(2);
    expect(new Set(toolCalls.map((tc) => tc.index))).toEqual(new Set([0, 1]));
    expect(new Set(toolCalls.map((tc) => tc.id)).size).toBe(2); // distinct synthesized ids
    const byName = new Map(toolCalls.map((tc) => [tc.function.name, tc]));
    expect(JSON.parse(byName.get('get_weather')!.function.arguments)).toEqual({ city: 'Lisbon' });
    expect(JSON.parse(byName.get('get_time')!.function.arguments)).toEqual({ tz: 'UTC' });
  });

  it('sends tools to Gemini on the streaming request (previously omitted entirely)', async () => {
    let capturedRequest: { tools?: unknown } | undefined;
    const adapter = new GoogleAdapter({ apiKey: 'AIzaTestKeyNotReal000000000000000' });
    const fakeModel = {
      generateContentStream: async (req: { tools?: unknown }) => {
        capturedRequest = req;
        return { stream: fakeGeminiStream(singleFunctionCallChunks()) };
      },
    };
    const fakeClient = { getGenerativeModel: () => fakeModel };
    (adapter as unknown as { client: unknown }).client = fakeClient;
    (adapter as unknown as { clientPool: unknown[] }).clientPool = [fakeClient];
    (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => fakeClient;
    (adapter as unknown as { normalizeModelName(m: string): Promise<string> }).normalizeModelName =
      async (m: string) => m;
    (
      adapter as unknown as { executeThroughBulkhead<T>(fn: () => Promise<T>): Promise<T> }
    ).executeThroughBulkhead = async (fn) => fn();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of adapter.chatCompletionStream(REQUEST)) {
      // drain
    }

    expect(capturedRequest?.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get current weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      },
    ]);
  });
});
