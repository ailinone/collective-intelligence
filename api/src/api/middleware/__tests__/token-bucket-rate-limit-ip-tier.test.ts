// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * IP-tier yields when an authenticated identifier is present.
 *
 * The default config for the IP bucket is aggressive (capacity ~100, refill
 * 1 token/sec). The previous behavior consumed an IP token on EVERY request
 * — including authenticated ones — which meant a single authenticated client
 * behind one IP could exhaust the IP burst in ~1 second, then be throttled
 * to 1 RPS regardless of the per-key/per-user/per-org tiers passing.
 *
 * Smoke v3 confirmed the diagnosis: with a 1.2s pacing the same workload
 * dropped from 114× 429 to 0× 429. See scripts/FINAL-REPORT.md §2.
 *
 * Contract under test:
 *   - When `apiKey` is present (x-api-key header)        → IP tier skipped.
 *   - When `userId` is populated (JWT auth)               → IP tier skipped.
 *   - When BOTH are absent (anonymous traffic)            → IP tier consumed.
 *
 * The IP tier remains a defense for unauthenticated traffic — never
 * disabled outright.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

const mocks = vi.hoisted(() => ({
  consumeMock: vi.fn(),
  getStatsMock: vi.fn(),
  getBucketMock: vi.fn(),
  getRetryAfterMock: vi.fn(),
  getDefaultConfigMock: vi.fn(),
  getTierConfigMock: vi.fn(),
  resolveOrganizationIdMock: vi.fn(),
}));

vi.mock('@/core/resilience/token-bucket-limiter', () => ({
  tokenBucketManager: {
    getBucket: mocks.getBucketMock,
    getDefaultConfig: mocks.getDefaultConfigMock,
    getRetryAfter: mocks.getRetryAfterMock,
    getAllStats: () => Promise.resolve([]),
  },
  // Passthrough stub: this file doesn't assert on the logged identifier
  // representation, only on rate-limit/bypass behavior.
  safeLogIdentifier: (_scope: string, identifier: string) => identifier,
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
}));

vi.mock('@/config/multi-tenancy-config', () => ({
  getTierConfig: mocks.getTierConfigMock,
}));

vi.mock('@/utils/context-headers', () => ({
  resolveOrganizationId: mocks.resolveOrganizationIdMock,
}));

import { tokenBucketRateLimitMiddleware } from '../token-bucket-rate-limit';

function makeRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    url: '/v1/chat/completions',
    method: 'POST',
    headers: {},
    ip: '10.0.0.5',
    query: {},
    ...overrides,
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply & { _sent: boolean; _statusCode?: number; _headers: Record<string, string> } {
  const reply = {
    _sent: false,
    _headers: {} as Record<string, string>,
    get sent() { return this._sent; },
    status(code: number) { this._statusCode = code; return this; },
    send() { this._sent = true; return this; },
    header(key: string, value: string) { this._headers[key] = value; return this; },
  } as FastifyReply & { _sent: boolean; _statusCode?: number; _headers: Record<string, string> };
  return reply;
}

beforeEach(() => {
  // vitest.ci.config.ts does not set `clearMocks` — without this, the
  // hoisted mocks accumulate call history across `it` blocks, and the
  // call-count assertions below (consumedScopes, "spy not called") read
  // calls leaked from earlier tests in this file.
  vi.clearAllMocks();
  mocks.consumeMock.mockResolvedValue(true);
  mocks.getStatsMock.mockResolvedValue({ tokensAvailable: 100, capacity: 100, refillRate: 1 });
  mocks.getBucketMock.mockReturnValue({
    consume: mocks.consumeMock,
    getStats: mocks.getStatsMock,
  });
  mocks.getRetryAfterMock.mockResolvedValue(60_000);
  mocks.getDefaultConfigMock.mockReturnValue({ capacity: 100, refillRate: 1 });
  mocks.getTierConfigMock.mockReturnValue(null);
  mocks.resolveOrganizationIdMock.mockReturnValue(undefined);
});

/**
 * Read the scopes the middleware actually consumed from. The mock receives
 * `getBucket(scope, identifier, ...)` — we collect the first arg.
 */
function consumedScopes(): string[] {
  return mocks.getBucketMock.mock.calls.map((c) => String(c[0]));
}

describe('tokenBucketRateLimitMiddleware: IP-tier yields under authenticated traffic', () => {
  it('skips IP tier when x-api-key is present', async () => {
    const request = makeRequest({
      headers: { 'x-api-key': 'ak_test_key' },
    });
    const reply = makeReply();

    await tokenBucketRateLimitMiddleware(request, reply, {
      perApiKey: true,
      perIP: true,
      perUser: true,
      perOrganization: true,
    });

    const scopes = consumedScopes();
    expect(scopes).toContain('api-key');
    expect(scopes).not.toContain('ip-address');
    expect(reply._sent).toBe(false);
  });

  it('skips IP tier when JWT-derived userId is present (no x-api-key header)', async () => {
    // Production JWT path: api-key-auth-middleware sets request.userId from
    // the JWT payload. The rate-limit middleware reads `extendedRequest.userId`
    // via getIdentifiers(). No x-api-key header on the request.
    const request = makeRequest({
      headers: {},
      // Cast to bypass the strict FastifyRequest typing — the production code
      // accesses these as `extendedRequest.userId` / `extendedRequest.tenantContext`.
    } as unknown as FastifyRequest);
    (request as unknown as { userId: string }).userId = 'user_abc123';

    const reply = makeReply();

    await tokenBucketRateLimitMiddleware(request, reply, {
      perApiKey: true,
      perIP: true,
      perUser: true,
      perOrganization: true,
    });

    const scopes = consumedScopes();
    expect(scopes).toContain('user');
    expect(scopes).not.toContain('ip-address');
    expect(reply._sent).toBe(false);
  });

  it('STILL consumes IP tier when no authenticated identifier is present (anonymous traffic)', async () => {
    // Floor test: this is the case the IP tier was actually designed for —
    // anti-DoS on the unauth surface. We must not lose this protection.
    const request = makeRequest({
      headers: {},
    });
    const reply = makeReply();

    await tokenBucketRateLimitMiddleware(request, reply, {
      perApiKey: true,
      perIP: true,
      perUser: false,
      perOrganization: false,
    });

    const scopes = consumedScopes();
    expect(scopes).toContain('ip-address');
    expect(reply._sent).toBe(false);
  });

  it('does not 429 an authenticated client even when the IP bucket would have been exhausted', async () => {
    // Regression scenario: smoke v2 saw 114/240 endpoints fail with 429,
    // because every authenticated request was also debiting the IP bucket
    // (capacity 100). With this fix, the IP tier is skipped, so the request
    // depends only on the per-key/per-user/per-org tiers. We simulate the
    // IP bucket being empty — if the middleware still consults it, a 429
    // would surface here.
    let calls = 0;
    mocks.consumeMock.mockImplementation(async () => {
      // First call (api-key tier) succeeds; the IP tier would fail if reached.
      calls++;
      if (calls === 1) return true;
      return false;
    });

    const request = makeRequest({
      headers: { 'x-api-key': 'ak_test_key' },
    });
    const reply = makeReply();

    await tokenBucketRateLimitMiddleware(request, reply, {
      perApiKey: true,
      perIP: true,
      perUser: false,
      perOrganization: false,
    });

    expect(reply._sent).toBe(false);
    expect(reply._statusCode).toBeUndefined();
    // Exactly one bucket consulted: api-key. IP tier was skipped.
    expect(consumedScopes()).toEqual(['api-key']);
  });
});
