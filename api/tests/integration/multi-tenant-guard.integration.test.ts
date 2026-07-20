// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Multi-tenant Guard Integration Tests
 * Validates tenant isolation across enterprise routes without mocks.
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createServer } from '@/server';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { prisma } from '@/database/client';
import { tenantIsolationMiddleware } from '@/api/middleware/tenant-isolation-middleware';
import { authRoutesClean } from '@/routes/auth/auth-routes-clean';
import { registerEnterpriseQuotaRoutes } from '@/routes/enterprise/quotas-routes';
import bcrypt from 'bcrypt';
import jwt, { type Algorithm } from 'jsonwebtoken';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { config } from '@/config';
import { syncDefaultRoles } from '@/services/rbac-sync-service';
import { getHeaderString } from '@/utils/type-guards';

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

describe('Multi-tenant Guard - Integration', () => {
  let server: FastifyInstance;
  let authToken: string;
  let organizationId: string;
  let userId: string;
  let apiKey: string;

  const baseHeaders = (): Record<string, string> => ({
    authorization: `Bearer ${authToken}`,
    'x-organization-id': organizationId,
    'x-user-id': userId,
  });

  beforeAll(async () => {
    await startTestEnvironment();
    server = await createServer();
    installAuthBypass(server, () => ({
      userId,
      organizationId,
      email: 'multi-tenant-owner@example.com',
      roles: ['owner'],
    }));
    server.addHook('preHandler', tenantIsolationMiddleware);

    await authRoutesClean(server);
    await registerEnterpriseQuotaRoutes(server);
    await server.ready();
    await syncDefaultRoles();

    await prisma.securityAuditLog.deleteMany({});
    await prisma.apiKey.deleteMany({
      where: { user: { email: 'multi-tenant-owner@example.com' } },
    });
    await prisma.user.deleteMany({
      where: { email: 'multi-tenant-owner@example.com' },
    });

    const organization = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: `Multi Tenant Guard Org ${Date.now()}`,
        tier: 'enterprise',
        status: 'active',
        settings: {},
      },
    });

    const passwordHash = await bcrypt.hash('Enterprise@123', 12);
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: 'multi-tenant-owner@example.com',
        passwordHash,
        name: 'Multi Tenant Owner',
        organizationId: organization.id,
        role: 'owner',
        status: 'active',
      },
    });

    userId = user.id;
    organizationId = organization.id;

    await ensureRoleAssignment(userId, organizationId, 'owner');

    authToken = createAccessToken({
      userId,
      organizationId,
      email: user.email,
      roles: ['owner'],
    });

    const generatedApiKey = `ak_${randomUUID().replace(/-/g, '')}`;
    const keyHash = await bcrypt.hash(generatedApiKey, 12);
    const quickHash = createHash('sha256').update(generatedApiKey).digest('hex');
    const keyPrefix = generatedApiKey.slice(0, 11);

    await prisma.apiKey.create({
      data: {
        name: 'integration-multi-tenant',
        keyHash,
        quickHash,
        keyPrefix,
        status: 'active',
        userId,
        organizationId,
      },
    });

    apiKey = generatedApiKey;
  });

  afterAll(async () => {
    await prisma.securityAuditLog.deleteMany({
      where: {
        eventType: {
          in: ['organization_mismatch', 'tenant_context_invalid'],
        },
      },
    });

    if (organizationId) {
      await prisma.usageQuota.deleteMany({
        where: { organizationId },
      });
      await prisma.apiKey.deleteMany({
        where: { userId },
      });
      await prisma.user.deleteMany({
        where: { id: userId },
      });
      await prisma.organization.deleteMany({
        where: { id: organizationId },
      });
    }

    if (server) {
      await server.close();
    }
    await stopTestEnvironment();
  });

  it('rejects quota configuration when payload organization differs from tenant context', async () => {
    const mismatchOrganizationId = randomUUID();
    const requestTimestamp = new Date();

    const response = await server.inject({
      method: 'POST',
      url: '/v1/enterprise/quotas',
      headers: baseHeaders(),
      payload: {
        organizationId: mismatchOrganizationId,
        limits: {
          period: 'month',
          maxRequests: 5_000,
        },
      },
    });

    expect(response.statusCode, response.body).toBe(403);
    const body = JSON.parse(response.body) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('organization_mismatch');

    const auditLog = await prisma.securityAuditLog.findFirst({
      where: {
        eventType: 'organization_mismatch',
        createdAt: { gte: requestTimestamp },
      },
      orderBy: { createdAt: 'asc' },
    });

    expect(auditLog).not.toBeNull();
    expect(auditLog?.organizationId).toBe(organizationId);
  });

  it('allows tenant to configure and list quotas within the tenant context', async () => {
    const configureResponse = await server.inject({
      method: 'POST',
      url: '/v1/enterprise/quotas',
      headers: baseHeaders(),
      payload: {
        limits: {
          period: 'month',
          maxRequests: 10_000,
          maxTokens: 250_000,
        },
      },
    });

    expect(configureResponse.statusCode, configureResponse.body).toBe(204);

    const listResponse = await server.inject({
      method: 'GET',
      url: '/v1/enterprise/quotas',
      headers: baseHeaders(),
    });

    expect(listResponse.statusCode).toBe(200);
    const listBody = JSON.parse(listResponse.body) as {
      quotas: Array<{
        organizationId: string;
        limits: { period: string; maxRequests?: number; maxTokens?: number };
      }>;
    };

    expect(Array.isArray(listBody.quotas)).toBe(true);
    expect(listBody.quotas.length).toBeGreaterThan(0);

    const tenantQuota = listBody.quotas.find(
      (quota) => quota.organizationId === organizationId && quota.limits.period === 'month',
    );

    expect(tenantQuota).toBeTruthy();
    expect(tenantQuota?.limits.maxRequests).toBe(10_000);
    expect(tenantQuota?.limits.maxTokens).toBe(250_000);
  });

  it('denies access when organizationId header references an unknown tenant via API key override', async () => {
    const unknownOrganizationId = randomUUID();
    const requestTimestamp = new Date();

    const response = await server.inject({
      method: 'GET',
      url: '/v1/enterprise/quotas',
      headers: {
        'x-api-key': apiKey,
        'x-organization-id': unknownOrganizationId,
      },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('organization_not_found');

    const auditLog = await prisma.securityAuditLog.findFirst({
      where: {
        eventType: 'tenant_context_invalid',
        createdAt: { gte: requestTimestamp },
      },
      orderBy: { createdAt: 'desc' },
    });

    expect(auditLog).not.toBeNull();
    expect(auditLog?.organizationId).toBeNull();
    const metadata = auditLog?.metadata as Record<string, unknown> | null;
    expect(metadata).not.toBeNull();
    expect(metadata?.attemptedOrganizationId).toBe(unknownOrganizationId);
  });
});


