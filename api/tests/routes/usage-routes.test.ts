// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Usage Routes Tests
 * Uses REAL database - NO mocks
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { registerUsageRoutes } from '../../src/routes/usage/usage-routes.js';
import { prisma, connectDatabase, disconnectDatabase } from '@/database/client';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { initializeDIContainer, resetDIContainer } from '@/di/container';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

const applyTenantContext = vi.fn();

vi.mock('../../src/middleware/auth-middleware.js', () => ({
  authenticate: async () => undefined,
}));

vi.mock('../../src/api/middleware/tenant-isolation-middleware.js', () => ({
  requireTenantContext:
    () =>
    async (request: FastifyRequest & { tenantContext?: unknown }, reply: FastifyReply) => {
      return applyTenantContext(request, reply);
    },
  getTenantContext: (request: FastifyRequest & { tenantContext?: unknown }) => request.tenantContext,
}));

describe('Usage Routes - Real Tests (NO DB Mocks)', () => {
  let testOrgId: string;
  let testUserId: string;
  const tenantContext = {
    organizationId: '',
    userId: '',
    tier: 'enterprise' as const,
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

  let app: ReturnType<typeof Fastify>;
  let currentTenant: typeof tenantContext | undefined;

  beforeAll(async () => {
    await startTestEnvironment();
    initializeDIContainer();
    await connectDatabase();
    await syncDefaultRoles();

    const org = await prisma.organization.create({
      data: {
        name: `Test Usage Org ${Date.now()}`,
        slug: `test-usage-org-${Date.now()}`,
        tier: 'enterprise',
        status: 'active',
      },
    });
    testOrgId = org.id;

    const user = await prisma.user.create({
      data: {
        email: `usage-test-${Date.now()}@example.com`,
        name: 'Usage Test User',
        passwordHash: '$2b$12$dummyhash',
        organizationId: testOrgId,
        role: 'admin',
        status: 'active',
      },
    });
    testUserId = user.id;

    const timestamp = Date.now();
    await prisma.requestLog.createMany({
      data: [
        {
          requestId: `req-${timestamp}-1`,
          organizationId: testOrgId,
          endpoint: '/v1/chat/completions',
          method: 'POST',
          strategyName: 'single',
          durationMs: 1200,
          totalTokens: 800,
          costUsd: 0.12,
          status: 'success',
          qualityScore: 0.95,
        },
        {
          requestId: `req-${timestamp}-2`,
          organizationId: testOrgId,
          endpoint: '/v1/chat/completions',
          method: 'POST',
          strategyName: 'single',
          durationMs: 1100,
          totalTokens: 600,
          costUsd: 0.1,
          status: 'success',
          qualityScore: 0.93,
        },
        {
          requestId: `req-${timestamp}-3`,
          organizationId: testOrgId,
          endpoint: '/v1/chat/completions',
          method: 'POST',
          strategyName: 'parallel',
          durationMs: 1800,
          totalTokens: 1000,
          costUsd: 0.2,
          status: 'error',
          qualityScore: 0.5,
        },
      ],
    });

    tenantContext.organizationId = testOrgId;
    tenantContext.userId = testUserId;
  }, 60_000);

  afterAll(async () => {
    if (testOrgId) {
      await prisma.requestLog.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { organizationId: testOrgId } }).catch(() => {});
      await prisma.organization.delete({ where: { id: testOrgId } }).catch(() => {});
    }
    await disconnectDatabase();
    resetDIContainer();
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    currentTenant = tenantContext;

    applyTenantContext.mockImplementation(
      async (request: FastifyRequest & { tenantContext?: unknown }, reply: FastifyReply) => {
        if (!currentTenant) {
          return reply.code(403).send({
            error: {
              code: 'tenant_context_required',
              message: 'Organization context is required to access this resource.',
            },
          });
        }
        request.tenantContext = currentTenant;
      }
    );

    app = Fastify();
    await registerUsageRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns usage stats scoped to tenant context', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/usage/stats',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      period: 'day',
    });
    expect(body.requestCount).toBeGreaterThanOrEqual(3);
  });

  it('rejects requests without tenant context', async () => {
    currentTenant = undefined;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/usage/stats',
    });

    expect(response.statusCode).toBe(403);
  });
});
