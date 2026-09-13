// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression coverage for the platform-admin-vs-tenant-admin RBAC fix
 * (2026-09-08). `requireRole('admin','owner')` checks a PER-ORGANIZATION
 * UserRole grant — any tenant's own org owner can self-service-promote
 * another user in the SAME org to `admin` via `PUT /v1/users/:id`. Routes
 * that operate on GLOBAL/cross-tenant resources (model discovery, benchmark
 * & experiment infrastructure, DLQ replay, the shared shell/git
 * tool-execution surface, etc.) must be gated by `requirePlatformAdmin()`
 * instead, which checks admin/owner of ONE reserved platform Organization
 * (`config.security.platformOrganizationId`), not of the caller's own tenant.
 *
 * `config` is a frozen object at runtime (assigning to it throws), so — same
 * pattern as require-permission-middleware.test.ts — `@/config` is mocked
 * with a hoisted, mutable stand-in this file can reassign per test.
 * `recordSecurityEvent` is mocked too, so denied-request tests never touch a
 * real database.
 *
 * Uses a real `Fastify()` instance + `.inject()` (this codebase's own
 * convention — see admission-control.test.ts) with a fake `preHandler` that
 * stands in for `authenticate` (sets `request.user`/`request.organizationId`
 * directly), since the real `authenticate()` needs a real JWT/DB round trip
 * this unit test has no business exercising — `requirePlatformAdmin`/
 * `isPlatformAdminRequest` only ever read what `authenticate` already
 * attached to the request.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';

const { mockSecurityConfig, recordSecurityEventMock } = vi.hoisted(() => ({
  mockSecurityConfig: { platformOrganizationId: null as string | null },
  recordSecurityEventMock: vi.fn(async () => {}),
}));

// `config` is a real, frozen object at runtime and `@/config` also exports
// other named bindings (e.g. `isDevelopment`) that unrelated modules
// transitively imported here (e.g. database/client.ts) rely on — so this
// spreads the REAL module and only overrides `platformOrganizationId`, via a
// getter (not a snapshot) so each test's mutation of `mockSecurityConfig` is
// picked up live.
vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      security: {
        ...actual.config.security,
        get platformOrganizationId() {
          return mockSecurityConfig.platformOrganizationId;
        },
      },
    },
  };
});

vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: recordSecurityEventMock,
}));

import { authenticate, requirePlatformAdmin, isPlatformAdminRequest } from '../auth-middleware';
import { AuthService } from '@/services/auth-service';

const PLATFORM_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ORG_ID = '22222222-2222-2222-2222-222222222222';

function fakeAuthenticateAs(user: { userId: string; organizationId: string; roles: string[] }) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    (request as unknown as { user: unknown; organizationId: string }).user = user;
    (request as unknown as { organizationId: string }).organizationId = user.organizationId;
  };
}

async function buildServer(user: { userId: string; organizationId: string; roles: string[] }) {
  const server = Fastify({ logger: false });
  server.get(
    '/platform-only',
    { preHandler: [fakeAuthenticateAs(user), requirePlatformAdmin()] },
    async () => ({ ok: true })
  );
  await server.ready();
  return server;
}

