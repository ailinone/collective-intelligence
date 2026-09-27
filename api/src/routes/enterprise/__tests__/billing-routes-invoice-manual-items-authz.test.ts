// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for the self-service invoice-creation billing-fraud gap on
 * `POST /v1/enterprise/billing/invoices`.
 *
 * Before the fix: any caller with `billing:update` (i.e. any org admin, not
 * just a platform admin) could pass `items` (or `costMetrics`/`costEvents`)
 * verbatim in the request body, and `createInvoice()` would use them exactly
 * as supplied — with no reconciliation against real usage — letting an org
 * submit an artificially low-price (or $0) invoice for itself and pay it.
 *
 * After the fix: a non-platform-admin caller supplying any of
 * `items`/`costMetrics`/`costEvents` is rejected with 403, and a
 * non-platform-admin caller who omits them gets invoice amounts computed
 * server-side from `aggregateUsageCosts()`. A genuine platform admin may
 * still supply manual line items (e.g. to correct billing).
 *
 * Hermetic: registers the real route module with its service/middleware
 * dependencies mocked out — same technique as
 * `src/tests/security/billing-route-authz.test.ts` and
 * `billing-routes-subscription-plan-validation.test.ts`.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const isPlatformAdminRequestMock = vi.fn(() => false);
vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async () => {},
  isPlatformAdminRequest: (...args: unknown[]) => isPlatformAdminRequestMock(...args),
}));
vi.mock('@/services/anonymous-quota-gate', () => ({
  rejectAnonymousGuestKeyPreHandler: async () => {},
}));
vi.mock('@/services/free-tier-quota-gate', () => ({
  rejectChatFreeTierKeyPreHandler: async () => {},
}));
vi.mock('@/api/middleware/tenant-isolation-middleware', () => ({
  requireTenantContext: () => async () => {},
  getTenantContext: () => ({ organizationId: 'org_test_123', userId: 'user_test_123' }),
}));
vi.mock('@/middleware/require-permission-middleware', () => ({
  requirePermission: () => async () => {},
  requireAnyPermission: () => async () => {},
}));

const recordSecurityEventMock = vi.fn();
vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: (...args: unknown[]) => recordSecurityEventMock(...args),
}));

const createInvoiceMock = vi.fn();
const findOverlappingInvoiceMock = vi.fn();
const markInvoicePaidMock = vi.fn();
vi.mock('@/services/billing-service', () => ({
  createInvoice: (...args: unknown[]) => createInvoiceMock(...args),
  findOverlappingInvoice: (...args: unknown[]) => findOverlappingInvoiceMock(...args),
  createSubscription: vi.fn(),
  getBillingConfig: vi.fn(),
  getInvoice: vi.fn(),
  listInvoices: vi.fn(),
  listSubscriptions: vi.fn(),
  markInvoicePaid: (...args: unknown[]) => markInvoicePaidMock(...args),
  upsertBillingConfig: vi.fn(),
  cancelSubscription: vi.fn(),
  listAvailableBillingPlans: vi.fn(),
  listPaymentMethodsForOrganization: vi.fn(),
  createSetupIntentForOrganization: vi.fn(),
  attachPaymentMethodToOrganization: vi.fn(),
  detachPaymentMethodFromOrganization: vi.fn(),
}));

const aggregateUsageCostsMock = vi.fn();
vi.mock('@/services/billing-usage-aggregation', () => ({
  aggregateUsageCosts: (...args: unknown[]) => aggregateUsageCostsMock(...args),
}));

import { registerEnterpriseBillingRoutes } from '@/routes/enterprise/billing-routes';

