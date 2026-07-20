// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SingleModelStrategy.executeStream() — genuine token streaming + fail-fast.
 *
 * Context: `/v1/chat/completions` never calls this (it has its own bespoke
 * streaming path in chat-routes.ts). But `orchestrationEngine.executeStream()`
 * — used by e.g. `/v1/responses` — dispatches purely on
 * `strategy.supportsStreaming()`. Before this change, single-model-strategy
 * inherited the BaseStrategy default (`false`), so those callers silently fell
 * back to the fully-buffered `execute()` path: zero tokens until the ENTIRE
 * generation finished, regardless of `stream: true`.
 *
 * These tests isolate `executeStream()`'s new candidate-assembly + streaming
 * logic by overriding the protected `selectBestModel()` with a scripted
 * candidate queue — `selectBestModel`'s own selection algorithm is unchanged
 * and out of scope here.
 */
import { describe, it, expect } from 'vitest';
import { SingleModelStrategy } from '../single-model-strategy';
import type { ChatRequest, ChatResponse, Model, OrchestrationContext } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

type Behavior = 'ok' | 'fail-before' | 'hang';

function chunk(content: string): ChatResponse {
  return {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null, logprobs: null }],
  } as ChatResponse;
}

function mockAdapter(name: string, behavior: Behavior): ProviderAdapter {
  return {
    getName: () => name,
    async *chatCompletionStream(): AsyncGenerator<ChatResponse> {
      if (behavior === 'fail-before') throw new Error(`${name} HTTP 403 insufficient_user_quota`);
      if (behavior === 'hang') { await new Promise(() => {}); }
      yield chunk(`[${name}]hello`);
      yield chunk(' world');
    },
  } as unknown as ProviderAdapter;
}

const model = (id: string): Model => ({ id, name: id } as Model);
const req = { messages: [{ role: 'user', content: 'x' }] } as ChatRequest;
const context = { requestId: 'r1', models: [] } as unknown as OrchestrationContext;

/** Scripts selectBestModel() to hand back a fixed candidate queue, in order. */
class ScriptedSingleModelStrategy extends SingleModelStrategy {
  private queue: Array<{ adapter: ProviderAdapter; model: Model } | null>;
  constructor(queue: Array<{ adapter: ProviderAdapter; model: Model } | null>) {
    super();
    this.queue = [...queue];
  }
  protected async selectBestModel(): Promise<{ model: Model; adapter: ProviderAdapter } | null> {
    return this.queue.shift() ?? null;
  }
}

async function collect(gen: AsyncGenerator<ChatResponse>): Promise<string> {
  let out = '';
  for await (const c of gen) {
    const d = c.choices?.[0]?.delta?.content;
    out += typeof d === 'string' ? d : '';
  }
  return out;
}

describe('SingleModelStrategy: supportsStreaming', () => {
  it('returns true (was the inherited false default before this change)', () => {
    expect(new SingleModelStrategy().supportsStreaming()).toBe(true);
  });
});

describe('SingleModelStrategy.executeStream', () => {
  it('streams real chunks from the selected model (not one buffered final chunk)', async () => {
    const s = new ScriptedSingleModelStrategy([{ adapter: mockAdapter('A', 'ok'), model: model('a') }]);
    const chunks: ChatResponse[] = [];
    for await (const c of s.executeStream(req, context)) chunks.push(c);
    // Genuine streaming means MULTIPLE chunks, not the whole answer in one.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.choices?.[0]?.delta?.content).join('')).toBe('[A]hello world');
  });

  it('fails fast on a hanging primary and falls back to the next candidate', async () => {
    const s = new ScriptedSingleModelStrategy([
      { adapter: mockAdapter('A', 'hang'), model: model('a') },
      { adapter: mockAdapter('B', 'ok'), model: model('b') },
    ]);
    const out = await collect(s.executeStream(req, context, { firstChunkTimeoutMs: 50 }));
    expect(out).toBe('[B]hello world');
  });

  it('throws (does not silently succeed) when every candidate fails — matches execute()\'s error contract', async () => {
    const s = new ScriptedSingleModelStrategy([
      { adapter: mockAdapter('A', 'fail-before'), model: model('a') },
      { adapter: mockAdapter('B', 'fail-before'), model: model('b') },
    ]);
    await expect(collect(s.executeStream(req, context))).rejects.toThrow(/All 2 candidates failed/);
  });

  it('throws when selectBestModel finds no candidate at all', async () => {
    const s = new ScriptedSingleModelStrategy([]);
    await expect(collect(s.executeStream(req, context))).rejects.toThrow(/No suitable model available/);
  });

  it('does not cap max_tokens on a plain single-model request (skipSynthesisCap)', async () => {
    let seenMaxTokens: number | undefined = -1 as unknown as number;
    const adapter = {
      getName: () => 'A',
      async *chatCompletionStream(r: ChatRequest): AsyncGenerator<ChatResponse> {
        seenMaxTokens = r.max_tokens;
        yield chunk('hi');
      },
    } as unknown as ProviderAdapter;
    const s = new ScriptedSingleModelStrategy([{ adapter, model: model('a') }]);
    await collect(s.executeStream({ messages: [{ role: 'user', content: 'x' }] } as ChatRequest, context));
    expect(seenMaxTokens).toBeUndefined();
  });
});
