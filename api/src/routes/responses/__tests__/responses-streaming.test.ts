// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Streaming SSE for POST /v1/responses — unit tests.
 *
 * These exercise the *testable core* of the Responses streaming path:
 *   - `extractDeltaText`   — engine-chunk → text-delta mapping (parity with
 *                            chat: handles both `delta.content` streaming
 *                            chunks AND `message.content` buffered-fallback
 *                            chunks).
 *   - `formatResponsesSSE` — `data: <json>\n\n` framing.
 *   - `streamResponse`     — drives an async generator of engine `ChatResponse`
 *                            chunks and emits OpenAI Responses streaming events
 *                            to a sink, terminating with `[DONE]`.
 *
 * We deliberately test the pure stream driver against a fake sink + a mock
 * async generator instead of booting Fastify + Prisma + the provider registry
 * (the same rationale chat-routes-pin-wiring.test.ts gives). The driver IS the
 * behavior under test; the engine and DB are mocked out so the import is cheap.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the heavy transitive deps so importing the route module is cheap and
//    side-effect-free (no real Prisma connection, no engine bootstrap). ──────
vi.mock('@/database/client', () => ({
  prisma: {
    requestLog: {
      upsert: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

const executeStreamMock = vi.fn();
vi.mock('@/core/orchestration/orchestration-engine', () => ({
  getOrchestrationEngine: () => ({ executeStream: executeStreamMock }),
  isOrchestrationEngineInitialized: () => true,
}));

vi.mock('@/services/billing-usage-tracker', () => ({
  trackChatUsage: vi.fn().mockResolvedValue(undefined),
}));

import {
  streamResponse,
  extractDeltaText,
  formatResponsesSSE,
  type SSESink,
} from '../responses-routes';
import type { ChatResponse } from '@/types';

// ── Helpers ──────────────────────────────────────────────────────────────

/** A fake SSE sink that records every frame written and end() calls. */
class RecordingSink implements SSESink {
  public frames: string[] = [];
  public ended = false;
  write(chunk: string): boolean {
    this.frames.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  /** Parse each `data: <json>` frame back into an object (skips [DONE]). */
  events(): Array<Record<string, unknown>> {
    return this.frames
      .filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'))
      .map((f) => JSON.parse(f.slice('data: '.length).trim()) as Record<string, unknown>);
  }
  raw(): string {
    return this.frames.join('');
  }
}

/** Build a minimal streaming chunk carrying an incremental `delta.content`. */
function deltaChunk(text: string, model = 'test/model'): ChatResponse {
  return {
    id: 'chatcmpl-x',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: text },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

/** A buffered-fallback chunk: full `message.content`, no `delta`. */
function messageChunk(text: string, model = 'test/model'): ChatResponse {
  return {
    id: 'chatcmpl-y',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    ailin_metadata: {
      strategy_used: 'single',
      models_used: ['test/model'],
      model_count: 1,
      execution_time_ms: 10,
      cost_usd: 0.0001,
      cache_hit: false,
    },
  };
}

/** Async generator over a fixed list of chunks. */
async function* gen(chunks: ChatResponse[]): AsyncGenerator<ChatResponse> {
  for (const c of chunks) {
    yield c;
  }
}

/** Async generator that yields some chunks then throws mid-stream. */
async function* genThenThrow(
  chunks: ChatResponse[],
  error: Error
): AsyncGenerator<ChatResponse> {
  for (const c of chunks) {
    yield c;
  }
  throw error;
}

beforeEach(() => {
  executeStreamMock.mockReset();
});

// ── extractDeltaText ───────────────────────────────────────────────────────

describe('extractDeltaText', () => {
  it('reads incremental text from delta.content (native streaming chunk)', () => {
    expect(extractDeltaText(deltaChunk('Hello'))).toBe('Hello');
  });

  it('reads full text from message.content (buffered-fallback chunk)', () => {
    expect(extractDeltaText(messageChunk('Full answer'))).toBe('Full answer');
  });

  it('returns empty for progress/observer metadata chunks (no real text)', () => {
    const progress: ChatResponse = {
      id: 'p',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'observer',
      choices: [
        { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null, logprobs: null },
      ],
      ailin_metadata: { type: 'progress', message: 'thinking', step: 1, total: 3 },
    };
    expect(extractDeltaText(progress)).toBe('');
  });

  it('returns empty when there are no choices', () => {
    const empty = { id: 'e', object: 'chat.completion', created: 1, model: 'm', choices: [] } as ChatResponse;
    expect(extractDeltaText(empty)).toBe('');
  });

  it('ignores non-string (multimodal array) content', () => {
    const multimodal: ChatResponse = {
      id: 'mm',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
    };
    expect(extractDeltaText(multimodal)).toBe('');
  });
});

// ── formatResponsesSSE ───────────────────────────────────────────────────────

describe('formatResponsesSSE', () => {
  it('frames an event as a single `data: <json>\\n\\n` block', () => {
    const frame = formatResponsesSSE({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'hi',
    });
    expect(frame).toBe(
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hi"}\n\n'
    );
  });
});

// ── streamResponse: happy path ───────────────────────────────────────────────

describe('streamResponse — successful stream', () => {
  it('emits created → deltas → ailin.metadata → completed → [DONE]', async () => {
    const sink = new RecordingSink();
    await streamResponse({
      source: gen([deltaChunk('Hel'), deltaChunk('lo'), deltaChunk(' world')]),
      sink,
      responseId: 'resp_test',
      requestedModel: 'auto',
      startTime: Date.now(),
    });

    const events = sink.events();
    const types = events.map((e) => e.type);

    // Ordered protocol: created first, completed + [DONE] last.
    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types).toContain('ailin.metadata');
    expect(types[types.length - 1]).toBe('response.completed');

    // ailin.metadata is emitted immediately before response.completed.
    const metaIdx = types.indexOf('ailin.metadata');
    const completedIdx = types.indexOf('response.completed');
    expect(metaIdx).toBeLessThan(completedIdx);

    // Terminates with the [DONE] sentinel.
    expect(sink.raw()).toContain('data: [DONE]\n\n');
    expect(sink.ended).toBe(false); // streamResponse does not call end(); the route does
  });

  it('emits one output_text.delta per non-empty chunk, reflecting output_text parts', async () => {
    const sink = new RecordingSink();
    await streamResponse({
      source: gen([deltaChunk('A'), deltaChunk('B'), deltaChunk('C')]),
      sink,
      responseId: 'resp_d',
      requestedModel: 'auto',
      startTime: Date.now(),
    });

    const deltas = sink
      .events()
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta);
    expect(deltas).toEqual(['A', 'B', 'C']);
  });

  it('accumulates deltas into the final response.completed output_text part', async () => {
    const sink = new RecordingSink();
    await streamResponse({
      source: gen([deltaChunk('Hel'), deltaChunk('lo')]),
      sink,
      responseId: 'resp_acc',
      requestedModel: 'auto',
      startTime: Date.now(),
    });

    const completed = sink.events().find((e) => e.type === 'response.completed') as
      | { response: { output: Array<{ content?: Array<{ type: string; text: string }> }>; status: string } }
      | undefined;
    expect(completed).toBeDefined();
    expect(completed!.response.status).toBe('completed');
    const part = completed!.response.output[0]?.content?.[0];
    expect(part).toEqual({ type: 'output_text', text: 'Hello' });
  });

  it('carries a final ailin_metadata frame with provenance from the stream', async () => {
    const sink = new RecordingSink();
    await streamResponse({
      source: gen([deltaChunk('x'), messageChunk('done', 'anthropic/claude-3-haiku')]),
      sink,
      responseId: 'resp_meta',
      requestedModel: 'auto',
      startTime: Date.now(),
    });

    const metaEvent = sink.events().find((e) => e.type === 'ailin.metadata') as
      | { ailin_metadata: Record<string, unknown> }
      | undefined;
    expect(metaEvent).toBeDefined();
    const meta = metaEvent!.ailin_metadata;
    expect(meta.strategy_used).toBe('single');
    expect(meta.models_used).toContain('test/model');
    expect(meta.total_cost).toBe(0.0001);
    expect(typeof meta.total_duration_ms).toBe('number');
  });

  it('handles buffered-fallback (single message chunk) the same as streaming chunks', async () => {
    const sink = new RecordingSink();
    await streamResponse({
      source: gen([messageChunk('A complete answer')]),
      sink,
      responseId: 'resp_buf',
      requestedModel: 'auto',
      startTime: Date.now(),
    });

    const deltas = sink
      .events()
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta);
    expect(deltas).toEqual(['A complete answer']);

    const completed = sink.events().find((e) => e.type === 'response.completed') as
      | { response: { output: Array<{ content?: Array<{ text: string }> }> } }
      | undefined;
    expect(completed!.response.output[0]?.content?.[0]?.text).toBe('A complete answer');
  });

  it('invokes the onComplete hook with the aggregated summary on success', async () => {
    const sink = new RecordingSink();
    const onComplete = vi.fn();
    await streamResponse({
      source: gen([deltaChunk('Hi'), messageChunk(' there')]),
      sink,
      responseId: 'resp_hook',
      requestedModel: 'auto',
      startTime: Date.now(),
      onComplete,
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    const summary = onComplete.mock.calls[0][0];
    expect(summary.failed).toBe(false);
    expect(summary.text).toBe('Hi there');
    expect(summary.usage.total_tokens).toBe(12);
  });
});

// ── streamResponse: mid-stream error ─────────────────────────────────────────

describe('streamResponse — mid-stream error', () => {
  it('emits already-received deltas, then a response.failed event and [DONE]', async () => {
    const sink = new RecordingSink();
    await streamResponse({
      source: genThenThrow([deltaChunk('partial')], new Error('provider exploded')),
      sink,
      responseId: 'resp_err',
      requestedModel: 'auto',
      startTime: Date.now(),
    });

    const events = sink.events();
    const types = events.map((e) => e.type);

    // The delta that arrived before the throw was still emitted.
    expect(types).toContain('response.output_text.delta');

    // Terminal event is response.failed (NOT completed), with an error body.
    expect(types).toContain('response.failed');
    expect(types).not.toContain('response.completed');

    const failed = events.find((e) => e.type === 'response.failed') as
      | { response: { status: string }; error: { message: string; type: string; code?: string } }
      | undefined;
    expect(failed).toBeDefined();
    expect(failed!.response.status).toBe('failed');
    expect(failed!.error.message).toContain('provider exploded');
    expect(failed!.error.type).toBe('response_error');

    // Stream still terminates cleanly with the [DONE] sentinel.
    expect(sink.raw()).toContain('data: [DONE]\n\n');
  });

  it('marks onComplete summary as failed when the stream errors', async () => {
    const sink = new RecordingSink();
    const onComplete = vi.fn();
    await streamResponse({
      source: genThenThrow([deltaChunk('half')], new Error('boom')),
      sink,
      responseId: 'resp_errhook',
      requestedModel: 'auto',
      startTime: Date.now(),
      onComplete,
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].failed).toBe(true);
    expect(onComplete.mock.calls[0][0].text).toBe('half');
  });

  it('still emits the ailin.metadata frame before failing', async () => {
    const sink = new RecordingSink();
    await streamResponse({
      source: genThenThrow([deltaChunk('x')], new Error('die')),
      sink,
      responseId: 'resp_errmeta',
      requestedModel: 'auto',
      startTime: Date.now(),
    });
    const types = sink.events().map((e) => e.type);
    const metaIdx = types.indexOf('ailin.metadata');
    const failedIdx = types.indexOf('response.failed');
    expect(metaIdx).toBeGreaterThanOrEqual(0);
    expect(metaIdx).toBeLessThan(failedIdx);
  });
});

// ── Parity with chat streaming ───────────────────────────────────────────────

describe('streamResponse — parity with chat streaming', () => {
  it('consumes the SAME engine.executeStream chunk shape as /v1/chat/completions', async () => {
    // The chat streaming path (chat-routes.ts handleStreamingRequest) consumes
    // ChatResponse chunks straight off engine.executeStream / provider streams.
    // streamResponse must accept those exact chunks unchanged — proving the two
    // endpoints share the streaming mechanism rather than duplicating it.
    const chatLikeChunks: ChatResponse[] = [
      deltaChunk('To', 'openai/gpt-4o-mini'),
      deltaChunk('ken', 'openai/gpt-4o-mini'),
      deltaChunk('s', 'openai/gpt-4o-mini'),
    ];
    const sink = new RecordingSink();
    await streamResponse({
      source: gen(chatLikeChunks),
      sink,
      responseId: 'resp_parity',
      requestedModel: 'openai/gpt-4o-mini',
      startTime: Date.now(),
    });

    // Same chunk source → coherent Responses output.
    const completed = sink.events().find((e) => e.type === 'response.completed') as
      | { response: { output: Array<{ content?: Array<{ text: string }> }> } }
      | undefined;
    expect(completed!.response.output[0]?.content?.[0]?.text).toBe('Tokens');
  });

  it('terminates with [DONE] exactly like the chat SSE path (sendSSEDone)', async () => {
    const sink = new RecordingSink();
    await streamResponse({
      source: gen([deltaChunk('hi')]),
      sink,
      responseId: 'resp_done',
      requestedModel: 'auto',
      startTime: Date.now(),
    });
    // Last frame must be the [DONE] sentinel — identical terminator to chat.
    expect(sink.frames[sink.frames.length - 1]).toBe('data: [DONE]\n\n');
  });
});
