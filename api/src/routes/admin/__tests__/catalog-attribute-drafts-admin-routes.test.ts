// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const { listAttributeDraftsMock, promoteDraftMock } = vi.hoisted(() => ({
  listAttributeDraftsMock: vi.fn(),
  promoteDraftMock: vi.fn(),
}));
vi.mock('@/services/catalog/capability-attribute-draft-service', () => ({
  listAttributeDrafts: listAttributeDraftsMock,
  promoteDraft: promoteDraftMock,
}));

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async () => {},
  requirePlatformAdmin: () => async () => {},
}));
vi.mock('@/services/anonymous-quota-gate', () => ({
  rejectAnonymousGuestKeyPreHandler: async () => {},
}));
vi.mock('@/services/free-tier-quota-gate', () => ({
  rejectChatFreeTierKeyPreHandler: async () => {},
}));

import { registerCatalogAttributeDraftsAdminRoutes } from '../catalog-attribute-drafts-admin-routes';

beforeEach(() => {
  listAttributeDraftsMock.mockReset();
  promoteDraftMock.mockReset();
});

describe('GET /v1/admin/catalog/attribute-drafts', () => {
  it('returns the draft list', async () => {
    listAttributeDraftsMock.mockResolvedValue([
      { id: 'd1', providerId: 'fal-ai', capability: 'video_generation', attributes: {}, autoResolved: false },
    ]);
    const server = Fastify();
    await registerCatalogAttributeDraftsAdminRoutes(server);
    const response = await server.inject({ method: 'GET', url: '/v1/admin/catalog/attribute-drafts' });
    expect(response.statusCode).toBe(200);
    expect(response.json().drafts).toHaveLength(1);
  });
});

describe('POST /v1/admin/catalog/attribute-drafts/:id/promote', () => {
  it('promotes the given draft id', async () => {
    const server = Fastify();
    await registerCatalogAttributeDraftsAdminRoutes(server);
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/catalog/attribute-drafts/d1/promote',
    });
    expect(response.statusCode).toBe(200);
    expect(promoteDraftMock).toHaveBeenCalledWith('d1');
  });
});
