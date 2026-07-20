// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration tests for Organization routes (Clean Architecture)
 * Validates end-to-end flow without mocks
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import jwt, { type Algorithm } from 'jsonwebtoken';
import { createServer } from '@/server';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { prisma } from '@/database/client';
import { config } from '@/config';
import { authRoutesClean } from '@/routes/auth/auth-routes-clean';
import { organizationRoutesClean } from '@/routes/organization/organization-routes-clean';
import type { JWTPayload } from '@/services/auth-service';
import { syncDefaultRoles } from '@/services/rbac-sync-service';
import { resetDIContainer } from '@/di/container';
import { getHeaderString } from '@/utils/type-guards';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';

/**
 * Type for organization member data returned from API
 */
type OrganizationMember = {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
};

let baseHeaders: Record<string, string>;

function withHeaders(headers?: Record<string, string>): Record<string, string> {
  return {
    ...baseHeaders,
    ...(headers ?? {}),
  };
}

async function ensureRoleAssignment(userId: string, organizationId: string, roleName: string): Promise<void> {
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) {
    throw new Error(`Role ${roleName} not found`);
  }

  await prisma.userRole.upsert({
    where: {
      userId_organizationId_roleId: {
        userId,
        organizationId,
        roleId: role.id,
      },
    },
    update: {},
    create: {
      userId,
      organizationId,
      roleId: role.id,
    },
  });
}

function createAccessToken(payload: {
  userId: string;
  organizationId: string;
  email: string;
  roles: string[];
}): string {
  const algorithm = config.security.jwtAlgorithms[0] as Algorithm;
  return jwt.sign(
    {
      ...payload,
      token_use: 'access',
      jti: `at_${randomUUID()}`,
    },
    config.security.jwtSecret,
    {
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
      algorithm,
      expiresIn: config.security.jwtExpiresIn,
      notBefore: 0,
    }
  );
}

function installAuthBypass(
  server: FastifyInstance,
  resolveContext: () => { userId: string; organizationId: string; email: string; roles: string[] }
): void {
  // Must run before route `onRequest: [authenticate]` hooks in these tests.
  server.addHook('onRequest', async (request) => {
    const context = resolveContext();
    const headerUserId = getHeaderString(request.headers, 'x-user-id');
    const headerOrganizationId = getHeaderString(request.headers, 'x-organization-id');
    const effectiveUserId = headerUserId ?? context.userId;
    const effectiveOrganizationId = headerOrganizationId ?? context.organizationId;

    if (!effectiveUserId || !effectiveOrganizationId) {
      return;
    }

    const userPayload = {
      userId: effectiveUserId,
      organizationId: effectiveOrganizationId,
      email: context.email,
      roles: context.roles,
      token_use: 'access' as const,
      jti: `test-${effectiveUserId}`,
    };

    request.user = userPayload;
    const extendedRequest = request as ExtendedFastifyRequest;
    extendedRequest.user = userPayload;
    extendedRequest.userId = effectiveUserId;
    extendedRequest.organizationId = effectiveOrganizationId;
  });
}

describe('Organization Routes - Clean Architecture', () => {
  let server: FastifyInstance;
  let authToken: string;
  let organizationId: string;
  let ownerUserId: string;
  let memberUserId: string;

  beforeAll(async () => {
    await startTestEnvironment();
    resetDIContainer();

    // Ensure default roles are synchronized
    await syncDefaultRoles();

    server = await createServer();
    installAuthBypass(server, () => ({
      userId: ownerUserId,
      organizationId,
      email: 'org-owner@example.com',
      roles: ['owner'],
    }));

    const { tenantIsolationMiddleware } = await import('@/api/middleware/tenant-isolation-middleware');
    server.addHook('preHandler', tenantIsolationMiddleware);

    await authRoutesClean(server);
    const { userRoutes } = await import('@/routes/user/user-routes-clean');
    await organizationRoutesClean(server);
    await userRoutes(server);
    await server.ready();

    await prisma.user.deleteMany({
      where: {
        email: {
          in: ['org-owner@example.com', 'org-member@example.com'],
        },
      },
    });

    const organization = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: `Organization Integration ${Date.now()}`,
        tier: 'pro',
        status: 'active',
        settings: {},
      },
    });

    const passwordHash = await bcrypt.hash('Password123!', 12);
    const owner = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: 'org-owner@example.com',
        passwordHash,
        name: 'Org Owner',
        organizationId: organization.id,
        role: 'owner',
        status: 'active',
      },
    });

    ownerUserId = owner.id;
    organizationId = organization.id;

    await ensureRoleAssignment(ownerUserId, organizationId, 'owner');

    authToken = createAccessToken({
      userId: owner.id,
      organizationId: organization.id,
      email: owner.email,
      roles: ['owner'],
    });

    const decoded = server.jwt.decode(authToken) as (JWTPayload & { sub?: string }) | null;
    const resolvedUserId = decoded?.userId ?? ownerUserId;

    baseHeaders = {
      authorization: `Bearer ${authToken}`,
      'x-organization-id': organizationId,
      'x-user-id': resolvedUserId,
    };
  });

  afterAll(async () => {
    if (memberUserId) {
      await prisma.user.deleteMany({
        where: { id: memberUserId },
      });
    }

    await prisma.user.deleteMany({
      where: { email: 'org-owner@example.com' },
    });

    if (server) {
      await server.close();
    }
    resetDIContainer();
    await stopTestEnvironment();
  });

  it('GET /v1/organizations/:id should return organization details with member count', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/organizations/${organizationId}`,
      headers: withHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.organization.id).toBe(organizationId);
    expect(body.organization.memberCount).toBeGreaterThanOrEqual(1);
    expect(body.organization.name).toBeDefined();
  });

  it('PUT /v1/organizations/:id should update organization name and tier', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: `/v1/organizations/${organizationId}`,
      headers: withHeaders(),
      payload: {
        name: 'Enterprise Org',
        tier: 'enterprise',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.organization.name).toBe('Enterprise Org');
    expect(body.organization.tier).toBe('enterprise');
  });

  describe('Organization Members', () => {
    beforeAll(async () => {
      const passwordHash = await bcrypt.hash('Password123!', 10);
      const member = await prisma.user.create({
        data: {
          id: randomUUID(),
          email: 'org-member@example.com',
          passwordHash,
          name: 'Org Member',
          organizationId,
          role: 'viewer',
          status: 'active',
        },
      });

      memberUserId = member.id;
    });

    it('GET /v1/organizations/:id/members should list members including new member', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/v1/organizations/${organizationId}/members`,
        headers: withHeaders(),
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { members: OrganizationMember[] };
      const memberIds = body.members.map((member: OrganizationMember) => member.id);
      expect(memberIds).toContain(ownerUserId);
      expect(memberIds).toContain(memberUserId);
    });

    it('DELETE /v1/organizations/:id/members/:userId should remove the member', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: `/v1/organizations/${organizationId}/members/${memberUserId}`,
        headers: withHeaders(),
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);

      const deletedMember = await prisma.user.findUnique({
        where: { id: memberUserId },
      });
      expect(deletedMember).toBeNull();

      memberUserId = '';
    });

    it('DELETE /v1/organizations/:id/members/:userId should prevent self removal', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: `/v1/organizations/${organizationId}/members/${ownerUserId}`,
        headers: withHeaders(),
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBeDefined();
    });
  });
});

