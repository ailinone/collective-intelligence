// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression guard for the dead-rate-limit-layer bug found while auditing
 * whether ci's API can absorb bursty tool-calling traffic from agentic
 * coding IDEs (Cursor, Cline, Zed, Claude Code, Goose, Opencode).
 *
 * The bug
 * ────────
 * `enforceApiKeyRateLimit` (api-key-rate-limit-middleware.ts) early-returns
 * whenever `request.apiKey?.id` is unset — by its own doc comment it "Should
 * be called AFTER api-key-auth-middleware has validated the API key." That
 * precondition was violated in production: `enforceApiKeyRateLimit` used to
 * be registered as a preHandler INSIDE `createServer()` (server.ts), while
 * `apiKeyAuthMiddleware` — the hook that actually sets `request.apiKey` — was
 * registered afterward, in index.ts's bootstrap, once `createServer()` had
 * already returned. Every preHandler `createServer()` adds therefore ran
 * BEFORE every preHandler index.ts adds, so `request.apiKey` was always
 * undefined when `enforceApiKeyRateLimit` ran, and this entire sliding-window
 * rate-limit layer silently no-op'd on every request in production.
 *
 * The fix moved the `enforceApiKeyRateLimit` registration out of server.ts
 * and into index.ts, immediately after `apiKeyAuthMiddleware` — mirroring
 * where `tokenBucketMiddleware` is already (correctly) registered for the
 * exact same reason.
 *
 * This file guards the fix two ways:
 *   1. A functional test that runs the two REAL middleware functions against
 *      the same request object in both orders, and shows the sliding window
 *      only ever throttles in the correct (auth-first) order — the wrong
 *      order reproduces the exact "always lets everything through" bug.
 *   2. A structural test on the actual registration call sites in
 *      server.ts/index.ts, so a future refactor that re-introduces the
 *      registration inside `createServer()` (or reorders the two hooks in
 *      index.ts) fails this test before it ever reaches production.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcrypt';

