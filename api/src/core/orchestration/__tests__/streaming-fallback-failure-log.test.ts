// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ci#765 defect 1 — structured failure logging on the streaming fallback chain.
 *
 * Prod evidence (requestId n-y74gcR8b9UHlPOTTCOe, 2026-10-04): an explicitly
 * pinned `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` routed to
 * cloudflare-workers-ai died in ~6s and NO error/warn line explained why
 * before the fallback chain moved on. Contract proven here:
 *
 *   1. When a candidate fails BEFORE the first chunk, exactly one structured
 *      warn is emitted (requestId, attempt, provider, model, errorCode,
 *      statusCode, error, durationMs, pinnedRequest) BEFORE the next
 *      candidate's stream is even opened.
 *   2. The same holds for a mid-stream failure (AFTER first chunk).
 *   3. pinnedRequest=false propagates for non-pinned (auto) requests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logChild = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logChild),
  },
}));

import { BaseStrategy } from '../base-strategy';
import type { ChatRequest, ChatResponse } from '@/types';

function chunk(content: string): ChatResponse {
  return {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [
      { index: 0, delta: { role: 'assistant', content }, finish_reason: null, logprobs: null },
    ],
  } as ChatResponse;
}

type Behavior = 'ok' | 'fail-before' | 'fail-after';

function mockAdapter(
  name: string,
  behavior: Behavior,
  onStreamStart?: () => void
) {
  return {
    getName: () => name,
    async *chatCompletionStream(): AsyncGenerator<ChatResponse> {
      onStreamStart?.();
      if (behavior === 'fail-before') {
        // Mirrors a provider rejecting a pinned model (e.g. 405/404 from
        // cloudflare-workers-ai for the pinned id) with a status + code body.
        const err = new Error(`${name}: model not allowed for this account`);
        Object.assign(err, { statusCode: 405, code: 'PINNED_MODEL_REJECTED' });
        throw err;
      }
      yield chunk(`[${name}]hello`);
      if (behavior === 'fail-after') {
        const err = new Error(`${name} mid-stream upstream disconnect`);
        Object.assign(err, { statusCode: 502, code: 'MID_STREAM_DROP' });
        throw err;
      }
      yield chunk(' world');
    },
  };
}

const model = (id: string) => ({ id, name: id });
const req = { messages: [{ role: 'user', content: 'x' }] } as ChatRequest;

class TestSynthStrategy extends BaseStrategy {
  getMetadata() {
    return { name: 'test-synth' } as unknown as ReturnType<BaseStrategy['getMetadata']>;
  }
  async execute() {
    throw new Error('not used in this test');
  }
  run(
    candidates: Array<{ adapter: ReturnType<typeof mockAdapter>; model: ReturnType<typeof model> }>,
    fallback: () => string,
    opts?: {
      firstChunkTimeoutMs?: number;
      throwOnTotalFailure?: boolean;
      requestId?: string;
      pinnedRequest?: boolean;
    }
  ) {
    return this.streamSynthesisWithFallback(
      req,
      candidates as never,
      fallback,
      opts as never
    );
  }
}

async function collect(gen: AsyncGenerator<ChatResponse>): Promise<string> {
  let out = '';
  for await (const c of gen) {
    const d = c.choices?.[0]?.delta?.content;
    if (typeof d === 'string') out += d;
  }
  return out;
}

const FAIL_BEFORE_FIRST_CHUNK = 'Synthesis stream failed/timed out before first chunk — falling back to next synthesizer';
const FAIL_AFTER_FIRST_CHUNK = 'Synthesis stream failed AFTER first chunk — keeping partial output';

describe('ci#765 defect 1: streaming fallback candidate failures leave a structured log', () => {
  beforeEach(() => {
    logChild.warn.mockClear();
    logChild.info.mockClear();
    logChild.error.mockClear();
  });

  it('logs the structured failure BEFORE the next candidate starts (pin, fail before first chunk)', async () => {
    const events: string[] = [];
    logChild.warn.mockImplementation((...args: unknown[]) => {
      void args;
      events.push('structured-failure-log');
    });
    const s = new TestSynthStrategy();
    const out = await collect(
      s.run(
        [
          { adapter: mockAdapter('A', 'fail-before'), model: model('a') },
          {
            adapter: mockAdapter('B', 'ok', () => {
              events.push('B-stream-started');
            }),
            model: model('b'),
          },
        ],
        () => 'DEGRADED',
        { requestId: 'req-765-pin', pinnedRequest: true, firstChunkTimeoutMs: 500 }
      )
    );

    expect(out).toBe('[B]hello world');

    // ORDERING CONTRACT: the structured failure line for candidate A must be
    // emitted BEFORE candidate B's stream is opened (ci#765: "before the next
    // attempt").
    expect(events).toEqual(['structured-failure-log', 'B-stream-started']);
    expect(logChild.warn).toHaveBeenCalledTimes(1);

    const [fields, message] = logChild.warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(message).toBe(FAIL_BEFORE_FIRST_CHUNK);
    expect(fields).toMatchObject({
      requestId: 'req-765-pin',
      attempt: 1,
      provider: 'A',
      model: 'a',
      errorCode: 'PINNED_MODEL_REJECTED',
      statusCode: 405,
      pinnedRequest: true,
      error: expect.stringContaining('model not allowed'),
    });
    expect(typeof fields.durationMs).toBe('number');
    expect(fields.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it('logs the same structured failure on a mid-stream (after first chunk) candidate death', async () => {
    const s = new TestSynthStrategy();
    const out = await collect(
      s.run(
        [
          { adapter: mockAdapter('A', 'fail-after'), model: model('a') },
          { adapter: mockAdapter('B', 'ok'), model: model('b') },
        ],
        () => 'DEGRADED',
        { requestId: 'req-765-mid', pinnedRequest: true }
      )
    );

    // Partial output of A is kept; B never runs (post-first-chunk failure stops the chain).
    expect(out).toBe('[A]hello');

    expect(logChild.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = logChild.warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(message).toBe(FAIL_AFTER_FIRST_CHUNK);
    expect(fields).toMatchObject({
      requestId: 'req-765-mid',
      attempt: 1,
      provider: 'A',
      model: 'a',
      errorCode: 'MID_STREAM_DROP',
      statusCode: 502,
      pinnedRequest: true,
    });
    expect(typeof fields.durationMs).toBe('number');
  });

  it('marks the failure as non-pinned for auto (no explicit model) requests', async () => {
    const s = new TestSynthStrategy();
    await collect(
      s.run(
        [
          { adapter: mockAdapter('A', 'fail-before'), model: model('a') },
          { adapter: mockAdapter('B', 'ok'), model: model('b') },
        ],
        () => 'DEGRADED',
        { requestId: 'req-765-auto', pinnedRequest: false }
      )
    );

    const [fields] = logChild.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.pinnedRequest).toBe(false);
    expect(fields.requestId).toBe('req-765-auto');
  });
});
