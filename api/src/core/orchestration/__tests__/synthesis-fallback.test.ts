// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * BaseStrategy.streamSynthesisWithFallback — resilient collective synthesis.
 *
 * A collective's final synthesizer must not hard-crash the SSE stream when its
 * provider fails (the runtime 401/402/403/404 cascade). This proves the four
 * behaviors: success passthrough, fall-back-before-first-chunk, degrade-when-all
 * -fail (no throw), and keep-partial-when-failing-mid-stream (no answer splice).
 */
import { describe, it, expect } from 'vitest';
import { BaseStrategy } from '../base-strategy';
import type { ChatRequest, ChatResponse } from '@/types';

type Behavior = 'ok' | 'fail-before' | 'fail-after' | 'hang';

function chunk(content: string): ChatResponse {
  return {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null, logprobs: null }],
  } as ChatResponse;
}

function mockAdapter(name: string, behavior: Behavior, onRequest?: (req: ChatRequest) => void) {
  return {
    getName: () => name,
    async *chatCompletionStream(req: ChatRequest): AsyncGenerator<ChatResponse> {
      onRequest?.(req);
      if (behavior === 'fail-before') throw new Error(`${name} HTTP 403 insufficient_user_quota`);
      if (behavior === 'hang') { await new Promise(() => {}); } // never yields a first chunk
      yield chunk(`[${name}]hello`);
      if (behavior === 'fail-after') throw new Error(`${name} mid-stream network drop`);
      yield chunk(' world');
    },
  };
}

const model = (id: string) => ({ id, name: id });
const req = { messages: [{ role: 'user', content: 'x' }] } as ChatRequest;

// Minimal concrete subclass exposing the protected helper.
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
    opts?: { firstChunkTimeoutMs?: number; throwOnTotalFailure?: boolean; skipSynthesisCap?: boolean },
    request: ChatRequest = req,
  ): AsyncGenerator<ChatResponse, void, unknown> {
    // Cast through the helper's typed signature — the helper only calls
    // adapter.chatCompletionStream()/getName() and model.id/name.
    return this.streamSynthesisWithFallback(request, candidates as never, fallback, opts);
  }
}

async function collect(gen: AsyncGenerator<ChatResponse>): Promise<string> {
  let out = '';
  for await (const c of gen) {
    const d = c.choices?.[0]?.delta?.content;
    const m = c.choices?.[0]?.message?.content;
    out += typeof d === 'string' ? d : typeof m === 'string' ? m : '';
  }
  return out;
}

