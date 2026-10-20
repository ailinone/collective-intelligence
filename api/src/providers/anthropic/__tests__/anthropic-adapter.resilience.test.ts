// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * REL-02 guard test — provider calls must flow through the resilience stack.
 *
 * Finding REL-02: mainstream adapters bypassed the distributed circuit breaker
 * + bulkhead by calling the network directly, so a provider outage produced no
 * fast-fail and no per-provider concurrency isolation. Every concrete adapter's
 * provider network call now routes through `ProviderAdapter.executeThroughBulkhead`.
 *
 * Anthropic is one of the 3 named hot-path adapters (openai/anthropic/google).
 * Its `chatCompletion`/`chatCompletionStream` used to route the Anthropic SDK's
 * `messages.create` call through `withRetry` — which itself calls
 * `executeThroughBulkhead`, but wraps withRetry's ENTIRE multi-attempt backoff
 * loop as a single breaker operation, so a real outage delayed each pre-open
 * failure by up to ~4 attempts of exponential backoff before it even counted
 * against the breaker. Both hot-path methods now call `executeThroughBulkhead`
 * directly around a single SDK attempt — the same one-attempt-per-breaker-
 * operation pattern `google-adapter.ts`, `mistral-adapter.ts`, and
 * `deepseek-adapter.ts` (see `deepseek-resilience.test.ts`, whose structure
 * this file mirrors) already use for their hot paths. The sampling-param
 * fallback retry inside `createMessageWithParamFallback` is unchanged — it is
 * a single, targeted retry for a known-recoverable 400, not a blind retry, and
 * stays invisible to the breaker on success (see `anthropic-adapter.sampling-
 * params.test.ts`).
 *
 * The assertions below prove the wiring end-to-end WITHOUT mocking the internals:
 *   1. Happy path is behavior-preserving (one SDK call, breaker stays CLOSED).
 *   2. After N consecutive failures the per-provider breaker opens.
 *   3. Once OPEN, further calls fast-fail WITHOUT touching the network.
 *   4. The breaker is keyed per-provider (`<name>-api`) so one provider's
 *      outage does not open another provider's breaker.
 *   5. The streaming hot path gets the same protection.
 *
 * Runs fully offline: with NODE_ENV=test the distributed breaker uses its local
 * (in-process) fallback, so no Redis is required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../anthropic-adapter';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';
import type { ChatRequest } from '@/types';

// Matches the `llm-provider` breaker profile (failureThreshold: 5) that
// `ProviderAdapter.initializeBulkhead()` registers via `getBreaker('<name>-api')`.
const FAILURE_THRESHOLD = 5;
const ANTHROPIC_BREAKER = 'anthropic-api';

const CHAT_REQUEST: ChatRequest = {
  model: 'claude-test',
  messages: [{ role: 'user', content: 'ping' }],
};

const OK_RESPONSE = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

const createMock = vi.fn();

/**
 * Builds an adapter whose SDK client is replaced by a recording stub, so we can
 * assert on the exact call count without touching the network — same technique
 * `anthropic-adapter.sampling-params.test.ts` uses. Each `chatCompletion()` /
 * `chatCompletionStream()` call now maps to exactly one `messages.create`
 * invocation (a direct `executeThroughBulkhead` wrap, no retry loop),
 * matching the DeepSeek test's model.
 */
function buildAdapter(): AnthropicAdapter {
  const adapter = new AnthropicAdapter({ apiKey: 'test-key' });
  const stub = { messages: { create: createMock } };
  (adapter as unknown as { client: unknown }).client = stub;
  (adapter as unknown as { clientPool: unknown[] }).clientPool = [stub];
  (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => stub;
  (adapter as unknown as { normalizeModelName(m: string): Promise<string> }).normalizeModelName =
    async (m: string) => m;
  return adapter;
}

describe('Anthropic adapter — REL-02 resilience wiring', () => {
  beforeEach(async () => {
    createMock.mockReset();
    // Independent starting state for every test (local in-process breaker).
    await distributedCircuitBreakerManager.getBreaker(ANTHROPIC_BREAKER).reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves the happy path — one SDK call, breaker stays CLOSED', async () => {
    createMock.mockResolvedValue(OK_RESPONSE);
    const adapter = buildAdapter();

    const res = await adapter.chatCompletion(CHAT_REQUEST);

    expect(res.choices?.[0]?.message?.content).toBe('pong');
    expect(createMock).toHaveBeenCalledTimes(1);

    const stats = await distributedCircuitBreakerManager.getBreaker(ANTHROPIC_BREAKER).getStats();
    expect(stats.state).toBe('CLOSED');
  });

  it('opens the breaker after N consecutive failures and then fast-fails without hitting the network', async () => {
    createMock.mockRejectedValue(new Error('ECONNREFUSED (simulated provider outage)'));
    const adapter = buildAdapter();

    // Drive exactly the failure threshold. Each chatCompletion == one breaker
    // operation == one SDK call (single-shot executeThroughBulkhead wrap, no
    // internal retry loop).
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(adapter.chatCompletion(CHAT_REQUEST)).rejects.toThrow();
    }
    expect(createMock).toHaveBeenCalledTimes(FAILURE_THRESHOLD);

    const breaker = distributedCircuitBreakerManager.getBreaker(ANTHROPIC_BREAKER);
    expect((await breaker.getStats()).state).toBe('OPEN');

    // The breaker is now OPEN: the next call must fast-fail with the OPEN error
    // and must NOT perform another network request (proving the call really is
    // routed through executeThroughBulkhead, not bypassing it).
    await expect(adapter.chatCompletion(CHAT_REQUEST)).rejects.toThrow(/is OPEN/i);
    expect(createMock).toHaveBeenCalledTimes(FAILURE_THRESHOLD); // unchanged — no extra call
  });

  it('keys the breaker per-provider — an Anthropic outage does not open another provider’s breaker', async () => {
    createMock.mockRejectedValue(new Error('ECONNREFUSED (simulated provider outage)'));
    const adapter = buildAdapter();

    // Sibling provider breaker starts CLOSED.
    const siblingBreaker = distributedCircuitBreakerManager.getBreaker('openai-api');
    await siblingBreaker.reset();

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(adapter.chatCompletion(CHAT_REQUEST)).rejects.toThrow();
    }

    expect(
      (await distributedCircuitBreakerManager.getBreaker(ANTHROPIC_BREAKER).getStats()).state
    ).toBe('OPEN');
    // Isolation: the other provider's breaker is untouched.
    expect((await siblingBreaker.getStats()).state).toBe('CLOSED');
  });

  it('applies the same fast-fail protection to the streaming hot path', async () => {
    createMock.mockRejectedValue(new Error('ECONNREFUSED (simulated provider outage)'));
    const adapter = buildAdapter();

    const drainStream = async () => {
      for await (const _chunk of adapter.chatCompletionStream(CHAT_REQUEST)) {
        // no-op: failures throw before any chunk is yielded
      }
    };

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(drainStream()).rejects.toThrow();
    }
    expect(createMock).toHaveBeenCalledTimes(FAILURE_THRESHOLD);

    const breaker = distributedCircuitBreakerManager.getBreaker(ANTHROPIC_BREAKER);
    expect((await breaker.getStats()).state).toBe('OPEN');

    await expect(drainStream()).rejects.toThrow(/is OPEN/i);
    expect(createMock).toHaveBeenCalledTimes(FAILURE_THRESHOLD); // unchanged — no extra call
  });
});
