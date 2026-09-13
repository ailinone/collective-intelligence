// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for AnthropicAdapter sampling-parameter gating.
 *
 * Live-traffic finding (LOTE AN): the adapter sent `temperature` on every
 * request, because the public chat route declares `temperature` with a schema
 * `default: 1` and Fastify's Ajv materialises defaults — so the field arrives
 * populated even when the caller never set it.
 *
 * Newer Claude models reject it outright:
 *   400 {"type":"error","error":{"type":"invalid_request_error",
 *        "message":"`temperature` is deprecated for this model."}}
 *
 * Because the `anthropic-api` circuit breaker is provider-wide, five such
 * failures on ONE model opened it for EVERY Claude model — after which Claude
 * requests were silently answered by another vendor with `degraded: false`.
 *
 * The adapter must therefore learn the rejection from the vendor's own message,
 * retry without the offending field, and omit it on later calls — with no
 * hardcoded model list.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnthropicAdapter } from '@/providers/anthropic/anthropic-adapter';
import type { ChatRequest } from '@/types';

type CreateArgs = { model: string; temperature?: number; top_p?: number; [k: string]: unknown };

/** Minimal Anthropic SDK error shape: a 400 with the vendor's message. */
function paramError(message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = 400;
  return e;
}

const OK_RESPONSE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

/**
 * Builds an adapter whose SDK client is replaced by a recording stub, so we can
 * assert on the exact payload without touching the network.
 */
function buildAdapter(createImpl: (args: CreateArgs) => unknown) {
  const calls: CreateArgs[] = [];
  const adapter = new AnthropicAdapter({ apiKey: 'test-key', maxRetries: 0 });
  const create = vi.fn(async (args: CreateArgs) => {
    calls.push(args);
    return createImpl(args);
  });
  // Both the pooled-client getter and the direct client must resolve to the stub.
  const stub = { messages: { create } };
  (adapter as unknown as { client: unknown }).client = stub;
  (adapter as unknown as { clientPool: unknown[] }).clientPool = [stub];
  (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => stub;
  // Keep the model id verbatim so assertions stay readable.
  (adapter as unknown as { normalizeModelName(m: string): Promise<string> }).normalizeModelName =
    async (m: string) => m;
  return { adapter, calls, create };
}

function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatRequest;
}

describe('AnthropicAdapter — sampling parameter gating', () => {
  beforeEach(() => {
    // The learned-rejection map is static; clear it so tests stay independent.
    (
      AnthropicAdapter as unknown as { unsupportedSamplingParams: Map<string, Set<string>> }
    ).unsupportedSamplingParams.clear();
  });

  it('sends temperature normally for a model that accepts it', async () => {
    const { adapter, calls } = buildAdapter(() => OK_RESPONSE);
    await adapter.chatCompletion(chatRequest({ temperature: 0.7 }));

    expect(calls).toHaveLength(1);
    expect(calls[0].temperature).toBe(0.7);
  });

  it('retries without temperature when the model reports it as deprecated', async () => {
    let first = true;
    const { adapter, calls } = buildAdapter((args) => {
      if (first && args.temperature !== undefined) {
        first = false;
        throw paramError('`temperature` is deprecated for this model.');
      }
      return OK_RESPONSE;
    });

    // Must resolve, not throw: a recoverable parameter mismatch has to stay
    // invisible to withRetry so it never trips the provider-wide breaker.
    await expect(adapter.chatCompletion(chatRequest({ temperature: 0.7 }))).resolves.toBeDefined();

    expect(calls).toHaveLength(2);
    expect(calls[0].temperature).toBe(0.7);
    // The retry must OMIT the key entirely, not send `undefined`.
    expect('temperature' in calls[1]).toBe(false);
  });

  it('omits temperature on subsequent calls once the rejection is learned', async () => {
    const { adapter, calls } = buildAdapter((args) => {
      if (args.temperature !== undefined) {
        throw paramError('`temperature` is deprecated for this model.');
      }
      return OK_RESPONSE;
    });

    await adapter.chatCompletion(chatRequest({ temperature: 0.7 }));
    await adapter.chatCompletion(chatRequest({ temperature: 0.2 }));

    // 1st call probes + retries (2 calls), 2nd call goes straight through (1 call).
    expect(calls).toHaveLength(3);
    expect('temperature' in calls[2]).toBe(false);
  });

  it('learns per-model, leaving other Claude models unaffected', async () => {
    const { adapter, calls } = buildAdapter((args) => {
      if (args.model === 'claude-opus-4-8' && args.temperature !== undefined) {
        throw paramError('`temperature` is deprecated for this model.');
      }
      return OK_RESPONSE;
    });

    await adapter.chatCompletion(chatRequest({ model: 'claude-opus-4-8', temperature: 0.7 }));
    await adapter.chatCompletion(
      chatRequest({ model: 'claude-haiku-4-5-20251001', temperature: 0.7 })
    );

    const haikuCall = calls.find((c) => c.model === 'claude-haiku-4-5-20251001');
    expect(haikuCall?.temperature).toBe(0.7);
  });

  it('also handles a rejected top_p', async () => {
    let thrown = false;
    const { adapter, calls } = buildAdapter((args) => {
      if (!thrown && args.top_p !== undefined) {
        thrown = true;
        throw paramError('`top_p` is not supported for this model.');
      }
      return OK_RESPONSE;
    });

    await expect(adapter.chatCompletion(chatRequest({ top_p: 0.9 }))).resolves.toBeDefined();
    expect('top_p' in calls[calls.length - 1]).toBe(false);
  });

  it('does NOT swallow unrelated 400s', async () => {
    const { adapter, create } = buildAdapter(() => {
      throw paramError('messages: at least one message is required');
    });

    await expect(adapter.chatCompletion(chatRequest({ temperature: 0.7 }))).rejects.toBeDefined();
    // One attempt only — no bogus retry for an error that names no gated param.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does NOT treat auth or rate-limit errors as a parameter problem', async () => {
    const learned = (
      AnthropicAdapter as unknown as { unsupportedSamplingParams: Map<string, Set<string>> }
    ).unsupportedSamplingParams;

    for (const status of [401, 429, 529]) {
      learned.clear();
      const { adapter, calls } = buildAdapter(() => {
        // Deliberately names a gated param: the HTTP status, not the wording,
        // must decide whether this is a recoverable parameter mismatch.
        const e = new Error('`temperature` unsupported') as Error & { status: number };
        e.status = status;
        throw e;
      });

      // The failure must surface. (withRetry may legitimately re-attempt these
      // statuses; what matters is that it still fails and reaches the breaker.)
      await expect(adapter.chatCompletion(chatRequest({ temperature: 0.7 }))).rejects.toBeDefined();

      // Nothing was learned, and temperature was never dropped on any attempt.
      expect(learned.size).toBe(0);
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c.temperature).toBe(0.7);
    }
  }, 30_000);

  it('never sends the field when the caller omitted it', async () => {
    const { adapter, calls } = buildAdapter(() => OK_RESPONSE);
    await adapter.chatCompletion(chatRequest());

    expect('temperature' in calls[0]).toBe(false);
    expect('top_p' in calls[0]).toBe(false);
  });
});
