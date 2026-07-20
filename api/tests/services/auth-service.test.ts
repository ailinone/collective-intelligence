// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Authentication Service
 * Uses REAL database and services - NO mocks
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { AuthService } from '@/services/auth-service';
import { prisma } from '@/database/client';
import bcrypt from 'bcrypt';
import { config } from '@/config';
import { syncDefaultRoles } from '@/services/rbac-sync-service';
import { assignRoleToUser } from '@/services/rbac-service';

function getExpectedAccessTokenTtlSeconds(): number {
  const value = (config.security.jwtExpiresIn || '24h').trim();
  const match = /^(\d+)(s|m|h|d)$/i.exec(value);
  if (!match) {
    return 24 * 60 * 60;
  }
  const amount = parseInt(match[1], 10);
  switch (match[2].toLowerCase()) {
    case 's':
      return amount;
    case 'm':
      return amount * 60;
    case 'h':
      return amount * 3600;
    case 'd':
      return amount * 86400;
    default:
      return 24 * 60 * 60;
  }
}

describe('AuthService - Real Tests (NO Mocks)', () => {
  let authService: AuthService;
  let testOrgId: string;
  let testUserId: string;

  beforeAll(async () => {
    // Global vitest setup already provides DB/test infra; avoid per-file lifecycle side effects.
    await syncDefaultRoles();
    authService = new AuthService();
  }, 60_000);

  afterAll(async () => {
    if (testOrgId) {
      await prisma.apiKey.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
      await prisma.organization.delete({ where: { id: testOrgId } }).catch(() => {});
    }
  }, 30_000);

  beforeEach(async () => {
    if (testOrgId) {
      await prisma.apiKey.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
    }
  });

  afterEach(async () => {
    if (testOrgId) {
      await prisma.apiKey.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
    }
  });

  describe('register', () => {
    it('should register new user successfully', async () => {
      const result = await authService.register({
        email: `test-${Date.now()}@example.com`,

        password: 'password123',
        name: 'Test User',
      });

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user?.email).toBeDefined();
      expect(result.tokens).toBeDefined();
      expect(result.tokens?.accessToken).toBeDefined();
      expect(result.tokens?.refreshToken).toBeDefined();

      // Store for cleanup
      if (result.user) {
        testUserId = result.user.id;
        testOrgId = result.user.organizationId;
      }
    });

    it('should fail if user already exists', async () => {
      // Create user first
      const email = `existing-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'password123',
        name: 'Existing User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
      }

      // Try to register again with same email
      const result = await authService.register({
        email,

        password: 'password123',
        name: 'Test User',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('User already exists with this email');
    });

    it('should hash password with bcrypt', async () => {
      const email = `hash-test-${Date.now()}@example.com`;
      const result = await authService.register({
        email,
        password: 'password123',
        name: 'Hash Test User',
      });

      expect(result.success).toBe(true);

      // Verify password is hashed in database
      if (result.user) {
        testOrgId = result.user.organizationId;
        const user = await prisma.user.findUnique({
          where: { id: result.user.id },
          select: { passwordHash: true },
        });

        expect(user?.passwordHash).toBeDefined();
        expect(user?.passwordHash).not.toBe('password123');
        expect(user?.passwordHash.length).toBeGreaterThan(20); // bcrypt hash is long
      }

    });
  });

  describe('login', () => {
    it('should login user successfully', async () => {
      // Create user first
      const email = `login-${Date.now()}@example.com`;
      const password = 'password123';
      const registerResult = await authService.register({
        email,
        password,
        name: 'Login Test User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;
      }

      // Now login
      const result = await authService.login(email, password);


      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.tokens).toBeDefined();
    });

    it('should fail with invalid email', async () => {
      const result = await authService.login('wrong@example.com', 'password123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid email or password');
    });

    it('should fail with invalid password', async () => {
      // Create user first
      const email = `wrongpass-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'correctpassword',
        name: 'Wrong Pass User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
      }

      // Try login with wrong password
      const result = await authService.login(email, 'wrongpassword');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid email or password');
    });

    it('should fail if user is not active', async () => {
      const email = `inactive-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'password123',
        name: 'Inactive User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;

        await prisma.user.update({
          where: { id: testUserId },
          data: { status: 'suspended' },
        });
      }

      const result = await authService.login(email, 'password123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('User account is not active');
    });

    it('should update lastLoginAt on successful login', async () => {
      // Create user first
      const email = `lastlogin-${Date.now()}@example.com`;
      const password = 'password123';
      const registerResult = await authService.register({
        email,
        password,
        name: 'Last Login User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;
      }

      // Get initial lastLoginAt
      const beforeLogin = await prisma.user.findUnique({
        where: { id: testUserId },
        select: { lastLoginAt: true },
      });

      // Login
      await authService.login(email, password);

      // Verify lastLoginAt was updated
      const afterLogin = await prisma.user.findUnique({
        where: { id: testUserId },
        select: { lastLoginAt: true },
      });

      expect(afterLogin?.lastLoginAt).toBeDefined();
      if (beforeLogin?.lastLoginAt && afterLogin?.lastLoginAt) {
        expect(afterLogin.lastLoginAt.getTime()).toBeGreaterThanOrEqual(beforeLogin.lastLoginAt?.getTime() || 0);
      }

    });
  });

  describe('verifyToken', () => {
    it('should verify valid token', async () => {
      // Register user
      const email = `verify-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'password123',
        name: 'Verify Token User',
      });

      if (!registerResult.tokens) {
        throw new Error('No tokens generated');
      }

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;
      }

      const payload = await authService.verifyToken(registerResult.tokens.accessToken);

      expect(payload).toBeDefined();
      expect(payload?.email).toBe(email);
      expect(payload?.userId).toBe(testUserId);

    });

    it('should return null for invalid token', async () => {
      const payload = await authService.verifyToken('invalid-token');
      expect(payload).toBeNull();
    });

    it('should return null if user is inactive', async () => {
      // Register user
      const email = `inactive-token-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'password123',
        name: 'Inactive Token User',

      });

      if (!registerResult.tokens) {
        throw new Error('No tokens generated');
      }

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;

        // Suspend user
        await prisma.user.update({
          where: { id: testUserId },
          data: { status: 'suspended' },
        });
      }

      const payload = await authService.verifyToken(registerResult.tokens.accessToken);
      expect(payload).toBeNull();
    });
  });

  describe('refreshToken', () => {
    it('should generate new tokens from valid refresh token', async () => {
      // Register user
      const email = `refresh-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'password123',
        name: 'Refresh Token User',
      });

      if (!registerResult.tokens) {
        throw new Error('No tokens generated');
      }

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;
      }


      const result = await authService.refreshToken(registerResult.tokens.refreshToken);

      expect(result.success).toBe(true);
      expect(result.tokens).toBeDefined();
      expect(result.tokens?.accessToken).toBeDefined();
      expect(result.tokens?.refreshToken).toBeDefined();

    });

    it('should fail with invalid refresh token', async () => {
      const result = await authService.refreshToken('invalid-refresh-token');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      // Create user
      const email = `changepass-${Date.now()}@example.com`;
      const oldPassword = 'oldpassword';
      const registerResult = await authService.register({
        email,
        password: oldPassword,
        name: 'Change Pass User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;
      }

      const success = await authService.changePassword(
        testUserId,
        oldPassword,

        'newpassword'
      );

      expect(success).toBe(true);

      // Verify new password works
      const loginResult = await authService.login(email, 'newpassword');
      expect(loginResult.success).toBe(true);
    });

    it('should fail with incorrect old password', async () => {
      // Create user
      const email = `wrongoldpass-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'correctoldpassword',
        name: 'Wrong Old Pass User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;
      }

      const success = await authService.changePassword(
        testUserId,

        'wrongoldpassword',
        'newpassword'
      );

      expect(success).toBe(false);
    });

    it('should fail if user not found', async () => {
      const success = await authService.changePassword(
        'nonexistent-user-id-12345',

        'oldpassword',
        'newpassword'
      );

      expect(success).toBe(false);
    });
  });

  describe('generateApiKey', () => {
    it('should generate API key successfully', async () => {
      // Create user
      const email = `apikey-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'password123',
        name: 'API Key User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;
      }

      const apiKey = await authService.generateApiKey(testUserId, 'My API Key');

      expect(apiKey).toBeDefined();
      expect(apiKey).toMatch(/^ak_/); // API keys start with 'ak_' prefix
      expect(apiKey!.length).toBeGreaterThanOrEqual(40);

      // Verify API key was stored in database
      const storedKey = await prisma.apiKey.findFirst({
        where: { userId: testUserId },
      });
      expect(storedKey).toBeDefined();
      expect(storedKey?.name).toBe('My API Key');
    });

    it('should return null if user not found', async () => {
      const apiKey = await authService.generateApiKey('nonexistent-user-id-12345', 'My API Key');

      expect(apiKey).toBeNull();
    });

    it('should hash API key before storing', async () => {
      // Create user
      const email = `apikeyhash-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'password123',
        name: 'API Key Hash User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;
      }

      const apiKey = await authService.generateApiKey(testUserId, 'My API Key');

      expect(apiKey).toBeDefined();

      // Verify key is hashed in database
      const storedKey = await prisma.apiKey.findFirst({
        where: { userId: testUserId },
        select: { keyHash: true, keyPrefix: true },
      });

      expect(storedKey?.keyHash).toBeDefined();
      expect(storedKey?.keyHash).not.toBe(apiKey);
      expect(storedKey?.keyPrefix).toMatch(/^ak_/); // API key prefix starts with 'ak_'

    });
  });

  describe('verifyApiKey', () => {
    it('should verify valid API key', async () => {
      // Create user and API key
      const email = `verifykey-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'password123',
        name: 'Verify Key User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;
      }

      // Ensure user has roles assigned (verifyApiKey needs roles)
      await syncDefaultRoles();
      const { assignRoleToUser } = await import('@/services/rbac-service');
      try {
        await assignRoleToUser(testUserId, testOrgId, 'developer');
      } catch {
        // Role may already be assigned, ignore
      }

      const apiKey = await authService.generateApiKey(testUserId, 'Test Key');
      if (!apiKey) {
        throw new Error('API key generation failed');
      }
      
      const payload = await authService.verifyApiKey(apiKey);

      expect(payload).toBeDefined();
      if (payload) {
        expect(payload.userId).toBe(testUserId);
        expect(payload.email).toBe(email);
      } else {
        throw new Error('API key verification returned null');
      }
    });

    it('should return null for invalid API key', async () => {
      const payload = await authService.verifyApiKey('invalid-key-ak_live_12345');

      expect(payload).toBeNull();
    });

    it('should update lastUsedAt on valid verification', async () => {
      // Create user and API key
      const email = `lastused-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'password123',
        name: 'Last Used User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;
      }

      const apiKey = await authService.generateApiKey(testUserId, 'Test Key');
      if (!apiKey) {
        throw new Error('API key generation failed');
      }

      // Get stored key ID
      const storedKey = await prisma.apiKey.findFirst({
        where: { userId: testUserId },
        select: { id: true, lastUsedAt: true },
      });

      if (!storedKey) {
        throw new Error('API key not found');
      }

      const beforeVerify = storedKey.lastUsedAt;

      // Verify API key
      await authService.verifyApiKey(apiKey);

      // Verify lastUsedAt was updated
      const afterVerify = await prisma.apiKey.findUnique({
        where: { id: storedKey.id },
        select: { lastUsedAt: true },
      });

      expect(afterVerify?.lastUsedAt).toBeDefined();
      if (beforeVerify && afterVerify?.lastUsedAt) {
        expect(afterVerify.lastUsedAt.getTime()).toBeGreaterThanOrEqual(beforeVerify.getTime());
      }

    });
  });

  describe('revokeApiKey', () => {
    it('should revoke API key successfully', async () => {
      // Create user and API key
      const email = `revoke-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'password123',
        name: 'Revoke Key User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;
      }

      const apiKey = await authService.generateApiKey(testUserId, 'Test Key');
      if (!apiKey) {
        throw new Error('API key generation failed');
      }

      // Get stored key ID
      const storedKey = await prisma.apiKey.findFirst({
        where: { userId: testUserId },
        select: { id: true },
      });

      if (!storedKey) {
        throw new Error('API key not found');
      }

      const success = await authService.revokeApiKey(storedKey.id, testUserId);

      expect(success).toBe(true);

      // Verify key is revoked
      const revokedKey = await prisma.apiKey.findUnique({
        where: { id: storedKey.id },
        select: { status: true },
      });

      expect(revokedKey?.status).toBe('revoked');
    });

    it('should fail if key not found', async () => {
      // Create user
      const email = `notfound-${Date.now()}@example.com`;
      const registerResult = await authService.register({
        email,
        password: 'password123',
        name: 'Not Found User',
      });

      if (registerResult.user) {
        testOrgId = registerResult.user.organizationId;
        testUserId = registerResult.user.id;
      }

      const success = await authService.revokeApiKey('nonexistent-key-id-12345', testUserId);

      expect(success).toBe(false);
    });

    it('should fail if key belongs to different user', async () => {
      // Create two users
      const email1 = `user1-${Date.now()}@example.com`;
      const registerResult1 = await authService.register({
        email: email1,
        password: 'password123',
        name: 'User 1',
      });

      const email2 = `user2-${Date.now()}@example.com`;
      const registerResult2 = await authService.register({
        email: email2,
        password: 'password123',
        name: 'User 2',
      });

      let userId1: string | undefined;
      let userId2: string | undefined;
      let keyId: string | undefined;

      if (registerResult1.user) {
        testOrgId = registerResult1.user.organizationId;
        userId1 = registerResult1.user.id;
      }

      if (registerResult2.user) {
        userId2 = registerResult2.user.id;
      }

      // Create API key for user 1
      if (userId1) {
        const apiKey = await authService.generateApiKey(userId1, 'Test Key');
        if (apiKey) {
          const storedKey = await prisma.apiKey.findFirst({
            where: { userId: userId1 },
            select: { id: true },
          });
          keyId = storedKey?.id;
        }
      }

      // Try to revoke with user 2
      if (keyId && userId2) {
        const success = await authService.revokeApiKey(keyId, userId2);
        expect(success).toBe(false);
      }

    });
  });

  describe('Security', () => {
    it('should generate different hashes for same password', async () => {
      const email1 = `hash1-${Date.now()}@example.com`;
      const email2 = `hash2-${Date.now()}@example.com`;
      const samePassword = 'samepassword';

      const result1 = await authService.register({
        email: email1,
        password: samePassword,
        name: 'Hash Test 1',
      });

      const result2 = await authService.register({
        email: email2,
        password: samePassword,
        name: 'Hash Test 2',
      });

      if (result1.user) {
        testOrgId = result1.user.organizationId;
      }

      // Get password hashes from database
      if (result1.user && result2.user) {
        const user1 = await prisma.user.findUnique({
          where: { id: result1.user.id },
          select: { passwordHash: true },
        });

        const user2 = await prisma.user.findUnique({
          where: { id: result2.user.id },
          select: { passwordHash: true },
        });

        // Bcrypt should generate different hashes for same password
        expect(user1?.passwordHash).not.toBe(user2?.passwordHash);
      }
    });

    it('should include sufficient entropy in JWT tokens', async () => {
      const email = `jwt-${Date.now()}@example.com`;
      const result = await authService.register({
        email,
        password: 'password123',
        name: 'JWT Test User',
      });

      if (result.user) {
        testOrgId = result.user.organizationId;
      }


      expect(result.tokens?.accessToken.length).toBeGreaterThan(100);
      expect(result.tokens?.refreshToken.length).toBeGreaterThan(100);
      expect(result.tokens?.accessToken).not.toBe(result.tokens?.refreshToken);
    });

    it('should set proper token expiration', async () => {
      const email = `expire-${Date.now()}@example.com`;
      const result = await authService.register({
        email,
        password: 'password123',
        name: 'Expire Test User',
      });

      if (result.user) {
        testOrgId = result.user.organizationId;
      }

      // expiresIn is a string (e.g., "24h"), not a number
      const expectedExpiresIn = config.security.jwtExpiresIn || '24h';
      expect(result.tokens?.expiresIn).toBe(expectedExpiresIn);
    });
  });
});