describe('POST /v1/enterprise/billing/invoices — manual line-item authorization', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerEnterpriseBillingRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    createInvoiceMock.mockReset();
    aggregateUsageCostsMock.mockReset();
    recordSecurityEventMock.mockReset();
    isPlatformAdminRequestMock.mockReset();
    isPlatformAdminRequestMock.mockReturnValue(false);
    findOverlappingInvoiceMock.mockReset();
    findOverlappingInvoiceMock.mockResolvedValue(null);
    markInvoicePaidMock.mockReset();
    markInvoicePaidMock.mockResolvedValue(undefined);
  });

  const basePayload = { periodStart: 1700000000000, periodEnd: 1700003600000 };

  it('rejects a non-platform-admin supplying manual `items` with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: {
        ...basePayload,
        items: [{ description: 'Consulting', quantity: 1, unitPrice: 0.01, total: 0.01 }],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload)).toMatchObject({
      error: { code: 'manual_invoice_items_forbidden' },
    });
    expect(createInvoiceMock).not.toHaveBeenCalled();
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'billing_manual_invoice_items_denied' })
    );
  });

  it('rejects a non-platform-admin supplying manual `costMetrics` with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: {
        ...basePayload,
        costMetrics: { totalCost: 0.01, costByModel: { 'gpt-4': 0.01 }, tokenUsage: 1 },
      },
    });

    expect(res.statusCode).toBe(403);
    expect(createInvoiceMock).not.toHaveBeenCalled();
  });

  it('computes invoice amounts server-side from real usage for a non-platform-admin with no manual fields', async () => {
    aggregateUsageCostsMock.mockResolvedValue({
      metrics: { totalCost: 42, costByModel: { 'gpt-4': 42 }, tokenUsage: 1000 },
      events: [],
    });
    createInvoiceMock.mockResolvedValue({
      id: 'inv_test_123',
      organizationId: 'org_test_123',
      periodStart: basePayload.periodStart,
      periodEnd: basePayload.periodEnd,
      items: [],
      subtotal: 42,
      tax: 0,
      total: 42,
      currency: 'USD',
      status: 'pending',
      dueDate: Date.now(),
      createdAt: Date.now(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: { ...basePayload },
    });

    expect(res.statusCode).toBe(200);
    expect(aggregateUsageCostsMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_test_123' })
    );
    expect(createInvoiceMock).toHaveBeenCalledTimes(1);
    expect(createInvoiceMock.mock.calls[0][0]).toMatchObject({
      organizationId: 'org_test_123',
      costMetrics: { totalCost: 42, costByModel: { 'gpt-4': 42 } },
      costEvents: [],
    });
  });

  it('allows a platform admin to supply manual `items` verbatim', async () => {
    isPlatformAdminRequestMock.mockReturnValue(true);
    createInvoiceMock.mockResolvedValue({
      id: 'inv_test_456',
      organizationId: 'org_test_123',
      periodStart: basePayload.periodStart,
      periodEnd: basePayload.periodEnd,
      items: [],
      subtotal: 500,
      tax: 0,
      total: 500,
      currency: 'USD',
      status: 'pending',
      dueDate: Date.now(),
      createdAt: Date.now(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: {
        ...basePayload,
        items: [{ description: 'Manual correction', quantity: 1, unitPrice: 500, total: 500 }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(aggregateUsageCostsMock).not.toHaveBeenCalled();
    expect(createInvoiceMock).toHaveBeenCalledTimes(1);
    expect(createInvoiceMock.mock.calls[0][0]).toMatchObject({
      organizationId: 'org_test_123',
      items: [{ description: 'Manual correction', quantity: 1, unitPrice: 500, total: 500 }],
    });
  });

  it('ignores a caller-chosen currency for a non-platform-admin (server decides it)', async () => {
    aggregateUsageCostsMock.mockResolvedValue({
      metrics: { totalCost: 42, costByModel: { 'gpt-4': 42 }, tokenUsage: 1000 },
      events: [],
    });
    createInvoiceMock.mockResolvedValue({
      id: 'inv_test_789',
      organizationId: 'org_test_123',
      periodStart: basePayload.periodStart,
      periodEnd: basePayload.periodEnd,
      items: [],
      subtotal: 42,
      tax: 0,
      total: 42,
      currency: 'USD',
      status: 'pending',
      dueDate: Date.now(),
      createdAt: Date.now(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: { ...basePayload, currency: 'IDR' },
    });

    expect(res.statusCode).toBe(200);
    expect(createInvoiceMock.mock.calls[0][0]).not.toHaveProperty('currency');
  });

  it('rejects a non-platform-admin invoice for a period that has not ended yet', async () => {
    const now = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: { periodStart: now - 3_600_000, periodEnd: now + 86_400_000 },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toMatchObject({ error: { code: 'invalid_invoice_period' } });
    expect(aggregateUsageCostsMock).not.toHaveBeenCalled();
    expect(createInvoiceMock).not.toHaveBeenCalled();
  });

  it('rejects a non-platform-admin invoice with periodStart >= periodEnd', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: { periodStart: basePayload.periodEnd, periodEnd: basePayload.periodStart },
    });

    expect(res.statusCode).toBe(400);
    expect(createInvoiceMock).not.toHaveBeenCalled();
  });

  it('rejects a non-platform-admin invoice overlapping an existing invoice (no double billing)', async () => {
    findOverlappingInvoiceMock.mockResolvedValue('inv_existing');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices',
      payload: { ...basePayload },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload)).toMatchObject({ error: { code: 'invoice_period_overlap' } });
    expect(findOverlappingInvoiceMock).toHaveBeenCalledWith(
      'org_test_123',
      new Date(basePayload.periodStart),
      new Date(basePayload.periodEnd)
    );
    expect(createInvoiceMock).not.toHaveBeenCalled();
  });

  it('POST /invoices/:id/pay only allows a manual (non-Stripe) mark for platform admins', async () => {
    const invoiceId = '11111111-1111-4111-8111-111111111111';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/enterprise/billing/invoices/${invoiceId}/pay`,
    });
    expect(res.statusCode).toBe(204);
    expect(markInvoicePaidMock).toHaveBeenCalledWith('org_test_123', invoiceId, {
      allowManualMark: false,
    });

    isPlatformAdminRequestMock.mockReturnValue(true);
    await app.inject({ method: 'POST', url: `/v1/enterprise/billing/invoices/${invoiceId}/pay` });
    expect(markInvoicePaidMock).toHaveBeenLastCalledWith('org_test_123', invoiceId, {
      allowManualMark: true,
    });
  });
});
