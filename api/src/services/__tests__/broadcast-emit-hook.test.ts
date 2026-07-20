// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Broadcast emit hook — proves the completion-path seam (F1 / ADR-017):
 *
 *   1. No-op when BROADCAST_FEATURE_ENABLED is unset/not "true" (default build
 *      pays nothing, never touches the emitter).
 *   2. When enabled, the chat completion is staged via the broadcast emitter
 *      with the tenant + timing the processor provides.
 *   3. emitBroadcastTrace returns synchronously (void) and NEVER throws, even
 *      when the underlying emitter rejects — the user request must be immune.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChatRequest, ChatResponse } from '@/types';

// Capture every call the hook makes into the broadcast emitter.
const emitChatCompletion = vi.fn(async () => true);

vi.mock('@/broadcast/application/broadcast-emitter', () => ({
  broadcastEmitter: {
    emitChatCompletion: (...args: unknown[]) => emitChatCompletion(...args),
  },
}));

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  emitChatCompletion.mockClear();
  emitChatCompletion.mockImplementation(async () => true);
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIG_ENV);
  vi.resetModules();
});

function sampleResponse(): ChatResponse {
  return {
    id: 'chatcmpl-x',
    object: 'chat.completion',
    created: 1,
    model: 'anthropic:claude-3-haiku',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'hi there' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    ailin_metadata: {
      strategy_used: 'single',
      models_used: ['anthropic:claude-3-haiku'],
      model_count: 1,
      execution_time_ms: 10,
      cost_usd: 0.0001,
      provider: 'anthropic',
      resolved_model: 'anthropic:claude-3-haiku',
    },
  } as unknown as ChatResponse;
}

function sampleRequest(): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'hello' }],
  } as ChatRequest;
}

describe('emitBroadcastTrace — feature gating', () => {
  it('is a no-op when BROADCAST_FEATURE_ENABLED is unset', async () => {
    delete process.env.BROADCAST_FEATURE_ENABLED;
    const { emitBroadcastTrace } = await import('../broadcast-emit-hook');
    emitBroadcastTrace({
      chatRequest: sampleRequest(),
      chatResponse: sampleResponse(),
      requestId: 'rid-1',
      organizationId: 'org-1',
      userId: 'user-1',
      startedAt: new Date(),
      endedAt: new Date(),
    });
    // Give any (wrongly) scheduled microtask a chance to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(emitChatCompletion).not.toHaveBeenCalled();
  });

  it('is a no-op when the flag is truthy-but-not-"true"', async () => {
    process.env.BROADCAST_FEATURE_ENABLED = '1';
    const { emitBroadcastTrace } = await import('../broadcast-emit-hook');
    emitBroadcastTrace({
      chatRequest: sampleRequest(),
      chatResponse: sampleResponse(),
      requestId: 'rid-2',
      organizationId: 'org-1',
      startedAt: new Date(),
      endedAt: new Date(),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(emitChatCompletion).not.toHaveBeenCalled();
  });
});

describe('emitBroadcastTrace — enabled path', () => {
  it('stages the completion via the broadcast emitter with tenant + timing', async () => {
    process.env.BROADCAST_FEATURE_ENABLED = 'true';
    const { emitBroadcastTrace } = await import('../broadcast-emit-hook');
    const startedAt = new Date('2026-06-13T00:00:00.000Z');
    const endedAt = new Date('2026-06-13T00:00:01.000Z');

    emitBroadcastTrace({
      chatRequest: sampleRequest(),
      chatResponse: sampleResponse(),
      requestId: 'rid-3',
      organizationId: 'org-42',
      userId: 'user-7',
      startedAt,
      endedAt,
    });

    // The hook detaches onto a microtask — flush it.
    await new Promise((r) => setTimeout(r, 0));

    expect(emitChatCompletion).toHaveBeenCalledTimes(1);
    const args = emitChatCompletion.mock.calls[0]![0] as {
      requestId: string;
      tenant: { organizationId: string | null; userId: string | null; resolutionScope: string };
      startedAt: Date;
      endedAt: Date;
      chatResponse: ChatResponse;
    };
    expect(args.requestId).toBe('rid-3');
    expect(args.tenant.organizationId).toBe('org-42');
    expect(args.tenant.userId).toBe('user-7');
    expect(args.tenant.resolutionScope).toBe('organization');
    expect(args.startedAt).toBe(startedAt);
    expect(args.endedAt).toBe(endedAt);
    expect(args.chatResponse.id).toBe('chatcmpl-x');
  });

  it('returns synchronously and NEVER throws even when the emitter rejects', async () => {
    process.env.BROADCAST_FEATURE_ENABLED = 'true';
    emitChatCompletion.mockImplementation(async () => {
      throw new Error('outbox down');
    });
    const { emitBroadcastTrace } = await import('../broadcast-emit-hook');

    // Must not throw synchronously.
    expect(() =>
      emitBroadcastTrace({
        chatRequest: sampleRequest(),
        chatResponse: sampleResponse(),
        requestId: 'rid-4',
        organizationId: 'org-1',
        startedAt: new Date(),
        endedAt: new Date(),
      }),
    ).not.toThrow();

    // And the rejected emit must not surface as an unhandled rejection that
    // fails the test run — flushing the microtask queue is enough to prove it
    // was caught (an uncaught rejection here would fail the suite).
    await new Promise((r) => setTimeout(r, 0));
    expect(emitChatCompletion).toHaveBeenCalledTimes(1);
  });
});
