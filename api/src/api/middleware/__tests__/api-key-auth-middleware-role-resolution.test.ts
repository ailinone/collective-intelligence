// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * REGRESSION: the roles that authorization actually consumes.
 *
 * `apiKeyAuthMiddleware` is registered as a GLOBAL Fastify preHandler
 * (index.ts) and runs on every `/v1/*`, `/console/api/*` and `/internal/*`
 * request. It resolves the principal itself, and route-level `authenticate`
 * short-circuits on the ids it attached — so the array this middleware builds is
 * the one `requireRole` and `requirePermission` read. Fixing `rbac-service` in
 * isolation does NOT fix production if this file still seeds authority from
 * somewhere else.
 *
 * It used to:
 *   - API-key path: `const roles = [apiKeyRecord.user.role]` — the denormalized
 *     hint column was the SEED of the effective role array;
 *   - JWT path: `[...userRoles, user.role, ...payload.roles]` — a UNION, so the
 *     hint column was added even with zero grants, and an unexpired token minted
 *     before a demotion kept resolving to its old role.
 *
 * Consequence: a principal with `users.role='admin'` and zero `user_roles` rows
 * authenticated as **admin on every route**, including the
 * `requireRole('admin','owner')`-gated `/v1/tools/*` shell/git/filesystem
 * surface. These tests pin the fix: effective roles are EXACTLY the
 * `user_roles` grants.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

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

// The middleware registers a cache-invalidation listener at module load; the
// service itself is irrelevant to what is under test here.
vi.mock('@/services/rbac-service', () => ({
  registerRoleChangeListener: vi.fn(() => () => {}),
}));

vi.mock('bcrypt', () => ({
  default: { compare: vi.fn(async () => true) },
}));

import {
  apiKeyAuthMiddleware,
  __resetApiKeyAuthCacheForTests,
  invalidateApiKeyAuthCacheForUser,
} from '@/api/middleware/api-key-auth-middleware';
import type { AuthenticatedRequest } from '@/api/middleware/api-key-auth-middleware';
import { prisma } from '@/database/client';

const USER_ID = '6687ac25-fc5a-4662-9d2a-b92550c4efcf';
const ORG_ID = '63632c52-6e75-45a3-aac6-1d91008a216b';
const API_KEY = 'ai1sk_timebomb_account_key_value';

function makeRequest(headers: Record<string, string>): Partial<FastifyRequest> {
  return {
    url: '/v1/tools/execute',
    method: 'POST',
    headers,
    ip: '192.168.1.100',
    log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as FastifyRequest['log'],
  };
}

function makeReply(): Partial<FastifyReply> {
  return { status: vi.fn().mockReturnThis(), send: vi.fn(), code: vi.fn().mockReturnThis() };
}

