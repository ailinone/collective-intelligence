// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for the fine-grained RBAC preHandler
 * (`src/middleware/require-permission-middleware.ts`).
 *
 * SEC-01 acceptance matrix:
 *   - a principal WITH the permission is allowed;
 *   - a principal WITHOUT the permission gets 403 (deny-by-default);
 *   - an unauthenticated request gets 401;
 *   - `RBAC_ENFORCE=false` fully bypasses the check;
 *   - the no-lockout super-role fallback allows admin/owner without a DB lookup;
 *   - `requireAnyPermission` passes when ANY listed permission is held;
 *   - the check fails CLOSED (500) when the permission lookup throws.
 *
 * The RBAC data layer (`userHasPermission`) and `config` are mocked so the test
 * is hermetic (no DB / no full env). `userHasPermission` is exactly the seam the
 * middleware delegates permission resolution + caching to.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const { userHasPermissionMock } = vi.hoisted(() => ({
  userHasPermissionMock: vi.fn<(userId: string, organizationId: string, permission: string) => Promise<boolean>>(),
}));

vi.mock('@/services/rbac-service', () => ({
  userHasPermission: userHasPermissionMock,
}));

vi.mock('@/config', () => ({
  config: {
    security: {
      rbac: {
        superRoles: ['owner', 'admin'],
      },
    },
  },
}));

import {
  requirePermission,
  requireAnyPermission,
  isRbacEnforced,
} from '@/middleware/require-permission-middleware';

interface CapturedReply {
  status?: number;
  body?: unknown;
  sent: boolean;
}

function makeReply(): { reply: FastifyReply; captured: CapturedReply } {
  const captured: CapturedReply = { sent: false };
  const reply = {
    get sent(): boolean {
      return captured.sent;
    },
    code(code: number) {
      captured.status = code;
      return this;
    },
    send(payload: unknown) {
      captured.body = payload;
      captured.sent = true;
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, captured };
}

function makeRequest(
  opts: {
    userId?: string;
    organizationId?: string;
    roles?: string[];
  } = {}
): FastifyRequest {
  const { userId, organizationId, roles } = opts;
  const authenticated = userId !== undefined && organizationId !== undefined;
  return {
    userId,
    organizationId,
    user: authenticated
      ? {
          userId,
          organizationId,
          roles: roles ?? [],
          email: 'principal@example.com',
          name: 'principal@example.com',
        }
      : undefined,
    url: '/v1/test',
    method: 'POST',
  } as unknown as FastifyRequest;
}

const MEMBER = { userId: 'user-1', organizationId: 'org-1', roles: ['developer'] };

beforeEach(() => {
  userHasPermissionMock.mockReset();
  delete process.env.RBAC_ENFORCE;
});

afterEach(() => {
  delete process.env.RBAC_ENFORCE;
});

describe('requirePermission', () => {
  it('is enforced by default (RBAC_ENFORCE unset)', () => {
    expect(isRbacEnforced()).toBe(true);
  });

  it('allows a principal that holds the required permission', async () => {
    userHasPermissionMock.mockResolvedValue(true);
    const { reply, captured } = makeReply();

    await requirePermission('org:update')(makeRequest(MEMBER), reply);

    expect(captured.sent).toBe(false);
    expect(captured.status).toBeUndefined();
    expect(userHasPermissionMock).toHaveBeenCalledWith('user-1', 'org-1', 'org:update');
  });

  it('returns 403 for an authenticated principal WITHOUT the permission', async () => {
    userHasPermissionMock.mockResolvedValue(false);
    const { reply, captured } = makeReply();

    await requirePermission('org:update')(makeRequest(MEMBER), reply);

    expect(captured.status).toBe(403);
    expect(captured.body).toEqual({ error: 'Forbidden', message: 'Insufficient permissions' });
  });

  it('returns 401 when the request is unauthenticated', async () => {
    const { reply, captured } = makeReply();

    await requirePermission('org:update')(makeRequest(), reply);

    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ error: 'Unauthorized', message: 'Authentication required' });
    expect(userHasPermissionMock).not.toHaveBeenCalled();
  });

  it('bypasses entirely when RBAC_ENFORCE=false (even without the permission)', async () => {
    process.env.RBAC_ENFORCE = 'false';
    userHasPermissionMock.mockResolvedValue(false);
    const { reply, captured } = makeReply();

    await requirePermission('org:update')(makeRequest(MEMBER), reply);

    expect(captured.sent).toBe(false);
    expect(captured.status).toBeUndefined();
    expect(userHasPermissionMock).not.toHaveBeenCalled();
  });

  it('allows a super-role principal WITHOUT a permission-table lookup (no-lockout)', async () => {
    userHasPermissionMock.mockResolvedValue(false);
    const { reply, captured } = makeReply();

    await requirePermission('quotas:override')(
      makeRequest({ userId: 'admin-1', organizationId: 'org-1', roles: ['admin'] }),
      reply
    );

    expect(captured.sent).toBe(false);
    expect(captured.status).toBeUndefined();
    // Super-role short-circuits before touching the RBAC tables.
    expect(userHasPermissionMock).not.toHaveBeenCalled();
  });

  it('fails closed with 500 when the permission lookup throws', async () => {
    userHasPermissionMock.mockRejectedValue(new Error('db down'));
    const { reply, captured } = makeReply();

    await requirePermission('org:update')(makeRequest(MEMBER), reply);

    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({
      error: 'Internal Server Error',
      message: 'Authorization check failed',
    });
  });
});

describe('requireAnyPermission', () => {
  it('allows when the principal holds AT LEAST ONE of the permissions', async () => {
    userHasPermissionMock.mockImplementation(async (_u, _o, permission) => permission === 'billing:read');
    const { reply, captured } = makeReply();

    await requireAnyPermission(['billing:update', 'billing:read'])(makeRequest(MEMBER), reply);

    expect(captured.sent).toBe(false);
    expect(captured.status).toBeUndefined();
  });

  it('returns 403 when the principal holds NONE of the permissions', async () => {
    userHasPermissionMock.mockResolvedValue(false);
    const { reply, captured } = makeReply();

    await requireAnyPermission(['billing:update', 'billing:read'])(makeRequest(MEMBER), reply);

    expect(captured.status).toBe(403);
    expect(captured.body).toEqual({ error: 'Forbidden', message: 'Insufficient permissions' });
  });

  it('returns 401 when unauthenticated', async () => {
    const { reply, captured } = makeReply();

    await requireAnyPermission(['billing:read'])(makeRequest(), reply);

    expect(captured.status).toBe(401);
  });
});
