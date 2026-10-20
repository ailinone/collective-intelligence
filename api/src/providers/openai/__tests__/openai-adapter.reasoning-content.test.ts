// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ci#750 — dedicated reasoning channel (owner decision 2026-10-04).
 *
 * Reasoning models behind the OpenAI wire protocol (DeepSeek-style vendors)
 * stream their chain of thought on `delta.reasoning_content` and return it on
 * `message.reasoning_content`. The adapter previously DISCARDED that field
 * silently. These tests pin the new contract: reasoning is forwarded VERBATIM
 * on the dedicated field and must NEVER appear inside `content` (direct
 * streaming/non-streaming consumers do not strip inline `<think>` tags, so
 * folding reasoning into content leaks the entire chain of thought as visible
 * answer text).
 */
import { describe, it, expect } from 'vitest';
import { OpenAIAdapter } from '@/providers/openai/openai-adapter';
import type { ChatRequest } from '@/types';

type CreateArgs = Record<string, unknown>;

/** Minimal streaming-chunk shape the adapter reads, with the DeepSeek-style extension. */
interface FakeChunk {
  id: string;
  created: number;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string;
    };
    finish_reason: string | null;
  }>;
}

function buildAdapter(
  streamChunks: FakeChunk[],
  nonStreamingResponse?: Record<string, unknown>
) {
  const calls: CreateArgs[] = [];
  const adapter = new OpenAIAdapter({ apiKey: 'test-key', maxRetries: 0 });

  async function* fakeStream() {
    for (const chunk of streamChunks) yield chunk;
  }

  const create = async (args: CreateArgs) => {
    calls.push({ ...args });
    if (nonStreamingResponse) return nonStreamingResponse;
    return fakeStream();
  };
  const stub = { chat: { completions: { create } } };
  (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => stub;

  // Bypass catalog/DB lookups — assertions concern chunk conversion only.
  (
    adapter as unknown as { normalizeModelName(id: string): Promise<string> }
  ).normalizeModelName = async (id: string) => id;
  (
    adapter as unknown as { isChatCompletionModel(id: string): Promise<boolean> }
  ).isChatCompletionModel = async () => true;
  (
    adapter as unknown as { usesMaxCompletionTokens(id: string): Promise<boolean> }
  ).usesMaxCompletionTokens = async () => false;
  (
    adapter as unknown as { isReasoningEffortModel(id: string): Promise<boolean> }
  ).isReasoningEffortModel = async () => false;

  return { adapter, calls };
}

const BASE_REQUEST: ChatRequest = {
  model: 'deepseek-r1',
  messages: [{ role: 'user', content: 'What is 17*23?' }],
};

describe('OpenAIAdapter — dedicated reasoning_content channel (ci#750)', () => {
  it('streams reasoning on delta.reasoning_content and keeps delta.content free of reasoning', async () => {
    const chunks: FakeChunk[] = [
      {
        id: 'chatcmpl-r1',
        created: 1,
        choices: [
          { index: 0, delta: { role: 'assistant', reasoning_content: '17*23 = ' }, finish_reason: null },
        ],
      },
      {
        id: 'chatcmpl-r1',
        created: 2,
        choices: [
          { index: 0, delta: { reasoning_content: '391' }, finish_reason: null },
        ],
      },
      {
        id: 'chatcmpl-r1',
        created: 3,
        choices: [
          { index: 0, delta: { content: 'The answer is 391.' }, finish_reason: 'stop' },
        ],
      },
    ];

    const { adapter } = buildAdapter(chunks);

    let content = '';
    let reasoning = '';
    for await (const chunk of adapter.chatCompletionStream(BASE_REQUEST)) {
      const delta = chunk.choices[0]?.delta;
      if (typeof delta?.content === 'string') content += delta.content;
      if (typeof delta?.reasoning_content === 'string') reasoning += delta.reasoning_content;
    }

    expect(reasoning).toBe('17*23 = 391');
    expect(content).toBe('The answer is 391.');
    expect(content).not.toContain('17*23');
    expect(content).not.toContain('<think>');
  });

  it('forwards message.reasoning_content on the non-streaming path, keeping content clean', async () => {
    const { adapter } = buildAdapter([], {
      id: 'chatcmpl-nr',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-r1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'The answer is 391.',
            reasoning_content: 'secret chain of thought',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const response = await adapter.chatCompletion(BASE_REQUEST);

    expect(response.choices[0]?.message.content).toBe('The answer is 391.');
    expect(response.choices[0]?.message.reasoning_content).toBe('secret chain of thought');
  });

  it('omits reasoning_content entirely when the provider sent none', async () => {
    const { adapter } = buildAdapter([
      {
        id: 'chatcmpl-plain',
        created: 1,
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'plain answer' }, finish_reason: 'stop' },
        ],
      },
    ]);

    for await (const chunk of adapter.chatCompletionStream(BASE_REQUEST)) {
      expect(chunk.choices[0]?.delta).not.toHaveProperty('reasoning_content');
    }
  });
});
