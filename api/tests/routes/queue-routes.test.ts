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
import type { FastifyRequest } from 'fastify';

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

let registerQueueRoutes: typeof import('@/routes/queue/queue-routes').registerQueueRoutes;

const queueResultServiceMock = vi.hoisted(() => ({
  get: vi.fn(),
  delete: vi.fn(),
}));

const recordSecurityEventMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/request-queue-result-service', () => ({
  queueResultService: queueResultServiceMock,
}));

vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: recordSecurityEventMock,
}));

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async (request: MockRequest, _reply: unknown) => {
    request.user = { userId: 'user-tenant', organizationId: 'org-123' };
  },
}));

const applyTenantContext = vi.hoisted(() => vi.fn(async (request: MockRequest) => {
  request.tenantContext = {
    organizationId: 'org-123',
    userId: 'user-tenant',
    tier: 'enterprise',
    roles: ['developer'],
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
}));

vi.mock('@/api/middleware/tenant-isolation-middleware', () => ({
  requireTenantContext: () => async (request: MockRequest, reply: unknown) => applyTenantContext(request, reply),
  getTenantContext: (request: MockRequest) => request.tenantContext,
}));

describe('Queue Routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    recordSecurityEventMock.mockClear();
    applyTenantContext.mockImplementation(async (request: MockRequest) => {
      request.tenantContext = {
        organizationId: 'org-123',
        userId: 'user-tenant',
        tier: 'enterprise',
        roles: ['developer'],
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
    });
    app = Fastify();
    ({ registerQueueRoutes } = await import('@/routes/queue/queue-routes'));
    await registerQueueRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 404 when job is missing', async () => {
    queueResultServiceMock.get.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/queue/status/job-404',
    });

    expect(response.statusCode).toBe(404);
    expect(queueResultServiceMock.get).toHaveBeenCalledWith('job-404');
  });

  it('returns 403 when organization does not match', async () => {
    queueResultServiceMock.get.mockResolvedValueOnce({
      status: 'queued',
      metadata: {
        organizationId: 'org-other',
        priority: 500,
        tier: 'enterprise',
        enqueueTimestamp: Date.now(),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/queue/status/job-1',
    });

    expect(response.statusCode).toBe(403);
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'organization_mismatch',
        organizationId: 'org-123',
        metadata: expect.objectContaining({
          queueId: 'job-1',
          jobOrganizationId: 'org-other',
        }),
      })
    );
  });

  it('returns queue status when job is owned by tenant', async () => {
    const record = {
      status: 'processing',
      metadata: {
        organizationId: 'org-123',
        userId: 'user-456',
        enqueueTimestamp: Date.now() - 1000,
        startedAt: Date.now(),
        priority: 500,
        tier: 'enterprise' as const,
      },
    };
    queueResultServiceMock.get.mockResolvedValueOnce(record);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/queue/status/job-2',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(record);
  });

  it('deletes job status when authorized', async () => {
    const record = {
      status: 'completed',
      metadata: {
        organizationId: 'org-123',
        userId: 'user-789',
        enqueueTimestamp: Date.now() - 3000,
        finishedAt: Date.now() - 1000,
        priority: 3000,
        tier: 'pro' as const,
      },
      result: { ok: true },
    };
    queueResultServiceMock.get.mockResolvedValueOnce(record);

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/queue/status/job-3',
    });

    expect(response.statusCode).toBe(204);
    expect(queueResultServiceMock.delete).toHaveBeenCalledWith('job-3');
    expect(recordSecurityEventMock).not.toHaveBeenCalled();
  });

  it('returns 403 when tenant context is not established', async () => {
    applyTenantContext.mockImplementation(async (_request: any, reply: any) => {
      reply.status(403).send({ error: { code: 'tenant_context_required' } });
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/queue/status/job-tenant-missing',
    });

    expect(response.statusCode).toBe(403);
    expect(queueResultServiceMock.get).not.toHaveBeenCalled();
    expect(recordSecurityEventMock).not.toHaveBeenCalled();
  });
});

