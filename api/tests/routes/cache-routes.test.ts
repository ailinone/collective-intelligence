// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { InjectOptions } from 'fastify';
import { registerCacheRoutes } from '../../src/routes/cache/cache-routes.js';
import type { TenantContext } from '../../src/api/middleware/tenant-isolation-middleware.js';

const cacheServiceMock = vi.hoisted(() => ({
  getValue: vi.fn(),
  setValue: vi.fn(),
  deleteValue: vi.fn(),
  clearNamespace: vi.fn(),
  getStats: vi.fn(),
}));

vi.mock('../../src/cache/distributed-cache-service.js', () => ({
  getDistributedCacheService: () => cacheServiceMock,
}));

vi.mock('../../src/middleware/auth-middleware.js', () => ({
  authenticate: async () => undefined,
}));

const applyTenantContext = vi.fn();

vi.mock('../../src/api/middleware/tenant-isolation-middleware.js', () => ({
  requireTenantContext:
    () =>
    async (request: any, reply: any) => {
      return applyTenantContext(request, reply);
    },
  getTenantContext: (request: any) => request.tenantContext,
}));

const recordSecurityEventMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../src/services/security-audit-service.js', () => ({
  recordSecurityEvent: recordSecurityEventMock,
}));

const TEST_ORGANIZATION_ID = 'org-test-cache-suite';

function withTenantContext<T extends InjectOptions>(options: T): T {
  return {
    ...(options ?? {}),
  };
}

describe('Cache Routes', () => {
  let app: ReturnType<typeof Fastify>;
  let currentTenantContext: TenantContext | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    currentTenantContext = {
      organizationId: TEST_ORGANIZATION_ID,
      userId: 'user-test',
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
    applyTenantContext.mockImplementation(async (request: any, reply: any) => {
      if (!currentTenantContext) {
        reply.status(403).send({
          error: {
            code: 'tenant_context_required',
            message: 'Organization context is required to access this resource.',
          },
        });
        return;
      }
      request.tenantContext = currentTenantContext;
    });
    app = Fastify();
    await registerCacheRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    applyTenantContext.mockReset();
    recordSecurityEventMock.mockClear();
    await app.close();
  });

  it('returns cached value on hit', async () => {
    cacheServiceMock.getValue.mockResolvedValueOnce({ hit: true, value: { data: 'value' } });

    const response = await app.inject(
      withTenantContext({
        method: 'GET',
        url: '/v1/cache/value',
        query: { key: 'foo', namespace: 'ns' },
      })
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ hit: true, value: { data: 'value' } });
    expect(cacheServiceMock.getValue).toHaveBeenCalledWith({
      key: 'foo',
      namespace: 'ns',
      organizationId: TEST_ORGANIZATION_ID,
    });
  });

  it('returns miss payload when value absent', async () => {
    cacheServiceMock.getValue.mockResolvedValueOnce({ hit: false });

    const response = await app.inject(
      withTenantContext({
        method: 'GET',
        url: '/v1/cache/value',
        query: { key: 'missing' },
      })
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ hit: false });
    expect(cacheServiceMock.getValue).toHaveBeenCalledWith({
      key: 'missing',
      namespace: undefined,
      organizationId: TEST_ORGANIZATION_ID,
    });
  });

  it('returns 400 when cache read fails', async () => {
    cacheServiceMock.getValue.mockRejectedValueOnce(new Error('invalid namespace'));

    const response = await app.inject(
      withTenantContext({
        method: 'GET',
        url: '/v1/cache/value',
        query: { key: 'foo', namespace: ':::' },
      })
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ hit: false });
  });

  it('returns 403 when tenant context is missing', async () => {
    currentTenantContext = undefined;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/cache/value',
      query: { key: 'without-header' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: 'tenant_context_required',
      },
    });
    expect(cacheServiceMock.getValue).not.toHaveBeenCalled();
  });

  it('stores value and returns 204', async () => {
    const response = await app.inject(
      withTenantContext({
        method: 'POST',
        url: '/v1/cache/value',
        payload: { key: 'alpha', value: { answer: 42 }, ttlSeconds: 120 },
      })
    );

    expect(response.statusCode).toBe(204);
    expect(cacheServiceMock.setValue).toHaveBeenCalledWith({
      key: 'alpha',
      value: { answer: 42 },
      ttlSeconds: 120,
      namespace: undefined,
      organizationId: TEST_ORGANIZATION_ID,
    });
  });

  it('deletes cache value', async () => {
    cacheServiceMock.deleteValue.mockResolvedValueOnce(true);

    const response = await app.inject(
      withTenantContext({
        method: 'DELETE',
        url: '/v1/cache/value',
        payload: { key: 'beta', namespace: 'team-a' },
      })
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: true });
    expect(cacheServiceMock.deleteValue).toHaveBeenCalledWith({
      key: 'beta',
      namespace: 'team-a',
      organizationId: TEST_ORGANIZATION_ID,
    });
  });

  it('clears namespace entries', async () => {
    cacheServiceMock.clearNamespace.mockResolvedValueOnce(5);

    const response = await app.inject(
      withTenantContext({
        method: 'POST',
        url: '/v1/cache/clear',
        payload: { namespace: 'workspace' },
      })
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cleared: 5 });
    expect(cacheServiceMock.clearNamespace).toHaveBeenCalledWith({
      namespace: 'workspace',
      organizationId: TEST_ORGANIZATION_ID,
    });
    expect(recordSecurityEventMock).toHaveBeenCalledWith({
      eventType: 'cache_namespace_cleared',
      severity: 'info',
      message: 'Cache namespace "workspace" cleared for tenant.',
      organizationId: TEST_ORGANIZATION_ID,
      userId: 'user-test',
      metadata: {
        namespace: 'workspace',
        cleared: 5,
      },
    });
  });

  it('returns cache statistics', async () => {
    cacheServiceMock.getStats.mockResolvedValueOnce({ items: 7, hits: 20, misses: 3 });

    const response = await app.inject(
      withTenantContext({
        method: 'GET',
        url: '/v1/cache/stats',
        query: { namespace: 'perf-team' },
      })
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: 7,
      hits: 20,
      misses: 3,
    });
    expect(cacheServiceMock.getStats).toHaveBeenCalledWith({
      namespace: 'perf-team',
      organizationId: TEST_ORGANIZATION_ID,
    });
  });
});
