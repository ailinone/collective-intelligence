// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SEC-01 route-level authorization coverage for `POST /v1/models/configure`.
 *
 * Before this change the route was gated only by the coarse claims-based
 * `requireRole('admin','developer','owner')` — the fine-grained RBAC model
 * (Role -> Permission -> RolePermission) was never consulted. This suite
 * proves the added `requirePermission('models:manage')` guard is REAL by
 * exercising the real route through `app.inject()` (only `userHasPermission`
 * and the DB client are mocked):
 *   (a) an authenticated 'developer' WITHOUT `models:manage` gets 403 and the
 *       model config is never written;
 *   (b) the same principal WITH `models:manage` succeeds and the upsert runs.
 *
 * `requireRole` is the REAL implementation (imported via `importOriginal`) —
 * only `authenticate` (needs JWT/DB) is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

const ORG_ID = '22222222-2222-2222-2222-222222222222';

const { userHasPermissionMock } = vi.hoisted(() => ({
  userHasPermissionMock: vi.fn<(userId: string, organizationId: string, permission: string) => Promise<boolean>>(),
}));

vi.mock('@/services/rbac-service', () => ({
  userHasPermission: userHasPermissionMock,
}));

vi.mock('@/middleware/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/middleware/auth-middleware')>();
  return {
    ...actual,
    authenticate: vi.fn(async (request: FastifyRequest) => {
      const req = request as unknown as Record<string, unknown>;
      req.user = { userId: 'dev-1', organizationId: ORG_ID, roles: ['developer'] };
      req.userId = 'dev-1';
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

const findFirstMock = vi.fn();
const upsertMock = vi.fn();
vi.mock('@/database/client', () => ({
  prisma: {
    model: { findFirst: (...args: unknown[]) => findFirstMock(...args) },
    modelConfig: { upsert: (...args: unknown[]) => upsertMock(...args) },
  },
}));

import { registerModelsConfigRoutes } from '@/routes/models/models-config-routes';

describe('models-config-routes — SEC-01 requirePermission(models:manage)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    userHasPermissionMock.mockReset();
    findFirstMock.mockReset();
    upsertMock.mockReset();
    app = Fastify({ logger: false });
    await registerModelsConfigRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects a developer WITHOUT models:manage with 403', async () => {
    userHasPermissionMock.mockResolvedValue(false);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/models/configure',
      payload: { modelId: 'gpt-4', enabled: true },
    });

    expect(res.statusCode).toBe(403);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(userHasPermissionMock).toHaveBeenCalledWith('dev-1', ORG_ID, 'models:manage');
  });

  it('allows a developer WITH models:manage and upserts the model config', async () => {
    userHasPermissionMock.mockResolvedValue(true);
    findFirstMock.mockResolvedValue({ id: 'gpt-4' });
    upsertMock.mockResolvedValue({
      modelId: 'gpt-4',
      enabled: true,
      model: { id: 'gpt-4', name: 'gpt-4', displayName: 'GPT-4', provider: { name: 'openai' } },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/models/configure',
      payload: { modelId: 'gpt-4', enabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.payload)).toMatchObject({ success: true });
  });
});
