// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Authentication JWT Flow - Integration Tests
 * 
 * Tests complete authentication flow:
 * - Registration
 * - Login with password
 * - JWT token validation
 * - Refresh token flow
 * - Token expiration
 * - Logout
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestServerWithAuthOnly } from '../../../../tests/utils/test-server';
import { prisma } from '@/database/client';
import { nanoid } from 'nanoid';

describe('Authentication JWT Flow (Integration)', () => {
  let server: FastifyInstance;
  let testOrgId: string;
  let testUserId: string;
  let testEmail: string;

  beforeAll(async () => {
    // Initialize DI container (required for handlers)
    const { initializeDIContainer } = await import('@/di/container');
    initializeDIContainer();

    // Sync default RBAC roles (required for user registration)
    const { syncDefaultRoles } = await import('@/services/rbac-sync-service');
    try {
      await syncDefaultRoles();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Log but don't fail - roles may already be synced
      console.warn(`RBAC sync warning (may already be synced): ${errorMessage}`);
    }

    // Create test server with auth routes
    server = await createTestServerWithAuthOnly();
    
    await server.listen({ port: 0, host: '127.0.0.1' }); // Random port

    // Create test organization
    const testOrg = await prisma.organization.create({
      data: {
        name: `Test Org ${nanoid(8)}`,
        slug: `test-org-${nanoid(8)}`,
        tier: 'enterprise',
        status: 'active',
      },
    });
    testOrgId = testOrg.id;
  });

  afterAll(async () => {
    // Cleanup: Delete test organization (cascades to users)
    await prisma.organization.delete({
      where: { id: testOrgId },
    });

    await server.close();
  });

  beforeEach(() => {
    testEmail = `test-${nanoid(8)}@example.com`;
  });

  describe('Registration Flow', () => {
    it('should register new user successfully', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testEmail,
          password: 'SecureP@ssw0rd123',
          name: 'Test User',
          organizationId: testOrgId,
        },
      });

      expect(response.statusCode).toBe(201);
      
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.user).toBeDefined();
      // Email is normalized to lowercase
      expect(body.user.email).toBe(testEmail.toLowerCase());
      expect(body.tokens).toBeDefined();
      expect(body.tokens.accessToken).toBeDefined();
      expect(body.tokens.refreshToken).toBeDefined();
      expect(body.tokens.expiresIn).toBeGreaterThan(0);

      testUserId = body.user.id;
    });

    it('should reject registration with weak password', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testEmail,
          password: '123', // Too weak
          name: 'Test User',
          organizationId: testOrgId,
        },
      });

      expect(response.statusCode).toBe(400);
      
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error?.toLowerCase()).toContain('password');
    });

    it('should reject registration with duplicate email', async () => {
      // First registration
      await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testEmail,
          password: 'SecureP@ssw0rd123',
          name: 'Test User',
          organizationId: testOrgId,
        },
      });

      // Duplicate registration
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testEmail,
          password: 'SecureP@ssw0rd123',
          name: 'Test User 2',
          organizationId: testOrgId,
        },
      });

      expect(response.statusCode).toBe(409); // Conflict
      
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('already exists');
    });

    it('should reject registration with invalid email format', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'not-an-email',
          password: 'SecureP@ssw0rd123',
          name: 'Test User',
          organizationId: testOrgId,
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('Login Flow', () => {
    beforeEach(async () => {
      // Register user for login tests
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testEmail,
          password: 'SecureP@ssw0rd123',
          name: 'Test User',
          organizationId: testOrgId,
        },
      });
      
      const body = JSON.parse(response.body);
      testUserId = body.user.id;
    });

    it('should login with correct credentials', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: testEmail,
          password: 'SecureP@ssw0rd123',
        },
      });

      expect(response.statusCode).toBe(200);
      
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.user).toBeDefined();
      // Email is normalized to lowercase
      expect(body.user.email).toBe(testEmail.toLowerCase());
      expect(body.tokens).toBeDefined();
      expect(body.tokens.accessToken).toBeDefined();
      expect(body.tokens.refreshToken).toBeDefined();
    });

    it('should reject login with wrong password', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: testEmail,
          password: 'WrongPassword',
        },
      });

      expect(response.statusCode).toBe(401);
      
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid');
    });

    it('should reject login with non-existent email', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'nonexistent@example.com',
          password: 'SecureP@ssw0rd123',
        },
      });

      expect(response.statusCode).toBe(401);
      
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
    });

    it('should reject login for suspended user', async () => {
      // Suspend user
      await prisma.user.update({
        where: { id: testUserId },
        data: { status: 'suspended', statusReason: 'Test suspension' },
      });

      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: testEmail,
          password: 'SecureP@ssw0rd123',
        },
      });

      expect(response.statusCode).toBe(403);
      
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('suspended');

      // Restore user for cleanup
      await prisma.user.update({
        where: { id: testUserId },
        data: { status: 'active', statusReason: null },
      });
    });
  });

  describe('JWT Token Validation', () => {
    let accessToken: string;
    let refreshToken: string;

    beforeEach(async () => {
      // Register and login
      const registerResponse = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testEmail,
          password: 'SecureP@ssw0rd123',
          name: 'Test User',
          organizationId: testOrgId,
        },
      });

      const body = JSON.parse(registerResponse.body);
      accessToken = body.tokens.accessToken;
      refreshToken = body.tokens.refreshToken;
      testUserId = body.user.id;
    });

    it('should accept valid JWT token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      
      const body = JSON.parse(response.body);
      // Response format is { user: { ... } }
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe(testEmail.toLowerCase());
    });

    it('should reject request without token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should reject invalid token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: 'Bearer invalid.token.here',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should reject expired token', async () => {
      // Create expired token (manually create with past exp)
      const jwt = require('jsonwebtoken');
      const expiredToken = jwt.sign(
        {
          userId: testUserId,
          organizationId: testOrgId,
          email: testEmail,
          roles: ['user'],
        },
        process.env.JWT_SECRET || 'test-secret',
        { expiresIn: '-1h' } // Expired 1 hour ago
      );

      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${expiredToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
      
      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/expired|invalid/i);
    });
  });

  describe('Refresh Token Flow', () => {
    let accessToken: string;
    let refreshToken: string;

    beforeEach(async () => {
      const registerResponse = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testEmail,
          password: 'SecureP@ssw0rd123',
          name: 'Test User',
          organizationId: testOrgId,
        },
      });

      const body = JSON.parse(registerResponse.body);
      accessToken = body.tokens.accessToken;
      refreshToken = body.tokens.refreshToken;
      testUserId = body.user.id;
    });

    it('should refresh access token with valid refresh token', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: {
          refreshToken,
        },
      });

      expect(response.statusCode).toBe(200);
      
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.tokens).toBeDefined();
      expect(body.tokens.accessToken).toBeDefined();
      expect(body.tokens.refreshToken).toBeDefined();
      expect(body.tokens.accessToken).not.toBe(accessToken); // New token
    });

    it('should reject invalid refresh token', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: {
          refreshToken: 'invalid.refresh.token',
        },
      });

      expect(response.statusCode).toBe(401);
      
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
    });

    it('should reject expired refresh token', async () => {
      // Create expired refresh token
      const jwt = require('jsonwebtoken');
      const expiredRefreshToken = jwt.sign(
        { userId: testUserId, type: 'refresh' },
        process.env.JWT_SECRET || 'test-secret',
        { expiresIn: '-1d' }
      );

      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: {
          refreshToken: expiredRefreshToken,
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('Security', () => {
    it('should hash passwords (not store plaintext)', async () => {
      const password = 'SecureP@ssw0rd123';
      
      await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testEmail,
          password,
          name: 'Test User',
          organizationId: testOrgId,
        },
      });

      // Check password is hashed in database
      // Email is normalized to lowercase
      const user = await prisma.user.findUnique({
        where: { email: testEmail.toLowerCase() },
      });

      expect(user).toBeDefined();
      expect(user).not.toBeNull();
      expect(user!.passwordHash).not.toBe(password); // Not plaintext
      expect(user!.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt format
    });

    it('should not return password hash in API responses', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testEmail,
          password: 'SecureP@ssw0rd123',
          name: 'Test User',
          organizationId: testOrgId,
        },
      });

      expect(response.statusCode).toBe(201); // Registration returns 201
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.user).toBeDefined();
      expect(body.user.password).toBeUndefined();
      expect(body.user.passwordHash).toBeUndefined();
    });
  });
});

