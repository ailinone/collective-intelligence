// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ApiKeyEntity - Unit Tests
 * Testing API key business logic (rotation, revocation, auto-rotation)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ApiKeyEntity, ApiKeyStatus } from '@/domain/entities/api-key.entity';

describe('ApiKeyEntity', () => {
  const validData = {
    name: 'Production API Key',
    userId: '550e8400-e29b-41d4-a716-446655440000',
    organizationId: '660e8400-e29b-41d4-a716-446655440000',
  };

  describe('Creation', () => {
    it('should create new API key', () => {
      const apiKey = ApiKeyEntity.create(validData);
      
      expect(apiKey).toBeInstanceOf(ApiKeyEntity);
      expect(apiKey.name).toBe('Production API Key');
      expect(apiKey.userId).toBe(validData.userId);
      expect(apiKey.organizationId).toBe(validData.organizationId);
      expect(apiKey.status).toBe(ApiKeyStatus.ACTIVE);
      expect(apiKey.requestCount).toBe(0);
    });

    it('should trim name', () => {
      const apiKey = ApiKeyEntity.create({
        ...validData,
        name: '  Test Key  ',
      });
      
      expect(apiKey.name).toBe('Test Key');
    });

    it('should set default grace period (7 days)', () => {
      const apiKey = ApiKeyEntity.create(validData);
      const dto = apiKey.toPersistence();
      
      expect(dto.gracePeriodDays).toBe(7);
    });

    it('should accept expiration date', () => {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);
      
      const apiKey = ApiKeyEntity.create({
        ...validData,
        expiresAt,
      });
      
      const dto = apiKey.toPersistence();
      expect(dto.expiresAt).toEqual(expiresAt);
    });

    it('should accept IP whitelist', () => {
      const apiKey = ApiKeyEntity.create({
        ...validData,
        ipWhitelist: ['192.168.1.1', '10.0.0.1'],
      });
      
      const dto = apiKey.toPersistence();
      expect(dto.ipWhitelist).toEqual(['192.168.1.1', '10.0.0.1']);
    });
  });

  describe('Invariant Validation', () => {
    it('should reject empty name', () => {
      expect(() => ApiKeyEntity.create({
        ...validData,
        name: '',
      })).toThrow('API key name cannot be empty');
    });

    it('should reject whitespace-only name', () => {
      expect(() => ApiKeyEntity.create({
        ...validData,
        name: '   ',
      })).toThrow('API key name cannot be empty');
    });

    it('should reject missing userId', () => {
      expect(() => ApiKeyEntity.create({
        ...validData,
        userId: '',
      })).toThrow('API key must belong to a user');
    });

    it('should reject missing organizationId', () => {
      expect(() => ApiKeyEntity.create({
        ...validData,
        organizationId: '',
      })).toThrow('API key must belong to an organization');
    });

    it('should reject expiration before creation', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      
      expect(() => ApiKeyEntity.create({
        ...validData,
        expiresAt: pastDate,
      })).toThrow('Expiration date must be after creation date');
    });

    it('should reject auto-rotation without interval', () => {
      expect(() => ApiKeyEntity.create({
        ...validData,
        autoRotate: true,
      })).toThrow('Auto-rotation enabled but no interval specified');
    });
  });

  describe('Business Logic: Record Usage', () => {
    it('should record usage without IP', () => {
      const apiKey = ApiKeyEntity.create(validData);
      const before = apiKey.requestCount;
      
      apiKey.recordUsage();
      
      expect(apiKey.requestCount).toBe(before + 1);
    });

    it('should record usage with IP', () => {
      const apiKey = ApiKeyEntity.create(validData);
      
      apiKey.recordUsage('192.168.1.1');
      
      expect(apiKey.requestCount).toBe(1);
      const dto = apiKey.toPersistence();
      expect(dto.lastRequestIp).toBe('192.168.1.1');
    });

    it('should update lastUsedAt timestamp', () => {
      const apiKey = ApiKeyEntity.create(validData);
      const dto1 = apiKey.toPersistence();
      const before = dto1.lastUsedAt;
      
      // Small delay
      const start = Date.now();
      while (Date.now() - start < 2) {}
      
      apiKey.recordUsage();
      const dto2 = apiKey.toPersistence();
      
      expect(dto2.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe('Business Logic: Rotation', () => {
    it('should start rotation', () => {
      const apiKey = ApiKeyEntity.create(validData);
      const newKeyId = 'new-key-id-123';
      
      apiKey.startRotation(newKeyId);
      
      expect(apiKey.status).toBe(ApiKeyStatus.ROTATING);
      const dto = apiKey.toPersistence();
      expect(dto.nextKeyId).toBe(newKeyId);
      expect(dto.rotatedAt).toBeInstanceOf(Date);
    });

    it('should throw if already rotating', () => {
      const apiKey = ApiKeyEntity.create(validData);
      apiKey.startRotation('key-1');
      
      expect(() => apiKey.startRotation('key-2')).toThrow('API key is already rotating');
    });

    it('should throw if trying to rotate revoked key', () => {
      const apiKey = ApiKeyEntity.create(validData);
      apiKey.revoke();
      
      expect(() => apiKey.startRotation('key-1')).toThrow('Cannot rotate revoked API key');
    });

    it('should complete rotation', () => {
      const apiKey = ApiKeyEntity.create(validData);
      apiKey.startRotation('new-key');
      
      apiKey.completeRotation();
      
      expect(apiKey.status).toBe(ApiKeyStatus.REVOKED);
      const dto = apiKey.toPersistence();
      expect(dto.revokedAt).toBeInstanceOf(Date);
      expect(dto.rotationCount).toBe(1);
    });

    it('should throw if completing non-rotating key', () => {
      const apiKey = ApiKeyEntity.create(validData);
      
      expect(() => apiKey.completeRotation()).toThrow('API key is not in rotating state');
    });
  });

  describe('Business Logic: Revocation', () => {
    it('should revoke active key', () => {
      const apiKey = ApiKeyEntity.create(validData);
      
      apiKey.revoke('Security incident');
      
      expect(apiKey.status).toBe(ApiKeyStatus.REVOKED);
      const dto = apiKey.toPersistence();
      expect(dto.revokedAt).toBeInstanceOf(Date);
    });

    it('should throw if already revoked', () => {
      const apiKey = ApiKeyEntity.create(validData);
      apiKey.revoke();
      
      expect(() => apiKey.revoke()).toThrow('API key is already revoked');
    });
  });

  describe('Business Logic: Expiration', () => {
    it('should mark as expired', () => {
      const apiKey = ApiKeyEntity.create(validData);
      
      apiKey.markExpired();
      
      expect(apiKey.status).toBe(ApiKeyStatus.EXPIRED);
    });

    it('should throw if already expired', () => {
      const apiKey = ApiKeyEntity.create(validData);
      apiKey.markExpired();
      
      expect(() => apiKey.markExpired()).toThrow('API key is already expired');
    });

    it('should check if expired based on expiresAt', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      
      const apiKey = ApiKeyEntity.reconstitute({
        ...validData,
        id: 'key-123',
        keyValue: 'ak_live_' + 'a'.repeat(40),
        status: 'active',
        lastUsedAt: new Date(),
        requestCount: 0,
        createdAt: new Date(Date.now() - 86400000 * 2),
        rotationCount: 0,
        autoRotate: false,
        gracePeriodDays: 7,
        ipWhitelist: [],
        expiresAt: pastDate,
      });
      
      expect(apiKey.isExpired()).toBe(true);
    });

    it('should not be expired if no expiresAt', () => {
      const apiKey = ApiKeyEntity.create(validData);
      expect(apiKey.isExpired()).toBe(false);
    });
  });

  describe('Business Logic: Auto-Rotation', () => {
    it('should enable auto-rotation', () => {
      const apiKey = ApiKeyEntity.create(validData);
      
      apiKey.enableAutoRotation(30);
      
      const dto = apiKey.toPersistence();
      expect(dto.autoRotate).toBe(true);
      expect(dto.rotationIntervalDays).toBe(30);
    });

    it('should throw if interval < 1', () => {
      const apiKey = ApiKeyEntity.create(validData);
      
      expect(() => apiKey.enableAutoRotation(0)).toThrow('Rotation interval must be at least 1 day');
    });

    it('should disable auto-rotation', () => {
      const apiKey = ApiKeyEntity.create({
        ...validData,
        autoRotate: true,
        rotationIntervalDays: 30,
      });
      
      apiKey.disableAutoRotation();
      
      const dto = apiKey.toPersistence();
      expect(dto.autoRotate).toBe(false);
      expect(dto.rotationIntervalDays).toBeNull();
    });

    it('should check if rotation is due', () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 31); // 31 days ago
      
      const apiKey = ApiKeyEntity.reconstitute({
        ...validData,
        id: 'key-123',
        keyValue: 'ak_live_' + 'a'.repeat(40),
        status: 'active',
        lastUsedAt: new Date(),
        requestCount: 0,
        createdAt: oldDate,
        rotatedAt: oldDate,
        rotationCount: 0,
        autoRotate: true,
        rotationIntervalDays: 30,
        gracePeriodDays: 7,
        ipWhitelist: [],
      });
      
      expect(apiKey.isRotationDue()).toBe(true);
    });

    it('should not be due if recently rotated', () => {
      const apiKey = ApiKeyEntity.create({
        ...validData,
        autoRotate: true,
        rotationIntervalDays: 30,
      });
      
      expect(apiKey.isRotationDue()).toBe(false);
    });
  });

  describe('Business Logic: IP Whitelist', () => {
    it('should allow all IPs if no whitelist', () => {
      const apiKey = ApiKeyEntity.create(validData);
      
      expect(apiKey.isIpAllowed('192.168.1.1')).toBe(true);
      expect(apiKey.isIpAllowed('10.0.0.1')).toBe(true);
    });

    it('should allow whitelisted IP', () => {
      const apiKey = ApiKeyEntity.create({
        ...validData,
        ipWhitelist: ['192.168.1.1'],
      });
      
      expect(apiKey.isIpAllowed('192.168.1.1')).toBe(true);
    });

    it('should reject non-whitelisted IP', () => {
      const apiKey = ApiKeyEntity.create({
        ...validData,
        ipWhitelist: ['192.168.1.1'],
      });
      
      expect(apiKey.isIpAllowed('10.0.0.1')).toBe(false);
    });
  });

  describe('Business Logic: Grace Period', () => {
    it('should be in grace period during rotation', () => {
      const apiKey = ApiKeyEntity.create(validData);
      apiKey.startRotation('new-key');
      
      expect(apiKey.isInGracePeriod()).toBe(true);
    });

    it('should not be in grace period if not rotating', () => {
      const apiKey = ApiKeyEntity.create(validData);
      
      expect(apiKey.isInGracePeriod()).toBe(false);
    });

    it('should not be in grace period after grace expires', () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10); // 10 days ago
      
      const apiKey = ApiKeyEntity.reconstitute({
        ...validData,
        id: 'key-123',
        keyValue: 'ak_live_' + 'a'.repeat(40),
        status: 'rotating',
        lastUsedAt: new Date(),
        requestCount: 0,
        createdAt: new Date(),
        rotatedAt: oldDate,
        rotationCount: 0,
        autoRotate: false,
        gracePeriodDays: 7,
        ipWhitelist: [],
      });
      
      expect(apiKey.isInGracePeriod()).toBe(false);
    });
  });

  describe('Serialization', () => {
    it('should convert to persistence DTO', () => {
      const apiKey = ApiKeyEntity.create(validData);
      const dto = apiKey.toPersistence();
      
      expect(dto.id).toBeDefined();
      expect(dto.name).toBe('Production API Key');
      expect(dto.keyPrefix).toHaveLength(15);
      expect(dto.keyValue).toMatch(/^ak_live_/);
      expect(dto.status).toBe('active');
      expect(dto.requestCount).toBe(0);
    });

    it('should convert to presentation DTO (MASKED)', () => {
      const apiKey = ApiKeyEntity.create(validData);
      const dto = apiKey.toDTO();
      
      expect(dto.id).toBeDefined();
      expect(dto.name).toBe('Production API Key');
      expect(dto.keyPreview).toMatch(/^ak_live_.*\*\*\*.*$/);
      expect(dto.keyPreview).not.toMatch(/^ak_live_[A-Za-z0-9_-]{40,}$/); // Not full key
      expect(dto.status).toBe('active');
      expect(dto.requestCount).toBe(0);
    });
  });
});

