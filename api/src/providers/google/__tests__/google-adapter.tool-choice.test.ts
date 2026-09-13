// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GoogleAdapter — `tool_choice` forwarding regression tests.
 *
 * Audited gap (tool-choice-forwarding investigation): `tools` were converted
 * via `convertToolsToGemini()` on both request builders, but no
 * `toolConfig.functionCallingConfig` was ever built from the incoming
 * `ChatRequest.tool_choice` — a client forcing a specific tool or
 * suppressing tool use for a turn was silently downgraded to Gemini's
 * default (unconstrained) behavior. These tests assert the fix: the
 * canonical OpenAI-shaped `tool_choice` now maps onto
 * `toolConfig.functionCallingConfig` (`mode: AUTO|ANY|NONE` +
 * `allowedFunctionNames`), on both the non-streaming and streaming request
 * builders. Mirrors google-adapter-thinking-config.test.ts's harness, which
 * captures the exact object passed to `generateContent`/`generateContentStream`.
 */
import { describe, it, expect } from 'vitest';
import { GoogleAdapter } from '@/providers/google/google-adapter';
import type { ChatRequest } from '@/types';

interface CapturedRequest {
  tools?: unknown;
  toolConfig?: { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } };
}

function fakeResponse() {
  return {
    response: {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    },
  };
}

/** Builds an adapter whose Gemini client stub captures the exact request object. */
function buildAdapter() {
  const adapter = new GoogleAdapter({ apiKey: 'AIzaTestKeyNotReal000000000000000' });
  let capturedRequest: CapturedRequest | undefined;

  const fakeModel = {
    generateContent: async (req: CapturedRequest) => {
      capturedRequest = req;
      return fakeResponse();
    },
    generateContentStream: async (req: CapturedRequest) => {
      capturedRequest = req;
      async function* empty() {
        yield { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] };
      }
      return { stream: empty() };
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

  return { adapter, getCapturedRequest: () => capturedRequest };
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
    messages: [{ role: 'user', content: 'hello' }],
    tools: TOOLS,
    ...overrides,
  };
}

describe.each([
  ['non-streaming', false],
  ['streaming', true],
] as const)('GoogleAdapter — tool_choice forwarding (%s)', (_label, stream) => {
  async function run(adapter: GoogleAdapter, request: ChatRequest): Promise<void> {
    if (stream) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of adapter.chatCompletionStream({ ...request, stream: true })) {
        // drain
      }
    } else {
      await adapter.chatCompletion(request);
    }
  }

  it("maps 'auto' to functionCallingConfig.mode='AUTO'", async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await run(adapter, baseRequest({ tool_choice: 'auto' }));
    expect(getCapturedRequest()?.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
  });

  it("maps 'none' to functionCallingConfig.mode='NONE'", async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await run(adapter, baseRequest({ tool_choice: 'none' }));
    expect(getCapturedRequest()?.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
  });

  it("maps 'required' to functionCallingConfig.mode='ANY' — NOT the same as 'auto'", async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await run(adapter, baseRequest({ tool_choice: 'required' as ChatRequest['tool_choice'] }));
    expect(getCapturedRequest()?.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
  });

  it('maps a forced function choice to mode=ANY + allowedFunctionNames', async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await run(
      adapter,
      baseRequest({ tool_choice: { type: 'function', function: { name: 'get_weather' } } })
    );
    expect(getCapturedRequest()?.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
  });

  it('omits toolConfig entirely when the caller sends none — preserves prior behavior', async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await run(adapter, baseRequest());
    expect(getCapturedRequest()?.toolConfig).toBeUndefined();
  });

  it('never sends toolConfig when there are no tools, even if the caller set one', async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await run(adapter, baseRequest({ tools: undefined, tool_choice: 'auto' }));
    expect(getCapturedRequest()?.toolConfig).toBeUndefined();
    expect(getCapturedRequest()?.tools).toBeUndefined();
  });
});
