// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test (cross-repo quota/tier hardening, P0 finding #2c):
 * `GET /v1/organizations` and `PUT /v1/organizations/:id` declared their
 * `tier` query/body enum independently in the same file
 * (`organization-routes-clean.ts`) — GET's was `['free','pro','enterprise']`
 * (missing 'starter'), PUT's was `['free','starter','pro','enterprise']`.
 * 'starter' is a fully real, assignable `TierLevel`
 * (domain/value-objects/organization-tier.ts), so `GET
 * /v1/organizations?tier=starter` was rejected with a 400 by Fastify/AJV
 * schema validation before the request ever reached
 * `ListOrganizationsHandler` — even though the exact same tier was
 * perfectly acceptable on the PUT endpoint right next to it.
 *
 * Both schemas now share one `ORGANIZATION_TIER_VALUES` constant derived
 * from `Object.values(TierLevel)`, so they cannot independently drift again.
 */
import 'reflect-metadata';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TierLevel } from '@/domain/value-objects/organization-tier';

const TEST_USER = { userId: 'user-1', organizationId: 'org-1', roles: ['owner'] };

const { findAllMock } = vi.hoisted(() => ({
  findAllMock: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: vi.fn(async (request: FastifyRequest) => {
    (request as unknown as { user: unknown }).user = TEST_USER;
  }),
  requireRole:
    (..._roles: string[]) =>
    async () => {
      // no-op: RBAC coarse gate isn't under test here
    },
}));

vi.mock('@/middleware/require-permission-middleware', () => ({
  requirePermission: (_permission: string) => async () => {
    // no-op: fine-grained permission isn't under test here
  },
}));

vi.mock('@/infrastructure/repositories/prisma-organization-repository', () => ({
  PrismaOrganizationRepository: vi.fn().mockImplementation(() => ({
    findAll: findAllMock,
    findById: vi.fn(),
    findByName: vi.fn(),
    save: vi.fn(),
    countMembers: vi.fn(),
    saveAggregate: vi.fn(),
    delete: vi.fn(),
  })),
}));

vi.mock('@/infrastructure/repositories/prisma-user-repository', () => ({
  PrismaUserRepository: vi.fn().mockImplementation(() => ({
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findByOrganizationId: vi.fn().mockResolvedValue([]),
    save: vi.fn(),
    delete: vi.fn(),
  })),
}));

describe('organization-routes-clean — tier enum (HTTP behavior)', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    findAllMock.mockResolvedValue([]);
    server = Fastify();
    const { organizationRoutesClean } = await import('@/routes/organization/organization-routes-clean');
    await organizationRoutesClean(server);
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  it('GET /v1/organizations?tier=starter is accepted (no 400) — the actual regression', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/organizations?tier=starter' });

    expect(res.statusCode).not.toBe(400);
    expect(res.statusCode).toBe(200);
    expect(findAllMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'starter' })
    );
  });

  it.each(Object.values(TierLevel))('GET /v1/organizations?tier=%s is accepted for every real tier', async (tier) => {
    const res = await server.inject({ method: 'GET', url: `/v1/organizations?tier=${tier}` });
    expect(res.statusCode).toBe(200);
  });

  it('GET /v1/organizations?tier=<garbage> is still rejected with 400 (the enum still validates)', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/organizations?tier=not-a-real-tier' });
    expect(res.statusCode).toBe(400);
  });
});

describe('organization-routes-clean — source contract', () => {
  const ROUTES_PATH = join(__dirname, '..', 'organization-routes-clean.ts');
  const routesSource = readFileSync(ROUTES_PATH, 'utf8');

  it('derives the tier enum from a single shared constant for both GET and PUT (cannot silently diverge again)', () => {
    const occurrences = routesSource.match(/enum:\s*ORGANIZATION_TIER_VALUES/g) ?? [];
    expect(occurrences.length).toBe(2);
    // No leftover hand-written literal tier arrays.
    expect(routesSource).not.toMatch(/enum:\s*\[\s*'free'/);
  });

  it('derives ORGANIZATION_TIER_VALUES from the domain TierLevel enum, not a redeclared literal union', () => {
    expect(routesSource).toMatch(
      /ORGANIZATION_TIER_VALUES\s*=\s*Object\.values\(TierLevel\)/
    );
    expect(routesSource).toMatch(
      /import\s*\{\s*TierLevel\s*\}\s*from\s*['"]@\/domain\/value-objects\/organization-tier['"]/
    );
  });
});
