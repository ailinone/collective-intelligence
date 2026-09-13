// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * AnthropicAdapter — `tool_choice` forwarding regression tests.
 *
 * Audited gap (tool-choice-forwarding investigation): `tools` was correctly
 * forwarded on both the non-streaming and streaming request builders, but
 * the sibling `tool_choice` field was never read from the incoming
 * `ChatRequest` at all — a client asking to force a specific tool
 * (`tool_choice: {type:'function', function:{name}}`) or suppress tool use
 * for a turn (`tool_choice: 'none'`) was silently downgraded to Anthropic's
 * default `auto` behavior. These tests assert the fix: the canonical
 * OpenAI-shaped `tool_choice` now maps onto the Messages API's own
 * `{type:'auto'|'any'|'tool'|'none'}` shape, on both request builders.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '@/providers/anthropic/anthropic-adapter';
import type { ChatRequest } from '@/types';

type CreateArgs = {
  model: string;
  stream?: boolean;
  tools?: unknown;
  tool_choice?: unknown;
  [k: string]: unknown;
};

const OK_RESPONSE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

/** A trivial empty async iterable — enough for chatCompletionStream to drain. */
async function* emptyStream(): AsyncGenerator<unknown, void, unknown> {
  yield { type: 'message_start' };
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
  yield { type: 'message_stop' };
}

/**
 * Builds an adapter whose SDK client is replaced by a recording stub, so we
 * can assert on the exact payload without touching the network. Mirrors
 * anthropic-adapter.sampling-params.test.ts's harness.
 */
function buildAdapter() {
  const calls: CreateArgs[] = [];
  const adapter = new AnthropicAdapter({ apiKey: 'test-key', maxRetries: 0 });
  const create = async (args: CreateArgs) => {
    calls.push(args);
    return args.stream ? emptyStream() : OK_RESPONSE;
  };
  const stub = { messages: { create } };
  (adapter as unknown as { client: unknown }).client = stub;
  (adapter as unknown as { clientPool: unknown[] }).clientPool = [stub];
  (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => stub;
  (adapter as unknown as { normalizeModelName(m: string): Promise<string> }).normalizeModelName =
    async (m: string) => m;
  return { adapter, calls };
}

const TOOLS: ChatRequest['tools'] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  },
];

function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'weather?' }],
    tools: TOOLS,
    ...overrides,
  } as ChatRequest;
}

describe.each([
  ['non-streaming', false],
  ['streaming', true],
] as const)('AnthropicAdapter — tool_choice forwarding (%s)', (_label, stream) => {
  async function run(adapter: AnthropicAdapter, request: ChatRequest): Promise<void> {
    if (stream) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of adapter.chatCompletionStream({ ...request, stream: true })) {
        // drain
      }
    } else {
      await adapter.chatCompletion(request);
    }
  }

  it("maps 'auto' to {type:'auto'}", async () => {
    const { adapter, calls } = buildAdapter();
    await run(adapter, chatRequest({ tool_choice: 'auto' }));
    expect(calls[0].tool_choice).toEqual({ type: 'auto' });
  });

  it("maps 'none' to {type:'none'}", async () => {
    const { adapter, calls } = buildAdapter();
    await run(adapter, chatRequest({ tool_choice: 'none' }));
    expect(calls[0].tool_choice).toEqual({ type: 'none' });
  });

  it("maps 'required' to {type:'any'} — NOT the same as 'auto'", async () => {
    const { adapter, calls } = buildAdapter();
    // 'required' isn't in ChatRequest['tool_choice']'s narrow type today;
    // a real OpenAI-compatible caller can still send it at runtime.
    await run(adapter, chatRequest({ tool_choice: 'required' as ChatRequest['tool_choice'] }));
    expect(calls[0].tool_choice).toEqual({ type: 'any' });
  });

  it("maps a forced function choice to {type:'tool', name}", async () => {
    const { adapter, calls } = buildAdapter();
    await run(
      adapter,
      chatRequest({ tool_choice: { type: 'function', function: { name: 'get_weather' } } })
    );
    expect(calls[0].tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
  });

  it('omits tool_choice entirely when the caller sends none — preserves prior behavior', async () => {
    const { adapter, calls } = buildAdapter();
    await run(adapter, chatRequest());
    expect('tool_choice' in calls[0]).toBe(false);
  });

  it('never sends tool_choice when there are no tools, even if the caller set one', async () => {
    const { adapter, calls } = buildAdapter();
    await run(adapter, chatRequest({ tools: undefined, tool_choice: 'auto' }));
    expect('tool_choice' in calls[0]).toBe(false);
    expect('tools' in calls[0]).toBe(false);
  });
});
