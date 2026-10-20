// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SEC-01 route-level authorization coverage for the organization-governance
 * mutating routes.
 *
 * Before this change, `PUT .../budget` and `POST .../policy` were gated only
 * by the coarse claims-based `requireRole('admin','owner')` — the fine-grained
 * RBAC model (Role -> Permission -> RolePermission) was never consulted, so a
 * principal whose JWT claimed `admin`/`owner` was authorized purely on that
 * claim. This suite proves the added `requirePermission('org:update')` guard
 * is REAL: it exercises the actual route through `app.inject()` with the real
 * `requirePermission` middleware wired in (only its data dependency,
 * `userHasPermission`, is mocked), so:
 *   (a) an authenticated admin/owner WITHOUT the `org:update` permission is
 *       rejected with 403 and the governance service is never called;
 *   (b) the same principal WITH the permission succeeds and the service is
 *       invoked with the expected arguments.
 *
 * `requireRole` itself is the REAL implementation (imported via
 * `importOriginal`) — only `authenticate` (needs JWT/DB) is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

const { userHasPermissionMock } = vi.hoisted(() => ({
  userHasPermissionMock: vi.fn<(userId: string, organizationId: string, permission: string) => Promise<boolean>>(),
}));

vi.mock('@/services/rbac-service', () => ({
  userHasPermission: userHasPermissionMock,
}));

// The default RBAC config treats 'admin'/'owner' as SUPER ROLES that bypass
// the DB permission lookup entirely (see require-permission-middleware.ts) —
// which is exactly why this route's requireRole('admin','owner') gate alone
// was not equivalent to the fine-grained RBAC model. To exercise the
// requirePermission('org:update') check in isolation (as an operator who
// narrows SECURITY_RBAC_SUPER_ROLES would experience it), this suite empties
// the super-role list; every other config field stays real.
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
      req.user = { userId: 'admin-1', organizationId: ORG_ID, roles: ['admin'] };
      req.userId = 'admin-1';
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
vi.mock('@/api/middleware/route-rate-limit', () => ({
  createRouteRateLimit: () => async (_req: FastifyRequest, _reply: FastifyReply) => {},
}));
vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: vi.fn(async () => {}),
}));

const setBudgetMock = vi.fn();
const setPolicyMock = vi.fn();
const queryAuditEventsMock = vi.fn();
vi.mock('@/services/org-governance-service', () => ({
  setBudget: (...args: unknown[]) => setBudgetMock(...args),
  setPolicy: (...args: unknown[]) => setPolicyMock(...args),
  getCostStatus: vi.fn(),
  queryAuditEvents: (...args: unknown[]) => queryAuditEventsMock(...args),
}));

import { registerOrgGovernanceRoutes } from '@/routes/admin/org-governance-routes';

describe('org-governance-routes — SEC-01 requirePermission(org:update)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    userHasPermissionMock.mockReset();
    setBudgetMock.mockReset();
    setPolicyMock.mockReset();
    queryAuditEventsMock.mockReset();
    app = Fastify({ logger: false });
    await registerOrgGovernanceRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('PUT /v1/admin/organizations/:id/budget', () => {
    it('rejects an admin/owner WITHOUT org:update with 403', async () => {
      userHasPermissionMock.mockResolvedValue(false);

      const res = await app.inject({
        method: 'PUT',
        url: `/v1/admin/organizations/${ORG_ID}/budget`,
        payload: { maxMonthlyCostUsd: 1000 },
      });

      expect(res.statusCode).toBe(403);
      expect(setBudgetMock).not.toHaveBeenCalled();
      expect(userHasPermissionMock).toHaveBeenCalledWith('admin-1', ORG_ID, 'org:update');
    });

    it('allows an admin/owner WITH org:update and calls setBudget', async () => {
      userHasPermissionMock.mockResolvedValue(true);
      setBudgetMock.mockResolvedValue({ maxMonthlyCostUsd: 1000, alertThresholds: [] });

      const res = await app.inject({
        method: 'PUT',
        url: `/v1/admin/organizations/${ORG_ID}/budget`,
        payload: { maxMonthlyCostUsd: 1000 },
      });

      expect(res.statusCode).toBe(200);
      expect(setBudgetMock).toHaveBeenCalledTimes(1);
      expect(setBudgetMock).toHaveBeenCalledWith(
        ORG_ID,
        expect.objectContaining({ maxMonthlyCostUsd: 1000 })
      );
    });
  });

  describe('POST /v1/admin/organizations/:id/policy', () => {
    it('rejects an admin/owner WITHOUT org:update with 403', async () => {
      userHasPermissionMock.mockResolvedValue(false);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/organizations/${ORG_ID}/policy`,
        payload: { allowedModels: ['gpt-4'] },
      });

      expect(res.statusCode).toBe(403);
      expect(setPolicyMock).not.toHaveBeenCalled();
    });

    it('allows an admin/owner WITH org:update and calls setPolicy', async () => {
      userHasPermissionMock.mockResolvedValue(true);
      setPolicyMock.mockResolvedValue({ allowedModels: ['gpt-4'] });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/organizations/${ORG_ID}/policy`,
        payload: { allowedModels: ['gpt-4'] },
      });

      expect(res.statusCode).toBe(200);
      expect(setPolicyMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /v1/admin/audit', () => {
    it('rejects an admin/owner WITHOUT audit:read with 403', async () => {
      userHasPermissionMock.mockResolvedValue(false);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/audit',
      });

      expect(res.statusCode).toBe(403);
      expect(queryAuditEventsMock).not.toHaveBeenCalled();
      expect(userHasPermissionMock).toHaveBeenCalledWith('admin-1', ORG_ID, 'audit:read');
    });

    it('allows an admin/owner WITH audit:read and queries the audit trail', async () => {
      userHasPermissionMock.mockResolvedValue(true);
      queryAuditEventsMock.mockResolvedValue({ events: [], total: 0 });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/audit',
      });

      expect(res.statusCode).toBe(200);
      expect(queryAuditEventsMock).toHaveBeenCalledTimes(1);
      expect(queryAuditEventsMock).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORG_ID })
      );
    });
  });
});
