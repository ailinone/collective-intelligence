// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * XAIAdapter — `tool_choice` forwarding regression tests.
 *
 * Audited gap (tool-choice-forwarding investigation): `tools: request.tools`
 * was present in both the non-streaming and streaming fetch bodies, but the
 * sibling `tool_choice` field was never read from the incoming `ChatRequest`
 * at all — a client forcing a specific tool or suppressing tool use for a
 * turn was silently downgraded to xAI's default `auto` behavior. xAI's chat
 * API is byte-identical to OpenAI here (confirmed against
 * https://docs.x.ai/docs/guides/function-calling), so the fix is a verbatim
 * passthrough. These tests assert it on both request bodies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { XAIAdapter } from '@/providers/xai/xai-adapter';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';
import type { ChatRequest } from '@/types';

function createAdapter(): XAIAdapter {
  return new XAIAdapter({ apiKey: 'test-key' });
}

/** A single-chunk SSE response, enough for chatCompletionStream to resolve. */
function sseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id: 'chatcmpl-1',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
          })}\n\n`
        )
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'x',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      model: 'grok-2-latest',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
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
    model: 'grok-2-latest',
    messages: [{ role: 'user', content: 'weather?' }],
    tools: TOOLS,
    ...overrides,
  };
}

describe.each([
  ['non-streaming', false],
  ['streaming', true],
] as const)('XAIAdapter — tool_choice forwarding (%s)', (_label, stream) => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await distributedCircuitBreakerManager.getBreaker('xai-api').reset();
  });

  async function runAndCaptureBody(request: ChatRequest): Promise<Record<string, unknown>> {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(stream ? sseResponse() : jsonResponse());
    const adapter = createAdapter();
    if (stream) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of adapter.chatCompletionStream({ ...request, stream: true })) {
        // drain
      }
    } else {
      await adapter.chatCompletion(request);
    }
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(init.body));
  }

  it("forwards 'auto' verbatim", async () => {
    const body = await runAndCaptureBody(baseRequest({ tool_choice: 'auto' }));
    expect(body.tool_choice).toBe('auto');
  });

  it("forwards 'none' verbatim", async () => {
    const body = await runAndCaptureBody(baseRequest({ tool_choice: 'none' }));
    expect(body.tool_choice).toBe('none');
  });

  it("forwards 'required' verbatim — xAI supports it byte-identically to OpenAI", async () => {
    const body = await runAndCaptureBody(
      baseRequest({ tool_choice: 'required' as ChatRequest['tool_choice'] })
    );
    expect(body.tool_choice).toBe('required');
  });

  it('forwards a forced function choice verbatim ({type, function:{name}})', async () => {
    const body = await runAndCaptureBody(
      baseRequest({ tool_choice: { type: 'function', function: { name: 'get_weather' } } })
    );
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('omits tool_choice entirely when the caller sends none — preserves prior behavior', async () => {
    const body = await runAndCaptureBody(baseRequest());
    expect('tool_choice' in body).toBe(false);
  });
});
