// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Email Challenge Authentication Flow - Integration Tests
 *
 * Tests passwordless authentication via email:
 * - Request email challenge
 * - Receive verification code
 * - Login with code
 * - Code expiration
 * - Rate limiting on challenges
 * - Security: Code format, attempts tracking
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestServerWithAuthOnly } from '../../../../tests/utils/test-server';
import { prisma } from '@/database/client';
import { nanoid } from 'nanoid';
import { syncDefaultRoles } from '@/services/rbac-sync-service';
import { ensureBaselineRole } from '@/services/rbac-service';

// Mock the email service to prevent actual email sending during tests
vi.mock('@/services/email-service', () => ({
  getEmailService: () => ({
    sendEmail: vi.fn().mockResolvedValue({ success: true, messageId: 'test-message-id' }),
    sendVerificationCode: vi
      .fn()
      .mockResolvedValue({ success: true, messageId: 'test-message-id' }),
  }),
}));

describe('Email Challenge Authentication Flow (Integration)', () => {
  let server: FastifyInstance;
  let testOrgId: string;
  let testEmail: string;

  beforeAll(async () => {
    server = await createTestServerWithAuthOnly();
    await server.listen({ port: 0, host: '127.0.0.1' });

    // Ensure RBAC defaults exist (roles + permissions) using the real sync service
    await syncDefaultRoles();

    const org = await prisma.organization.create({
      data: {
        name: `Test Org ${nanoid(8)}`,
        slug: `test-org-${nanoid(8)}`,
        tier: 'enterprise',
        status: 'active',
      },
    });
    testOrgId = org.id;
  });

  afterAll(async () => {
    // Cleanup in reverse order of dependencies
    await prisma.userRole.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
    await prisma.authLoginChallenge
      .deleteMany({ where: { organizationId: testOrgId } })
      .catch(() => {});
    await prisma.user.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
    await prisma.organization.delete({ where: { id: testOrgId } }).catch(() => {});
    await server.close();
  });

  beforeEach(() => {
    testEmail = `test-${nanoid(8)}@example.com`;
  });

  /**
   * Seed a member of `testOrgId` directly.
   *
   * This suite exercises the email-code login flow, not signup, and its
   * challenge rows are keyed to `testOrgId` — so the account has to land in
   * THAT organization. It used to get there by POSTing `organizationId` to
   * `POST /v1/auth/register`, which is an anonymous cross-tenant implant and is
   * now correctly rejected with 409. Putting an operator-provisioned member
   * into an operator-provisioned tenant is the legitimate expression of the
   * same intent, and it mirrors what this file's own fallback path already did.
   *
   * The `user_roles` grant is not optional: `users.role` is a hint, never a
   * grant, so a member with no rows resolves to zero roles.
   */
  async function seedOrgMember(email: string): Promise<string> {
    const bcrypt = await import('bcrypt');
    const passwordHash = await bcrypt.hash('SecureP@ssw0rd123', 12);
    const user = await prisma.user.upsert({
      where: { email: email.trim().toLowerCase() },
      update: { passwordHash, organizationId: testOrgId, status: 'active' },
      create: {
        email: email.trim().toLowerCase(),
        passwordHash,
        name: 'Test User',
        organizationId: testOrgId,
        status: 'active',
      },
    });
    await ensureBaselineRole(user.id, testOrgId, 'test-fixture:email-challenge');
    return user.id;
  }

  describe('Request Email Challenge', () => {
    it('should send email challenge for existing user', async () => {
      // First, seed the user into the suite's organization
      await seedOrgMember(testEmail);

      // Request email challenge
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/email-challenge',
        payload: {
          email: testEmail,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.challengeId).toBeDefined();
      expect(body.expiresAt).toBeDefined();
      expect(body.loginMode).toBe('email_code');
    });

    it('should reject challenge request for non-existent user', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/email-challenge',
        payload: {
          email: 'nonexistent@example.com',
        },
      });

      // Security: Don't leak user existence
      // Should either reject or send fake success
      expect([200, 404]).toContain(response.statusCode);
    });

    it('should rate limit email challenge requests', async () => {
      // Seed user
      await seedOrgMember(testEmail);

      // Make 10 rapid challenge requests
      const attempts = [];
      for (let i = 0; i < 10; i++) {
        attempts.push(
          server.inject({
            method: 'POST',
            url: '/v1/auth/email-challenge',
            payload: { email: testEmail },
          })
        );
      }

      const responses = await Promise.all(attempts);

      // Should have cooldown after first few attempts
      const rateLimited = responses.filter((r) => r.statusCode === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  describe('Login with Email Code', () => {
    let challengeId: string;
    let verificationCode: string;

    beforeEach(async () => {
      // Seed the user directly so these cases validate the code flow itself
      // rather than registration side-effects.
      await seedOrgMember(testEmail);

      // Create a challenge with a known code for testing
      // In production, the code is sent via email, but for testing we create it manually
      verificationCode = '123456';
      const bcrypt = require('bcrypt');
      const codeHash = await bcrypt.hash(verificationCode, 10);

      // Normalize email to lowercase to match how users are stored
      const normalizedEmail = testEmail.trim().toLowerCase();

      const challenge = await prisma.authLoginChallenge.create({
        data: {
          email: normalizedEmail,
          organizationId: testOrgId,
          codeHash,
          status: 'pending',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        },
      });

      challengeId = challenge.id;
    });

    it('should login successfully with valid code', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login-with-code',
        payload: {
          challengeId,
          code: verificationCode,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.user).toBeDefined();
      expect(body.tokens).toBeDefined();
      expect(body.tokens.accessToken).toBeDefined();
    });

    it('should reject invalid code', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login-with-code',
        payload: {
          challengeId,
          code: '000000', // Wrong code
        },
      });

      expect(response.statusCode).toBe(401);

      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/invalid|incorrect/i);
    });

    it('should reject expired challenge', async () => {
      // Expire the challenge
      await prisma.authLoginChallenge.updateMany({
        where: { email: testEmail },
        data: { expiresAt: new Date(Date.now() - 1000) }, // 1 second ago
      });

      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login-with-code',
        payload: {
          challengeId,
          code: verificationCode,
        },
      });

      expect(response.statusCode).toBe(401);

      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/expired/i);
    });

    it('should limit code verification attempts', async () => {
      // Make 10 failed attempts
      const attempts = [];
      for (let i = 0; i < 10; i++) {
        attempts.push(
          server.inject({
            method: 'POST',
            url: '/v1/auth/login-with-code',
            payload: {
              challengeId,
              code: '000000',
            },
          })
        );
      }

      await Promise.all(attempts);

      // Challenge should be locked or attempts exhausted
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login-with-code',
        payload: {
          challengeId,
          code: verificationCode, // Even correct code should fail
        },
      });

      expect(response.statusCode).toBe(401);

      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/attempts|locked|expired/i);
    });

    it('should invalidate code after successful use', async () => {
      // First login (success)
      await server.inject({
        method: 'POST',
        url: '/v1/auth/login-with-code',
        payload: {
          challengeId,
          code: verificationCode,
        },
      });

      // Try to reuse same code
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login-with-code',
        payload: {
          challengeId,
          code: verificationCode,
        },
      });

      expect(response.statusCode).toBe(401);

      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/invalid|used|expired/i);
    });
  });

  describe('Code Format Validation', () => {
    it('should reject non-numeric codes', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login-with-code',
        payload: {
          challengeId: 'test-challenge',
          code: 'abcdef', // Not numeric
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject codes with wrong length', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login-with-code',
        payload: {
          challengeId: 'test-challenge',
          code: '123', // Too short (should be 6 digits)
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
