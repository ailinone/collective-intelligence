// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * WatsonxAdapter — real `chat_stream` SSE streaming (audit fix, 2026-09-08).
 *
 * Prior to this fix, `chatCompletionStream` was an "honest placeholder"
 * that called the non-streaming `chatCompletion()` once and yielded the
 * single result — no incremental deltas at all, tool calls included.
 *
 * Per https://cloud.ibm.com/apidocs/watsonx-ai (endpoint listing:
 * `POST /ml/v1/text/chat_stream`) and
 * https://ibm.github.io/watsonx-ai-python-sdk/v1.7.1/fm_model.html
 * (`chat_stream(messages, params, tools, tool_choice, tool_choice_option)`
 * signature + its own `chunk["choices"][0]["delta"]` consumption example),
 * watsonx's chat surface is designed to be OpenAI-compatible — this adapter
 * now hits the real `chat_stream` endpoint and forwards each parsed SSE
 * `data:` payload as an OpenAI-shaped `chat.completion.chunk`, trusting the
 * same "already OpenAI-like" contract the non-streaming path already relies
 * on (see `chatCompletion`'s doc comment).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatsonxAdapter } from '../watsonx-adapter';
import type { ChatRequest } from '@/types';

const BASE = 'https://us-south.ml.cloud.ibm.com';
const IAM_URL = 'https://iam.cloud.ibm.com/identity/token';

function makeAdapter(): WatsonxAdapter {
  return new WatsonxAdapter({
    apiKey: 'ibm-apikey-123',
    baseUrl: BASE,
    projectId: 'project-abc',
  });
}

function iamTokenResponse(): Response {
  return new Response(
    JSON.stringify({ access_token: 'iam-access-1', expires_in: 3600, token_type: 'Bearer' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function sseResponse(dataPayloads: Array<Record<string, unknown> | '[DONE]'>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const payload of dataPayloads) {
        const line = payload === '[DONE]' ? '[DONE]' : JSON.stringify(payload);
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
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
    model: 'meta-llama/llama-3-1-70b-instruct',
    messages: [{ role: 'user', content: 'weather in Lisbon?' }],
    tools: TOOLS,
    ...overrides,
  };
}

describe('WatsonxAdapter — chatCompletionStream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /ml/v1/text/chat_stream (not /ml/v1/text/chat) with Accept: text/event-stream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === IAM_URL) return iamTokenResponse();
      if (u.includes('/ml/v1/text/chat_stream')) {
        return sseResponse([
          {
            id: 'r1',
            model_id: 'meta-llama/llama-3-1-70b-instruct',
            choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }],
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const adapter = makeAdapter();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of adapter.chatCompletionStream(baseRequest({ tools: undefined }))) {
      // drain
    }

    const streamCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/ml/v1/text/chat_stream'));
    expect(streamCall).toBeDefined();
    const [, init] = streamCall as [string, RequestInit];
    expect((init.headers as Record<string, string>).Accept).toBe('text/event-stream');
    // Must never hit the non-streaming endpoint for a streaming call.
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/ml/v1/text/chat?version=2024-05-31'))).toBe(
      false
    );
  });

  it('forwards tools/tool_choice in the chat_stream request body, same as non-streaming', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === IAM_URL) return iamTokenResponse();
      return sseResponse([]);
    });

    const adapter = makeAdapter();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of adapter.chatCompletionStream(baseRequest({ tool_choice: 'auto' }))) {
      // drain
    }

    const streamCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('chat_stream'));
    const [, init] = streamCall as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.tools).toEqual(TOOLS);
    expect(body.tool_choice).toBe('auto');
    expect(body.model_id).toBe('meta-llama/llama-3-1-70b-instruct');
    expect(body.project_id).toBe('project-abc');
  });

  it('forwards choices[].delta.tool_calls chunks verbatim (already OpenAI-shaped)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === IAM_URL) return iamTokenResponse();
      return sseResponse([
        {
          id: 'r1',
          model_id: 'meta-llama/llama-3-1-70b-instruct',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'r1',
          model_id: 'meta-llama/llama-3-1-70b-instruct',
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Lisbon"}' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'r1',
          model_id: 'meta-llama/llama-3-1-70b-instruct',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        },
        '[DONE]',
      ]);
    });

    const adapter = makeAdapter();
    const toolCalls: import('@/types').ToolCall[] = [];
    let finishReason: string | null = null;
    for await (const chunk of adapter.chatCompletionStream(baseRequest())) {
      expect(chunk.object).toBe('chat.completion.chunk');
      if (chunk.choices[0]?.delta?.tool_calls) toolCalls.push(...chunk.choices[0].delta.tool_calls);
      if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    }

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ id: 'call_1', index: 0, function: { name: 'get_weather' } });
    expect(toolCalls[1]).toMatchObject({ index: 0, function: { arguments: '{"city":"Lisbon"}' } });
    expect(finishReason).toBe('tool_calls');
  });

  it('normalizes model_id -> model on each chunk, same as the non-streaming path', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === IAM_URL) return iamTokenResponse();
      return sseResponse([
        {
          id: 'r1',
          model_id: 'meta-llama/llama-3-1-70b-instruct',
          choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
        },
      ]);
    });

    const adapter = makeAdapter();
    const models: string[] = [];
    for await (const chunk of adapter.chatCompletionStream(baseRequest({ tools: undefined }))) {
      models.push(chunk.model);
    }
    expect(models).toEqual(['meta-llama/llama-3-1-70b-instruct']);
  });

  it('throws WATSONX_PROJECT_ID error before ever hitting the network when projectId is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const adapter = new WatsonxAdapter({ apiKey: 'k', baseUrl: BASE, projectId: '' });
    await expect(async () => {
      for await (const _chunk of adapter.chatCompletionStream(baseRequest())) {
        // should throw before yielding
      }
    }).rejects.toThrow('WATSONX_PROJECT_ID');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