describe('requirePlatformAdmin', () => {
  let server: FastifyInstance | undefined;

  beforeEach(() => {
    mockSecurityConfig.platformOrganizationId = null;
    recordSecurityEventMock.mockClear();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('denies a tenant admin/owner whose organizationId is NOT the platform org', async () => {
    mockSecurityConfig.platformOrganizationId = PLATFORM_ORG_ID;
    server = await buildServer({
      userId: 'tenant-admin-1',
      organizationId: TENANT_ORG_ID,
      roles: ['admin'],
    });

    const res = await server.inject({ method: 'GET', url: '/platform-only' });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('Forbidden');
  });

  it('denies a member/viewer of the platform org itself (role, not just org, must match)', async () => {
    mockSecurityConfig.platformOrganizationId = PLATFORM_ORG_ID;
    server = await buildServer({
      userId: 'platform-viewer-1',
      organizationId: PLATFORM_ORG_ID,
      roles: ['viewer'],
    });

    const res = await server.inject({ method: 'GET', url: '/platform-only' });

    expect(res.statusCode).toBe(403);
  });

  it('allows a caller who is admin/owner of the platform organization', async () => {
    mockSecurityConfig.platformOrganizationId = PLATFORM_ORG_ID;
    server = await buildServer({
      userId: 'platform-admin-1',
      organizationId: PLATFORM_ORG_ID,
      roles: ['admin'],
    });

    const res = await server.inject({ method: 'GET', url: '/platform-only' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('allows platform "owner" the same as platform "admin"', async () => {
    mockSecurityConfig.platformOrganizationId = PLATFORM_ORG_ID;
    server = await buildServer({
      userId: 'platform-owner-1',
      organizationId: PLATFORM_ORG_ID,
      roles: ['owner'],
    });

    const res = await server.inject({ method: 'GET', url: '/platform-only' });

    expect(res.statusCode).toBe(200);
  });

  it('fails CLOSED — denies even a would-be platform admin when platformOrganizationId is unset', async () => {
    mockSecurityConfig.platformOrganizationId = null;
    server = await buildServer({
      userId: 'would-be-platform-admin',
      organizationId: PLATFORM_ORG_ID,
      roles: ['admin'],
    });

    const res = await server.inject({ method: 'GET', url: '/platform-only' });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).message).toMatch(/not configured/i);
  });

  it('returns 401 for an unauthenticated request (no user attached)', async () => {
    const localServer = Fastify({ logger: false });
    localServer.get('/platform-only', { preHandler: [requirePlatformAdmin()] }, async () => ({
      ok: true,
    }));
    await localServer.ready();
    server = localServer;

    const res = await server.inject({ method: 'GET', url: '/platform-only' });

    expect(res.statusCode).toBe(401);
  });
});

describe('isPlatformAdminRequest', () => {
  beforeEach(() => {
    mockSecurityConfig.platformOrganizationId = null;
  });

  function fakeRequest(user: unknown): FastifyRequest {
    return {
      user,
      organizationId: (user as { organizationId?: string })?.organizationId,
    } as unknown as FastifyRequest;
  }

  it('returns false for a tenant admin (organizationId mismatch)', () => {
    mockSecurityConfig.platformOrganizationId = PLATFORM_ORG_ID;
    const req = fakeRequest({ userId: 'u1', organizationId: TENANT_ORG_ID, roles: ['admin'] });
    expect(isPlatformAdminRequest(req)).toBe(false);
  });

  it('returns true for a genuine platform admin', () => {
    mockSecurityConfig.platformOrganizationId = PLATFORM_ORG_ID;
    const req = fakeRequest({ userId: 'u1', organizationId: PLATFORM_ORG_ID, roles: ['admin'] });
    expect(isPlatformAdminRequest(req)).toBe(true);
  });

  it('returns false when platformOrganizationId is unset, even for the reserved org id', () => {
    mockSecurityConfig.platformOrganizationId = null;
    const req = fakeRequest({ userId: 'u1', organizationId: PLATFORM_ORG_ID, roles: ['admin'] });
    expect(isPlatformAdminRequest(req)).toBe(false);
  });

  it('returns false when there is no user at all', () => {
    mockSecurityConfig.platformOrganizationId = PLATFORM_ORG_ID;
    expect(isPlatformAdminRequest(fakeRequest(undefined))).toBe(false);
  });

  it('ignores a scalar `role` hint and only trusts the `roles` array (rbac-silent-role-downgrade)', () => {
    mockSecurityConfig.platformOrganizationId = PLATFORM_ORG_ID;
    const req = fakeRequest({
      userId: 'u1',
      organizationId: PLATFORM_ORG_ID,
      role: 'admin', // scalar hint — must NOT be trusted
      roles: [], // real grant array is empty
    });
    expect(isPlatformAdminRequest(req)).toBe(false);
  });
});

/**
 * Regression coverage for the org-header-spoofing fix (2026-09-09).
 *
 * `authenticate()`'s API-key branch used to resolve the request's
 * `organizationId` as `organizationHeader || payload.organizationId` —
 * `organizationHeader` comes straight from the 100% client-controlled
 * `X-Organization-Id` header (or an `organizationId`/`organization_id` query
 * param), with no check that it matched the key's real organization.
 * `payload.roles` always reflected the key's REAL org's grants, but the
 * `organizationId` attached to the request could be forged to any value —
 * which completely defeated `isPlatformAdminRequest()`/`requirePlatformAdmin()`
 * above: any tenant's own (legitimately self-created) admin API key could
 * claim to be the reserved platform org just by sending that header, and be
 * granted full platform-admin authority.
 *
 * Unlike the suites above, this exercises the REAL `authenticate()` — not the
 * `fakeAuthenticateAs` preHandler stand-in — since the bug lives inside
 * `authenticate()` itself, in how it resolves `organizationId` for API-key
 * auth. Only `AuthService.prototype.verifyApiKey` is mocked (to avoid a real
 * DB/bcrypt round trip); `@/config` and `recordSecurityEvent` reuse the same
 * hoisted mocks as the rest of this file.
 */
describe('authenticate() (API-key path) + requirePlatformAdmin — org-header-spoofing regression', () => {
  let server: FastifyInstance | undefined;
  let verifyApiKeySpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    mockSecurityConfig.platformOrganizationId = null;
    recordSecurityEventMock.mockClear();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    verifyApiKeySpy?.mockRestore();
    verifyApiKeySpy = undefined;
  });

  async function buildAuthenticatedServer() {
    const localServer = Fastify({ logger: false });
    localServer.get(
      '/platform-only',
      { preHandler: [authenticate, requirePlatformAdmin()] },
      async () => ({ ok: true })
    );
    await localServer.ready();
    return localServer;
  }

  it('does NOT let a common tenant API key claim platform-admin by forging X-Organization-Id', async () => {
    mockSecurityConfig.platformOrganizationId = PLATFORM_ORG_ID;

    // A REAL, legitimately-issued API key belonging to an ordinary,
    // self-created tenant — admin of its OWN org (TENANT_ORG_ID), not of the
    // platform org. This is exactly what `verifyApiKey()` returns for any
    // customer's own API key.
    verifyApiKeySpy = vi.spyOn(AuthService.prototype, 'verifyApiKey').mockResolvedValue({
      userId: 'tenant-admin-1',
      organizationId: TENANT_ORG_ID,
      email: 'tenant-admin@example.com',
      roles: ['admin'],
      apiKeyId: 'tenant-key-1',
    });

    server = await buildAuthenticatedServer();

    const res = await server.inject({
      method: 'GET',
      url: '/platform-only',
      headers: {
        'x-api-key': 'ai1sk_tenant-owned-key',
        // Forged: the key's REAL org is TENANT_ORG_ID, but the client claims
        // the reserved platform org via the header.
        'x-organization-id': PLATFORM_ORG_ID,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('Forbidden');
  });

  it('still allows a genuine platform-org API key through (no regression on the legitimate path)', async () => {
    mockSecurityConfig.platformOrganizationId = PLATFORM_ORG_ID;

    verifyApiKeySpy = vi.spyOn(AuthService.prototype, 'verifyApiKey').mockResolvedValue({
      userId: 'platform-admin-1',
      organizationId: PLATFORM_ORG_ID,
      email: 'platform-admin@example.com',
      roles: ['admin'],
      apiKeyId: 'platform-key-1',
    });

    server = await buildAuthenticatedServer();

    const res = await server.inject({
      method: 'GET',
      url: '/platform-only',
      headers: {
        'x-api-key': 'ai1sk_platform-owned-key',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});
