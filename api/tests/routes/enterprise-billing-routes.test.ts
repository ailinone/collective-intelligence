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
import { registerEnterpriseBillingRoutes } from '@/routes/enterprise/billing-routes';
import type {
  BillingConfig,
  BillingPaymentMethod,
  BillingSetupIntent,
  BillingSubscription,
  BillingPlan,
  Invoice,
} from '@/types';
import { getTestTenantContext, TEST_TENANT_ORGANIZATION_ID } from '../utils/test-tenant';

const billingServiceMock = vi.hoisted(() => ({
  getBillingConfig: vi.fn<[], Promise<BillingConfig | null>>(),
  listPaymentMethodsForOrganization: vi.fn<[], Promise<BillingPaymentMethod[]>>(),
  createSetupIntentForOrganization: vi.fn<[], Promise<BillingSetupIntent>>(),
  attachPaymentMethodToOrganization: vi.fn<[], Promise<BillingPaymentMethod>>(),
  detachPaymentMethodFromOrganization: vi.fn<[], Promise<void>>(),
  upsertBillingConfig: vi.fn<[], Promise<BillingConfig>>(),
  listInvoices: vi.fn<[], Promise<Invoice[]>>(),
  getInvoice: vi.fn<[], Promise<Invoice | null>>(),
  markInvoicePaid: vi.fn<[], Promise<void>>(),
  createInvoice: vi.fn<[], Promise<Invoice>>(),
  createSubscription: vi.fn<[], Promise<BillingSubscription>>(),
  listSubscriptions: vi.fn<[], Promise<BillingSubscription[]>>(),
  cancelSubscription: vi.fn<[], Promise<void>>(),
  listAvailableBillingPlans: vi.fn<[], Promise<BillingPlan[]>>(),
}));

vi.mock('@/services/billing-service', () => billingServiceMock);

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async () => {},
}));

const applyTenantContext = vi.hoisted(() => vi.fn());

vi.mock('@/api/middleware/tenant-isolation-middleware', () => ({
  requireTenantContext:
    () =>
    async (request: any, reply: any): Promise<void> =>
      applyTenantContext(request, reply),
  getTenantContext: (request: any) => {
    if (!request?.tenantContext) {
      throw new Error('Tenant context missing');
    }
    return request.tenantContext;
  },
}));

describe('Enterprise Billing Routes', () => {
  let app: ReturnType<typeof Fastify>;

  const buildApp = async () => {
    const instance = Fastify();
    instance.addSchema({
      $id: 'Invoice',
      type: 'object',
      properties: {
        id: { type: 'string' },
        organizationId: { type: 'string' },
        periodStart: { type: 'number' },
        periodEnd: { type: 'number' },
        subtotal: { type: 'number' },
        tax: { type: 'number' },
        total: { type: 'number' },
        currency: { type: 'string' },
        status: { type: 'string' },
        dueDate: { type: 'string' },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' },
      },
    });
    await registerEnterpriseBillingRoutes(instance);
    await instance.ready();
    return instance;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    Object.values(billingServiceMock).forEach((fn) => {
      fn.mockReset?.();
    });
    applyTenantContext.mockReset();
    applyTenantContext.mockImplementation(async (request: any) => {
      request.tenantContext = getTestTenantContext();
    });
    billingServiceMock.createInvoice.mockResolvedValue({
      id: 'inv-1',
      organizationId: TEST_TENANT_ORGANIZATION_ID,
      periodStart: Date.now() - 3_600_000,
      periodEnd: Date.now(),
      status: 'draft',
      currency: 'USD',
      subtotal: 0,
      tax: 0,
      total: 0,
      dueDate: Date.now() + 86_400_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as Invoice);
    billingServiceMock.createSubscription.mockResolvedValue({
      id: 'sub-1',
      organizationId: TEST_TENANT_ORGANIZATION_ID,
      plan: 'enterprise',
      billingCycle: 'monthly',
      status: 'active',
      amount: 100,
      currency: 'USD',
      startDate: Date.now(),
    } as BillingSubscription);
    billingServiceMock.listAvailableBillingPlans.mockResolvedValue([]);
    billingServiceMock.listInvoices.mockResolvedValue([]);
    billingServiceMock.listSubscriptions.mockResolvedValue([]);
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('rejects invoice creation when payload organizationId mismatches tenant', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: {
        organizationId: 'different-org',
        periodStart: Date.now(),
        periodEnd: Date.now() + 1000,
      },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'organization_mismatch',
        message: 'Organization in payload does not match authenticated tenant.',
      },
    });
    expect(billingServiceMock.createInvoice).not.toHaveBeenCalled();
  });

  it('rejects subscription creation when payload organizationId mismatches tenant', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/subscriptions',
      payload: {
        organizationId: 'different-org',
        plan: 'enterprise',
        billingCycle: 'monthly',
      },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'organization_mismatch',
        message: 'Organization in payload does not match authenticated tenant.',
      },
    });
    expect(billingServiceMock.createSubscription).not.toHaveBeenCalled();
  });

  it('creates invoice with tenant organizationId enforced', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: {
        periodStart: Date.now(),
        periodEnd: Date.now() + 1000,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(billingServiceMock.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: TEST_TENANT_ORGANIZATION_ID,
      }),
    );
  });

  it('creates subscription with tenant organizationId enforced', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/subscriptions',
      payload: {
        plan: 'enterprise',
        billingCycle: 'monthly',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(billingServiceMock.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: TEST_TENANT_ORGANIZATION_ID,
      }),
    );
  });

  it('returns 403 when tenant context middleware denies request', async () => {
    applyTenantContext.mockImplementation(async (_request: any, reply: any) => {
      reply.status(403).send({
        error: {
          code: 'tenant_context_required',
          message: 'Tenant context required',
        },
      });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: {
        periodStart: Date.now(),
        periodEnd: Date.now() + 1000,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(billingServiceMock.createInvoice).not.toHaveBeenCalled();
  });
});


