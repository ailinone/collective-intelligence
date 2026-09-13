// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * VertexAIAdapter — `tool_choice` forwarding regression tests.
 *
 * Audited gap (tool-choice-forwarding investigation): `payload.tools` was
 * built from `request.tools` in the shared `buildVertexAIPayload()` (used by
 * both `chatCompletion` and `chatCompletionStream`), but no
 * `toolConfig`/`functionCallingConfig` equivalent existed anywhere in this
 * file — a client forcing a specific tool or suppressing tool use for a
 * turn was silently downgraded to Vertex's default unconstrained behavior.
 * These tests assert the fix: the canonical OpenAI-shaped `tool_choice` now
 * maps onto `toolConfig.functionCallingConfig` (camelCase field names, per
 * Google's REST reference for the classic `:generateContent` /
 * `:streamGenerateContent` endpoints this adapter posts to), on both
 * request paths — which share the one payload builder, so exercising both
 * public methods covers the same code twice by construction, not by
 * accident.
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

/** Minimal non-streaming generateContent-shaped JSON response. */
function jsonResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/** A single-chunk SSE response, enough for chatCompletionStream to resolve. */
function sseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          })}\n\n`
        )
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
    messages: [{ role: 'user', content: 'weather?' }],
    tools: TOOLS,
    ...overrides,
  };
}

describe.each([
  ['non-streaming', false],
  ['streaming', true],
] as const)('VertexAIAdapter — tool_choice forwarding (%s)', (_label, stream) => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it("maps 'auto' to functionCallingConfig.mode='AUTO'", async () => {
    const body = await runAndCaptureBody(baseRequest({ tool_choice: 'auto' }));
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
  });

  it("maps 'none' to functionCallingConfig.mode='NONE'", async () => {
    const body = await runAndCaptureBody(baseRequest({ tool_choice: 'none' }));
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
  });

  it("maps 'required' to functionCallingConfig.mode='ANY' — NOT the same as 'auto'", async () => {
    const body = await runAndCaptureBody(
      baseRequest({ tool_choice: 'required' as ChatRequest['tool_choice'] })
    );
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
  });

  it('maps a forced function choice to mode=ANY + allowedFunctionNames', async () => {
    const body = await runAndCaptureBody(
      baseRequest({ tool_choice: { type: 'function', function: { name: 'get_weather' } } })
    );
    expect(body.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
  });

  it('omits toolConfig entirely when the caller sends none — preserves prior behavior', async () => {
    const body = await runAndCaptureBody(baseRequest());
    expect('toolConfig' in body).toBe(false);
  });

  it('never sends toolConfig when there are no tools, even if the caller set one', async () => {
    const body = await runAndCaptureBody(baseRequest({ tools: undefined, tool_choice: 'auto' }));
    expect('toolConfig' in body).toBe(false);
    expect('tools' in body).toBe(false);
  });
});
