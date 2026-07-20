// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * User Persistence Mapper - Tests (Enterprise-Grade)
 * 
 * Test Coverage:
 * - Type safety (no as any bypasses)
 * - Optional field handling (null vs undefined)
 * - Prisma relation mapping (connect by ID)
 * - JSON field serialization
 * - Edge cases (missing fields, empty arrays)
 */

import { describe, it, expect } from 'vitest';
import type { Prisma } from '@/generated/prisma/index.js';
import {
  mapUserToPrismaCreate,
  mapUserToPrismaUpdate,
  mapApiKeyToPrismaCreate,
  mapApiKeyToPrismaUpdate,
} from './user-persistence-mapper';

// Type-safe test data types (matching ReturnType<UserEntity['toPersistence']>)
type UserPersistenceData = ReturnType<import('@/domain/entities/user.entity').UserEntity['toPersistence']>;
type ApiKeyPersistenceData = ReturnType<import('@/domain/entities/api-key.entity').ApiKeyEntity['toPersistence']>;

describe('User Persistence Mapper', () => {
  describe('mapUserToPrismaCreate', () => {
    it('should map user entity to Prisma create input with all fields', () => {
      const userPersistence = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        passwordHash: '$2b$10$kxNE8./TzbVJKwfG6V5b6eOwiiOAJ33HFaHn9mxvpVxGCqi8ShGp.',
        role: 'admin',
        status: 'active',
        statusReason: null,
        organizationId: 'org-123',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-02'),
      };

      const result: Prisma.UserCreateInput = mapUserToPrismaCreate(userPersistence as UserPersistenceData);

      expect(result).toEqual({
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        passwordHash: '$2b$10$kxNE8./TzbVJKwfG6V5b6eOwiiOAJ33HFaHn9mxvpVxGCqi8ShGp.',
        role: 'admin',
        status: 'active',
        statusReason: null,
        createdAt: userPersistence.createdAt,
        updatedAt: userPersistence.updatedAt,
        lastLoginAt: null,
        organization: {
          connect: {
            id: 'org-123',
          },
        },
      });

      // Type check: Ensure result is valid Prisma.UserCreateInput
      const typeCheck: Prisma.UserCreateInput = result;
      expect(typeCheck).toBeDefined();
    });

    it('should throw error when password hash is missing', () => {
      const userPersistence = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        passwordHash: null,
        role: 'viewer',
        status: 'active',
        statusReason: null,
        organizationId: 'org-123',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-02'),
      };

      // Should throw error when passwordHash is missing - auth service must provide valid hash
      expect(() => {
        mapUserToPrismaCreate(userPersistence as UserPersistenceData);
      }).toThrow('passwordHash is required');
    });

    it('should handle user with status reason', () => {
      const userPersistence = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        passwordHash: '$2b$10$hash',
        role: 'admin',
        status: 'suspended',
        statusReason: 'Policy violation',
        organizationId: 'org-123',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-02'),
      };

      const result = mapUserToPrismaCreate(userPersistence as UserPersistenceData);

      expect(result.statusReason).toBe('Policy violation');
    });
  });

  describe('mapUserToPrismaUpdate', () => {
    it('should map user entity to Prisma update input', () => {
      const userPersistence = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Updated Name',
        passwordHash: '$2b$10$newhash',
        role: 'editor',
        status: 'active',
        statusReason: null,
        organizationId: 'org-123',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-03'),
      };

      const result: Prisma.UserUpdateInput = mapUserToPrismaUpdate(userPersistence as UserPersistenceData);

      expect(result).toEqual({
        name: 'Updated Name',
        role: 'editor',
        status: 'active',
        statusReason: null,
        updatedAt: userPersistence.updatedAt,
        passwordHash: '$2b$10$newhash',
      });

      // Should not update immutable fields
      expect(result).not.toHaveProperty('id');
      expect(result).not.toHaveProperty('createdAt');
    });

    it('should not update password if not provided', () => {
      const userPersistence = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Updated Name',
        passwordHash: null,
        role: 'editor',
        status: 'active',
        statusReason: null,
        organizationId: 'org-123',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-03'),
      };

      const result = mapUserToPrismaUpdate(userPersistence as UserPersistenceData);

      expect(result).not.toHaveProperty('passwordHash');
    });
  });

  describe('mapApiKeyToPrismaCreate', () => {
    const keyHash = '$2b$10$validhash';
    const quickHash = 'sha256quickhash';

    it('should map API key entity to Prisma create input with all fields', () => {
      const apiKeyPersistence = {
        id: 'key-123',
        name: 'Production API Key',
        keyPrefix: 'ak_live_abc123',
        keyValue: 'ak_live_fullkey', // Not stored, used for hash
        userId: 'user-123',
        organizationId: 'org-123',
        status: 'active',
        statusReason: null,
        lastUsedAt: new Date('2025-01-02'),
        requestCount: 100,
        lastRequestIp: '192.168.1.1',
        expiresAt: new Date('2026-01-01'),
        createdAt: new Date('2025-01-01'),
        rotatedAt: null,
        revokedAt: null,
        rotationCount: 0,
        previousKeyId: null,
        nextKeyId: null,
        autoRotate: true,
        rotationIntervalDays: 90,
        gracePeriodDays: 7,
        ipWhitelist: ['192.168.1.0/24', '10.0.0.1'],
        permissions: { read: true, write: true, delete: false },
      };

      const result: Prisma.ApiKeyCreateInput = mapApiKeyToPrismaCreate(
        apiKeyPersistence as ApiKeyPersistenceData,
        keyHash,
        quickHash
      );

      expect(result).toMatchObject({
        id: 'key-123',
        name: 'Production API Key',
        keyHash,
        keyPrefix: 'ak_live_abc123',
        quickHash,
        status: 'active',
        statusReason: null,
        lastUsedAt: apiKeyPersistence.lastUsedAt,
        requestCount: 100,
        lastRequestIp: '192.168.1.1',
        expiresAt: apiKeyPersistence.expiresAt,
        createdAt: apiKeyPersistence.createdAt,
        rotatedAt: null,
        revokedAt: null,
        rotationCount: 0,
        previousKeyId: null,
        nextKeyId: null,
        autoRotate: true,
        rotationIntervalDays: 90,
        gracePeriodDays: 7,
        ipWhitelist: ['192.168.1.0/24', '10.0.0.1'],
      });

      // Relations
      expect(result.user).toEqual({ connect: { id: 'user-123' } });
      expect(result.organization).toEqual({ connect: { id: 'org-123' } });

      // JSON field
      expect(result.permissions).toEqual({ read: true, write: true, delete: false });
    });

    it('should handle API key with minimal fields', () => {
      const apiKeyPersistence = {
        id: 'key-123',
        name: 'Test Key',
        keyPrefix: 'ak_test_123',
        keyValue: 'ak_test_fullkey',
        userId: 'user-123',
        organizationId: 'org-123',
        status: 'active',
        statusReason: null,
        lastUsedAt: new Date('2025-01-01'),
        requestCount: null,
        lastRequestIp: null,
        expiresAt: null,
        createdAt: new Date('2025-01-01'),
        rotatedAt: null,
        revokedAt: null,
        rotationCount: null,
        previousKeyId: null,
        nextKeyId: null,
        autoRotate: null,
        rotationIntervalDays: null,
        gracePeriodDays: null,
        ipWhitelist: null,
        permissions: null,
      };

      const result = mapApiKeyToPrismaCreate(apiKeyPersistence as ApiKeyPersistenceData, keyHash, quickHash);

      expect(result.requestCount).toBe(0);
      expect(result.lastRequestIp).toBeNull();
      expect(result.expiresAt).toBeNull();
      expect(result.autoRotate).toBe(false);
      expect(result.gracePeriodDays).toBe(7);
      expect(result.ipWhitelist).toEqual([]);
    });

    it('should handle empty IP whitelist', () => {
      const apiKeyPersistence = {
        id: 'key-123',
        name: 'Test Key',
        keyPrefix: 'ak_test_123',
        keyValue: 'ak_test_fullkey',
        userId: 'user-123',
        organizationId: 'org-123',
        status: 'active',
        statusReason: null,
        lastUsedAt: new Date(),
        createdAt: new Date(),
        ipWhitelist: [],
        permissions: null,
      };

      const result = mapApiKeyToPrismaCreate(apiKeyPersistence as ApiKeyPersistenceData, keyHash, quickHash);

      expect(result.ipWhitelist).toEqual([]);
    });
  });

  describe('mapApiKeyToPrismaUpdate', () => {
    it('should map API key entity to Prisma update input', () => {
      const apiKeyPersistence = {
        id: 'key-123',
        name: 'Updated Key Name',
        status: 'rotating',
        statusReason: 'Scheduled rotation',
        lastUsedAt: new Date('2025-01-05'),
        requestCount: 500,
        lastRequestIp: '10.0.0.5',
        expiresAt: new Date('2026-06-01'),
        rotatedAt: new Date('2025-01-05'),
        revokedAt: null,
        rotationCount: 1,
        previousKeyId: 'key-old',
        nextKeyId: 'key-new',
        autoRotate: true,
        rotationIntervalDays: 60,
        gracePeriodDays: 14,
        ipWhitelist: ['192.168.1.0/24'],
        permissions: { read: true, write: false },
      };

      const result: Prisma.ApiKeyUpdateInput = mapApiKeyToPrismaUpdate(apiKeyPersistence as ApiKeyPersistenceData);

      expect(result).toMatchObject({
        name: 'Updated Key Name',
        status: 'rotating',
        statusReason: 'Scheduled rotation',
        lastUsedAt: apiKeyPersistence.lastUsedAt,
        requestCount: 500,
        lastRequestIp: '10.0.0.5',
        expiresAt: apiKeyPersistence.expiresAt,
        rotatedAt: apiKeyPersistence.rotatedAt,
        revokedAt: null,
        rotationCount: 1,
        previousKeyId: 'key-old',
        nextKeyId: 'key-new',
        autoRotate: true,
        rotationIntervalDays: 60,
        gracePeriodDays: 14,
        ipWhitelist: ['192.168.1.0/24'],
      });

      // Should not update immutable fields
      expect(result).not.toHaveProperty('id');
      expect(result).not.toHaveProperty('createdAt');
      expect(result).not.toHaveProperty('keyHash');
      expect(result).not.toHaveProperty('quickHash');
    });
  });

  describe('Type Safety', () => {
    it('should produce valid Prisma.UserCreateInput type', () => {
      const userPersistence = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test',
        passwordHash: '$2b$10$kxNE8./TzbVJKwfG6V5b6eOwiiOAJ33HFaHn9mxvpVxGCqi8ShGp.',
        role: 'admin',
        status: 'active',
        statusReason: null,
        organizationId: 'org-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = mapUserToPrismaCreate(userPersistence as UserPersistenceData);

      // This should compile without errors (type check)
      const _typeCheck: Prisma.UserCreateInput = result;
      expect(_typeCheck).toBeDefined();
    });

    it('should produce valid Prisma.ApiKeyCreateInput type', () => {
      const apiKeyPersistence = {
        id: 'key-123',
        name: 'Test',
        keyPrefix: 'ak_test',
        userId: 'user-123',
        organizationId: 'org-123',
        status: 'active',
        statusReason: null,
        lastUsedAt: new Date(),
        createdAt: new Date(),
        permissions: null,
      };

      const result = mapApiKeyToPrismaCreate(apiKeyPersistence as ApiKeyPersistenceData, 'hash', 'quickhash');

      // This should compile without errors (type check)
      const _typeCheck: Prisma.ApiKeyCreateInput = result;
      expect(_typeCheck).toBeDefined();
    });
  });
});

