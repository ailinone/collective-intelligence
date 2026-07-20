// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for BroadcastEmitter — the edge entry point that takes chat
 * completion data and stages a TraceEnvelope in the outbox.
 *
 * Coverage:
 *   - Happy path: builder + writer invoked, returns true
 *   - Builder failure swallowed: returns false, writer NOT called, no throw
 *   - Writer failure swallowed: returns false, no throw
 *   - Envelope shape: asserts key fields propagate from chat data
 */

import { describe, it, expect, vi } from 'vitest';

import { DefaultBroadcastEmitter } from '../broadcast-emitter';
import type { BroadcastOutboxWriter } from '@/broadcast/infrastructure/outbox/broadcast-outbox-writer';
import type { BuildEnvelopeArgs } from '@/broadcast/application/envelope-builder';
import type { ChatRequest, ChatResponse } from '@/types';

function makeArgs(overrides: Partial<BuildEnvelopeArgs> = {}): BuildEnvelopeArgs {
  const chatRequest: ChatRequest = {
    model: 'openai/gpt-5',
    messages: [{ role: 'user', content: 'hello' }],
  } as ChatRequest;
  const chatResponse: ChatResponse = {
    id: 'chatcmpl-abc',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'openai/gpt-5',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'hi there' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    ailin_metadata: { cost_usd: 0.0001, provider: 'openai' },
  } as unknown as ChatResponse;
  return {
    chatRequest,
    chatResponse,
    requestId: 'req-test-' + Math.random().toString(36).slice(2),
    tenant: {
      organizationId: '00000000-0000-0000-0000-000000000001',
      userId: '00000000-0000-0000-0000-000000000002',
      apiKeyId: null,
      resolutionScope: 'organization',
    },
    startedAt: new Date(Date.now() - 100),
    endedAt: new Date(),
    deploymentEnvironment: 'development',
    streaming: false,
    status: 'ok',
    httpStatus: 200,
    ...overrides,
  };
}

function makeWriter(opts: { fail?: boolean } = {}): BroadcastOutboxWriter & {
  calls: Array<unknown>;
} {
  const calls: unknown[] = [];
  return {
    calls,
    write: vi.fn(async (envelope, _tx) => {
      calls.push(envelope);
      if (opts.fail) throw new Error('DB unavailable');
      return {
        envelopeId: (envelope as { envelopeId: string }).envelopeId,
        bytes: 0,
        stagedAt: new Date(),
        alreadyStaged: false,
      };
    }),
  } as unknown as BroadcastOutboxWriter & { calls: unknown[] };
}

describe('BroadcastEmitter — happy path', () => {
  it('builds a validated envelope and writes it to the outbox', async () => {
    const writer = makeWriter();
    const emitter = new DefaultBroadcastEmitter(writer);

    const ok = await emitter.emitChatCompletion(makeArgs());

    expect(ok).toBe(true);
    expect(writer.calls).toHaveLength(1);
    const env = writer.calls[0] as Record<string, unknown>;
    expect(env.schemaVersion).toBe('1.0');
    expect(typeof env.envelopeId).toBe('string');
  });

  it('propagates model slug, provider, and token usage into generation fields', async () => {
    const writer = makeWriter();
    const emitter = new DefaultBroadcastEmitter(writer);

    await emitter.emitChatCompletion(makeArgs());

    const env = writer.calls[0] as {
      generation: { model: { slug: string; provider: string }; usage: Record<string, number> };
    };
    expect(env.generation.model.slug).toBe('openai/gpt-5');
    expect(env.generation.model.provider).toBe('openai');
    expect(env.generation.usage.inputTokens).toBe(10);
    expect(env.generation.usage.outputTokens).toBe(4);
    expect(env.generation.usage.totalTokens).toBe(14);
  });
});

describe('BroadcastEmitter — failure handling (contract: never throws)', () => {
  it('returns false and does NOT call the writer when the builder throws', async () => {
    const writer = makeWriter();
    const emitter = new DefaultBroadcastEmitter(writer);

    // A tenant with a non-UUID organizationId will fail Zod validation in
    // buildChatTraceEnvelope — exercising the builder-failure branch.
    const badArgs = makeArgs({
      tenant: {
        organizationId: 'NOT-A-UUID',
        userId: null,
        apiKeyId: null,
        resolutionScope: 'organization',
      },
    });

    const ok = await emitter.emitChatCompletion(badArgs);

    expect(ok).toBe(false);
    expect(writer.calls).toHaveLength(0);
  });

  it('returns false when the writer throws, and does not rethrow', async () => {
    const writer = makeWriter({ fail: true });
    const emitter = new DefaultBroadcastEmitter(writer);

    const ok = await emitter.emitChatCompletion(makeArgs());

    expect(ok).toBe(false);
    expect(writer.calls).toHaveLength(1); // writer WAS called, but threw
  });
});

describe('BroadcastEmitter — transactional call-site contract (Fase 3.5)', () => {
  // The emitter supports callers that want the envelope INSERT to run inside
  // their existing $transaction. This is the path any future caller with an
  // atomic "business write" should use. Chat-routes doesn't currently have
  // such a write, but the emitter's contract must honor the tx when supplied.
  it('threads the provided tx client into the writer instead of the global prisma', async () => {
    const sentinelTx = { broadcastTraceOutbox: {} as unknown } as {
      broadcastTraceOutbox: unknown;
      __sentinel: 'tx';
    };
    sentinelTx.__sentinel = 'tx';

    let receivedTx: unknown = null;
    const writer = {
      write: vi.fn(async (envelope: unknown, tx: unknown) => {
        receivedTx = tx;
        return {
          envelopeId: (envelope as { envelopeId: string }).envelopeId,
          bytes: 0,
          stagedAt: new Date(),
          alreadyStaged: false,
        };
      }),
    } as unknown as BroadcastOutboxWriter;

    const emitter = new DefaultBroadcastEmitter(writer);
    const ok = await emitter.emitChatCompletion(
      makeArgs(),
      sentinelTx as unknown as Parameters<typeof emitter.emitChatCompletion>[1],
    );

    expect(ok).toBe(true);
    expect(receivedTx).toBe(sentinelTx);
  });
});
