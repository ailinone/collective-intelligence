// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  tenantIsolationMiddleware,
  requireTenantContext,
} from '@/api/middleware/tenant-isolation-middleware';
import { prisma } from '@/database/client';
import { getTierConfig, checkQuota } from '@/config/multi-tenancy-config';
import { getUserRoles } from '@/services/rbac-service';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

/**
 * Type for mock FastifyReply
 */
type MockFastifyReply = {
  status: ReturnType<typeof vi.fn<(code: number) => MockFastifyReply>>;
  send: ReturnType<typeof vi.fn<(payload: unknown) => MockFastifyReply>>;
};

/**
 * Type for mock FastifyRequest with tenant context
 */
type MockFastifyRequest = Partial<FastifyRequest> & {
  url?: string;
  method?: string;
  tenantContext?: {
    organizationId: string;
    userId?: string;
  };
};

/**
 * Type for mocked Prisma organization methods
 */
type MockPrismaOrganizationMethods = {
  findUnique: ReturnType<typeof vi.fn<() => Promise<{ tier: string } | null>>>;
};

vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/config/multi-tenancy-config', () => ({
  getTierConfig: vi.fn().mockReturnValue({
    features: {
      advancedOrchestration: false,
      multiModelExecution: false,
      prioritySupport: false,
      customModels: false,
    },
    requestsPerMinute: 60,
    requestsPerHour: 600,
    concurrentRequests: 5,
  }),
  checkQuota: vi.fn().mockResolvedValue({
    allowed: true,
    current: 10,
    limit: 100,
    remaining: 90,
  }),
}));

vi.mock('@/database/client', () => ({
  prisma: {
    organization: {
      findUnique: vi.fn().mockResolvedValue({ tier: 'enterprise' }),
    },
  },
}));

vi.mock('@/services/rbac-service', () => ({
  getUserRoles: vi.fn().mockResolvedValue(['developer']),
}));

const createReply = (): MockFastifyReply => {
  const reply: MockFastifyReply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
};

describe('requireTenantContext middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('denies access when tenant context is missing', async () => {
    const hook = requireTenantContext();
    const request: MockFastifyRequest = { url: '/secure', method: 'GET' };
    const reply = createReply();

    await hook(request, reply);

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'tenant_context_required' }),
      }),
    );
  });

  it('denies access when user identity is required but missing', async () => {
    const hook = requireTenantContext({ requireUser: true });
    const request: MockFastifyRequest = {
      url: '/secure',
      method: 'POST',
      tenantContext: {
        organizationId: 'org-123',
        userId: 'anonymous',
      },
    };
    const reply = createReply();

    await hook(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'user_identity_required' }),
      }),
    );
  });

  it('allows request when tenant context and user are present', async () => {
    const hook = requireTenantContext();
    const request: MockFastifyRequest = {
      url: '/secure',
      method: 'GET',
      tenantContext: {
        organizationId: 'org-123',
        userId: 'user-456',
      },
    };
    const reply = createReply();

    await hook(request, reply);

    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});

describe('tenantIsolationMiddleware', () => {
  const findUniqueMock = prisma.organization.findUnique as MockPrismaOrganizationMethods['findUnique'] & { mockResolvedValue: ReturnType<typeof vi.fn> };
  const getTierConfigMock = getTierConfig as ReturnType<typeof vi.fn> & { mockReturnValue: ReturnType<typeof vi.fn> };
  const checkQuotaMock = checkQuota as ReturnType<typeof vi.fn> & { mockResolvedValue: ReturnType<typeof vi.fn> };
  const getUserRolesMock = getUserRoles as ReturnType<typeof vi.fn> & { mockResolvedValue: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue({ tier: 'enterprise' });
    checkQuotaMock.mockResolvedValue({
      allowed: true,
      current: 10,
      limit: 100,
      remaining: 90,
    });
    getUserRolesMock.mockResolvedValue(['developer']);
    getTierConfigMock.mockReturnValue({
      features: {
        advancedOrchestration: false,
        multiModelExecution: false,
        prioritySupport: false,
        customModels: false,
      },
      requestsPerMinute: 60,
      requestsPerHour: 600,
      concurrentRequests: 5,
    });
  });

  it('returns 401 when organization context is missing', async () => {
    const request: MockFastifyRequest = {
      headers: {},
      url: '/secure',
      method: 'GET',
    };
    const reply = createReply();

    await tenantIsolationMiddleware(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'organization_required' }),
      }),
    );
  });

  it('returns 404 when organization does not exist', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const request: MockFastifyRequest = {
      headers: { 'x-organization-id': 'org-missing' },
      user: { userId: 'user-123', organizationId: 'org-missing' },
      url: '/secure',
      method: 'GET',
    };
    const reply = createReply();

    await tenantIsolationMiddleware(request, reply);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'organization_not_found' }),
      }),
    );
  });

  it('attaches tenant context when organization is present', async () => {
    const request: MockFastifyRequest = {
      headers: { 'x-organization-id': 'org-123', 'x-user-id': 'user-123' },
      url: '/secure',
      method: 'GET',
      user: { userId: 'user-123', organizationId: 'org-123' },
    };
    const reply = createReply();

    await tenantIsolationMiddleware(request, reply);

    expect(reply.status).not.toHaveBeenCalled();
    expect(request.tenantContext).toBeDefined();
    expect(request.tenantContext.organizationId).toBe('org-123');
  });
});


