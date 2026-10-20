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
 * DeepSeek-R1-class models stream their chain of thought on
 * `delta.reasoning_content`, distinct from `delta.content` — DeepSeek is the
 * ORIGIN of this convention, yet this adapter's chunk conversion dropped the
 * field silently, discarding the model's entire reasoning trace on every
 * streaming call. These tests pin the new contract: reasoning is forwarded
 * VERBATIM on the dedicated field and must NEVER appear inside `content`
 * (direct streaming consumers do not strip inline `<think>` tags — folding
 * reasoning into content leaks the entire chain of thought as visible answer
 * text).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter } from '../deepseek-adapter';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';
import type { ChatRequest } from '@/types';

function createAdapter(): DeepSeekAdapter {
  return new DeepSeekAdapter({ apiKey: 'test-key' });
}

/** Encodes a sequence of raw SSE `data:` payloads into one streaming Response. */
function sseResponse(payloads: Record<string, unknown>[]): Response {
  const lines = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`);
  lines.push('data: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const BASE_REQUEST: ChatRequest = {
  model: 'deepseek-reasoner',
  messages: [{ role: 'user', content: 'What is 17*23?' }],
};

describe('DeepSeekAdapter — dedicated reasoning_content channel (ci#750)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await distributedCircuitBreakerManager.getBreaker('deepseek-api').reset();
  });

  it('streams reasoning on delta.reasoning_content and keeps delta.content free of reasoning', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        {
          id: 'chatcmpl-r1',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', reasoning_content: '17*23 = ' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'chatcmpl-r1',
          choices: [{ index: 0, delta: { reasoning_content: '391' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-r1',
          choices: [
            { index: 0, delta: { content: 'The answer is 391.' }, finish_reason: 'stop' },
          ],
        },
      ])
    );

    const adapter = createAdapter();

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

  it('omits reasoning_content entirely when the provider sent none', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse([
        {
          id: 'chatcmpl-plain',
          choices: [
            { index: 0, delta: { role: 'assistant', content: 'plain answer' }, finish_reason: 'stop' },
          ],
        },
      ])
    );

    const adapter = createAdapter();
    for await (const chunk of adapter.chatCompletionStream(BASE_REQUEST)) {
      expect(chunk.choices[0]?.delta).not.toHaveProperty('reasoning_content');
    }
  });
});