// ── Prisma mock (same shape proven out in api-key-auth-middleware.test.ts) ──
vi.mock('@/database/client', () => ({
  prisma: {
    apiKey: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

// Force the sliding-window middleware into its local in-memory fallback path
// (same technique as api-key-rate-limit-fallback.test.ts) so this test needs
// no real Redis.
vi.mock('ioredis', () => ({
  default: class {
    constructor() {
      throw new Error('simulated: Redis unreachable (test uses local fallback)');
    }
  },
}));

const { prisma } = await import('@/database/client');
const { apiKeyAuthMiddleware, __resetApiKeyAuthCacheForTests } = await import(
  '@/api/middleware/api-key-auth-middleware'
);
const { enforceApiKeyRateLimit } = await import('../api-key-rate-limit-middleware');

interface MockApiKeyWithUser {
  id: string;
  name?: string;
  status: string;
  expiresAt?: Date | null;
  keyHash: string;
  ipWhitelist?: string[];
  permissions?: Record<string, unknown> | null;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    organization: { id: string; tier: string; status: string };
    userRoles: unknown[];
  };
}

function makeMockApiKeyRecord(keyHash: string): MockApiKeyWithUser {
  return {
    id: `key-${Math.random().toString(36).slice(2)}`,
    name: 'Hook Order Test Key',
    status: 'active',
    expiresAt: null,
    keyHash,
    ipWhitelist: [],
    permissions: null,
    user: {
      id: 'user-hook-order',
      email: 'hook-order@example.com',
      name: 'Hook Order Tester',
      role: 'member',
      status: 'active',
      // free tier => TIER_RATE_LIMITS.free = 20/min, burst = floor(20*1.5) = 30
      organization: { id: 'org-hook-order', tier: 'free', status: 'active' },
      userRoles: [],
    },
  };
}

function makeRequest(apiKey: string): FastifyRequest {
  return {
    url: '/v1/chat/completions',
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    ip: '10.0.0.5',
    log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply & { statusCode?: number; body?: unknown } {
  const reply = {
    header: vi.fn().mockReturnThis(),
    code: vi.fn(function (this: typeof reply, code: number) {
      this.statusCode = code;
      return this;
    }),
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

describe('enforceApiKeyRateLimit + apiKeyAuthMiddleware — registration order (Issue 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.apiKey.update).mockResolvedValue({} as never);
    vi.stubEnv('API_KEY_RATE_LIMIT_ENABLED', 'true');
    __resetApiKeyAuthCacheForTests();
  });

  it(
    'CORRECT order (auth, then rate-limit): request.apiKey is populated and the ' +
      'sliding window actually throttles once the tier limit is exceeded',
    async () => {
      const rawApiKey = `ak_live_correct_order_${Date.now()}`;
      const hashedKey = await bcrypt.hash(rawApiKey, 4); // low cost factor, this is a test
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(
        makeMockApiKeyRecord(hashedKey) as never
      );

      let blocked = 0;
      let allowed = 0;
      let sawApiKeyPopulated = false;

      // free tier burst = floor(20 * 1.5) = 30 — 35 requests must produce at
      // least one 429.
      for (let i = 0; i < 35; i++) {
        const request = makeRequest(rawApiKey);
        const reply = makeReply();

        // Production order: apiKeyAuthMiddleware runs first (sets
        // request.apiKey), THEN enforceApiKeyRateLimit consumes it.
        await apiKeyAuthMiddleware(request, reply);
        if ((request as unknown as { apiKey?: { id: string } }).apiKey?.id) {
          sawApiKeyPopulated = true;
        }
        await enforceApiKeyRateLimit(request, reply);

        if (reply.statusCode === 429) {
          blocked++;
        } else {
          allowed++;
        }
      }

      expect(sawApiKeyPopulated).toBe(true);
      // This is the exact assertion that would have FAILED before the fix:
      // the old registration order meant `enforceApiKeyRateLimit` never saw
      // `request.apiKey`, so `blocked` was always 0 and `allowed` was always 35.
      expect(blocked).toBeGreaterThan(0);
      expect(allowed).toBeLessThan(35);
    }
  );

  it(
    'WRONG order (rate-limit before auth) reproduces the production bug: ' +
      'request.apiKey is never populated, so the limiter never throttles',
    async () => {
      const rawApiKey = `ak_live_wrong_order_${Date.now()}`;
      const hashedKey = await bcrypt.hash(rawApiKey, 4);
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(
        makeMockApiKeyRecord(hashedKey) as never
      );

      let blocked = 0;

      // Old (buggy) order: enforceApiKeyRateLimit runs BEFORE apiKeyAuthMiddleware
      // ever gets a chance to set request.apiKey — exactly what server.ts's
      // createServer() vs. index.ts's bootstrap ordering used to produce.
      for (let i = 0; i < 35; i++) {
        const request = makeRequest(rawApiKey);
        const reply = makeReply();

        await enforceApiKeyRateLimit(request, reply); // apiKey not set yet
        await apiKeyAuthMiddleware(request, reply); // too late — already skipped

        if (reply.statusCode === 429) {
          blocked++;
        }
      }

      // Documents the bug this fix closes: with the wrong order, the sliding
      // window layer is a complete no-op no matter how many requests fire.
      expect(blocked).toBe(0);
    }
  );
});

describe('Registration-order contract (source guard) — Issue 1', () => {
  const SERVER_PATH = join(__dirname, '..', '..', 'server.ts');
  const INDEX_PATH = join(__dirname, '..', '..', 'index.ts');
  const serverSource = readFileSync(SERVER_PATH, 'utf8');
  const indexSource = readFileSync(INDEX_PATH, 'utf8');

  it('server.ts (createServer) no longer registers enforceApiKeyRateLimit as a preHandler', () => {
    // This was the actual bug: createServer() runs to completion, adding all
    // of its own preHandlers, BEFORE index.ts's bootstrap adds
    // apiKeyAuthMiddleware. Registering the rate limiter in here — no matter
    // where — puts it before auth. It must never come back.
    expect(serverSource).not.toMatch(
      /addHook\(\s*['"]preHandler['"]\s*,\s*enforceApiKeyRateLimit\s*\)/
    );
  });

  it('index.ts registers apiKeyAuthMiddleware as a preHandler', () => {
    expect(indexSource).toMatch(
      /addHook\(\s*['"]preHandler['"]\s*,\s*apiKeyAuthMiddleware\s*\)/
    );
  });

  it('index.ts registers enforceApiKeyRateLimit as a preHandler', () => {
    expect(indexSource).toMatch(
      /addHook\(\s*['"]preHandler['"]\s*,\s*enforceApiKeyRateLimit\s*\)/
    );
  });

  it('index.ts registers apiKeyAuthMiddleware BEFORE enforceApiKeyRateLimit', () => {
    const authHookIndex = indexSource.search(
      /addHook\(\s*['"]preHandler['"]\s*,\s*apiKeyAuthMiddleware\s*\)/
    );
    const rateLimitHookIndex = indexSource.search(
      /addHook\(\s*['"]preHandler['"]\s*,\s*enforceApiKeyRateLimit\s*\)/
    );

    expect(authHookIndex).toBeGreaterThan(-1);
    expect(rateLimitHookIndex).toBeGreaterThan(-1);
    // The load-bearing assertion: if a future refactor moves the rate-limit
    // hook registration back above the auth hook registration (or re-adds it
    // inside createServer(), which the test above also guards), this fails.
    expect(authHookIndex).toBeLessThan(rateLimitHookIndex);
  });
});