/** `users.role` says admin; the authoritative join table says nothing. */
function apiKeyRecord(declaredRole: string, grantedRoles: string[]) {
  return {
    id: 'key-1',
    name: 'root key',
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
      email: 'eval-timebomb@example.com',
      name: 'Eval',
      role: declaredRole,
      status: 'active',
      organizationId: ORG_ID,
      organization: { id: ORG_ID, tier: 'enterprise', status: 'active' },
      userRoles: grantedRoles.map((name) => ({ role: { id: `role-${name}`, name } })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetApiKeyAuthCacheForTests();
  vi.mocked(prisma.apiKey.update).mockResolvedValue({} as never);
});

describe('API-key path: users.role is never a grant', () => {
  it('resolves NO roles for users.role=admin with zero user_roles rows', async () => {
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(apiKeyRecord('admin', []) as never);

    const request = makeRequest({ 'x-api-key': API_KEY });
    await apiKeyAuthMiddleware(request as FastifyRequest, makeReply() as FastifyReply);

    const authenticated = request as AuthenticatedRequest;
    expect(authenticated.user).toBeDefined();
    // THE ASSERTION THAT MATTERS: not ['admin'].
    expect(authenticated.user.roles).toEqual([]);
    expect(authenticated.tenantContext.roles).toEqual([]);
  });

  it('resolves exactly the granted roles, ignoring a contradictory users.role', async () => {
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(
      apiKeyRecord('owner', ['viewer']) as never
    );

    const request = makeRequest({ 'x-api-key': API_KEY });
    await apiKeyAuthMiddleware(request as FastifyRequest, makeReply() as FastifyReply);

    const authenticated = request as AuthenticatedRequest;
    expect(authenticated.user.roles).toEqual(['viewer']);
    expect(authenticated.user.roles).not.toContain('owner');
  });

  it('a role change evicts the cached context for that user', async () => {
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(
      apiKeyRecord('admin', ['admin']) as never
    );

    const first = makeRequest({ 'x-api-key': API_KEY });
    await apiKeyAuthMiddleware(first as FastifyRequest, makeReply() as FastifyReply);
    expect((first as AuthenticatedRequest).user.roles).toEqual(['admin']);

    // Demotion lands in the DB...
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(
      apiKeyRecord('viewer', ['viewer']) as never
    );

    // ...without invalidation the 30s cache would still answer 'admin'.
    const cached = makeRequest({ 'x-api-key': API_KEY });
    await apiKeyAuthMiddleware(cached as FastifyRequest, makeReply() as FastifyReply);
    expect((cached as AuthenticatedRequest).user.roles).toEqual(['admin']);

    invalidateApiKeyAuthCacheForUser(USER_ID);

    const after = makeRequest({ 'x-api-key': API_KEY });
    await apiKeyAuthMiddleware(after as FastifyRequest, makeReply() as FastifyReply);
    expect((after as AuthenticatedRequest).user.roles).toEqual(['viewer']);
  });
});

describe('JWT path: neither users.role nor the token claim is a grant', () => {
  it('resolves NO roles for users.role=admin with zero user_roles rows', async () => {
    verifyTokenMock.mockResolvedValue({
      userId: USER_ID,
      organizationId: ORG_ID,
      email: 'eval-timebomb@example.com',
      roles: [],
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: USER_ID,
      email: 'eval-timebomb@example.com',
      name: 'Eval',
      role: 'admin',
      status: 'active',
      organizationId: ORG_ID,
      organization: { id: ORG_ID, tier: 'enterprise', status: 'active' },
      userRoles: [],
    } as never);

    const request = makeRequest({ authorization: 'Bearer header.payload.signature' });
    await apiKeyAuthMiddleware(request as FastifyRequest, makeReply() as FastifyReply);

    const authenticated = request as AuthenticatedRequest;
    expect(authenticated.user.roles).toEqual([]);
  });

  it('does not honour a token claim the database does not back', async () => {
    // A federated token asserting `owner` (which syncFederatedRoles refuses to
    // grant), or a stale local token minted before a demotion.
    verifyTokenMock.mockResolvedValue({
      userId: USER_ID,
      organizationId: ORG_ID,
      email: 'eval-timebomb@example.com',
      roles: ['owner', 'admin'],
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: USER_ID,
      email: 'eval-timebomb@example.com',
      name: 'Eval',
      role: 'viewer',
      status: 'active',
      organizationId: ORG_ID,
      organization: { id: ORG_ID, tier: 'enterprise', status: 'active' },
      userRoles: [{ role: { id: 'role-viewer', name: 'viewer' } }],
    } as never);

    const request = makeRequest({ authorization: 'Bearer header.payload.signature' });
    await apiKeyAuthMiddleware(request as FastifyRequest, makeReply() as FastifyReply);

    const authenticated = request as AuthenticatedRequest;
    expect(authenticated.user.roles).toEqual(['viewer']);
    expect(authenticated.user.roles).not.toContain('owner');
    expect(authenticated.user.roles).not.toContain('admin');
  });
});
