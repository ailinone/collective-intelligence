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
import { registerEnterpriseBillingRoutes } from '@/routes/enterprise/billing-routes';
import type { Invoice } from '@/types';

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
    roles: string[];
  };
  tenantContext?: TenantContext;
}

const billingServiceMock = vi.hoisted(() => ({
  getBillingConfig: vi.fn(),
  listPaymentMethodsForOrganization: vi.fn(),
  createSetupIntentForOrganization: vi.fn(),
  attachPaymentMethodToOrganization: vi.fn(),
  detachPaymentMethodFromOrganization: vi.fn(),
  upsertBillingConfig: vi.fn(),
  listAvailableBillingPlans: vi.fn(),
  createInvoice: vi.fn(),
  listInvoices: vi.fn(),
  getInvoice: vi.fn(),
  markInvoicePaid: vi.fn(),
  createSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
  cancelSubscription: vi.fn(),
}));

let currentTenantContext: TenantContext | null;

vi.mock('@/services/billing-service', () => ({
  getBillingConfig: billingServiceMock.getBillingConfig,
  listPaymentMethodsForOrganization: billingServiceMock.listPaymentMethodsForOrganization,
  createSetupIntentForOrganization: billingServiceMock.createSetupIntentForOrganization,
  attachPaymentMethodToOrganization: billingServiceMock.attachPaymentMethodToOrganization,
  detachPaymentMethodFromOrganization: billingServiceMock.detachPaymentMethodFromOrganization,
  upsertBillingConfig: billingServiceMock.upsertBillingConfig,
  listAvailableBillingPlans: billingServiceMock.listAvailableBillingPlans,
  createInvoice: billingServiceMock.createInvoice,
  listInvoices: billingServiceMock.listInvoices,
  getInvoice: billingServiceMock.getInvoice,
  markInvoicePaid: billingServiceMock.markInvoicePaid,
  createSubscription: billingServiceMock.createSubscription,
  listSubscriptions: billingServiceMock.listSubscriptions,
  cancelSubscription: billingServiceMock.cancelSubscription,
}));

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async (request: MockRequest) => {
    if (currentTenantContext) {
      request.user = {
        userId: currentTenantContext.userId,
        organizationId: currentTenantContext.organizationId,
        roles: currentTenantContext.roles ?? ['admin'],
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

describe('Enterprise Billing Routes', () => {
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
    await registerEnterpriseBillingRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns billing config for tenant', async () => {
    billingServiceMock.getBillingConfig.mockResolvedValueOnce({
      organizationId: 'org-123',
      billingEmail: 'finance@example.com',
      autoPay: true,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/enterprise/billing/config',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      config: {
        organizationId: 'org-123',
        billingEmail: 'finance@example.com',
        autoPay: true,
      },
    });
    expect(billingServiceMock.getBillingConfig).toHaveBeenCalledWith('org-123');
  });

  it('rejects invoice creation when payload organization mismatches tenant', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: {
        organizationId: 'org-other',
        amount: 100,
        currency: 'USD',
        periodStart: Date.now(),
        periodEnd: Date.now() + 86_400_000,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'organization_mismatch',
        message: 'Organization in payload does not match authenticated tenant.',
      },
    });
    expect(billingServiceMock.createInvoice).not.toHaveBeenCalled();
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

  it('creates invoice for tenant with sanitized payload', async () => {
    billingServiceMock.createInvoice.mockResolvedValueOnce({
      id: 'inv-001',
      organizationId: 'org-123',
      periodStart: Date.now(),
      periodEnd: Date.now() + 86_400_000,
      subtotal: 100,
      tax: 0,
      total: 100,
      currency: 'USD',
      status: 'draft',
      dueDate: Date.now() + 2 * 86_400_000,
      createdAt: Date.now(),
      items: [],
    } as Invoice);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: {
        amount: 100,
        currency: 'USD',
        periodStart: Date.now(),
        periodEnd: Date.now() + 86_400_000,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'inv-001',
      organizationId: 'org-123',
      total: 100,
      currency: 'USD',
      status: 'draft',
    });
    expect(billingServiceMock.createInvoice).toHaveBeenCalledWith({
      currency: 'USD',
      organizationId: 'org-123',
      periodStart: expect.any(Number),
      periodEnd: expect.any(Number),
    });
  });

  it('denies access when tenant context is missing', async () => {
    currentTenantContext = undefined;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/enterprise/billing/config',
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