describe('BaseStrategy.streamSynthesisWithFallback', () => {
  const s = new TestSynthStrategy();

  it('streams the first synthesizer when it succeeds (no fallback)', async () => {
    const out = await collect(s.run(
      [{ adapter: mockAdapter('A', 'ok'), model: model('a') }, { adapter: mockAdapter('B', 'ok'), model: model('b') }],
      () => 'DEGRADED',
    ));
    expect(out).toBe('[A]hello world');
  });

  it('falls back to the next synthesizer when the first fails before any content', async () => {
    const out = await collect(s.run(
      [{ adapter: mockAdapter('A', 'fail-before'), model: model('a') }, { adapter: mockAdapter('B', 'ok'), model: model('b') }],
      () => 'DEGRADED',
    ));
    expect(out).toBe('[B]hello world');
  });

  it('emits degraded content (does NOT throw) when all synthesizers fail before content', async () => {
    const out = await collect(s.run(
      [{ adapter: mockAdapter('A', 'fail-before'), model: model('a') }, { adapter: mockAdapter('B', 'fail-before'), model: model('b') }],
      () => 'DEGRADED-ANSWER',
    ));
    expect(out).toBe('DEGRADED-ANSWER');
  });

  it('keeps partial output and stops (no answer splice) when a synthesizer fails AFTER the first chunk', async () => {
    const out = await collect(s.run(
      [{ adapter: mockAdapter('A', 'fail-after'), model: model('a') }, { adapter: mockAdapter('B', 'ok'), model: model('b') }],
      () => 'DEGRADED',
    ));
    expect(out).toBe('[A]hello');
  });

  it('times out a hanging synthesizer (no first chunk) and falls back to the next', async () => {
    const out = await collect(s.run(
      [{ adapter: mockAdapter('A', 'hang'), model: model('a') }, { adapter: mockAdapter('B', 'ok'), model: model('b') }],
      () => 'DEGRADED',
      { firstChunkTimeoutMs: 50 },
    ));
    expect(out).toBe('[B]hello world');
  });

  // throwOnTotalFailure — the single-model-strategy contract: no partial
  // multi-model output exists to degrade to, so total failure must surface as
  // a real error (matching execute()'s throw), not a silent empty "success".
  it('throws (does not degrade) when all candidates fail and throwOnTotalFailure is set', async () => {
    const gen = s.run(
      [{ adapter: mockAdapter('A', 'fail-before'), model: model('a') }, { adapter: mockAdapter('B', 'fail-before'), model: model('b') }],
      () => 'DEGRADED-ANSWER',
      { throwOnTotalFailure: true },
    );
    await expect(collect(gen)).rejects.toThrow(/All 2 candidates failed/);
  });

  it('still degrades gracefully (no throw) when throwOnTotalFailure is NOT set — existing collective contract unchanged', async () => {
    const out = await collect(s.run(
      [{ adapter: mockAdapter('A', 'fail-before'), model: model('a') }],
      () => 'DEGRADED-ANSWER',
    ));
    expect(out).toBe('DEGRADED-ANSWER');
  });

  // capSynthesisRequest / skipSynthesisCap. As of 2026-07-11, there is NO fixed
  // numeric default: an unset max_tokens is left unset (the provider applies
  // its own native max) UNLESS the operator opts in via
  // COLLECTIVE_SYNTHESIS_MAX_TOKENS. skipSynthesisCap bypasses even that
  // opt-in cap — used by callers (single-model) that must never have
  // max_tokens silently modified just because they reuse this helper.
  it('leaves max_tokens unset when absent and no env cap is configured', async () => {
    let seenMaxTokens: number | undefined = -1 as unknown as number;
    const adapter = mockAdapter('A', 'ok', (r) => { seenMaxTokens = r.max_tokens; });
    await collect(s.run(
      [{ adapter, model: model('a') }],
      () => 'DEGRADED',
      undefined,
      { messages: [{ role: 'user', content: 'x' }] } as ChatRequest,
    ));
    expect(seenMaxTokens).toBeUndefined();
  });

  it('applies COLLECTIVE_SYNTHESIS_MAX_TOKENS when the operator sets it, and skipSynthesisCap bypasses even that', async () => {
    const prev = process.env.COLLECTIVE_SYNTHESIS_MAX_TOKENS;
    process.env.COLLECTIVE_SYNTHESIS_MAX_TOKENS = '2048';
    try {
      let seenWithCap: number | undefined;
      await collect(s.run(
        [{ adapter: mockAdapter('A', 'ok', (r) => { seenWithCap = r.max_tokens; }), model: model('a') }],
        () => 'DEGRADED',
        undefined,
        { messages: [{ role: 'user', content: 'x' }] } as ChatRequest,
      ));
      expect(seenWithCap).toBe(2048);

      let seenSkipped: number | undefined = -1 as unknown as number;
      await collect(s.run(
        [{ adapter: mockAdapter('A', 'ok', (r) => { seenSkipped = r.max_tokens; }), model: model('a') }],
        () => 'DEGRADED',
        { skipSynthesisCap: true },
        { messages: [{ role: 'user', content: 'x' }] } as ChatRequest,
      ));
      expect(seenSkipped).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.COLLECTIVE_SYNTHESIS_MAX_TOKENS;
      else process.env.COLLECTIVE_SYNTHESIS_MAX_TOKENS = prev;
    }
  });
});
