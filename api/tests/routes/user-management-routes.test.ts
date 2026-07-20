// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for User Management Routes
 * Uses REAL database - NO mocks
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { prisma, connectDatabase, disconnectDatabase } from '@/database/client';
import type { User, ApiKey } from '@/generated/prisma/client.js';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { initializeDIContainer, resetDIContainer } from '@/di/container';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

// NO MOCKS - Uses real database

describe('User Management Routes Logic - Real Tests (NO Mocks)', () => {
  let testOrgId: string;
  let testUserId: string;

  beforeAll(async () => {
    await startTestEnvironment();
    initializeDIContainer();
    await connectDatabase();
    await syncDefaultRoles();

    // Create test organization
    const org = await prisma.organization.create({
      data: {
        name: `Test Org ${Date.now()}`,
        slug: `test-org-${Date.now()}`,
        tier: 'enterprise',
        status: 'active',
      },
    });
    testOrgId = org.id;

    // Create test user
    const user = await prisma.user.create({
      data: {
        email: `test-${Date.now()}@example.com`,
        name: 'Test User',
        passwordHash: '$2b$12$dummyhash',
        organizationId: testOrgId,
        role: 'admin',
        status: 'active',
      },
    });
    testUserId = user.id;
  }, 60_000);

  afterAll(async () => {
    // Cleanup
    if (testOrgId) {
      await prisma.apiKey.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
      await prisma.organization.delete({ where: { id: testOrgId } }).catch(() => {});
    }
    await disconnectDatabase();
    resetDIContainer();
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(async () => {
    // Clean up test data before each test (except the base user/org)
    await prisma.apiKey.deleteMany({ 
      where: { 
        organizationId: testOrgId,
        userId: { not: testUserId },
      },
    }).catch(() => {});
  });

  describe('List Users', () => {
    it('should list users with pagination', async () => {
      // Create additional test users
      const user2 = await prisma.user.create({
        data: {
          email: `test2-${Date.now()}@example.com`,
          name: 'Test User 2',
          passwordHash: '$2b$12$dummyhash',
          organizationId: testOrgId,
          role: 'developer',
          status: 'active',
        },
      });

      // Simulate route logic
      const page = 1;
      const limit = 20;
      const skip = (page - 1) * limit;
      
      const users = await prisma.user.findMany({
        where: { organizationId: testOrgId },
        skip,
        take: limit,
      });
      
      const total = await prisma.user.count({
        where: { organizationId: testOrgId },
      });
      const totalPages = Math.ceil(total / limit);

      expect(users.length).toBeGreaterThanOrEqual(2);
      expect(total).toBeGreaterThanOrEqual(2);
      expect(totalPages).toBeGreaterThanOrEqual(1);

      // Cleanup
      await prisma.user.delete({ where: { id: user2.id } }).catch(() => {});
    });

    it('should filter users by status', async () => {
      // Create suspended user
      const suspendedUser = await prisma.user.create({
        data: {
          email: `suspended-${Date.now()}@example.com`,
          name: 'Suspended User',
          passwordHash: '$2b$12$dummyhash',
          organizationId: testOrgId,
          role: 'developer',
          status: 'suspended',
        },
      });

      const activeUsers = await prisma.user.findMany({
        where: {
          organizationId: testOrgId,
          status: 'active',
        },
      });

      expect(activeUsers.length).toBeGreaterThanOrEqual(1);
      expect(activeUsers.every(u => u.status === 'active')).toBe(true);

      // Cleanup
      await prisma.user.delete({ where: { id: suspendedUser.id } }).catch(() => {});
    });

    it('should handle pagination correctly', () => {
      const testCases = [
        { page: 1, limit: 20, expectedSkip: 0 },
        { page: 2, limit: 20, expectedSkip: 20 },
        { page: 3, limit: 10, expectedSkip: 20 },
        { page: 1, limit: 50, expectedSkip: 0 },
      ];

      testCases.forEach(({ page, limit, expectedSkip }) => {
        const skip = (page - 1) * limit;
        expect(skip).toBe(expectedSkip);
      });
    });

    it('should calculate total pages correctly', () => {
      const testCases = [
        { total: 100, limit: 20, expectedPages: 5 },
        { total: 95, limit: 20, expectedPages: 5 },
        { total: 10, limit: 20, expectedPages: 1 },
        { total: 0, limit: 20, expectedPages: 0 },
      ];

      testCases.forEach(({ total, limit, expectedPages }) => {
        const totalPages = Math.ceil(total / limit);
        expect(totalPages).toBe(expectedPages);
      });
    });
  });

  describe('Get User Details', () => {
    it('should get user details with organization', async () => {
      const user = await prisma.user.findUnique({
        where: { id: testUserId },
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              tier: true,
            },
          },
        },
      });

      expect(user).toBeDefined();
      expect(user?.organization).toBeDefined();
      expect(user?.organization.id).toBe(testOrgId);
    });

    it('should return null for non-existent user', async () => {
      const nonexistentUserId = '00000000-0000-0000-0000-000000000001';
      const user = await prisma.user.findUnique({
        where: { id: nonexistentUserId },
      });

      expect(user).toBeNull();
    });
  });

  describe('Update User', () => {
    it('should update user name', async () => {
      const result = await prisma.user.update({
        where: { id: testUserId },
        data: { name: 'Updated Name' },
      });

      expect(result.name).toBe('Updated Name');

      // Restore original name
      await prisma.user.update({
        where: { id: testUserId },
        data: { name: 'Test User' },
      });
    });

    it('should update user role', async () => {
      const originalRole = (await prisma.user.findUnique({ where: { id: testUserId } }))?.role;
      
      const result = await prisma.user.update({
        where: { id: testUserId },
        data: { role: 'viewer' },
      });

      expect(result.role).toBe('viewer');

      // Restore original role
      if (originalRole) {
        await prisma.user.update({
          where: { id: testUserId },
          data: { role: originalRole },
        });
      }
    });

    it('should update user status', async () => {
      const result = await prisma.user.update({
        where: { id: testUserId },
        data: { status: 'suspended' },
      });

      expect(result.status).toBe('suspended');

      // Restore active status
      await prisma.user.update({
        where: { id: testUserId },
        data: { status: 'active' },
      });
    });

    it('should support partial updates', async () => {
      const originalName = (await prisma.user.findUnique({ where: { id: testUserId } }))?.name;
      
      const result = await prisma.user.update({
        where: { id: testUserId },
        data: { name: 'Partially Updated' },
      });

      expect(result.name).toBe('Partially Updated');
      expect(result.email).toBeDefined();

      // Restore original name
      if (originalName) {
        await prisma.user.update({
          where: { id: testUserId },
          data: { name: originalName },
        });
      }
    });
  });

  describe('Delete User', () => {
    it('should delete user successfully', async () => {
      // Create a user to delete
      const userToDelete = await prisma.user.create({
        data: {
          email: `delete-${Date.now()}@example.com`,
          name: 'User To Delete',
          passwordHash: '$2b$12$dummyhash',
          organizationId: testOrgId,
          role: 'developer',
          status: 'active',
        },
      });

      await prisma.user.delete({
        where: { id: userToDelete.id },
      });

      const deleted = await prisma.user.findUnique({
        where: { id: userToDelete.id },
      });

      expect(deleted).toBeNull();
    });

    it('should fail to delete non-existent user', async () => {
      // Use valid UUID format; Prisma/Postgres reject non-UUID strings for @db.Uuid columns
      const nonexistentUserId = '00000000-0000-0000-0000-000000000001';
      await expect(
        prisma.user.delete({
          where: { id: nonexistentUserId },
        })
      ).rejects.toThrow();
    });
  });

  describe('List User API Keys', () => {
    it('should list API keys for user', async () => {
      // Create test API key
      const apiKey = await prisma.apiKey.create({
        data: {
          userId: testUserId,
          organizationId: testOrgId,
          name: 'Test API Key',
          keyHash: 'hashed-key-value',
          keyPrefix: 'ak_test_keyval01',
          status: 'active',
        },
      });

      const keys = await prisma.apiKey.findMany({
        where: {
          userId: testUserId,
          organizationId: testOrgId,
        },
      });

      expect(keys.length).toBeGreaterThanOrEqual(1);
      expect(keys.some(k => k.id === apiKey.id)).toBe(true);

      // Cleanup
      await prisma.apiKey.delete({ where: { id: apiKey.id } }).catch(() => {});
    });

    it('should return empty array when user has no API keys', async () => {
      // Create user without API keys
      const userWithoutKeys = await prisma.user.create({
        data: {
          email: `nokeys-${Date.now()}@example.com`,
          name: 'User Without Keys',
          passwordHash: '$2b$12$dummyhash',
          organizationId: testOrgId,
          role: 'developer',
          status: 'active',
        },
      });

      const keys = await prisma.apiKey.findMany({
        where: {
          userId: userWithoutKeys.id,
          organizationId: testOrgId,
        },
      });

      expect(keys).toEqual([]);

      // Cleanup
      await prisma.user.delete({ where: { id: userWithoutKeys.id } }).catch(() => {});
    });

    it('should filter API keys by status', async () => {
      // Create active and revoked API keys
      const activeKey = await prisma.apiKey.create({
        data: {
          userId: testUserId,
          organizationId: testOrgId,
          name: 'Active Key',
          keyHash: 'hashed-active',
          keyPrefix: 'ak_test_active01',
          status: 'active',
        },
      });

      const revokedKey = await prisma.apiKey.create({
        data: {
          userId: testUserId,
          organizationId: testOrgId,
          name: 'Revoked Key',
          keyHash: 'hashed-revoked',
          keyPrefix: 'ak_test_revoked1',
          status: 'revoked',
        },
      });

      const activeKeys = await prisma.apiKey.findMany({
        where: {
          userId: testUserId,
          organizationId: testOrgId,
          status: 'active',
        },
      });

      expect(activeKeys.length).toBeGreaterThanOrEqual(1);
      expect(activeKeys.every(k => k.status === 'active')).toBe(true);

      // Cleanup
      await prisma.apiKey.deleteMany({ 
        where: { id: { in: [activeKey.id, revokedKey.id] } },
      }).catch(() => {});
    });
  });
});
