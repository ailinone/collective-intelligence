// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Operational-route bypass + reply-already-sent guard for token-bucket
 * rate limiting.
 *
 * Why this is its own file
 * ------------------------
 * The full token-bucket behavior (multi-tier limits, tier resolution,
 * Redis-backed buckets) is exhaustively covered elsewhere. This file
 * intentionally narrows to the two contracts the production incident
 * exposed:
 *
 *   1. Operational paths (`/health*`, `/metrics`, `/v1/status*`,
 *      `/v1/hcra/health`) MUST NOT consume a token from any bucket. A
 *      regression that re-bills health probes against a customer's API key
 *      manifests as 429s on the *probe* — masking real outages.
 *
 *   2. If a previous preHandler hook already sent a response (`reply.sent`),
 *      this middleware MUST be a no-op. A header touch on a sent reply is
 *      exactly what triggers FST_ERR_REP_ALREADY_SENT downstream.
 *
 * The token-bucket manager is mocked at module scope: any call to
 * `consume()` is a test failure when bypass should have triggered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

// `vi.mock(...)` factories are hoisted above all top-level declarations by the
// Vitest transform, so any variable they reference must be hoisted alongside
// them. `vi.hoisted(...)` is the documented escape hatch — the returned object
// is created BEFORE both the mock factory and the rest of this file runs.
//
// Important interaction with the repo's vitest.config.ts:
//   `mockReset: true` resets ALL `vi.fn()` implementations and return values
//   between EVERY test. So we cannot rely on `mockReturnValue(...)` set here
//   surviving past the first test — we re-arm them in `beforeEach` below.
//   For mocks we never assert on (e.g. logger.child), we use plain function
//   literals which mockReset cannot touch.
const mocks = vi.hoisted(() => {
  return {
    consumeMock: vi.fn(),
    consumeWithStatsMock: vi.fn(),
    getStatsMock: vi.fn(),
    getBucketMock: vi.fn(),
    getRetryAfterMock: vi.fn(),
    getDefaultConfigMock: vi.fn(),
    getTierConfigMock: vi.fn(),
    resolveOrganizationIdMock: vi.fn(),
  };
});

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

// Plain function literals (not `vi.fn()`) — these are never asserted on, and
// because `mockReset: true` only touches `vi.fn` instances, function literals
// stay stable for the whole file. If you ever need to assert calls on
// logger.child, switch to vi.fn AND re-arm in beforeEach.
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
    headers: { 'x-api-key': 'ak_test_key' },
    ip: '10.0.0.5',
    query: {},
    ...overrides,
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply & { _sent: boolean; _statusCode?: number; _payload?: unknown; _headers: Record<string, string> } {
  const reply = {
    _sent: false,
    _headers: {} as Record<string, string>,
    get sent() {
      return this._sent;
    },
    status(code: number) {
      this._statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this._payload = payload;
      this._sent = true;
      return this;
    },
    header(key: string, value: string) {
      this._headers[key] = value;
      return this;
    },
  } as FastifyReply & { _sent: boolean; _statusCode?: number; _payload?: unknown; _headers: Record<string, string> };
  return reply;
}

beforeEach(() => {
  // This file runs under vitest.ci.config.ts (the quality-gate config), which
  // does NOT set `clearMocks`/`mockReset` — the original assumption that
  // vitest.config.ts clears mocks before this hook does not hold there, and
  // call history leaked across `it` blocks (breaking the "spy not called"
  // assertions). Clear explicitly, then re-arm every return value.
  vi.clearAllMocks();
  mocks.consumeMock.mockResolvedValue(true);
  mocks.getStatsMock.mockResolvedValue({
    tokensAvailable: 100,
    capacity: 100,
    refillRate: 1,
  });
  // The middleware calls consumeWithStats() (one Redis round-trip for both the
  // allow/deny decision and the header stats) instead of consume()+getStats()
  // separately — see token-bucket-rate-limit.ts. Mock both call shapes so this
  // test stays valid regardless of which one the middleware uses.
  mocks.consumeWithStatsMock.mockResolvedValue({
    allowed: true,
    stats: { tokensAvailable: 100, capacity: 100, refillRate: 1 },
  });
  mocks.getBucketMock.mockReturnValue({
    consume: mocks.consumeMock,
    getStats: mocks.getStatsMock,
    consumeWithStats: mocks.consumeWithStatsMock,
  });
  mocks.getRetryAfterMock.mockResolvedValue(60_000);
  mocks.getDefaultConfigMock.mockReturnValue({ capacity: 100, refillRate: 1 });
  mocks.getTierConfigMock.mockReturnValue(null);
  mocks.resolveOrganizationIdMock.mockReturnValue(undefined);
});

