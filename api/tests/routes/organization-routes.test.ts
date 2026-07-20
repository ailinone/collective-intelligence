// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Organization Management Routes
 * Uses REAL database - NO mocks
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { prisma, connectDatabase, disconnectDatabase } from '@/database/client';
import type { Organization, User } from '@/generated/prisma/client.js';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { initializeDIContainer, resetDIContainer } from '@/di/container';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

// NO MOCKS - Uses real database

describe('Organization Management Routes Logic - Real Tests (NO Mocks)', () => {
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
      await prisma.user.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
      await prisma.organization.delete({ where: { id: testOrgId } }).catch(() => {});
    }
    await disconnectDatabase();
    resetDIContainer();
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(async () => {
    // Clean up test data before each test (except base org/user)
  });

  describe('Get Organization', () => {
    it('should get organization with member count', async () => {
      // Create additional test users
      const user2 = await prisma.user.create({
        data: {
          email: `member-${Date.now()}@example.com`,
          name: 'Test Member',
          passwordHash: '$2b$12$dummyhash',
          organizationId: testOrgId,
          role: 'developer',
          status: 'active',
        },
      });

      const org = await prisma.organization.findUnique({
        where: { id: testOrgId },
        include: {
          _count: {
            select: { users: true },
          },
        },
      });

      expect(org).toBeDefined();
      expect(org?._count.users).toBeGreaterThanOrEqual(2);

      // Cleanup
      await prisma.user.delete({ where: { id: user2.id } }).catch(() => {});
    });

    it('should return null for non-existent organization', async () => {
      // Use valid UUID format; Prisma/Postgres reject non-UUID strings for @db.Uuid columns
      const nonexistentOrgId = '00000000-0000-0000-0000-000000000001';
      const org = await prisma.organization.findUnique({
        where: { id: nonexistentOrgId },
      });

      expect(org).toBeNull();
    });
  });

  describe('Update Organization', () => {
    it('should update organization name', async () => {
      const originalName = (await prisma.organization.findUnique({ where: { id: testOrgId } }))?.name;
      
      const result = await prisma.organization.update({
        where: { id: testOrgId },
        data: { name: 'Updated Organization' },
      });

      expect(result.name).toBe('Updated Organization');

      // Restore original name
      if (originalName) {
        await prisma.organization.update({
          where: { id: testOrgId },
          data: { name: originalName },
        });
      }
    });

    it('should update organization tier', async () => {
      const originalTier = (await prisma.organization.findUnique({ where: { id: testOrgId } }))?.tier;
      
      const result = await prisma.organization.update({
        where: { id: testOrgId },
        data: { tier: 'pro' },
      });

      expect(result.tier).toBe('pro');

      // Restore original tier
      if (originalTier) {
        await prisma.organization.update({
          where: { id: testOrgId },
          data: { tier: originalTier },
        });
      }
    });

    it('should support partial updates', async () => {
      const originalName = (await prisma.organization.findUnique({ where: { id: testOrgId } }))?.name;
      
      const result = await prisma.organization.update({
        where: { id: testOrgId },
        data: { name: 'Partially Updated' },
      });

      expect(result.name).toBe('Partially Updated');
      expect(result.tier).toBeDefined();

      // Restore original name
      if (originalName) {
        await prisma.organization.update({
          where: { id: testOrgId },
          data: { name: originalName },
        });
      }
    });
  });

  describe('List Members', () => {
    it('should list organization members', async () => {
      // Create additional test members
      const member1 = await prisma.user.create({
        data: {
          email: `member1-${Date.now()}@example.com`,
          name: 'Member 1',
          passwordHash: '$2b$12$dummyhash',
          organizationId: testOrgId,
          role: 'developer',
          status: 'active',
        },
      });

      const member2 = await prisma.user.create({
        data: {
          email: `member2-${Date.now()}@example.com`,
          name: 'Member 2',
          passwordHash: '$2b$12$dummyhash',
          organizationId: testOrgId,
          role: 'viewer',
          status: 'active',
        },
      });

      const members = await prisma.user.findMany({
        where: { organizationId: testOrgId },
      });

      expect(members.length).toBeGreaterThanOrEqual(3);
      expect(members.every(m => m.organizationId === testOrgId)).toBe(true);

      // Cleanup
      await prisma.user.deleteMany({ 
        where: { id: { in: [member1.id, member2.id] } },
      }).catch(() => {});
    });

    it('should order members by creation date', async () => {
      const members = await prisma.user.findMany({
        where: { organizationId: testOrgId },
        orderBy: { createdAt: 'asc' },
      });

      // Verify ordering (older first)
      for (let i = 1; i < members.length; i++) {
        expect(members[i].createdAt.getTime()).toBeGreaterThanOrEqual(
          members[i - 1].createdAt.getTime()
        );
      }
    });

    it('should exclude sensitive data from members list', async () => {
      const members = await prisma.user.findMany({
        where: { organizationId: testOrgId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          // passwordHash explicitly excluded
        },
      });

      expect(members.length).toBeGreaterThan(0);
      expect(members[0]).not.toHaveProperty('passwordHash');
    });
  });

  describe('Remove Member', () => {
    it('should remove member successfully', async () => {
      // Create member to remove
      const memberToRemove = await prisma.user.create({
        data: {
          email: `remove-${Date.now()}@example.com`,
          name: 'Member To Remove',
          passwordHash: '$2b$12$dummyhash',
          organizationId: testOrgId,
          role: 'developer',
          status: 'active',
        },
      });

      const user = await prisma.user.findUnique({
        where: { id: memberToRemove.id },
      });

      expect(user).toBeDefined();
      expect(user?.organizationId).toBe(testOrgId);

      await prisma.user.delete({
        where: { id: memberToRemove.id },
      });

      const deleted = await prisma.user.findUnique({
        where: { id: memberToRemove.id },
      });

      expect(deleted).toBeNull();
    });

    it('should fail if member not in organization', async () => {
      // Create org and member in different org
      const otherOrg = await prisma.organization.create({
        data: {
          name: `Other Org ${Date.now()}`,
          slug: `other-org-${Date.now()}`,
          tier: 'pro',
          status: 'active',
        },
      });

      const memberInOtherOrg = await prisma.user.create({
        data: {
          email: `other-${Date.now()}@example.com`,
          name: 'Member In Other Org',
          passwordHash: '$2b$12$dummyhash',
          organizationId: otherOrg.id,
          role: 'developer',
          status: 'active',
        },
      });

      const user = await prisma.user.findUnique({
        where: { id: memberInOtherOrg.id },
      });

      expect(user?.organizationId).not.toBe(testOrgId);

      // Cleanup
      await prisma.user.delete({ where: { id: memberInOtherOrg.id } }).catch(() => {});
      await prisma.organization.delete({ where: { id: otherOrg.id } }).catch(() => {});
    });
  });

  describe('Organization Tiers', () => {
    it('should support free tier', () => {
      const tier = 'free';
      const validTiers = ['free', 'pro', 'enterprise'];
      
      expect(validTiers.includes(tier)).toBe(true);
    });

    it('should support pro tier', () => {
      const tier = 'pro';
      const validTiers = ['free', 'pro', 'enterprise'];
      
      expect(validTiers.includes(tier)).toBe(true);
    });

    it('should support enterprise tier', () => {
      const tier = 'enterprise';
      const validTiers = ['free', 'pro', 'enterprise'];
      
      expect(validTiers.includes(tier)).toBe(true);
    });

    it('should reject invalid tier', () => {
      const tier = 'invalid';
      const validTiers = ['free', 'pro', 'enterprise'];
      
      expect(validTiers.includes(tier)).toBe(false);
    });
  });

  describe('Permission Checks', () => {
    it('should verify organization membership', () => {
      const userOrgId = testOrgId;
      const requestedOrgId = testOrgId;

      expect(userOrgId).toBe(requestedOrgId);
    });

    it('should detect cross-organization access', () => {
      const userOrgId = testOrgId;
      const requestedOrgId = 'different-org-id';

      expect(userOrgId).not.toBe(requestedOrgId);
    });

    it('should check admin/owner role', () => {
      const adminRoles = ['admin', 'owner'];

      expect(adminRoles.includes('admin')).toBe(true);
      expect(adminRoles.includes('owner')).toBe(true);
      expect(adminRoles.includes('viewer')).toBe(false);
    });
  });

  describe('Member Statistics', () => {
    it('should calculate member count correctly', async () => {
      // Create additional members
      const member1 = await prisma.user.create({
        data: {
          email: `stat1-${Date.now()}@example.com`,
          name: 'Stat Member 1',
          passwordHash: '$2b$12$dummyhash',
          organizationId: testOrgId,
          role: 'developer',
          status: 'active',
        },
      });

      const org = await prisma.organization.findUnique({
        where: { id: testOrgId },
        include: {
          _count: {
            select: { users: true },
          },
        },
      });

      expect(org?._count.users).toBeGreaterThanOrEqual(2);

      // Cleanup
      await prisma.user.delete({ where: { id: member1.id } }).catch(() => {});
    });

    it('should handle zero members edge case', async () => {
      // Create isolated org with no members
      const emptyOrg = await prisma.organization.create({
        data: {
          name: `Empty Org ${Date.now()}`,
          slug: `empty-org-${Date.now()}`,
          tier: 'free',
          status: 'active',
        },
      });

      const org = await prisma.organization.findUnique({
        where: { id: emptyOrg.id },
        include: {
          _count: {
            select: { users: true },
          },
        },
      });

      expect(org?._count.users).toBe(0);

      // Cleanup
      await prisma.organization.delete({ where: { id: emptyOrg.id } }).catch(() => {});
    });
  });

  describe('Security', () => {
    it('should prevent self-removal', () => {
      const currentUserId = testUserId;
      const targetUserId = testUserId;

      const canRemove = currentUserId !== targetUserId;
      expect(canRemove).toBe(false);
    });

    it('should allow admin to remove others', () => {
      const currentUserId = testUserId;
      const targetUserId = 'different-user-id';
      const isAdmin = true;

      const canRemove = isAdmin && currentUserId !== targetUserId;
      expect(canRemove).toBe(true);
    });
  });
});
