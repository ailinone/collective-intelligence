// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Upstream HTTP status must survive the adapter.
 *
 * `chatCompletion`'s catch-all used to rethrow every failure with a hardcoded
 * `statusCode: 500`. That single line disarmed the whole fallback chain,
 * because everything downstream decides retry-vs-failover from `.statusCode`:
 *
 *   - `isPaymentFailure` (402/403/404) → false, so cross-provider retry never fired
 *   - `classifyProviderFailure({httpStatus: 500})` → TRANSIENT_FAILURE, so the
 *     route was never marked dead
 *   - `isModelNotFound(500, msg)` → false, so the dead-model registry stayed empty
 *
 * A permanent 404 ("This model is unavailable for free") was therefore treated
 * as a retryable server error, and the chain burned its entire budget on a model
 * that could never succeed — observed in production as `[DEGRADED] All execution
 * attempts failed` while a live candidate pool of 106k models sat unused.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OpenRouterAdapter } from '@/providers/openrouter/openrouter-adapter';
import type { ChatRequest } from '@/types';

const REQUEST: ChatRequest = {
  model: 'qwen/qwen3-next-80b-a3b-instruct:free',
  messages: [{ role: 'user', content: 'hi' }],
};

/** The exact body OpenRouter returned in the production incident. */
const FREE_MODEL_404 = JSON.stringify({
  error: {
    message:
      'This model is unavailable for free. The paid version is available now - use this slug instead: qwen/qwen3-next-80b-a3b-instruct',
    code: 404,
  },
});

function adapterReturning(status: number, body: string): OpenRouterAdapter {
  const adapter = new OpenRouterAdapter({
    name: 'openrouter',
    apiKey: 'test-key-not-real',
    baseURL: 'https://openrouter.test/api/v1',
    enabled: true,
    priority: 1,
  } as never);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).makeRequest = async () =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).executeThroughBulkhead = async (fn: () => Promise<unknown>) => fn();

  return adapter;
}

async function statusOf(adapter: OpenRouterAdapter): Promise<number | undefined> {
  try {
    await adapter.chatCompletion(REQUEST);
    return undefined;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode;
  }
}

describe('OpenRouterAdapter upstream status preservation', () => {
  let status: number | undefined;

  beforeEach(async () => {
    status = await statusOf(adapterReturning(404, FREE_MODEL_404));
  });

  it('preserves a 404 instead of laundering it into a 500', () => {
    expect(status).toBe(404);
  });

  it('reports a status the payment/not-found classifiers actually recognise', () => {
    // isPaymentFailure checks 402/403/404 — with 500 it never matched.
    expect([402, 403, 404]).toContain(status);
  });

  it.each([
    [401, 'auth failure must reach the auth-failure branch'],
    [402, 'payment failure must trigger cross-provider failover'],
    [403, 'forbidden must not look transient'],
    [429, 'rate limit must be distinguishable from a server error'],
  ])('preserves %i (%s)', async (code) => {
    expect(await statusOf(adapterReturning(code, '{"error":"nope"}'))).toBe(code);
  });

  it('still reports 500 for a genuine upstream server error', async () => {
    expect(await statusOf(adapterReturning(500, 'boom'))).toBe(500);
  });

  it('falls back to 500 when there is no recoverable status', async () => {
    const adapter = adapterReturning(200, '{}');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).makeRequest = async () => {
      throw new Error('socket hang up');
    };
    expect(await statusOf(adapter)).toBe(500);
  });
});
