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
 * provider network call now routes through `ProviderAdapter.executeThroughBulkhead`
 * (directly, or via `withRetry` / the hub's `sendJsonRequestWithRetry`).
 *
 * DeepSeek is used as a representative adapter: its `chatCompletion` wraps a
 * single `fetch` in `executeThroughBulkhead`, giving a clean 1:1 mapping between
 * a chat call and a circuit-breaker operation. The assertions below prove the
 * wiring end-to-end WITHOUT mocking the internals:
 *   1. Happy path is behavior-preserving (one fetch, breaker stays CLOSED).
 *   2. After N consecutive failures the per-provider breaker opens.
 *   3. Once OPEN, further calls fast-fail WITHOUT touching the network.
 *   4. The breaker is keyed per-provider (`<name>-api`) so one provider's
 *      outage does not open another provider's breaker.
 *
 * Runs fully offline: with NODE_ENV=test the distributed breaker uses its local
 * (in-process) fallback, so no Redis is required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter } from '../deepseek-adapter';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';
import type { ChatRequest } from '@/types';

// Matches the `llm-provider` breaker profile (failureThreshold: 5) that
// `ProviderAdapter.initializeBulkhead()` registers via `getBreaker('<name>-api')`.
const FAILURE_THRESHOLD = 5;
const DEEPSEEK_BREAKER = 'deepseek-api';

const CHAT_REQUEST: ChatRequest = {
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'ping' }],
};

const fetchMock = vi.fn();

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'cmpl-test',
      object: 'chat.completion',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  } as unknown as Response;
}

describe('DeepSeek adapter — REL-02 resilience wiring', () => {
  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    // Independent starting state for every test (local in-process breaker).
    await distributedCircuitBreakerManager.getBreaker(DEEPSEEK_BREAKER).reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the happy path — one fetch, breaker stays CLOSED', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const adapter = new DeepSeekAdapter({ apiKey: 'test-key' });

    const res = await adapter.chatCompletion(CHAT_REQUEST);

    expect(res.choices?.[0]?.message?.content).toBe('pong');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stats = await distributedCircuitBreakerManager.getBreaker(DEEPSEEK_BREAKER).getStats();
    expect(stats.state).toBe('CLOSED');
  });

  it('opens the breaker after N consecutive failures and then fast-fails without hitting the network', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED (simulated provider outage)'));
    const adapter = new DeepSeekAdapter({ apiKey: 'test-key' });

    // Drive exactly the failure threshold. Each chatCompletion == one breaker
    // operation == one fetch (DeepSeek does not retry internally).
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(adapter.chatCompletion(CHAT_REQUEST)).rejects.toThrow();
    }
    expect(fetchMock).toHaveBeenCalledTimes(FAILURE_THRESHOLD);

    const breaker = distributedCircuitBreakerManager.getBreaker(DEEPSEEK_BREAKER);
    expect((await breaker.getStats()).state).toBe('OPEN');

    // The breaker is now OPEN: the next call must fast-fail with the OPEN error
    // and must NOT perform another network request (proving the call really is
    // routed through executeThroughBulkhead, not bypassing it).
    await expect(adapter.chatCompletion(CHAT_REQUEST)).rejects.toThrow(/is OPEN/i);
    expect(fetchMock).toHaveBeenCalledTimes(FAILURE_THRESHOLD); // unchanged — no extra fetch
  });

  it('keys the breaker per-provider — a DeepSeek outage does not open another provider’s breaker', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED (simulated provider outage)'));
    const adapter = new DeepSeekAdapter({ apiKey: 'test-key' });

    // Sibling provider breaker starts CLOSED.
    const siblingBreaker = distributedCircuitBreakerManager.getBreaker('openai-api');
    await siblingBreaker.reset();

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(adapter.chatCompletion(CHAT_REQUEST)).rejects.toThrow();
    }

    expect((await distributedCircuitBreakerManager.getBreaker(DEEPSEEK_BREAKER).getStats()).state).toBe('OPEN');
    // Isolation: the other provider's breaker is untouched.
    expect((await siblingBreaker.getStats()).state).toBe('CLOSED');
  });
});
