// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PerplexityAgentAdapter — unit tests against the REAL wire shapes.
 *
 * Every fixture in this file is verbatim (lightly trimmed) from live
 * captures against api.perplexity.ai on 2026-07-16 — not hand-invented.
 * The SSE fixture keeps the `event:` lines, the non-contiguous
 * sequence_numbers, and the missing `data: [DONE]` sentinel, because those
 * are exactly the quirks the parser must survive.
 */
import { describe, expect, it, vi } from 'vitest';
import { PerplexityAgentAdapter } from '../perplexity-agent-adapter';
import type { ChatRequest, ChatResponse } from '@/types';

function makeAdapter(): PerplexityAgentAdapter {
  return new PerplexityAgentAdapter({
    name: 'perplexity-agent',
    enabled: true,
    providerName: 'perplexity-agent',
    apiKey: 'test-key',
    baseUrl: 'https://api.perplexity.ai/v1',
  });
}

function sseResponse(sse: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** Captured live 2026-07-16 (claude-haiku-4-5, "Count from 1 to 5"). */
const LIVE_SSE_FIXTURE = `event: response.created
data: {"response":{"created_at":1784183995,"id":"resp_0f236545-9efc-4c3a-a481-3ba39fb44e00","model":"anthropic/claude-haiku-4-5","object":"response","output":[],"status":"in_progress","usage":null},"sequence_number":0,"type":"response.created"}

event: response.in_progress
data: {"response":{"created_at":1784183995,"id":"resp_0f236545-9efc-4c3a-a481-3ba39fb44e00","model":"anthropic/claude-haiku-4-5","object":"response","output":[],"status":"in_progress","usage":null},"sequence_number":1,"type":"response.in_progress"}

event: response.output_item.added
data: {"item":{"content":null,"id":"msg_0483c509-f60e-41a4-8b53-fe17b110dd1a","role":"assistant","status":"completed","type":"message"},"output_index":0,"sequence_number":4,"type":"response.output_item.added"}

event: response.output_text.delta
data: {"content_index":0,"delta":"1","item_id":"msg_0483c509-f60e-41a4-8b53-fe17b110dd1a","output_index":0,"sequence_number":5,"type":"response.output_text.delta"}

event: response.output_text.delta
data: {"content_index":0,"delta":"\\n2\\n3\\n4\\n5","item_id":"msg_0483c509-f60e-41a4-8b53-fe17b110dd1a","output_index":0,"sequence_number":6,"type":"response.output_text.delta"}

event: response.output_text.done
data: {"content_index":0,"item_id":"msg_0483c509-f60e-41a4-8b53-fe17b110dd1a","output_index":0,"sequence_number":8,"text":"1\\n2\\n3\\n4\\n5","type":"response.output_text.done"}

event: response.output_item.done
data: {"item":{"content":[{"annotations":[],"text":"1\\n2\\n3\\n4\\n5","type":"output_text"}],"id":"msg_0483c509-f60e-41a4-8b53-fe17b110dd1a","role":"assistant","status":"completed","type":"message"},"output_index":0,"sequence_number":9,"type":"response.output_item.done"}

event: response.completed
data: {"response":{"created_at":1784183995,"id":"resp_0f236545-9efc-4c3a-a481-3ba39fb44e00","model":"anthropic/claude-haiku-4-5","object":"response","output":[{"content":[{"annotations":[],"text":"1\\n2\\n3\\n4\\n5","type":"output_text"}],"id":"msg_0483c509-f60e-41a4-8b53-fe17b110dd1a","role":"assistant","status":"completed","type":"message"}],"status":"completed","usage":{"input_tokens":39,"input_tokens_details":{"cached_tokens":0},"output_tokens":13,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":52}},"sequence_number":10,"type":"response.completed"}
`;

const CHAT_REQUEST: ChatRequest = {
  model: 'anthropic/claude-haiku-4-5',
  messages: [{ role: 'user', content: 'Count from 1 to 5, digits only' }],
  max_tokens: 60,
};

async function collect(gen: AsyncGenerator<ChatResponse>): Promise<ChatResponse[]> {
  const out: ChatResponse[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe('PerplexityAgentAdapter — real SSE streaming', () => {
  it('parses the captured live event stream into OpenAI-style chunks', async () => {
    const adapter = makeAdapter();
    vi.spyOn(adapter, 'normalizeModelName').mockResolvedValue('anthropic/claude-haiku-4-5');
    const send = vi
      .spyOn(
        adapter as unknown as { sendJsonRequestWithRetry: (o: unknown) => Promise<Response> },
        'sendJsonRequestWithRetry',
      )
      .mockResolvedValue(sseResponse(LIVE_SSE_FIXTURE));

    const chunks = await collect(adapter.chatCompletionStream(CHAT_REQUEST));

    // stream=true must be on the outgoing payload
    const payload = (send.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload;
    expect(payload.stream).toBe(true);
    expect(payload.max_output_tokens).toBe(60);

    // 2 text deltas + 1 terminal chunk
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.choices[0]!.delta?.content).toBe('1');
    expect(chunks[1]!.choices[0]!.delta?.content).toBe('\n2\n3\n4\n5');
    expect(chunks[0]!.id).toBe('resp_0f236545-9efc-4c3a-a481-3ba39fb44e00');
    expect(chunks[0]!.created).toBe(1784183995);

    const terminal = chunks[2]!;
    expect(terminal.object).toBe('chat.completion.chunk');
    expect(terminal.choices[0]!.finish_reason).toBe('stop');
    expect(terminal.choices[0]!.delta?.content).toBe(''); // no repeated text
    expect(terminal.usage).toEqual({
      prompt_tokens: 39,
      completion_tokens: 13,
      total_tokens: 52,
    });
  });

  it('throws when the stream ends without response.completed (truncated upstream)', async () => {
    const adapter = makeAdapter();
    vi.spyOn(adapter, 'normalizeModelName').mockResolvedValue('anthropic/claude-haiku-4-5');
    const truncated = LIVE_SSE_FIXTURE.split('event: response.completed')[0]!;
    vi.spyOn(
      adapter as unknown as { sendJsonRequestWithRetry: (o: unknown) => Promise<Response> },
      'sendJsonRequestWithRetry',
    ).mockResolvedValue(sseResponse(truncated));

    await expect(collect(adapter.chatCompletionStream(CHAT_REQUEST))).rejects.toThrow(
      /ended without a response\.completed/,
    );
  });
});

describe('PerplexityAgentAdapter — tool calling', () => {
  it('sends flat Responses-style tools and maps function_call output to tool_calls', async () => {
    const adapter = makeAdapter();
    vi.spyOn(adapter, 'normalizeModelName').mockResolvedValue('anthropic/claude-haiku-4-5');
    // Non-streaming response shape captured live 2026-07-16 (tools probe).
    const send = vi
      .spyOn(
        adapter as unknown as { sendJsonRequestWithRetry: (o: unknown) => Promise<Response> },
        'sendJsonRequestWithRetry',
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'resp_tools_fixture',
            created_at: 1784184100,
            model: 'anthropic/claude-haiku-4-5',
            status: 'completed',
            output: [
              {
                arguments: '{"city": "Paris"}',
                call_id: 'toolu_bdrk_01KLxcJ4XGm6G6w5aZsyBmkD',
                id: 'fc_2722b03a-0000',
                name: 'get_weather',
                status: 'completed',
                type: 'function_call',
              },
            ],
            usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
          }),
          { status: 200 },
        ),
      );

    const result = await adapter.chatCompletion({
      ...CHAT_REQUEST,
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
    });

    // Outgoing: FLAT shape (no `function` wrapper) — confirmed live as the
    // only accepted shape.
    const payload = (send.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload;
    expect(payload.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);

    // Incoming: function_call item → OpenAI tool_calls, correlation id from
    // call_id (not the fc_ item id), finish_reason tool_calls.
    const choice = result.choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message?.tool_calls).toEqual([
      {
        id: 'toolu_bdrk_01KLxcJ4XGm6G6w5aZsyBmkD',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city": "Paris"}' },
      },
    ]);
  });
});
