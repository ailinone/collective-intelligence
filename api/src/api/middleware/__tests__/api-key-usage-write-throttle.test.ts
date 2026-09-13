// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * trackApiKeyUsage() used to UPDATE api_keys on every successful auth (cache
 * hit or miss): one Postgres write per request. These tests pin the per-key
 * throttle (one write per API_KEY_USAGE_WRITE_INTERVAL_MS, requests inside
 * the window accumulated into the next `requestCount` increment) and that
 * the auth decision itself is untouched by it.
 *
 * Setup mirrors api-key-auth-middleware-role-resolution.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const { verifyTokenMock } = vi.hoisted(() => ({ verifyTokenMock: vi.fn() }));

vi.mock('@/database/client', () => ({
  prisma: {
    apiKey: { findFirst: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() })),
  },
}));

vi.mock('@/services/auth-service', () => ({
  getAuthService: () => ({ verifyToken: verifyTokenMock }),
}));

vi.mock('@/services/rbac-service', () => ({
  registerRoleChangeListener: vi.fn(() => () => {}),
}));

vi.mock('bcrypt', () => ({
  default: { compare: vi.fn(async () => true) },
}));

import {
  apiKeyAuthMiddleware,
  __resetApiKeyAuthCacheForTests,
} from '@/api/middleware/api-key-auth-middleware';
import type { AuthenticatedRequest } from '@/api/middleware/api-key-auth-middleware';
import { prisma } from '@/database/client';

const USER_ID = '6687ac25-fc5a-4662-9d2a-b92550c4efcf';
const ORG_ID = '63632c52-6e75-45a3-aac6-1d91008a216b';
const API_KEY = 'ai1sk_usage_throttle_key_value';
const KEY_ID = 'key-throttle-1';

function makeRequest(ip: string): Partial<FastifyRequest> {
  return {
    url: '/v1/chat/completions',
    method: 'POST',
    headers: { 'x-api-key': API_KEY },
    ip,
    log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as FastifyRequest['log'],
  };
}

function makeReply(): Partial<FastifyReply> {
  return { status: vi.fn().mockReturnThis(), send: vi.fn(), code: vi.fn().mockReturnThis() };
}

function apiKeyRecord() {
  return {
    id: KEY_ID,
    name: 'throttle key',
    status: 'active',
    statusReason: null,
    expiresAt: null,
    keyHash: '$2b$12$hash',
    ipWhitelist: [],
    permissions: null,
    userId: USER_ID,
    organizationId: ORG_ID,
    user: {
      id: USER_ID,
      email: 'throttle@example.com',
      name: 'Throttle',
      role: 'user',
      status: 'active',
      organizationId: ORG_ID,
      organization: { id: ORG_ID, tier: 'enterprise', status: 'active' },
      userRoles: [{ role: { id: 'role-user', name: 'user' } }],
    },
  };
}

async function authenticate(ip = '10.0.0.1'): Promise<AuthenticatedRequest> {
  const request = makeRequest(ip);
  await apiKeyAuthMiddleware(request as FastifyRequest, makeReply() as FastifyReply);
  return request as AuthenticatedRequest;
}

function updateData(callIndex: number): Record<string, unknown> {
  const args = vi.mocked(prisma.apiKey.update).mock.calls[callIndex][0] as {
    where: { id: string };
    data: Record<string, unknown>;
  };
  expect(args.where).toEqual({ id: KEY_ID });
  return args.data;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
  vi.clearAllMocks();
  __resetApiKeyAuthCacheForTests();
  delete process.env.API_KEY_USAGE_WRITE_INTERVAL_MS;
  vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(apiKeyRecord() as never);
  vi.mocked(prisma.apiKey.update).mockResolvedValue({} as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('api_keys usage write throttle', () => {
  it('writes immediately on the first auth of a key', async () => {
    const authenticated = await authenticate('10.0.0.1');

    expect(authenticated.user.userId).toBe(USER_ID);
    expect(prisma.apiKey.update).toHaveBeenCalledTimes(1);
    expect(updateData(0)).toMatchObject({
      requestCount: { increment: 1 },
      lastRequestIp: '10.0.0.1',
      lastUsedAt: new Date('2026-09-11T12:00:00Z'),
    });
  });

  it('does not write again inside the interval, on auth-cache hits or misses', async () => {
    await authenticate();
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5_000);
      const authenticated = await authenticate();
      expect(authenticated.user.userId).toBe(USER_ID);
    }
    // Auth-cache miss (context resolved from the DB again) must still be
    // throttled: clear only the auth cache by re-mocking a fresh lookup.
    vi.mocked(prisma.apiKey.findFirst).mockClear();
    vi.advanceTimersByTime(31_000); // auth cache TTL is 30 s
    const afterMiss = await authenticate();
    expect(afterMiss.user.userId).toBe(USER_ID);
    expect(prisma.apiKey.findFirst).toHaveBeenCalledTimes(1);

    expect(prisma.apiKey.update).toHaveBeenCalledTimes(1);
  });

  it('flushes the accumulated count and latest IP once the interval elapsed', async () => {
    await authenticate('10.0.0.1');
    for (let i = 0; i < 5; i++) {
      await authenticate(`10.0.0.${i + 2}`);
    }
    expect(prisma.apiKey.update).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await authenticate('10.0.0.99');

    expect(prisma.apiKey.update).toHaveBeenCalledTimes(2);
    expect(updateData(1)).toMatchObject({
      requestCount: { increment: 6 },
      lastRequestIp: '10.0.0.99',
      lastUsedAt: new Date('2026-09-11T12:01:00Z'),
    });
  });

  it('honours API_KEY_USAGE_WRITE_INTERVAL_MS', async () => {
    process.env.API_KEY_USAGE_WRITE_INTERVAL_MS = '1000';
    await authenticate();
    vi.advanceTimersByTime(1_000);
    await authenticate();

    expect(prisma.apiKey.update).toHaveBeenCalledTimes(2);
  });

  it('carries increments from a failed write into the next flush without failing auth', async () => {
    vi.mocked(prisma.apiKey.update).mockRejectedValueOnce(new Error('db down') as never);

    const authenticated = await authenticate();
    expect(authenticated.user.userId).toBe(USER_ID);
    await vi.runAllTimersAsync();

    await authenticate();
    vi.advanceTimersByTime(60_000);
    await authenticate();

    expect(prisma.apiKey.update).toHaveBeenCalledTimes(2);
    expect(updateData(1)).toMatchObject({ requestCount: { increment: 3 } });
  });

  it('tracks keys independently', async () => {
    await authenticate();
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue({
      ...apiKeyRecord(),
      id: 'key-throttle-2',
    } as never);
    const request = makeRequest('10.0.0.1');
    request.headers = { 'x-api-key': 'ai1sk_other_key_value' };
    await apiKeyAuthMiddleware(request as FastifyRequest, makeReply() as FastifyReply);

    expect(prisma.apiKey.update).toHaveBeenCalledTimes(2);
    const ids = vi
      .mocked(prisma.apiKey.update)
      .mock.calls.map((call) => (call[0] as { where: { id: string } }).where.id);
    expect(ids).toEqual([KEY_ID, 'key-throttle-2']);
  });

  it('resets with __resetApiKeyAuthCacheForTests so the next auth writes again', async () => {
    await authenticate();
    __resetApiKeyAuthCacheForTests();
    await authenticate();

    expect(prisma.apiKey.update).toHaveBeenCalledTimes(2);
    expect(updateData(1)).toMatchObject({ requestCount: { increment: 1 } });
  });
});
