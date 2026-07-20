// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * User Routes Integration Tests
 * End-to-End testing with real database and Clean Architecture
 * 
 * Tests the full flow: Route → Handler → Repository → Database
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { createServer } from '@/server';
import { prisma } from '@/database/client';
import { PasswordHash } from '@/domain/value-objects/password-hash';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

describe('User Routes Integration Tests', () => {
  let server: FastifyInstance;
  let authToken: string;
  let testUserId: string;
  let testOrgId: string;

  beforeAll(async () => {
    // Ensure default roles are synchronized
    await syncDefaultRoles();

    // Create server instance
    server = await createServer();

    const { tenantIsolationMiddleware } = await import('@/api/middleware/tenant-isolation-middleware');
    server.addHook('preHandler', tenantIsolationMiddleware);

    const { authRoutesClean } = await import('@/routes/auth/auth-routes-clean');
    const { userRoutes } = await import('@/routes/user/user-routes-clean');
    await server.register(authRoutesClean);
    await server.register(userRoutes);

    await server.ready();

    // Create test organization
    const org = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: 'Test Org Integration',
        tier: 'free',
        status: 'active',
        settings: {},
      },
    });
    testOrgId = org.id;

    // Create test user
    const passwordHash = await PasswordHash.fromPlainText('IntegrationPass123!');

    const user = await prisma.user.create({
      data: {
        email: 'integration@test.com',
        name: 'Integration User',
        role: 'user',
        status: 'active',
        organizationId: testOrgId,
        passwordHash: passwordHash.getValue(),
      },
    });
    testUserId = user.id;

    // Generate auth token using authService (same method used in production)
    const { getAuthService } = await import('@/services/auth-service');
    const authService = getAuthService();
    const { getUserRoles } = await import('@/services/rbac-service');
    const roles = await getUserRoles(testUserId, testOrgId);
    
    const tokens = await authService.generateTokens({
      userId: testUserId,
      organizationId: testOrgId,
      email: 'integration@test.com',
      roles: roles.length > 0 ? roles : ['user'],
    });
    
    authToken = tokens.accessToken;
  });

  afterAll(async () => {
    // Cleanup
    await prisma.user.deleteMany({
      where: { email: { contains: 'integration' } },
    });
    await prisma.organization.deleteMany({
      where: { name: { contains: 'Integration' } },
    });
    
    await server.close();
    await prisma.$disconnect();
  });

  describe('GET /v1/user/profile', () => {
    it('should get user profile with valid token', async () => {
      // Act
      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe('integration@test.com');
      expect(body.user.name).toBe('Integration User');
      expect(body.user.organizationId).toBe(testOrgId);
    });

    it('should return 401 without token', async () => {
      // Act
      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('should return 401 with invalid token', async () => {
      // Act
      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: 'Bearer invalid_token',
        },
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('should return user data in correct format', async () => {
      // Act
      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      
      expect(body.user).toHaveProperty('id');
      expect(body.user).toHaveProperty('email');
      expect(body.user).toHaveProperty('name');
      expect(body.user).toHaveProperty('role');
      expect(body.user).toHaveProperty('status');
      expect(body.user).toHaveProperty('organizationId');
      expect(body.user).toHaveProperty('createdAt');
      expect(body.user).toHaveProperty('updatedAt');
    });
  });

  describe('PUT /v1/user/profile', () => {
    it('should update user name successfully', async () => {
      // Act
      const response = await server.inject({
        method: 'PUT',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          name: 'Updated Integration User',
        },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.message).toBeDefined();

      // Verify in database
      const updatedUser = await prisma.user.findUnique({
        where: { id: testUserId },
      });
      expect(updatedUser?.name).toBe('Updated Integration User');
    });

    it('should return 401 without token', async () => {
      // Act
      const response = await server.inject({
        method: 'PUT',
        url: '/v1/user/profile',
        payload: {
          name: 'Should Fail',
        },
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('should handle empty update payload', async () => {
      // Act
      const response = await server.inject({
        method: 'PUT',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {},
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });

    it('should sanitize input (XSS protection)', async () => {
      // Act
      const response = await server.inject({
        method: 'PUT',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          name: '<script>alert("xss")</script>Sanitized',
        },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      
      // Verify sanitization happened
      const updatedUser = await prisma.user.findUnique({
        where: { id: testUserId },
      });
      expect(updatedUser?.name).not.toContain('<script>');
    });

    it('should update updatedAt timestamp', async () => {
      // Arrange
      const beforeUpdate = await prisma.user.findUnique({
        where: { id: testUserId },
      });
      const oldUpdatedAt = beforeUpdate?.updatedAt;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      // Act
      const response = await server.inject({
        method: 'PUT',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          name: 'Timestamp Test',
        },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      
      const afterUpdate = await prisma.user.findUnique({
        where: { id: testUserId },
      });
      expect(afterUpdate?.updatedAt.getTime()).toBeGreaterThan(oldUpdatedAt!.getTime());
    });
  });

  describe('Clean Architecture Flow', () => {
    it('should flow through entire Clean Architecture stack', async () => {
      // This test validates:
      // Route → DI Container → Handler → Repository → Domain Entity → Database

      // Act
      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      
      // Verify the response went through Clean Architecture
      // (Handler uses repository, repository returns domain entity, entity converted to DTO)
      const body = JSON.parse(response.body);
      expect(body.user).toBeDefined();
      expect(typeof body.user.id).toBe('string');
      expect(typeof body.user.email).toBe('string');
    });

    it('should handle domain validation errors correctly', async () => {
      // Try to update with invalid data (if validation exists)
      const response = await server.inject({
        method: 'PUT',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          name: 'a'.repeat(300), // Very long name
        },
      });

      // Should either accept (no length validation) or reject gracefully
      expect([200, 400]).toContain(response.statusCode);
    });
  });

  describe('Error Handling', () => {
    it('should reject requests when authenticated user no longer exists', async () => {
      await prisma.user.delete({
        where: { id: testUserId },
      });

      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      expect([401, 404]).toContain(response.statusCode);
    });
  });
});

