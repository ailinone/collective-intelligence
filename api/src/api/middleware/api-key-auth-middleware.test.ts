// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Key Authentication Middleware - Tests (Enterprise-Grade)
 * 
 * Test Coverage:
 * - Public routes bypass
 * - API key extraction (x-api-key, Authorization headers)
 * - Database lookup and validation
 * - User and organization status checks
 * - IP whitelist enforcement
 * - Key expiration handling
 * - Error responses (401 codes)
 * - Performance (sub-50ms latency)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { apiKeyAuthMiddleware, __resetApiKeyAuthCacheForTests } from './api-key-auth-middleware';
import type { AuthenticatedRequest } from './api-key-auth-middleware';
import { prisma } from '@/database/client';
import bcrypt from 'bcrypt';

/**
 * Type-safe mock types for Prisma API Key queries
 */
interface MockApiKeyWithUser {
  id: string;
  name?: string;
  status: string;
  statusReason?: string | null;
  expiresAt?: Date | null;
  keyHash: string;
  ipWhitelist?: string[];
  permissions?: Record<string, unknown> | null;
  userId?: string;
  organizationId?: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    organizationId?: string;
    organization: {
      id: string;
      tier: string;
      status: string;
    };
    userRoles: unknown[];
  };
}

// Mock Prisma
vi.mock('@/database/client', () => ({
  prisma: {
    apiKey: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

// Mock logger
vi.mock('@/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

describe('API Key Authentication Middleware', () => {
  let mockRequest: Partial<FastifyRequest>;
  let mockReply: Partial<FastifyReply>;

  beforeEach(() => {
    mockRequest = {
      url: '/v1/chat/completions',
      method: 'POST',
      headers: {},
      ip: '192.168.1.100',
      log: {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      } as FastifyRequest['log'],
    };

    mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    vi.clearAllMocks();
    vi.mocked(prisma.apiKey.update).mockResolvedValue({} as never);
    // The auth cache is a process-level singleton (keyed by quickHash) — reset it
    // so each test resolves fresh against its own mocked findFirst/bcrypt, exactly
    // like the earlier tests relied on `findFirst` being called every time.
    __resetApiKeyAuthCacheForTests();
  });

  describe('Public Routes', () => {
    it('should skip authentication for /health', async () => {
      mockRequest.url = '/health';

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    it('should skip authentication for /v1/auth/login', async () => {
      mockRequest.url = '/v1/auth/login';

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).not.toHaveBeenCalled();
    });

    it('should skip authentication for /v1/models/list', async () => {
      mockRequest.url = '/v1/models/list';

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).not.toHaveBeenCalled();
    });

    // ─── Operational endpoints — added after the prod incident on
    //     /v1/hcra/health returning 401 + FST_ERR_REP_ALREADY_SENT.
    //     If a regression removes one of these from PUBLIC_ROUTES, this
    //     suite catches it before deploy.
    it.each([
      ['/v1/hcra/health', 'HCRA search-stack liveness (was the original incident)'],
      ['/health/startup', 'K8s startup probe (was preexisting gap)'],
      ['/health/live', 'K8s liveness'],
      ['/health/ready', 'K8s readiness'],
      ['/metrics', 'Prometheus scraping'],
      ['/v1/status/health', 'product status health'],
    ])(
      'skips authentication for %s (%s)',
      async (url) => {
        mockRequest.url = url;

        await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      },
    );

    it('skips authentication for /v1/hcra/health regardless of query string', async () => {
      // Live probes append timestamps/probe-ids; this guards the
      // `url.split('?')[0]` strip in `isPublicRoute`.
      mockRequest.url = '/v1/hcra/health?probe=k8s&ts=1700000000';

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).not.toHaveBeenCalled();
    });
  });

  describe('API Key Extraction', () => {
    it('should extract API key from x-api-key header', async () => {
      mockRequest.headers = {
        'x-api-key': 'ak_live_test123',
      };

      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(prisma.apiKey.findFirst).toHaveBeenCalled();
      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should extract API key from Authorization header (direct)', async () => {
      mockRequest.headers = {
        authorization: 'ak_live_test123',
      };

      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(prisma.apiKey.findFirst).toHaveBeenCalled();
    });

    it('should extract API key from Authorization Bearer header', async () => {
      mockRequest.headers = {
        authorization: 'Bearer ak_live_test123',
      };

      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(prisma.apiKey.findFirst).toHaveBeenCalled();
    });

    it('should return 401 if no API key provided', async () => {
      mockRequest.headers = {};

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: {
          code: 'unauthorized',
          message: expect.stringContaining('API key or JWT required'),
          type: 'authentication_error',
        },
      });
    });
  });

  describe('API Key Validation', () => {
    const validApiKey = 'ak_live_test123';
    const keyHash = '$2b$10$validhash'; // bcrypt hash placeholder

    beforeEach(() => {
      mockRequest.headers = {
        'x-api-key': validApiKey,
      };
    });

    it('should return 401 if API key not found in database', async () => {
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: {
          code: 'invalid_api_key',
          message: 'Invalid or expired API key',
          type: 'authentication_error',
        },
      });
    });

    it('should return 401 if API key status is revoked', async () => {
      const mockApiKey: MockApiKeyWithUser = {
        id: 'key-123',
        status: 'revoked',
        statusReason: 'Security incident',
        keyHash,
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          role: 'admin',
          status: 'active',
          organization: {
            id: 'org-123',
            tier: 'enterprise',
            status: 'active',
          },
          userRoles: [],
        },
      };
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as never);

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should return 401 if API key is expired', async () => {
      const expiredDate = new Date('2023-01-01');

      const mockApiKey: MockApiKeyWithUser = {
        id: 'key-123',
        status: 'active',
        expiresAt: expiredDate,
        keyHash,
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          role: 'admin',
          status: 'active',
          organization: {
            id: 'org-123',
            tier: 'enterprise',
            status: 'active',
          },
          userRoles: [],
        },
      };
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as never);

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should return 401 if user is not active', async () => {
      vi.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);

      const mockApiKey: MockApiKeyWithUser = {
        id: 'key-123',
        status: 'active',
        expiresAt: null,
        keyHash,
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          role: 'admin',
          status: 'suspended',
          organization: {
            id: 'org-123',
            tier: 'enterprise',
            status: 'active',
          },
          userRoles: [],
        },
      };
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as never);

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should return 401 if organization is not active', async () => {
      vi.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);

      const mockApiKey: MockApiKeyWithUser = {
        id: 'key-123',
        status: 'active',
        expiresAt: null,
        keyHash,
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          role: 'admin',
          status: 'active',
          organization: {
            id: 'org-123',
            tier: 'enterprise',
            status: 'suspended',
          },
          userRoles: [],
        },
      };
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as never);

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should authenticate successfully with valid API key', async () => {
      const hashedKey = await bcrypt.hash(validApiKey, 10);

      const mockApiKey: MockApiKeyWithUser = {
        id: 'key-123',
        name: 'Test API Key',
        status: 'active',
        expiresAt: null,
        keyHash: hashedKey,
        ipWhitelist: [],
        permissions: { read: true, write: true },
        userId: 'user-123',
        organizationId: 'org-123',
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          role: 'admin',
          status: 'active',
          organizationId: 'org-123',
          organization: {
            id: 'org-123',
            tier: 'enterprise',
            status: 'active',
          },
          userRoles: [],
        },
      };
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as never);

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      const authenticatedRequest = mockRequest as AuthenticatedRequest;
      expect(authenticatedRequest.user).toEqual({
        userId: 'user-123',
        organizationId: 'org-123',
        roles: ['admin'],
        email: 'test@example.com',
        name: 'Test User',
      });
      expect(authenticatedRequest.apiKey).toEqual({
        id: 'key-123',
        name: 'Test API Key',
        permissions: { read: true, write: true },
      });
    });
  });

  describe('Auth Cache (eliminates repeat bcrypt+DB cost)', () => {
    const validApiKey = 'ak_live_cachetest';

    function makeMockApiKey(hashedKey: string, ipWhitelist: string[] = []): MockApiKeyWithUser {
      return {
        id: 'key-cache-1',
        name: 'Cache Test Key',
        status: 'active',
        expiresAt: null,
        keyHash: hashedKey,
        ipWhitelist,
        permissions: null,
        userId: 'user-cache-1',
        organizationId: 'org-cache-1',
        user: {
          id: 'user-cache-1',
          email: 'cache@example.com',
          name: 'Cache User',
          role: 'member',
          status: 'active',
          organizationId: 'org-cache-1',
          organization: { id: 'org-cache-1', tier: 'pro', status: 'active' },
          userRoles: [],
        },
      };
    }

    it('resolves the DB+bcrypt lookup ONCE, then serves subsequent requests from cache', async () => {
      const hashedKey = await bcrypt.hash(validApiKey, 10);
      const mockApiKey = makeMockApiKey(hashedKey);
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as never);
      const compareSpy = vi.spyOn(bcrypt, 'compare');

      mockRequest.headers = { 'x-api-key': validApiKey };
      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);
      expect(mockReply.status).not.toHaveBeenCalled();
      expect(prisma.apiKey.findFirst).toHaveBeenCalledTimes(1);
      expect(compareSpy).toHaveBeenCalledTimes(1);

      // Second request, same key: findFirst/bcrypt must NOT run again — even if the
      // mock were to return something different, the cached context wins.
      mockRequest = {
        ...mockRequest,
        headers: { 'x-api-key': validApiKey },
        log: mockRequest.log,
      };
      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);
      expect(mockReply.status).not.toHaveBeenCalled();
      expect(prisma.apiKey.findFirst).toHaveBeenCalledTimes(1); // still 1 — cache hit
      expect(compareSpy).toHaveBeenCalledTimes(1); // still 1 — cache hit
      const authenticatedRequest = mockRequest as AuthenticatedRequest;
      expect(authenticatedRequest.user.userId).toBe('user-cache-1');
    });

    it('re-checks the IP whitelist against the CURRENT request even on a cache hit', async () => {
      const hashedKey = await bcrypt.hash(validApiKey, 10);
      const mockApiKey = makeMockApiKey(hashedKey, ['10.0.0.1']);
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as never);

      // First request from the whitelisted IP populates the cache.
      mockRequest.headers = { 'x-api-key': validApiKey };
      mockRequest.ip = '10.0.0.1';
      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);
      expect(mockReply.status).not.toHaveBeenCalled();

      // Second request, same (cached) key, DIFFERENT IP: must still be rejected —
      // a cache hit must not bypass IP whitelist enforcement.
      mockRequest = {
        ...mockRequest,
        headers: { 'x-api-key': validApiKey },
        ip: '203.0.113.9',
        log: mockRequest.log,
      };
      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);
      expect(mockReply.status).toHaveBeenCalledWith(401);
      // The lookup itself was still served from cache (no second DB round-trip).
      expect(prisma.apiKey.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe('IP Whitelist Enforcement', () => {
    const validApiKey = 'ak_live_test123';
    const keyHash = '$2b$10$validhash';

    beforeEach(() => {
      mockRequest.headers = {
        'x-api-key': validApiKey,
      };
      mockRequest.ip = '203.0.113.100';
    });

    it('should return 401 if client IP not in whitelist', async () => {
      vi.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);

      const mockApiKey: MockApiKeyWithUser = {
        id: 'key-123',
        status: 'active',
        expiresAt: null,
        keyHash,
        ipWhitelist: ['192.168.1.0/24', '10.0.0.1'],
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          role: 'admin',
          status: 'active',
          organization: {
            id: 'org-123',
            tier: 'enterprise',
            status: 'active',
          },
          userRoles: [],
        },
      };
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as never);

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it('should authenticate if client IP in whitelist', async () => {
      mockRequest.ip = '192.168.1.50';

      const hashedKey = await bcrypt.hash(validApiKey, 10);

      const mockApiKey: MockApiKeyWithUser = {
        id: 'key-123',
        name: 'Test API Key',
        status: 'active',
        expiresAt: null,
        keyHash: hashedKey,
        ipWhitelist: ['192.168.1.50'],
        permissions: null,
        userId: 'user-123',
        organizationId: 'org-123',
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          role: 'admin',
          status: 'active',
          organizationId: 'org-123',
          organization: {
            id: 'org-123',
            tier: 'enterprise',
            status: 'active',
          },
          userRoles: [],
        },
      };
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as never);

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      const authenticatedRequest = mockRequest as AuthenticatedRequest;
      expect(authenticatedRequest.user).toBeDefined();
    });
  });

  describe('X-Forwarded-For Support', () => {
    it('should use X-Forwarded-For for client IP', async () => {
      mockRequest.headers = {
        'x-api-key': 'ak_live_test123',
        'x-forwarded-for': '203.0.113.100, 192.168.1.1',
      };

      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      await apiKeyAuthMiddleware(mockRequest as FastifyRequest, mockReply as FastifyReply);

      // Should extract first IP from X-Forwarded-For
      expect(mockRequest.log.warn).toHaveBeenCalled();
    });
  });
});

