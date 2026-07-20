// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Auth Flow Integration Tests
 * End-to-end authentication flow using real infrastructure (no mocks)
 */

import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { FastifyInstance } from 'fastify';
import { createServer } from '@/server';
import { prisma } from '@/database/client';
import { initializeDIContainer, resetDIContainer } from '@/di/container';
import { syncDefaultRoles } from '@/services/rbac-sync-service';
import { assignRoleToUser } from '@/services/rbac-service';
import { getAuthService } from '@/services/auth-service';

async function createUserWithRole(data: {
  email: string;
  name: string;
  organizationId: string;
  role?: string;
  status?: string;
  password?: string;
  organizationName?: string;
}) {
  await prisma.organization.upsert({
    where: { id: data.organizationId },
    create: {
      id: data.organizationId,
      name: data.organizationName ?? `Auth Test Org ${data.organizationId}`,
      tier: 'free',
      status: 'active',
      settings: {},
    },
    update: {},
  });

  const passwordHash = await bcrypt.hash(data.password ?? 'TestPassword123!', 10);

  const user = await prisma.user.create({
    data: {
      email: data.email,
      name: data.name,
      role: data.role ?? 'viewer',
      status: data.status ?? 'active',
      organizationId: data.organizationId,
      passwordHash,
    },
  });

  await assignRoleToUser(user.id, data.organizationId, data.role ?? 'viewer');

  return user;
}

async function cleanupTestData(): Promise<void> {
  await prisma.apiKey.deleteMany({ where: { name: { contains: 'Test API Key' } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { contains: 'authtest' } } } });
  await prisma.user.deleteMany({ where: { email: { contains: 'authtest' } } });
  await prisma.organization.deleteMany({ where: { name: { contains: 'Auth Test Org' } } });
}

async function createAccessTokenForUser(user: {
  id: string;
  email: string;
  organizationId: string;
  role: string;
}): Promise<string> {
  const authService = getAuthService();
  const tokens = await authService.generateTokens({
    userId: user.id,
    organizationId: user.organizationId,
    email: user.email,
    roles: [user.role],
  });
  return tokens.accessToken;
}

describe(
  'Auth Flow Integration Tests',
  {
    timeout: 120_000,
    hookTimeout: 120_000,
  },
  () => {
  let server: FastifyInstance;
  let testOrgId: string;

  beforeAll(async () => {
    initializeDIContainer();

    server = await createServer();

    const { tenantIsolationMiddleware } = await import('@/api/middleware/tenant-isolation-middleware');
    server.addHook('onRequest', tenantIsolationMiddleware);

    const { authRoutesClean } = await import('@/routes/auth/auth-routes-clean');
    const { userRoutes } = await import('@/routes/user/user-routes-clean');
    await server.register(authRoutesClean);
    await server.register(userRoutes);

    await server.ready();

    await syncDefaultRoles();

    const org = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: 'Auth Test Org',
        tier: 'free',
        status: 'active',
        settings: {},
      },
    });
    testOrgId = org.id;
  });

  afterAll(async () => {
    await cleanupTestData();
    resetDIContainer();
    await server.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    if (testOrgId) {
      await prisma.organization.upsert({
        where: { id: testOrgId },
        create: {
          id: testOrgId,
          name: 'Auth Test Org',
          tier: 'free',
          status: 'active',
          settings: {},
        },
        update: {
          name: 'Auth Test Org',
          status: 'active',
          settings: {},
        },
      });
    }
  });

  describe('JWT Authentication', () => {
    it('should authenticate with valid JWT token', async () => {
      const user = await createUserWithRole({
        email: 'authtest-jwt@example.com',
        name: 'JWT Test User',
        organizationId: testOrgId,
        role: 'developer',
      });

      const token = await createAccessTokenForUser({
        id: user.id,
        email: user.email,
        organizationId: user.organizationId,
        role: user.role,
      });

      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': testOrgId,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user.email).toBe('authtest-jwt@example.com');
    });

    it('should reject expired JWT token', async () => {
      const user = await createUserWithRole({
        email: 'authtest-expired@example.com',
        name: 'Expired JWT User',
        organizationId: testOrgId,
        role: 'developer',
      });

      const expiredToken = server.jwt.sign(
        {
          userId: user.id,
          email: user.email,
          organizationId: testOrgId,
        },
        { expiresIn: '1s' }
      );

      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${expiredToken}`,
          'x-organization-id': testOrgId,
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should reject malformed JWT token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: 'Bearer malformed.token.here',
          'x-organization-id': testOrgId,
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should reject token with invalid signature', async () => {
      const user = await createUserWithRole({
        email: 'authtest-invalidsignature@example.com',
        name: 'Invalid Signature User',
        organizationId: testOrgId,
      });

      const validToken = server.jwt.sign({
        userId: user.id,
        organizationId: testOrgId,
        email: user.email,
      });

      const tamperedToken = `${validToken}tampered`;

      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${tamperedToken}`,
          'x-organization-id': testOrgId,
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('API Key Authentication', () => {
    it('should authenticate with valid API key', async () => {
      const user = await createUserWithRole({
        email: 'authtest-apikey@example.com',
        name: 'API Key Test User',
        organizationId: testOrgId,
        role: 'developer',
      });

      const rawKey = 'ak_test_' + Math.random().toString(36).slice(2, 15);
      const keyHash = await bcrypt.hash(rawKey, 10);

      await prisma.apiKey.create({
        data: {
          name: 'Test API Key',
          keyHash,
          keyPrefix: rawKey.substring(0, 15),
          quickHash: 'quick',
          userId: user.id,
          organizationId: testOrgId,
          status: 'active',
        },
      });

      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          'x-api-key': rawKey,
          'x-organization-id': testOrgId,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user.email).toBe('authtest-apikey@example.com');
    });

    it('should reject invalid API key', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          'x-api-key': 'ak_invalid_key_12345',
          'x-organization-id': testOrgId,
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should reject revoked API key', async () => {
      const user = await createUserWithRole({
        email: 'authtest-revoked@example.com',
        name: 'Revoked API Key User',
        organizationId: testOrgId,
        role: 'developer',
      });

      const rawKey = 'ak_revoked_' + Math.random().toString(36).slice(2, 15);
      const keyHash = await bcrypt.hash(rawKey, 10);

      await prisma.apiKey.create({
        data: {
          name: 'Revoked Key',
          keyHash,
          keyPrefix: rawKey.substring(0, 15),
          quickHash: 'quick',
          userId: user.id,
          organizationId: testOrgId,
          status: 'revoked',
        },
      });

      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          'x-api-key': rawKey,
          'x-organization-id': testOrgId,
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('Authorization', () => {
    it('should allow user to access own profile', async () => {
      const user = await createUserWithRole({
        email: 'authtest-profile@example.com',
        name: 'Profile Owner',
        organizationId: testOrgId,
        role: 'developer',
      });

      const token = await createAccessTokenForUser({
        id: user.id,
        email: user.email,
        organizationId: user.organizationId,
        role: user.role,
      });

      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': testOrgId,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user.email).toBe('authtest-profile@example.com');
    });

    it('should not allow suspended user to access API', async () => {
      const user = await createUserWithRole({
        email: 'authtest-suspended@example.com',
        name: 'Suspended User',
        organizationId: testOrgId,
        role: 'developer',
        status: 'suspended',
      });

      const token = await createAccessTokenForUser({
        id: user.id,
        email: user.email,
        organizationId: user.organizationId,
        role: user.role,
      });

      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': testOrgId,
        },
      });
      expect(response.statusCode).toBe(401);
    });
  });
});

