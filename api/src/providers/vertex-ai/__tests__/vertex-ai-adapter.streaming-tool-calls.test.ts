// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * VertexAIAdapter — endpoint-swap + functionCall streaming/parsing fix
 * (audit, 2026-09-08).
 *
 * Two independent, previously-broken things this file covers:
 *
 *  1. Endpoint swap: `chatCompletion` (non-streaming) was hitting
 *     `:streamGenerateContent` (returns a JSON ARRAY without `alt=sse`,
 *     which has no top-level `.candidates` — every non-streaming call threw
 *     "No response candidates from Vertex AI"), while `chatCompletionStream`
 *     was hitting `:generateContent` (a single JSON object, never `data: `
 *     SSE lines) and then trying to parse that body as SSE — yielding
 *     nothing at all, ever. Fixed per
 *     https://ai.google.dev/api/generate-content (fetched 2026-09-08):
 *     `:generateContent` for non-streaming, `:streamGenerateContent?alt=sse`
 *     for real SSE.
 *
 *  2. `functionCall` parts (`{name, args, id?}` per
 *     https://ai.google.dev/api/generate-content and
 *     https://ai.google.dev/gemini-api/docs/function-calling, fetched
 *     2026-09-08) were never read anywhere in this adapter — `tools` +
 *     a Gemini/Vertex model never surfaced a tool call, streaming or not.
 *     Also fixes a real mapping bug found alongside it: `finishReason:
 *     'RECITATION'` was incorrectly mapped to `'tool_calls'` (RECITATION is
 *     a content-safety-adjacent stoppage, unrelated to function calling).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VertexAIAdapter } from '@/providers/vertex-ai/vertex-ai-adapter';
import type { ChatRequest } from '@/types';

function createAdapter(): VertexAIAdapter {
  return new VertexAIAdapter({
    apiKey: 'test-key',
    projectId: 'test-project',
    useExpressMode: true,
  });
}

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(dataPayloads: Record<string, unknown>[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const payload of dataPayloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const TOOLS: ChatRequest['tools'] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  },
];

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', content: 'weather in Lisbon?' }],
    tools: TOOLS,
    ...overrides,
  };
}

describe('VertexAIAdapter — endpoint selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('chatCompletion (non-streaming) calls :generateContent, not :streamGenerateContent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })
    );
    const adapter = createAdapter();
    await adapter.chatCompletion(baseRequest({ tools: undefined }));

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain(':generateContent');
    expect(url).not.toContain(':streamGenerateContent');
  });

  it('chatCompletionStream calls :streamGenerateContent with alt=sse, not :generateContent', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        sseResponse([{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }])
      );
    const adapter = createAdapter();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of adapter.chatCompletionStream({
      ...baseRequest({ tools: undefined }),
      stream: true,
    })) {
      // drain
    }

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain(':streamGenerateContent');
    expect(url).toContain('alt=sse');
  });
});

describe('VertexAIAdapter — non-streaming functionCall parsing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts a functionCall part into OAI-shaped tool_calls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'get_weather', args: { city: 'Lisbon' } } }],
            },
            finishReason: 'STOP',
          },
        ],
      })
    );
    const adapter = createAdapter();
    const result = await adapter.chatCompletion(baseRequest());

    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message?.tool_calls).toHaveLength(1);
    const call = result.choices[0].message!.tool_calls![0];
    expect(call.function.name).toBe('get_weather');
    expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Lisbon' });
  });

  it('uses functionCall.id when present (parallel-call correlation)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { id: 'call-xyz', name: 'get_weather', args: { city: 'Porto' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      })
    );
    const adapter = createAdapter();
    const result = await adapter.chatCompletion(baseRequest());
    expect(result.choices[0].message?.tool_calls?.[0].id).toBe('call-xyz');
  });

  it('does NOT map RECITATION to tool_calls (bug fix — recitation is content-safety, not tool use)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'RECITATION' }],
      })
    );
    const adapter = createAdapter();
    const result = await adapter.chatCompletion(baseRequest({ tools: undefined }));
    expect(result.choices[0].finish_reason).toBe('content_filter');
  });

  it('still returns plain text + finish_reason "stop" when there is no functionCall part', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'Hi there' }] }, finishReason: 'STOP' }] })
    );
    const adapter = createAdapter();
    const result = await adapter.chatCompletion(baseRequest({ tools: undefined }));
    expect(result.choices[0].message?.content).toBe('Hi there');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.choices[0].message?.tool_calls).toBeUndefined();
  });
});

describe('VertexAIAdapter — streaming functionCall deltas', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a tool_calls delta chunk for a functionCall part in an SSE chunk', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Lisbon' } } }] },
              finishReason: 'STOP',
            },
          ],
        },
      ])
    );
    const adapter = createAdapter();
    const toolCalls: import('@/types').ToolCall[] = [];
    for await (const chunk of adapter.chatCompletionStream({ ...baseRequest(), stream: true })) {
      if (chunk.choices[0]?.delta?.tool_calls) toolCalls.push(...chunk.choices[0].delta.tool_calls);
    }
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe('get_weather');
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ city: 'Lisbon' });
  });

  it('emits a terminal finish_reason "tool_calls" chunk even with zero accumulated text (bug fix)', async () => {
    // Regression test: the prior gating condition `accumulatedContent &&
    // finishReason` meant a pure tool-call turn (no text at all) never got
    // its terminal finish_reason chunk sent.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Lisbon' } } }] },
              finishReason: 'STOP',
            },
          ],
        },
      ])
    );
    const adapter = createAdapter();
    const chunks: import('@/types').ChatResponse[] = [];
    for await (const chunk of adapter.chatCompletionStream({ ...baseRequest(), stream: true })) {
      chunks.push(chunk);
    }
    const withFinish = chunks.filter((c) => c.choices[0]?.finish_reason !== null);
    expect(withFinish).toHaveLength(1);
    expect(withFinish[0]?.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('assigns sequential indices to multiple functionCall parts across chunks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        {
          candidates: [
            { content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Lisbon' } } }] } },
          ],
        },
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'get_time', args: { tz: 'UTC' } } }] },
              finishReason: 'STOP',
            },
          ],
        },
      ])
    );
    const adapter = createAdapter();
    const toolCalls: import('@/types').ToolCall[] = [];
    for await (const chunk of adapter.chatCompletionStream({ ...baseRequest(), stream: true })) {
      if (chunk.choices[0]?.delta?.tool_calls) toolCalls.push(...chunk.choices[0].delta.tool_calls);
    }
    expect(toolCalls.map((tc) => tc.index)).toEqual([0, 1]);
  });
});
