// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Key Rotation Service - Unit Tests
 * 
 * Tests for crypto, hashing, validation, rotation, and maintenance
 */

import crypto from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as apiKeyRotationService from '../../../src/services/api-key-rotation';
import { prisma } from '../../../src/database/client';

// Type definitions for mock data
interface MockUser {
  id: string;
  email: string;
  name: string;
  status: string;
}

interface MockOrganization {
  id: string;
  name: string;
  tier: string;
  status: string;
}

interface MockApiKey {
  id: string;
  keyHash?: string;
  quickHash?: string;
  status: string;
  expiresAt?: Date | null;
  userId: string;
  organizationId: string;
  name?: string;
  autoRotate?: boolean;
  rotationIntervalDays?: number;
  gracePeriodDays?: number;
  rotationCount?: number;
  ipWhitelist?: string[];
  permissions?: unknown;
  user?: MockUser;
  organization?: MockOrganization;
  previousKeyId?: string;
  nextKeyId?: string;
  keyPrefix?: string;
  createdAt?: Date;
  rotatedAt?: Date | null;
  revokedAt?: Date | null;
}

interface MockRotationLog {
  id?: string;
  [key: string]: unknown;
}

// Mock Prisma
vi.mock('../../../src/database/client', () => ({
  prisma: {
    apiKey: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    apiKeyRotationLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn((callback) => callback(prisma)),
  },
}));

const emailServiceMock = vi.hoisted(() => ({
  send: vi.fn(),
}));

const fetchMock = vi.hoisted(() => vi.fn());

const notificationsConfig = vi.hoisted(() => ({
  emailEnabled: true,
  includePlainKeyInEmail: false,
  webhookEnabled: false,
  webhookUrl: undefined as string | undefined,
  webhookSecret: undefined as string | undefined,
  includePlainKeyInWebhook: false,
  webhookTimeoutMs: 5000,
}));

interface MockConfig {
  notifications: {
    apiKeys: typeof notificationsConfig;
  };
}

const configMock = vi.hoisted(() => ({} as MockConfig));

vi.mock('@/services/email-service', () => ({
  getEmailService: () => emailServiceMock,
}));

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  const cloned = structuredClone(actual.config);

  Object.assign(configMock, cloned);
  configMock.notifications = {
    ...cloned.notifications,
    apiKeys: notificationsConfig,
  };

  return {
    ...actual,
    config: configMock,
    isDevelopment: actual.isDevelopment,
  };
});

