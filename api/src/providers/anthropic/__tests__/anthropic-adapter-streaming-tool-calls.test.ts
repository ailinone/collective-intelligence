// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * AnthropicAdapter — streaming tool-call reconstruction (LOTE AW Part 2b).
 *
 * Prior to this fix, `chatCompletionStream`'s read loop only inspected
 * `content_block_delta` events whose `delta.type === 'text_delta'`. Anthropic
 * announces a `tool_use` block's `id`/`name` via `content_block_start` and
 * streams its arguments incrementally via `content_block_delta` events with
 * `delta.type === 'input_json_delta'` — neither was ever inspected, so
 * `stream: true` + `tools` on an Anthropic-backed model silently dropped every
 * tool call from the stream. Non-streaming was already correct; only the
 * streaming path was broken.
 *
 * These tests simulate a real Anthropic SSE stream (as the `@anthropic-ai/sdk`
 * client would already have parsed it into `RawMessageStreamEvent`s) and
 * assert the adapter now reconstructs OpenAI-compatible `tool_calls` deltas.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '@/providers/anthropic/anthropic-adapter';
import type { ChatRequest, ToolCall } from '@/types';

/** Minimal Anthropic RawMessageStreamEvent shapes this adapter reads. */
type FakeEvent =
  | { type: 'message_start' }
  | { type: 'content_block_start'; index: number; content_block: Record<string, unknown> }
  | { type: 'content_block_delta'; index: number; delta: Record<string, unknown> }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string | null } }
  | { type: 'message_stop' };

async function* fakeStream(events: FakeEvent[]): AsyncGenerator<FakeEvent, void, unknown> {
  for (const event of events) {
    yield event;
  }
}

/**
 * A single tool_use block ("get_weather") whose arguments arrive as two
 * `input_json_delta` fragments — mirrors real Anthropic streaming, which
 * never delivers a tool call's arguments as one atomic chunk.
 */
function singleToolCallEvents(): FakeEvent[] {
  return [
    { type: 'message_start' },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_01abc', name: 'get_weather', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"Lisbon"}' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
}

/** Text before a tool call — Claude commonly emits a text block, then calls a tool. */
function textThenToolCallEvents(): FakeEvent[] {
  return [
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Let me check that for you.' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_02def', name: 'get_weather', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"city":"Porto"}' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
}

/** Two parallel tool calls in one turn, fragments interleaved across blocks. */
function parallelToolCallEvents(): FakeEvent[] {
  return [
    { type: 'message_start' },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_call_a', name: 'get_weather', input: {} },
    },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_call_b', name: 'get_time', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":"Lisbon"}' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"tz":"UTC"}' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
}

function buildAdapter(events: FakeEvent[]) {
  const adapter = new AnthropicAdapter({ apiKey: 'test-key', maxRetries: 0 });
  const create = async () => fakeStream(events);
  const stub = { messages: { create } };
  (adapter as unknown as { client: unknown }).client = stub;
  (adapter as unknown as { clientPool: unknown[] }).clientPool = [stub];
  (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => stub;
  (adapter as unknown as { normalizeModelName(m: string): Promise<string> }).normalizeModelName =
    async (m: string) => m;
  return adapter;
}

const REQUEST: ChatRequest = {
  model: 'claude-opus-4-8',
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

async function collectToolCalls(adapter: AnthropicAdapter): Promise<ToolCall[]> {
  const collected: ToolCall[] = [];
  for await (const chunk of adapter.chatCompletionStream(REQUEST)) {
    const toolCalls = chunk.choices[0]?.delta?.tool_calls;
    if (toolCalls) collected.push(...toolCalls);
  }
  return collected;
}

describe('AnthropicAdapter streaming — tool_use reconstruction', () => {
  it('emits a tool_calls delta announcing id + name from content_block_start', async () => {
    const adapter = buildAdapter(singleToolCallEvents());
    const deltas = await collectToolCalls(adapter);

    expect(deltas.length).toBeGreaterThanOrEqual(3); // announce + 2 argument fragments
    expect(deltas[0]).toMatchObject({
      id: 'toolu_01abc',
      type: 'function',
      index: 0,
      function: { name: 'get_weather', arguments: '' },
    });
  });

  it('streams input_json_delta fragments tagged with the same id/name/index', async () => {
    const adapter = buildAdapter(singleToolCallEvents());
    const deltas = await collectToolCalls(adapter);

    for (const delta of deltas) {
      expect(delta.id).toBe('toolu_01abc');
      expect(delta.function.name).toBe('get_weather');
      expect(delta.index).toBe(0);
    }

    // Reassembling via the standard `arguments += delta` pattern must
    // reproduce the exact complete JSON arguments.
    const reassembled = deltas.map((d) => d.function.arguments).join('');
    expect(reassembled).toBe('{"city":"Lisbon"}');
    expect(() => JSON.parse(reassembled)).not.toThrow();
    expect(JSON.parse(reassembled)).toEqual({ city: 'Lisbon' });
  });

  it('still streams the text block before the tool call, unaffected', async () => {
    const adapter = buildAdapter(textThenToolCallEvents());
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
    expect(text).toBe('Let me check that for you.');
    // Anthropic's own content-block index for this block is 1 (index 0 was
    // text) — the adapter must remap it to a dense zero-based tool-call
    // index, not forward Anthropic's raw block index.
    expect(toolCalls[0]).toMatchObject({ id: 'toolu_02def', index: 0 });
    const args = toolCalls.map((tc) => tc.function.arguments).join('');
    expect(JSON.parse(args)).toEqual({ city: 'Porto' });
  });

  it('keys concurrent (parallel) tool calls by index, not delivery order', async () => {
    const adapter = buildAdapter(parallelToolCallEvents());
    const deltas = await collectToolCalls(adapter);

    const byIndex = new Map<number, ToolCall[]>();
    for (const delta of deltas) {
      const bucket = byIndex.get(delta.index!) ?? [];
      bucket.push(delta);
      byIndex.set(delta.index!, bucket);
    }

    expect(byIndex.size).toBe(2);
    const callA = byIndex.get(0)!;
    const callB = byIndex.get(1)!;
    expect(callA.every((d) => d.id === 'toolu_call_a' && d.function.name === 'get_weather')).toBe(
      true
    );
    expect(callB.every((d) => d.id === 'toolu_call_b' && d.function.name === 'get_time')).toBe(
      true
    );
    expect(JSON.parse(callA.map((d) => d.function.arguments).join(''))).toEqual({
      city: 'Lisbon',
    });
    expect(JSON.parse(callB.map((d) => d.function.arguments).join(''))).toEqual({ tz: 'UTC' });
  });

  it('emits a terminal finish_reason of tool_calls, mapped from message_delta.stop_reason', async () => {
    const adapter = buildAdapter(singleToolCallEvents());
    const chunks = [];
    for await (const chunk of adapter.chatCompletionStream(REQUEST)) {
      chunks.push(chunk);
    }
    const withFinish = chunks.filter((c) => c.choices[0]?.finish_reason !== null);
    expect(withFinish).toHaveLength(1);
    expect(withFinish[0]?.choices[0]?.finish_reason).toBe('tool_calls');
    // Terminal chunk carries no tool_calls of its own — it is purely the
    // finish-reason frame.
    expect(withFinish[0]?.choices[0]?.delta?.tool_calls).toBeUndefined();
  });
});
