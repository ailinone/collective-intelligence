// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression guard for the free-tier burst-capacity gap found while
 * auditing whether ci's API can absorb bursty tool-calling traffic from
 * agentic coding IDEs (Cursor, Cline, Zed, Claude Code, Goose, Opencode).
 *
 * The bug
 * ────────
 * `resolveScopeConfig` (token-bucket-rate-limit.ts) derives each tier/scope's
 * token-bucket burst CAPACITY from `TIER_CONFIGS` (multi-tenancy-config.ts).
 * For a fresh org on the default "free" tier (`requestsPerMinute: 10`), the
 * three scopes that ALL must independently allow a request (api-key/user/
 * organization run concurrently via `Promise.all` in
 * `tokenBucketRateLimitMiddleware`, and a single rejection 429s the whole
 * request) used to resolve to:
 *
 *   - organization: max(10, 10)          = 10
 *   - api-key:      max(round(10*0.8),10) = 10
 *   - user:         max(round(10/4), 5)   =  5   <-- the bottleneck
 *
 * So the free tier's REAL effective burst ceiling was min(10, 10, 5) = 5, not
 * 10 — a realistic agentic tool-calling loop (6+ near-simultaneous
 * round-trips: reading several files in parallel, a rapid multi-step tool
 * chain) tripped a 429 well before the nominal "10 req/min" sustained rate
 * was ever exceeded.
 *
 * The fix raises the 'user' scope's floor from 5 to `MIN_SCOPE_BURST_CAPACITY`
 * (10), aligning it with the other two scopes' existing floor of 10 — so the
 * free tier's effective burst ceiling becomes 10. It does NOT touch the
 * sustained rate: refillRate is `capacity / 60` floored at 1 token/sec, and
 * for capacity <= 60 (true here) that floor — not `capacity / 60` — is what
 * governs steady-state throughput either way. Paid tiers are untouched (pro's
 * user-scope burst is round(100/4) = 25, well above this floor).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { tokenBucketManager } from '@/core/resilience/token-bucket-limiter';

// This file verifies pure burst-capacity MATH against TIER_CONFIGS' real,
// hardcoded numbers -- it has no interest in the billing-aware resolution
// path (resolveEffectiveTierConfigForHotPath) that production now uses, so
// this stubs just that one export back to an immediately-resolved hardcoded
// lookup (via the REAL getTierConfig/TIER_CONFIGS, kept otherwise unmocked)
// instead of racing a real Redis/billing round-trip for every request this
// file fires (up to 20 in a single test).
vi.mock('@/config/multi-tenancy-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/multi-tenancy-config')>();
  return {
    ...actual,
    resolveEffectiveTierConfigForHotPath: (tier: string) => Promise.resolve(actual.getTierConfig(tier)),
  };
});

