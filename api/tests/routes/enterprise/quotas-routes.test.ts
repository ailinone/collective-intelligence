// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { registerEnterpriseQuotaRoutes } from '@/routes/enterprise/quotas-routes';

// Types for testing
interface TenantContext {
  organizationId: string;
  userId: string;
  tier: string;
  roles: string[];
  features: Record<string, boolean>;
  quotas: {
    requestsPerMinute: number;
    requestsPerHour: number;
    concurrentRequests: number;
  };
}

interface MockRequest extends FastifyRequest {
  user?: {
    userId: string;
    organizationId: string;
  };
  tenantContext?: TenantContext;
}

const quotaServiceMock = vi.hoisted(() => ({
  listQuotas: vi.fn(),
  upsertQuota: vi.fn(),
  checkQuota: vi.fn(),
  recordQuotaUsage: vi.fn(),
  resetQuota: vi.fn(),
  getQuotaUsage: vi.fn(),
}));

let currentTenantContext: TenantContext | null;

vi.mock('@/services/quota-service', () => ({
  listQuotas: quotaServiceMock.listQuotas,
  upsertQuota: quotaServiceMock.upsertQuota,
  checkQuota: quotaServiceMock.checkQuota,
  recordQuotaUsage: quotaServiceMock.recordQuotaUsage,
  resetQuota: quotaServiceMock.resetQuota,
  getQuotaUsage: quotaServiceMock.getQuotaUsage,
}));

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async (request: MockRequest) => {
    if (currentTenantContext) {
      request.user = {
        userId: currentTenantContext.userId,
        organizationId: currentTenantContext.organizationId,
      };
    } else {
      request.user = undefined;
    }
    request.tenantContext = currentTenantContext ?? undefined;
  },
}));

const recordSecurityEventMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: recordSecurityEventMock,
}));

describe('Enterprise Quota Routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    currentTenantContext = {
      organizationId: 'org-123',
      userId: 'user-456',
      tier: 'enterprise',
      roles: ['admin'],
      features: {
        advancedOrchestration: true,
        multiModelExecution: true,
        prioritySupport: true,
        customModels: true,
      },
      quotas: {
        requestsPerMinute: 1000,
        requestsPerHour: 10000,
        concurrentRequests: 25,
      },
    };

    app = Fastify();
    await registerEnterpriseQuotaRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists quotas for the authenticated tenant', async () => {
    const quotas = [
      {
        organizationId: 'org-123',
        limits: {
          period: 'hour' as const,
          maxRequests: 2000,
        },
      },
    ];
    quotaServiceMock.listQuotas.mockResolvedValueOnce(quotas);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/enterprise/quotas',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ quotas });
    expect(quotaServiceMock.listQuotas).toHaveBeenCalledWith('org-123');
  });

  it('rejects quota configuration when payload organization differs from tenant', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/quotas',
      payload: {
        organizationId: 'org-other',
        limits: {
          period: 'day',
          maxRequests: 100,
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'organization_mismatch',
        message: 'Organization in payload does not match authenticated tenant.',
      },
    });
    expect(quotaServiceMock.upsertQuota).not.toHaveBeenCalled();
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'organization_mismatch',
        organizationId: 'org-123',
        userId: 'user-456',
        metadata: expect.objectContaining({
          attemptedOrganizationId: 'org-other',
        }),
      }),
    );
  });

  it('checks quota using tenant context organization', async () => {
    quotaServiceMock.checkQuota.mockResolvedValueOnce({
      allowed: true,
      limit: 1000,
      current: 10,
      remaining: 990,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/quotas/check',
      payload: {
        period: 'minute',
        operation: {
          requests: 5,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      allowed: true,
      limit: 1000,
      current: 10,
      remaining: 990,
    });
    expect(quotaServiceMock.checkQuota).toHaveBeenCalledWith(
      'org-123',
      expect.objectContaining({
        period: 'minute',
      }),
    );
  });

  it('denies access when tenant context is missing', async () => {
    currentTenantContext = undefined;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/enterprise/quotas',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'tenant_context_required',
        message: 'Organization context is required to access this resource.',
      },
    });
  });
});

