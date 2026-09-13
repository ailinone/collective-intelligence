// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for AnthropicAdapter's native extended-thinking forwarding
 * (LOTE AZ follow-up, 2026-09).
 *
 * Audited gap: the codebase's canonical `reasoning_effort`/`thinking_budget`
 * (see `resolveReasoningEffort()`, `@/utils/reasoning-effort`) was never
 * forwarded to Claude's real `thinking: {type: 'enabled', budget_tokens}`
 * Messages API field — the adapter had zero support for it. These tests
 * cover:
 *   1. The `thinking` block is attached only for a Claude generation that
 *      actually supports it (3.7+ / 4.x+), never for 3.5 and earlier.
 *   2. `budget_tokens` is floored at Anthropic's documented minimum (1,024).
 *   3. `budget_tokens` never reaches (or exceeds) `max_tokens` — the API
 *      400s on that — `max_tokens` is raised, never the budget silently
 *      clipped.
 *   4. `temperature`/`top_p` are omitted once `thinking` is set (the API
 *      rejects them together).
 *   5. A model with no reasoning signal at all behaves exactly as before
 *      this change.
 *   6. The response side (non-streaming and streaming) surfaces the
 *      `thinking` content block as a `<think>...</think>`-wrapped prefix,
 *      the same convention DeepSeek-R1/QwQ's own native inline tags
 *      already use, so it flows through the existing reasoning-extraction
 *      pipeline unchanged.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '@/providers/anthropic/anthropic-adapter';
import type { ChatRequest } from '@/types';

type CreateArgs = {
  model: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  thinking?: { type: string; budget_tokens: number };
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

/** Builds an adapter whose SDK client is a recording stub — no network. */
function buildAdapter(createImpl: (args: CreateArgs) => unknown = () => OK_RESPONSE) {
  const calls: CreateArgs[] = [];
  const adapter = new AnthropicAdapter({ apiKey: 'test-key', maxRetries: 0 });
  const create = async (args: CreateArgs) => {
    calls.push(args);
    return createImpl(args);
  };
  const stub = { messages: { create } };
  (adapter as unknown as { client: unknown }).client = stub;
  (adapter as unknown as { clientPool: unknown[] }).clientPool = [stub];
  (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => stub;
  // Keep the model id verbatim so assertions stay readable.
  (adapter as unknown as { normalizeModelName(m: string): Promise<string> }).normalizeModelName =
    async (m: string) => m;
  return { adapter, calls };
}

function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'claude-opus-4-8', // Claude 4.8 — a generation that supports extended thinking
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatRequest;
}

describe('AnthropicAdapter — native extended thinking (request side)', () => {
  it('does not attach `thinking` when the request carries no reasoning signal', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(chatRequest({ temperature: 0.7 }));

    expect(calls[0].thinking).toBeUndefined();
    expect(calls[0].temperature).toBe(0.7);
    expect(calls[0].max_tokens).toBe(4096);
  });

  it('attaches `thinking` with the documented per-tier budget for reasoning_effort="high"', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(chatRequest({ reasoning_effort: 'high' }));

    expect(calls[0].thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
  });

  it('attaches `thinking` with the "low" tier budget for reasoning_effort="low"', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(chatRequest({ reasoning_effort: 'low' }));

    expect(calls[0].thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  it('defaults bare ailin_constraints.enable_reasoning to the "medium" tier budget', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({ ailin_constraints: { enable_reasoning: true } } as Partial<ChatRequest>)
    );

    expect(calls[0].thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('honors an explicit thinking_budget verbatim when it is already >= the API floor', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(chatRequest({ thinking_budget: 8000 }));

    expect(calls[0].thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
  });

  it('floors an explicit thinking_budget below Anthropic\'s 1,024 minimum', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(chatRequest({ thinking_budget: 200 }));

    expect(calls[0].thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  it('omits temperature and top_p once `thinking` is attached', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({ reasoning_effort: 'high', temperature: 0.9, top_p: 0.5 })
    );

    expect(calls[0].thinking).toBeDefined();
    expect('temperature' in calls[0]).toBe(false);
    expect('top_p' in calls[0]).toBe(false);
  });

  it('raises max_tokens so budget_tokens stays strictly below it', async () => {
    const { adapter, calls } = buildAdapter();
    // Default max_tokens (4096) < high-tier budget (16384) — must be raised.
    await adapter.chatCompletion(chatRequest({ reasoning_effort: 'high' }));

    expect(calls[0].max_tokens).toBeGreaterThan(calls[0].thinking!.budget_tokens);
    expect(calls[0].max_tokens).toBe(16384 + 1024);
  });

  it('bumps max_tokens even when the caller-specified value exactly equals the budget', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({ reasoning_effort: 'low', max_tokens: 1024 }) // budget === max_tokens
    );

    expect(calls[0].max_tokens).toBeGreaterThan(calls[0].thinking!.budget_tokens);
  });

  it('leaves an already-sufficient caller-specified max_tokens untouched', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(chatRequest({ reasoning_effort: 'low', max_tokens: 50000 }));

    expect(calls[0].max_tokens).toBe(50000);
  });

  it('does NOT attach `thinking` for a Claude 3.5 model even with a reasoning signal', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({ model: 'claude-3-5-sonnet-20241022', reasoning_effort: 'high', temperature: 0.7 })
    );

    expect(calls[0].thinking).toBeUndefined();
    // Falls back to the pre-existing sampling-parameter behavior untouched.
    expect(calls[0].temperature).toBe(0.7);
    expect(calls[0].max_tokens).toBe(4096);
  });

  it('does NOT attach `thinking` for a Claude 3 (bare major, no minor) model', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({ model: 'claude-3-opus-20240229', reasoning_effort: 'high' })
    );

    expect(calls[0].thinking).toBeUndefined();
  });

  it('DOES attach `thinking` for Claude 3.7', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({ model: 'claude-3-7-sonnet-latest', reasoning_effort: 'high' })
    );

    expect(calls[0].thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
  });

  it('DOES attach `thinking` for a Claude 4.x haiku', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({ model: 'claude-haiku-4-5-20251001', reasoning_effort: 'medium' })
    );

    expect(calls[0].thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('does not touch temperature/top_p for a capable model with no reasoning signal', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(chatRequest({ temperature: 0.3, top_p: 0.8 }));

    expect(calls[0].thinking).toBeUndefined();
    expect(calls[0].temperature).toBe(0.3);
    expect(calls[0].top_p).toBe(0.8);
  });
});

