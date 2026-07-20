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
import { registerEnterpriseUsageAnalyticsRoutes } from '../../src/routes/enterprise/usage-analytics-routes.js';
import type { UsageMetrics } from '../../src/types/index.js';

const { recordUsageEventsMock, getUsageMetricsMock } = vi.hoisted(() => ({
  recordUsageEventsMock: vi.fn(),
  getUsageMetricsMock: vi.fn(),
}));

vi.mock('@/services/usage-analytics-service', () => ({
  recordUsageEvents: recordUsageEventsMock,
  getUsageMetrics: getUsageMetricsMock,
}));

const applyTenantContext = vi.fn();
const recordSecurityEventMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: recordSecurityEventMock,
}));

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async () => {},
}));

vi.mock('@/api/middleware/tenant-isolation-middleware', () => ({
  requireTenantContext:
    () =>
    async (request: any, reply: any): Promise<void> =>
      applyTenantContext(request, reply),
  getTenantContext: (request: any) => request.tenantContext,
}));

describe('Enterprise Usage Analytics Routes', () => {
  let app: ReturnType<typeof Fastify>;

  const buildApp = async () => {
    const instance = Fastify();
    await registerEnterpriseUsageAnalyticsRoutes(instance);
    await instance.ready();
    return instance;
  };

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
          requestsPerHour: 10000,
          concurrentRequests: 50,
        },
      };
    });
    recordUsageEventsMock.mockResolvedValue(undefined);
    getUsageMetricsMock.mockResolvedValue({
      totalEvents: 0,
      eventsByType: {},
      eventsByUser: {},
      eventsByTeam: {},
      timeRange: {
        start: Date.now(),
        end: Date.now(),
      },
    } satisfies UsageMetrics);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 403 when tenant context middleware denies request', async () => {
    applyTenantContext.mockImplementation(async (_request: any, reply: any) => {
      reply.status(403).send({
        error: { code: 'tenant_context_required' },
      });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/usage/events',
      payload: { events: [{ eventType: 'test' }] },
    });

    expect(response.statusCode).toBe(403);
    expect(recordUsageEventsMock).not.toHaveBeenCalled();
  });

  it('rejects events whose organizationId differs from tenant context', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/usage/events',
      payload: {
        events: [
          {
            eventType: 'diff',
            organizationId: 'other-org',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(recordUsageEventsMock).not.toHaveBeenCalled();
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'organization_mismatch',
        organizationId: 'org-tenant',
        userId: 'user-tenant',
        metadata: expect.objectContaining({
          attemptedOrganizationId: 'other-org',
        }),
      }),
    );
  });

  it('records events with tenant organizationId enforced', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/usage/events',
      payload: {
        events: [
          {
            eventType: 'tool_used',
            metadata: { tool: 'git' },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(204);
    expect(recordUsageEventsMock).toHaveBeenCalledWith({
      organizationId: 'org-tenant',
      events: [
        expect.objectContaining({
          organizationId: 'org-tenant',
          eventType: 'tool_used',
        }),
      ],
    });
  });

  it('forces organizationId for metrics queries', async () => {
    getUsageMetricsMock.mockResolvedValue({
      totalEvents: 5,
      eventsByType: { build: 5 },
      eventsByUser: { 'user-tenant': 5 },
      eventsByTeam: {},
      timeRange: {
        start: Date.now() - 1000,
        end: Date.now(),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/enterprise/usage/metrics?organizationId=external',
    });

    expect(response.statusCode).toBe(200);
    expect(getUsageMetricsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-tenant',
      }),
    );
  });
});


