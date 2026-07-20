// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { registerEnterpriseQuotaRoutes } from '@/routes/enterprise/quotas-routes';
import type { QuotaCheckResult, QuotaConfig, QuotaUsage } from '@/types';

const quotaServiceMocks = vi.hoisted(() => ({
  listQuotas: vi.fn<[], Promise<QuotaConfig[]>>().mockResolvedValue([]),
  upsertQuota: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  checkQuota: vi.fn<[], Promise<QuotaCheckResult>>().mockResolvedValue({
    allowed: true,
    remaining: {},
  } as QuotaCheckResult),
  recordQuotaUsage: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  resetQuota: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  getQuotaUsage: vi.fn<[], Promise<QuotaUsage | null>>().mockResolvedValue(null),
}));

vi.mock('@/services/quota-service', () => ({
  listQuotas: quotaServiceMocks.listQuotas,
  upsertQuota: quotaServiceMocks.upsertQuota,
  checkQuota: quotaServiceMocks.checkQuota,
  recordQuotaUsage: quotaServiceMocks.recordQuotaUsage,
  resetQuota: quotaServiceMocks.resetQuota,
  getQuotaUsage: quotaServiceMocks.getQuotaUsage,
}));

vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async () => {},
}));

const applyTenantContext = vi.hoisted(() =>
  vi.fn(async (request: any) => {
    request.tenantContext = {
      organizationId: 'org-tenant',
      userId: 'user-tenant',
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
        requestsPerHour: 5000,
        concurrentRequests: 25,
      },
    };
  }),
);

vi.mock('@/api/middleware/tenant-isolation-middleware', () => ({
  requireTenantContext: () => async (request: any, reply: any) => applyTenantContext(request, reply),
  getTenantContext: (request: any) => {
    if (!request?.tenantContext) {
      throw new Error('Tenant context missing');
    }
    return request.tenantContext;
  },
}));

describe('Enterprise Quota Routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    applyTenantContext.mockImplementation(async (request: any) => {
      request.tenantContext = {
        organizationId: 'org-tenant',
        userId: 'user-tenant',
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
          requestsPerHour: 5000,
          concurrentRequests: 25,
        },
      };
    });
    app = Fastify();
    await registerEnterpriseQuotaRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 403 when tenant context middleware denies request', async () => {
    applyTenantContext.mockImplementation(async (_request: any, reply: any) => {
      reply.status(403).send({ error: { code: 'tenant_context_required' } });
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/enterprise/quotas',
    });

    expect(response.statusCode).toBe(403);
    expect(quotaServiceMocks.listQuotas).not.toHaveBeenCalled();
  });

  it('rejects quota configuration for mismatched organization', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/quotas',
      payload: {
        organizationId: 'other-org',
        limits: {
          period: 'hour',
          maxRequests: 100,
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(quotaServiceMocks.upsertQuota).not.toHaveBeenCalled();
  });

  it('stores quota configuration using tenant organizationId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/quotas',
      payload: {
        limits: {
          period: 'day',
          maxRequests: 1000,
        },
      },
    });

    expect(response.statusCode).toBe(204);
    expect(quotaServiceMocks.upsertQuota).toHaveBeenCalledWith('org-tenant', {
      organizationId: 'org-tenant',
      limits: expect.objectContaining({ period: 'day', maxRequests: 1000 }),
    });
  });
});