describe('AnthropicAdapter — native extended thinking (non-streaming response side)', () => {
  it('wraps a returned `thinking` content block in <think> tags ahead of the answer', async () => {
    const { adapter } = buildAdapter(() => ({
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [
        { type: 'thinking', thinking: 'step one, step two', signature: 'sig' },
        { type: 'text', text: 'final answer' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    const response = await adapter.chatCompletion(chatRequest({ reasoning_effort: 'high' }));

    expect(response.choices[0]?.message.content).toBe(
      '<think>step one, step two</think>\n\nfinal answer'
    );
  });

  it('leaves content untouched when the response has no thinking block', async () => {
    const { adapter } = buildAdapter(() => OK_RESPONSE);
    const response = await adapter.chatCompletion(chatRequest());

    expect(response.choices[0]?.message.content).toBe('ok');
  });

  it('does not surface a redacted_thinking block as visible text', async () => {
    const { adapter } = buildAdapter(() => ({
      id: 'msg_3',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [
        { type: 'redacted_thinking', data: 'opaque-encrypted-blob' },
        { type: 'text', text: 'final answer' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    const response = await adapter.chatCompletion(chatRequest({ reasoning_effort: 'high' }));

    expect(response.choices[0]?.message.content).toBe('final answer');
  });
});

describe('AnthropicAdapter — native extended thinking (streaming response side)', () => {
  type FakeEvent =
    | { type: 'message_start' }
    | { type: 'content_block_start'; index: number; content_block: Record<string, unknown> }
    | { type: 'content_block_delta'; index: number; delta: Record<string, unknown> }
    | { type: 'content_block_stop'; index: number }
    | { type: 'message_delta'; delta: { stop_reason: string | null } }
    | { type: 'message_stop' };

  async function* fakeStream(events: FakeEvent[]): AsyncGenerator<FakeEvent, void, unknown> {
    for (const event of events) yield event;
  }

  function buildStreamingAdapter(events: FakeEvent[]) {
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
    reasoning_effort: 'high',
    messages: [{ role: 'user', content: 'hi' }],
  } as ChatRequest;

  it('wraps thinking_delta fragments in <think>...</think> ahead of the text answer', async () => {
    const events: FakeEvent[] = [
      { type: 'message_start' },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'here' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the answer' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    const adapter = buildStreamingAdapter(events);

    let text = '';
    for await (const chunk of adapter.chatCompletionStream(REQUEST)) {
      if (typeof chunk.choices[0]?.delta?.content === 'string') {
        text += chunk.choices[0].delta.content;
      }
    }

    expect(text).toBe('<think>reasoning here</think>\n\nthe answer');
  });

  it('does not open/close a <think> tag for a redacted_thinking block', async () => {
    const events: FakeEvent[] = [
      { type: 'message_start' },
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer only' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    const adapter = buildStreamingAdapter(events);

    let text = '';
    for await (const chunk of adapter.chatCompletionStream(REQUEST)) {
      if (typeof chunk.choices[0]?.delta?.content === 'string') {
        text += chunk.choices[0].delta.content;
      }
    }

    expect(text).toBe('answer only');
  });
});
