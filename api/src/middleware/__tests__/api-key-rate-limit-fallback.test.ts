// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic test for the local in-memory rate-limit fallback (scale-to-100k
 * Phase 3, issue #148) — this middleware is a live, global preHandler hook
 * (registered in server.ts) that previously failed OPEN (unlimited traffic)
 * whenever Redis was unavailable/erroring, exactly the scenario the plan doc
 * flags as dangerous (Redis saturation correlating with high load). This
 * verifies that with Redis unavailable, requests are still throttled by a
 * local sliding window instead of unconditionally allowed.
 *
 * ioredis is mocked to always fail to construct, simulating Redis being
 * completely unreachable — the middleware's own getRedisClient() catches
 * the constructor throw and returns null, taking the fallback path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

vi.mock('ioredis', () => ({
  default: class {
    constructor() {
      throw new Error('simulated: Redis unreachable');
    }
  },
}));

const { enforceApiKeyRateLimit } = await import('../api-key-rate-limit-middleware');

function fakeRequest(apiKeyId: string, tier = 'free'): FastifyRequest {
  return {
    apiKey: { id: apiKeyId, name: 'test-key', permissions: null },
    tenantContext: { tier },
    url: '/v1/chat/completions',
    method: 'POST',
  } as unknown as FastifyRequest;
}

function fakeReply(): FastifyReply & { statusCode?: number; body?: unknown } {
  const reply = {
    header: vi.fn().mockReturnThis(),
    code: vi.fn(function (this: typeof reply, code: number) {
      this.statusCode = code;
      return this;
    }),
    send: vi.fn(function (this: typeof reply, body: unknown) {
      this.body = body;
      return this;
    }),
  } as unknown as FastifyReply & { statusCode?: number; body?: unknown };
  return reply;
}

describe('enforceApiKeyRateLimit — local fallback when Redis is unavailable (issue #148)', () => {
  beforeEach(() => {
    vi.stubEnv('API_KEY_RATE_LIMIT_ENABLED', 'true');
  });

  it('does NOT fail open: requests are actually throttled once the tier limit is exceeded', async () => {
    // free tier = 20 req/min * 1.5 burst = 30 allowed
    const apiKeyId = `fallback-throttle-${Date.now()}`;
    let blocked = 0;
    let allowed = 0;

    for (let i = 0; i < 35; i++) {
      const reply = fakeReply();
      await enforceApiKeyRateLimit(fakeRequest(apiKeyId), reply);
      if (reply.statusCode === 429) {
        blocked++;
      } else {
        allowed++;
      }
    }

    // The old fail-open behavior would have let all 35 through (blocked === 0).
    // The fix must reject at least some once the local window fills up.
    expect(blocked).toBeGreaterThan(0);
    expect(allowed).toBeLessThan(35);
    expect(allowed).toBeLessThanOrEqual(30);
  });

  it('tracks separate windows per API key (one key exhausting its limit does not throttle another)', async () => {
    const keyA = `fallback-isolated-a-${Date.now()}`;
    const keyB = `fallback-isolated-b-${Date.now()}`;

    for (let i = 0; i < 35; i++) {
      await enforceApiKeyRateLimit(fakeRequest(keyA), fakeReply());
    }

    const replyForB = fakeReply();
    await enforceApiKeyRateLimit(fakeRequest(keyB), replyForB);
    expect(replyForB.statusCode).not.toBe(429);
  });

  it('sets rate-limit headers even in fallback mode', async () => {
    const reply = fakeReply();
    await enforceApiKeyRateLimit(fakeRequest(`fallback-headers-${Date.now()}`), reply);

    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(String));
    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
  });
});
