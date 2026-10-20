// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SEC-01 route-level authorization coverage for `DELETE /v1/users/:id`.
 *
 * Before this change the route was gated only by the coarse claims-based
 * `requireRole('admin','owner')` plus an in-handler rank check (an admin
 * cannot delete a strictly higher-ranked owner) — the fine-grained RBAC
 * model (Role -> Permission -> RolePermission) was never consulted. This
 * suite proves the added `requirePermission('users:delete')` guard is REAL
 * by exercising the real route through `app.inject()` (only
 * `userHasPermission`/`getUserRoles` and the DB client are mocked):
 *   (a) an authenticated admin WITHOUT `users:delete` gets 403 and the user
 *       is never deleted;
 *   (b) the same principal WITH `users:delete` succeeds and the delete runs.
 *
 * `requireRole` and `roleSetRank` are the REAL implementations (imported via
 * `importOriginal`) — only `authenticate` (needs JWT/DB) is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

const ORG_ID = '33333333-3333-3333-3333-333333333333';
const ACTOR_ID = 'admin-1';
const TARGET_ID = 'target-1';

const { userHasPermissionMock, getUserRolesMock } = vi.hoisted(() => ({
  userHasPermissionMock: vi.fn<(userId: string, organizationId: string, permission: string) => Promise<boolean>>(),
  getUserRolesMock: vi.fn<(userId: string, organizationId: string) => Promise<string[]>>(),
}));

vi.mock('@/services/rbac-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/rbac-service')>();
  return {
    ...actual,
    userHasPermission: userHasPermissionMock,
    getUserRoles: getUserRolesMock,
    // roleSetRank stays the REAL (pure) implementation.
    setUserRole: vi.fn(),
    assertRoleChangeAllowed: vi.fn(),
  };
});

// The default RBAC config treats 'admin'/'owner' as SUPER ROLES that bypass
// the DB permission lookup entirely (see require-permission-middleware.ts).
// To exercise the requirePermission('users:delete') check in isolation (as an
// operator who narrows SECURITY_RBAC_SUPER_ROLES would experience it), this
// suite empties the super-role list; every other config field stays real.
vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      security: {
        ...actual.config.security,
        rbac: { ...actual.config.security.rbac, superRoles: [] },
      },
    },
  };
});

vi.mock('@/middleware/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/middleware/auth-middleware')>();
  return {
    ...actual,
    authenticate: vi.fn(async (request: FastifyRequest) => {
      const req = request as unknown as Record<string, unknown>;
      req.user = { userId: ACTOR_ID, organizationId: ORG_ID, roles: ['admin'] };
      req.userId = ACTOR_ID;
      req.organizationId = ORG_ID;
    }),
  };
});

vi.mock('@/services/anonymous-quota-gate', () => ({
  rejectAnonymousGuestKeyPreHandler: async () => {},
}));
vi.mock('@/services/free-tier-quota-gate', () => ({
  rejectChatFreeTierKeyPreHandler: async () => {},
}));
vi.mock('@/services/auth-service', () => ({
  getAuthService: () => ({ changePassword: vi.fn() }),
}));

const findUniqueMock = vi.fn();
const deleteMock = vi.fn();
vi.mock('@/database/client', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
    },
  },
}));

import { registerUserManagementRoutes } from '@/routes/user/user-management-routes';

describe('DELETE /v1/users/:id — SEC-01 requirePermission(users:delete)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    userHasPermissionMock.mockReset();
    getUserRolesMock.mockReset();
    findUniqueMock.mockReset();
    deleteMock.mockReset();
    // Target outranks nobody: rank check passes once permission passes.
    getUserRolesMock.mockImplementation(async (userId: string) =>
      userId === ACTOR_ID ? ['admin'] : ['member']
    );
    findUniqueMock.mockResolvedValue({ id: TARGET_ID, organizationId: ORG_ID });
    app = Fastify({ logger: false });
    await registerUserManagementRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects an admin WITHOUT users:delete with 403', async () => {
    userHasPermissionMock.mockResolvedValue(false);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${TARGET_ID}`,
    });

    expect(res.statusCode).toBe(403);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(userHasPermissionMock).toHaveBeenCalledWith(ACTOR_ID, ORG_ID, 'users:delete');
  });

  it('allows an admin WITH users:delete and deletes the user', async () => {
    userHasPermissionMock.mockResolvedValue(true);
    deleteMock.mockResolvedValue({ id: TARGET_ID });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${TARGET_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: TARGET_ID } });
    expect(JSON.parse(res.payload)).toMatchObject({ success: true });
  });
});