import { tokenBucketRateLimitMiddleware } from '../token-bucket-rate-limit';

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeRequest(opts: { apiKey: string; userId: string; orgId: string; tier: string }): FastifyRequest {
  return {
    url: '/v1/chat/completions',
    method: 'POST',
    headers: { 'x-api-key': opts.apiKey },
    ip: '10.0.0.9',
    query: {},
    tenantContext: {
      organizationId: opts.orgId,
      userId: opts.userId,
      tier: opts.tier,
      roles: [],
    },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply & { statusCode?: number; body?: unknown } {
  const reply = {
    header: vi.fn().mockReturnThis(),
    status: vi.fn(function (this: typeof reply, code: number) {
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

const FULL_SCOPE_CONFIG = { perApiKey: true, perIP: true, perUser: true, perOrganization: true };

describe('token-bucket-rate-limit — free-tier burst capacity (Issue 3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the free tier "user" scope burst capacity to 10 (was 5)', async () => {
    const suffix = uniqueSuffix();
    const request = makeRequest({
      apiKey: `ak_burst_capacity_${suffix}`,
      userId: `user_burst_capacity_${suffix}`,
      orgId: `org_burst_capacity_${suffix}`,
      tier: 'free',
    });
    const reply = makeReply();
    const getBucketSpy = vi.spyOn(tokenBucketManager, 'getBucket');

    await tokenBucketRateLimitMiddleware(request, reply, FULL_SCOPE_CONFIG);

    const userCall = getBucketSpy.mock.calls.find((call) => call[0] === 'user');
    const apiKeyCall = getBucketSpy.mock.calls.find((call) => call[0] === 'api-key');
    const orgCall = getBucketSpy.mock.calls.find((call) => call[0] === 'organization');

    expect(userCall?.[2]).toEqual({ capacity: 10, refillRate: 1 });
    // Sanity: 'user' is now aligned with the other two scopes, not the
    // odd-one-out at half their floor.
    expect(apiKeyCall?.[2]).toEqual({ capacity: 10, refillRate: 1 });
    expect(orgCall?.[2]).toEqual({ capacity: 10, refillRate: 1 });
  });

  it('does NOT change the pro tier (still round(100/4) = 25, comfortably above the free-tier floor)', async () => {
    const suffix = uniqueSuffix();
    const request = makeRequest({
      apiKey: `ak_pro_unaffected_${suffix}`,
      userId: `user_pro_unaffected_${suffix}`,
      orgId: `org_pro_unaffected_${suffix}`,
      tier: 'pro',
    });
    const reply = makeReply();
    const getBucketSpy = vi.spyOn(tokenBucketManager, 'getBucket');

    await tokenBucketRateLimitMiddleware(request, reply, FULL_SCOPE_CONFIG);

    const userCall = getBucketSpy.mock.calls.find((call) => call[0] === 'user');
    expect(userCall?.[2]).toEqual({ capacity: 25, refillRate: 1 });
  });

  it(
    'a realistic 10-near-simultaneous-request agentic burst no longer trips a 429 ' +
      'for a fresh free-tier org (was capped at 5 before the fix)',
    async () => {
      const suffix = uniqueSuffix();
      const identity = {
        apiKey: `ak_realistic_burst_${suffix}`,
        userId: `user_realistic_burst_${suffix}`,
        orgId: `org_realistic_burst_${suffix}`,
        tier: 'free',
      };

      const statuses: Array<number | undefined> = [];
      for (let i = 0; i < 10; i++) {
        const reply = makeReply();
        await tokenBucketRateLimitMiddleware(makeRequest(identity), reply, FULL_SCOPE_CONFIG);
        statuses.push(reply.statusCode);
      }

      // Before the fix, the 'user' scope bucket (capacity 5) would have
      // rejected requests 6-10. With the fix, all 10 fit inside the new
      // capacity-10 bucket.
      expect(statuses.filter((s) => s === 429)).toHaveLength(0);
    }
  );

  it('the burst ceiling is still real and bounded: a 20-request flood exceeds capacity 10', async () => {
    // Deliberately not asserting on a single exact boundary index (e.g. "the
    // 11th request") — the refill floor of 1 token/sec means a slow CI runner
    // taking >1s across the loop could legitimately earn back a token before
    // the last iteration, which would make an exact-index assertion flaky.
    // Firing well past the capacity (20 requests against a capacity of 10)
    // and asserting SOME-but-not-all are rejected is robust to that jitter
    // while still proving the ceiling is real and finite.
    const suffix = uniqueSuffix();
    const identity = {
      apiKey: `ak_ceiling_bounded_${suffix}`,
      userId: `user_ceiling_bounded_${suffix}`,
      orgId: `org_ceiling_bounded_${suffix}`,
      tier: 'free',
    };

    const statuses: Array<number | undefined> = [];
    for (let i = 0; i < 20; i++) {
      const reply = makeReply();
      await tokenBucketRateLimitMiddleware(makeRequest(identity), reply, FULL_SCOPE_CONFIG);
      statuses.push(reply.statusCode);
    }

    const blocked = statuses.filter((s) => s === 429).length;
    // This is what keeps the raised floor a real (if wider) anti-abuse
    // boundary rather than an accidental removal of the limit altogether.
    expect(blocked).toBeGreaterThan(0);
    expect(blocked).toBeLessThan(20);
  });
});