// Mock logger
vi.mock('../../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

describe('API Key Rotation Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emailServiceMock.send.mockReset();
    emailServiceMock.send.mockResolvedValue(undefined);
    Object.assign(notificationsConfig, {
      emailEnabled: true,
      includePlainKeyInEmail: false,
      webhookEnabled: false,
      webhookUrl: undefined,
      webhookSecret: undefined,
      includePlainKeyInWebhook: false,
      webhookTimeoutMs: 5000,
    });
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  apiKeyRotationService.resetApiKeyGenerator();
  });

  // ==========================================
  // Key Generation Tests
  // ==========================================

  describe('generateApiKey', () => {
    it('should generate a valid API key with correct prefix', () => {
      const key = apiKeyRotationService.generateApiKey();
      
      expect(key).toBeDefined();
      expect(typeof key).toBe('string');
      expect(key.startsWith('ak_')).toBe(true);
      expect(key.length).toBeGreaterThan(40); // Prefix + 32 bytes base64url
    });

    it('should generate unique keys', () => {
      const key1 = apiKeyRotationService.generateApiKey();
      const key2 = apiKeyRotationService.generateApiKey();
      
      expect(key1).not.toBe(key2);
    });

    it('should generate cryptographically secure keys', () => {
      // Generate multiple keys and check they're all different
      const keys = new Set();
      for (let i = 0; i < 100; i++) {
        keys.add(apiKeyRotationService.generateApiKey());
      }
      
      expect(keys.size).toBe(100); // All unique
    });
  });

  // ==========================================
  // Hashing Tests
  // ==========================================

  describe('hashApiKey', () => {
    it('should hash an API key', async () => {
      const key = 'ak_test123456789';
      const hash = await apiKeyRotationService.hashApiKey(key);
      
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash).not.toBe(key); // Hash is different from original
      expect(hash.length).toBeGreaterThan(50); // bcrypt hash length
    });

    it('should generate different hashes for same key (bcrypt salt)', async () => {
      const key = 'ak_test123456789';
      const hash1 = await apiKeyRotationService.hashApiKey(key);
      const hash2 = await apiKeyRotationService.hashApiKey(key);
      
      // Different due to random salt, but both valid
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('quickHash', () => {
    it('should generate SHA-256 hash', () => {
      const key = 'ak_test123456789';
      const hash = apiKeyRotationService.quickHash(key);
      
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64); // SHA-256 hex length
    });

    it('should generate consistent hash for same input', () => {
      const key = 'ak_test123456789';
      const hash1 = apiKeyRotationService.quickHash(key);
      const hash2 = apiKeyRotationService.quickHash(key);
      
      expect(hash1).toBe(hash2); // Deterministic
    });

    it('should generate different hashes for different inputs', () => {
      const key1 = 'ak_test123456789';
      const key2 = 'ak_test987654321';
      const hash1 = apiKeyRotationService.quickHash(key1);
      const hash2 = apiKeyRotationService.quickHash(key2);
      
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('getKeyPrefix', () => {
    it('should extract key prefix', () => {
      const key = 'ak_abcd1234test';
      const prefix = apiKeyRotationService.getKeyPrefix(key);
      
      expect(prefix).toBe('ak_abcd1234');
    });

    it('should throw error for invalid key format', () => {
      const invalidKey = 'invalid_key';
      
      expect(() => apiKeyRotationService.getKeyPrefix(invalidKey)).toThrow();
    });
  });

  // ==========================================
  // Validation Tests
  // ==========================================

  describe('validateApiKey', () => {
    it('should validate active API key', async () => {
      const plainKey = 'ak_test123456789';
      const hashedKey = await apiKeyRotationService.hashApiKey(plainKey);
      const quickHashValue = apiKeyRotationService.quickHash(plainKey);
      
      const mockApiKey = {
        id: 'key-123',
        keyHash: hashedKey,
        quickHash: quickHashValue,
        status: 'active',
        expiresAt: null,
        userId: 'user-123',
        organizationId: 'org-123',
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          status: 'active',
        },
        organization: {
          id: 'org-123',
          name: 'Test Org',
          tier: 'pro',
          status: 'active',
        },
      };
      
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as MockApiKey);
      vi.mocked(prisma.apiKey.update).mockResolvedValue(mockApiKey as MockApiKey);
      
      const result = await apiKeyRotationService.validateApiKey(plainKey);
      
      expect(result.isValid).toBe(true);
      expect(result.apiKey).toBeDefined();
      expect(result.apiKey?.id).toBe('key-123');
    });

    it('should reject expired API key', async () => {
      const plainKey = 'ak_test123456789';
      const quickHashValue = apiKeyRotationService.quickHash(plainKey);
      
      // Mock: No key found (expired or doesn't exist)
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);
      
      const result = await apiKeyRotationService.validateApiKey(plainKey);
      
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('should reject key with inactive user', async () => {
      const plainKey = 'ak_test123456789';
      const hashedKey = await apiKeyRotationService.hashApiKey(plainKey);
      const quickHashValue = apiKeyRotationService.quickHash(plainKey);
      
      const mockApiKey = {
        id: 'key-123',
        keyHash: hashedKey,
        quickHash: quickHashValue,
        status: 'active',
        expiresAt: null,
        userId: 'user-123',
        organizationId: 'org-123',
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          status: 'inactive', // INACTIVE
        },
        organization: {
          id: 'org-123',
          name: 'Test Org',
          tier: 'pro',
          status: 'active',
        },
      };
      
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as MockApiKey);
      
      const result = await apiKeyRotationService.validateApiKey(plainKey, false);
      
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('inactive');
    });

    it('should update usage statistics when updateUsageStats=true', async () => {
      const plainKey = 'ak_test123456789';
      const hashedKey = await apiKeyRotationService.hashApiKey(plainKey);
      const quickHashValue = apiKeyRotationService.quickHash(plainKey);
      
      const mockApiKey = {
        id: 'key-123',
        keyHash: hashedKey,
        quickHash: quickHashValue,
        status: 'active',
        expiresAt: null,
        userId: 'user-123',
        organizationId: 'org-123',
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          status: 'active',
        },
        organization: {
          id: 'org-123',
          name: 'Test Org',
          tier: 'pro',
          status: 'active',
        },
      };
      
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as MockApiKey);
      vi.mocked(prisma.apiKey.update).mockResolvedValue(mockApiKey as MockApiKey);
      
      await apiKeyRotationService.validateApiKey(plainKey, true);
      
      expect(prisma.apiKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'key-123' },
          data: expect.objectContaining({
            requestCount: { increment: 1 },
          }),
        })
      );
    });
  });

  // ==========================================
  // Creation Tests
  // ==========================================

  describe('createApiKey', () => {
    it('should create API key with auto-rotation enabled', async () => {
      const mockCreatedKey = {
        id: 'key-new',
        userId: 'user-123',
        organizationId: 'org-123',
        name: 'Test Key',
        autoRotate: true,
        rotationIntervalDays: 90,
        gracePeriodDays: 7,
      };
      
      vi.mocked(prisma.apiKey.create).mockResolvedValue(mockCreatedKey as MockApiKey);
      vi.mocked(prisma.apiKeyRotationLog.create).mockResolvedValue({} as MockApiKey | MockRotationLog);
      
      const result = await apiKeyRotationService.createApiKey({
        userId: 'user-123',
        organizationId: 'org-123',
        name: 'Test Key',
        autoRotate: true,
        rotationIntervalDays: 90,
      });
      
      expect(result.apiKey).toBeDefined();
      expect(result.plainKey).toBeDefined();
      expect(result.plainKey.startsWith('ak_')).toBe(true);
      expect(prisma.apiKeyRotationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'created',
          }),
        })
      );
    });
  });

  // ==========================================
  // Rotation Tests
  // ==========================================

  describe('rotateApiKey', () => {
    it('should rotate API key with grace period', async () => {
      const mockOldKey = {
        id: 'key-old',
        userId: 'user-123',
        organizationId: 'org-123',
        name: 'Test Key',
        status: 'active',
        autoRotate: true,
        rotationIntervalDays: 90,
        gracePeriodDays: 7,
        rotationCount: 0,
        ipWhitelist: [],
        permissions: null,
        user: {
          email: 'test@example.com',
        },
        organization: {
          name: 'Test Org',
        },
      };
      
      const mockNewKey = {
        id: 'key-new',
        userId: 'user-123',
        organizationId: 'org-123',
        name: 'Test Key',
        status: 'active',
        rotationCount: 1,
        previousKeyId: 'key-old',
      };
      
      const mockUpdatedOldKey = {
        ...mockOldKey,
        status: 'rotating',
        nextKeyId: 'key-new',
      };
      
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldKey as MockApiKey);
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        vi.mocked(prisma.apiKey.create).mockResolvedValue(mockNewKey as MockApiKey);
        vi.mocked(prisma.apiKey.update).mockResolvedValue(mockUpdatedOldKey as MockApiKey);
        vi.mocked(prisma.apiKeyRotationLog.create).mockResolvedValue({} as MockApiKey | MockRotationLog);
        return callback(prisma);
      });
      
      const result = await apiKeyRotationService.rotateApiKey({
        keyId: 'key-old',
        gracePeriodDays: 7,
        reason: 'Manual rotation',
      });
      
      expect(result.oldKey).toBeDefined();
      expect(result.newKey).toBeDefined();
      expect(result.plainKey).toBeDefined();
      expect(result.oldKey.status).toBe('rotating');
      expect(result.newKey.previousKeyId).toBe('key-old');
      expect(emailServiceMock.send).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should throw error if key is not active', async () => {
      const mockKey = {
        id: 'key-123',
        status: 'revoked', // NOT ACTIVE
      };
      
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockKey as MockApiKey);
      
      await expect(
        apiKeyRotationService.rotateApiKey({
          keyId: 'key-123',
        })
      ).rejects.toThrow('Cannot rotate');
    });
  });

  // ==========================================
  // Revocation Tests
  // ==========================================

  describe('revokeApiKey', () => {
    it('should revoke API key immediately', async () => {
      const mockRevokedKey = {
        id: 'key-123',
        status: 'revoked',
        revokedAt: new Date(),
      };
      
      vi.mocked(prisma.apiKey.update).mockResolvedValue(mockRevokedKey as MockApiKey);
      vi.mocked(prisma.apiKeyRotationLog.create).mockResolvedValue({} as MockApiKey | MockRotationLog);
      
      await apiKeyRotationService.revokeApiKey('key-123', 'Security incident');
      
      expect(prisma.apiKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'key-123' },
          data: expect.objectContaining({
            status: 'revoked',
          }),
        })
      );
      
      expect(prisma.apiKeyRotationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'revoked',
            reason: 'Security incident',
          }),
        })
      );
    });
  });

  // ==========================================
  // Maintenance Tests
  // ==========================================

  describe('revokeExpiredKeys', () => {
    it('should revoke keys past grace period', async () => {
      const expiredDate = new Date();
      expiredDate.setDate(expiredDate.getDate() - 1); // Yesterday
      
      const mockExpiredKeys = [
        { id: 'key-expired-1', status: 'rotating', expiresAt: expiredDate },
        { id: 'key-expired-2', status: 'rotating', expiresAt: expiredDate },
      ];
      
      vi.mocked(prisma.apiKey.findMany).mockResolvedValue(mockExpiredKeys as MockApiKey[]);
      vi.mocked(prisma.apiKey.update).mockResolvedValue({} as MockApiKey | MockRotationLog);
      vi.mocked(prisma.apiKeyRotationLog.create).mockResolvedValue({} as MockApiKey | MockRotationLog);
      
      const count = await apiKeyRotationService.revokeExpiredKeys();
      
      expect(count).toBe(2);
      expect(prisma.apiKey.update).toHaveBeenCalledTimes(2);
      expect(prisma.apiKeyRotationLog.create).toHaveBeenCalledTimes(2);
    });

    it('should return 0 if no expired keys', async () => {
      vi.mocked(prisma.apiKey.findMany).mockResolvedValue([]);
      
      const count = await apiKeyRotationService.revokeExpiredKeys();
      
      expect(count).toBe(0);
      expect(prisma.apiKey.update).not.toHaveBeenCalled();
    });
  });

  describe('checkAutoRotation', () => {
    it('should trigger rotation for keys past interval', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 91); // 91 days ago
      
      const mockKeysNeedingRotation = [
        {
          id: 'key-auto-1',
          autoRotate: true,
          rotationIntervalDays: 90,
          gracePeriodDays: 7,
          status: 'active',
          createdAt: oldDate,
          rotatedAt: null,
        },
      ];
      
      vi.mocked(prisma.apiKey.findMany).mockResolvedValue(mockKeysNeedingRotation as MockApiKey[]);
      
      // Mock rotation
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue({
        ...mockKeysNeedingRotation[0],
        userId: 'user-123',
        organizationId: 'org-123',
        name: 'Auto Key',
        rotationCount: 0,
        ipWhitelist: [],
        permissions: null,
        user: { email: 'test@example.com' },
        organization: { name: 'Test Org' },
      } as MockApiKey | MockRotationLog);
      
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        vi.mocked(prisma.apiKey.create).mockResolvedValue({ id: 'key-new' } as MockApiKey | MockRotationLog);
        vi.mocked(prisma.apiKey.update).mockResolvedValue({} as MockApiKey | MockRotationLog);
        vi.mocked(prisma.apiKeyRotationLog.create).mockResolvedValue({} as MockApiKey | MockRotationLog);
        return callback(prisma);
      });
      
      const count = await apiKeyRotationService.checkAutoRotation();
      
      expect(count).toBe(1);
    });

    it('should return 0 if no keys need rotation', async () => {
      vi.mocked(prisma.apiKey.findMany).mockResolvedValue([]);
      
      const count = await apiKeyRotationService.checkAutoRotation();
      
      expect(count).toBe(0);
    });
  });

  describe('notifications', () => {
    it('should send rotation email without plain key by default', async () => {
      const mockOldKey = {
        id: 'key-old',
        userId: 'user-123',
        organizationId: 'org-123',
        name: 'Test Key',
        status: 'active',
        autoRotate: false,
        rotationIntervalDays: 90,
        gracePeriodDays: 7,
        rotationCount: 0,
        ipWhitelist: [],
        permissions: null,
        keyPrefix: 'ak_old',
        user: {
          email: 'user@example.com',
          name: 'Test User',
        },
        organization: {
          name: 'Test Org',
        },
      };

      const mockNewKey = {
        id: 'key-new',
        userId: 'user-123',
        organizationId: 'org-123',
        name: 'Test Key',
        status: 'active',
        rotationCount: 1,
        previousKeyId: 'key-old',
        keyPrefix: 'ak_new',
      };

      const mockUpdatedOldKey = {
        ...mockOldKey,
        status: 'rotating',
        nextKeyId: 'key-new',
      };

      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldKey as MockApiKey);
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        vi.mocked(prisma.apiKey.create).mockResolvedValue(mockNewKey as MockApiKey);
        vi.mocked(prisma.apiKey.update).mockResolvedValue(mockUpdatedOldKey as MockApiKey);
        vi.mocked(prisma.apiKeyRotationLog.create).mockResolvedValue({} as MockApiKey | MockRotationLog);
        return callback(prisma);
      });

      const newKeyValue = 'ak_TEST_KEY_123456';
      apiKeyRotationService.setApiKeyGenerator(() => newKeyValue);

      await apiKeyRotationService.rotateApiKey({ keyId: 'key-old' });

      expect(emailServiceMock.send).toHaveBeenCalledTimes(1);
      const emailPayload = emailServiceMock.send.mock.calls[0][0];
      expect(emailPayload.to).toBe('user@example.com');
      expect(emailPayload.text).not.toContain(newKeyValue);
      expect(emailPayload.html).not.toContain(newKeyValue);
    });

    it('should include plain key in email when configured', async () => {
      notificationsConfig.includePlainKeyInEmail = true;

      const mockOldKey = {
        id: 'key-old',
        userId: 'user-123',
        organizationId: 'org-123',
        name: 'Test Key',
        status: 'active',
        rotationCount: 0,
        autoRotate: false,
        rotationIntervalDays: 90,
        gracePeriodDays: 7,
        ipWhitelist: [],
        permissions: null,
        keyPrefix: 'ak_old',
        user: {
          email: 'user@example.com',
          name: 'Test User',
        },
        organization: {
          name: 'Test Org',
        },
      };

      const mockNewKey = {
        id: 'key-new',
        userId: 'user-123',
        organizationId: 'org-123',
        name: 'Test Key',
        status: 'active',
        rotationCount: 1,
        previousKeyId: 'key-old',
        keyPrefix: 'ak_new',
      };

      const mockUpdatedOldKey = {
        ...mockOldKey,
        status: 'rotating',
        nextKeyId: 'key-new',
      };

      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldKey as MockApiKey);
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        vi.mocked(prisma.apiKey.create).mockResolvedValue(mockNewKey as MockApiKey);
        vi.mocked(prisma.apiKey.update).mockResolvedValue(mockUpdatedOldKey as MockApiKey);
        vi.mocked(prisma.apiKeyRotationLog.create).mockResolvedValue({} as MockApiKey | MockRotationLog);
        return callback(prisma);
      });

      const newKeyValue = 'ak_TEST_KEY_WITH_EMAIL';
      apiKeyRotationService.setApiKeyGenerator(() => newKeyValue);

      await apiKeyRotationService.rotateApiKey({ keyId: 'key-old' });

      const emailPayload = emailServiceMock.send.mock.calls[0][0];
      expect(emailPayload.text).toContain(newKeyValue);
      expect(emailPayload.html).toContain(newKeyValue);
    });

    it('should deliver webhook when enabled', async () => {
      notificationsConfig.emailEnabled = false;
      notificationsConfig.webhookEnabled = true;
      notificationsConfig.webhookUrl = 'https://hooks.example.com/api-key-rotation';
      notificationsConfig.webhookSecret = 'super-secret';
      notificationsConfig.includePlainKeyInWebhook = true;

      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const mockOldKey = {
        id: 'key-old',
        userId: 'user-123',
        organizationId: 'org-123',
        name: 'Test Key',
        status: 'active',
        rotationCount: 0,
        autoRotate: false,
        rotationIntervalDays: 90,
        gracePeriodDays: 7,
        ipWhitelist: [],
        permissions: null,
        keyPrefix: 'ak_old',
        user: {
          email: 'user@example.com',
          name: 'Test User',
        },
        organization: {
          name: 'Test Org',
        },
      };

      const mockNewKey = {
        id: 'key-new',
        userId: 'user-123',
        organizationId: 'org-123',
        name: 'Test Key',
        status: 'active',
        rotationCount: 1,
        previousKeyId: 'key-old',
        keyPrefix: 'ak_new',
      };

      const mockUpdatedOldKey = {
        ...mockOldKey,
        status: 'rotating',
        nextKeyId: 'key-new',
      };

      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockOldKey as MockApiKey);
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        vi.mocked(prisma.apiKey.create).mockResolvedValue(mockNewKey as MockApiKey);
        vi.mocked(prisma.apiKey.update).mockResolvedValue(mockUpdatedOldKey as MockApiKey);
        vi.mocked(prisma.apiKeyRotationLog.create).mockResolvedValue({} as MockApiKey | MockRotationLog);
        return callback(prisma);
      });

      const newKeyValue = 'ak_TEST_KEY_FOR_WEBHOOK';
      apiKeyRotationService.setApiKeyGenerator(() => newKeyValue);

      await apiKeyRotationService.rotateApiKey({ keyId: 'key-old', reason: 'Policy rotation' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://hooks.example.com/api-key-rotation');
      const payload = JSON.parse(options.body);
      expect(payload.event).toBe('api_key.rotated');
      expect(payload.data.plainKey).toBe(newKeyValue);
      expect(payload.data.reason).toBe('Policy rotation');
      const signature = options.headers['X-Ailin-Signature'];
      const expectedSignature = crypto.createHmac('sha256', 'super-secret').update(options.body).digest('hex');
      expect(signature).toBe(expectedSignature);
    });
  });
});