// ─── Operational-route bypass ───────────────────────────────────────────────

describe('tokenBucketRateLimitMiddleware: operational-route bypass', () => {
  // Every entry in OPERATIONAL_ROUTE_PATHS is asserted here. If you add to
  // that list, add the path here too — the lockstep is intentional.
  it.each([
    '/health',
    '/health/ready',
    '/health/live',
    '/health/startup',
    '/metrics',
    '/.well-known/jwks.json',
    '/console/api/v1/jwks',
    '/v1/status',
    '/v1/status/health',
    '/v1/status/ready',
    '/v1/hcra/health',
  ])('does NOT consume a token for %s', async (path) => {
    const request = makeRequest({ url: path });
    const reply = makeReply();

    await tokenBucketRateLimitMiddleware(request, reply);

    expect(mocks.consumeWithStatsMock).not.toHaveBeenCalled();
    expect(reply._sent).toBe(false);
    expect(reply._statusCode).toBeUndefined();
  });

  it('strips the query string before matching', async () => {
    // Real probes append `?probe=1`, `?ts=...` etc. The bypass must not be
    // fooled by a query string attached to a known operational path.
    const request = makeRequest({ url: '/v1/hcra/health?probe=1&ts=1700000000' });
    const reply = makeReply();

    await tokenBucketRateLimitMiddleware(request, reply);

    expect(mocks.consumeWithStatsMock).not.toHaveBeenCalled();
  });

  it('does NOT bypass paths that merely START with an operational prefix (no false-positive)', async () => {
    // `/healthcare` shares a prefix with `/health` but is NOT operational.
    // The check uses `path === route || path.startsWith(`${route}/`)` — a
    // strict-segment prefix — so this must fall through to bucket consumption.
    const request = makeRequest({ url: '/healthcare/v1/something' });
    const reply = makeReply();

    await tokenBucketRateLimitMiddleware(request, reply);

    expect(mocks.consumeWithStatsMock).toHaveBeenCalled();
  });

  it('still rate-limits product endpoints normally', async () => {
    // Sanity floor: the bypass MUST be a narrowly-scoped exception. Any path
    // outside OPERATIONAL_ROUTE_PATHS still gets the full token-bucket
    // treatment (this is the whole point of the rate limiter).
    const request = makeRequest({ url: '/v1/chat/completions' });
    const reply = makeReply();

    await tokenBucketRateLimitMiddleware(request, reply);

    expect(mocks.consumeWithStatsMock).toHaveBeenCalled();
  });
});

// ─── reply.sent guard: defense-in-depth against FST_ERR_REP_ALREADY_SENT ───

describe('tokenBucketRateLimitMiddleware: reply-already-sent guard', () => {
  it('is a no-op when an upstream hook already sent the reply', async () => {
    // Simulates the regression: api-key-auth-middleware sent a 401, and a
    // poorly-written `return;` (without `return reply`) let Fastify keep
    // dispatching hooks. This middleware must NOT touch the reply.
    const request = makeRequest({ url: '/v1/chat/completions' });
    const reply = makeReply();
    reply._sent = true;
    reply._statusCode = 401;

    await tokenBucketRateLimitMiddleware(request, reply);

    // No bucket consumption (the request never made it past auth anyway).
    expect(mocks.consumeWithStatsMock).not.toHaveBeenCalled();
    // No additional headers set (would corrupt the already-sent response).
    expect(Object.keys(reply._headers)).toEqual([]);
    // Status code preserved (the upstream 401 stands).
    expect(reply._statusCode).toBe(401);
  });

  it('does NOT silently swallow product traffic — only short-circuits when reply was actually sent', async () => {
    // Floor test for the previous case: a reply that has NOT been sent must
    // still be processed. Otherwise the guard would mask the entire rate
    // limiter.
    const request = makeRequest({ url: '/v1/chat/completions' });
    const reply = makeReply();
    expect(reply._sent).toBe(false);

    await tokenBucketRateLimitMiddleware(request, reply);

    expect(mocks.consumeWithStatsMock).toHaveBeenCalled();
  });
});
