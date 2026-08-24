// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Workstream G — TTFT recording in streamSynthesisWithFallback.
 *
 * The tracker that powers latency-aware rung ranking and the dynamic
 * first-chunk budget is fed HERE, at the moment each candidate's first chunk
 * lands (or fails). These tests pin the semantic-success contract:
 *  - a candidate that yields content records a SUCCESS latency sample;
 *  - a candidate that fails/times out BEFORE the first chunk records a FAILURE;
 *  - a metadata-only first chunk (no delta content) records NEITHER.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BaseStrategy } from '../base-strategy';
import { getTtftTracker, resetTtftTrackerForTesting } from '@/core/selection/ttft-tracker';
import type { ChatRequest, ChatResponse } from '@/types';

function chunk(content: string | null): ChatResponse {
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

function mockAdapter(name: string, behavior: 'ok' | 'fail-before' | 'hang' | 'metadata-first') {
  return {
    getName: () => name,
    async *chatCompletionStream(): AsyncGenerator<ChatResponse> {
      if (behavior === 'fail-before') throw new Error(`${name} HTTP 403`);
      if (behavior === 'hang') await new Promise(() => {}); // never yields
      if (behavior === 'metadata-first') {
        yield chunk(null); // role-only first chunk, no content
        return;
      }
      yield chunk(`[${name}]hello`);
    },
  };
}

const model = (id: string) => ({ id, name: id });
const req = { messages: [{ role: 'user', content: 'x' }] } as ChatRequest;

class TestSynthStrategy extends BaseStrategy {
  getMetadata() {
    return { name: 'test-ttft' } as unknown as ReturnType<BaseStrategy['getMetadata']>;
  }
  async execute() {
    throw new Error('not used');
  }
  run(
    candidates: Array<{ adapter: ReturnType<typeof mockAdapter>; model: ReturnType<typeof model> }>,
    fallback: () => string,
    opts?: { firstChunkTimeoutMs?: number }
  ) {
    return this.streamSynthesisWithFallback(
      req,
      candidates as never,
      fallback,
      opts as never
    ) as AsyncGenerator<ChatResponse, void, unknown>;
  }
}

async function collect(gen: AsyncGenerator<ChatResponse>): Promise<string> {
  let out = '';
  for await (const c of gen) out += c.choices?.[0]?.delta?.content ?? '';
  return out;
}

describe('streamSynthesisWithFallback TTFT recording', () => {
  beforeEach(() => {
    resetTtftTrackerForTesting();
  });

  it('records a success sample when a candidate yields content', async () => {
    const s = new TestSynthStrategy();
    const out = await collect(
      s.run([{ adapter: mockAdapter('prov-a', 'ok'), model: model('m-a') }], () => 'DEGRADED')
    );
    expect(out).toBe('[prov-a]hello');
    expect(getTtftTracker().sampleCount('prov-a', 'm-a')).toBe(1);
    expect(getTtftTracker().predictedTtftMs('prov-a', 'm-a')).not.toBeNull();
  });

  it('records failures for pre-first-chunk errors AND timeouts (degraded = failures)', async () => {
    const s = new TestSynthStrategy();
    const out = await collect(
      s.run(
        [
          { adapter: mockAdapter('prov-a', 'fail-before'), model: model('m-a') },
          { adapter: mockAdapter('prov-b', 'hang'), model: model('m-b') },
        ],
        () => 'DEGRADED',
        { firstChunkTimeoutMs: 50 }
      )
    );
    expect(out).toBe('DEGRADED');
    const tracker = getTtftTracker();
    expect(tracker.errorRate('prov-a', 'm-a')).toBe(1);
    expect(tracker.errorRate('prov-b', 'm-b')).toBe(1);
    expect(tracker.sampleCount('prov-a', 'm-a')).toBe(0);
    expect(tracker.sampleCount('prov-b', 'm-b')).toBe(0);
  });

  it('does NOT record a success for a metadata-only first chunk', async () => {
    const s = new TestSynthStrategy();
    await collect(
      s.run([{ adapter: mockAdapter('prov-a', 'metadata-first'), model: model('m-a') }], () => 'DEGRADED')
    );
    const tracker = getTtftTracker();
    expect(tracker.sampleCount('prov-a', 'm-a')).toBe(0);
    expect(tracker.errorRate('prov-a', 'm-a')).toBe(0);
  });

  it('supports the per-candidate resolver form for the first-chunk deadline', async () => {
    const s = new TestSynthStrategy();
    const seen: string[] = [];
    const out = await collect(
      s.run(
        [
          { adapter: mockAdapter('prov-a', 'ok'), model: model('m-a') },
          { adapter: mockAdapter('prov-b', 'ok'), model: model('m-b') },
        ],
        () => 'DEGRADED',
        {
          firstChunkTimeoutMs: (attemptIndex: number, cand?: { adapter: { getName(): string } }) => {
            seen.push(`${attemptIndex}:${cand?.adapter.getName()}`);
            return 5000;
          },
        } as never
      )
    );
    expect(out).toBe('[prov-a]hello');
    expect(seen[0]).toBe('0:prov-a');
  });
});
