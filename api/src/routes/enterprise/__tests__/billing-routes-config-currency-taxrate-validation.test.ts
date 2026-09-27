// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for the billing-config currency/taxRate gap on
 * `PUT /v1/enterprise/billing/config`.
 *
 * Before the fix: any caller with `billing:update` (i.e. any org admin, not
 * just a platform admin) could set `currency` to an arbitrary free-text
 * string and `taxRate` to any number, including a negative one, and it was
 * accepted (204) and persisted via `upsertBillingConfig`. That profile is
 * read back by EVERY invoice for the org — `createInvoice()` falls back to
 * `profile.currency`/`profile.taxRate` whenever the caller doesn't supply
 * them, and the daily usage-reconciliation job
 * (`createUsageInvoiceFromUsage`) never supplies them at all — so this was
 * the same self-service invoice-fraud vector #654 closed on the invoice
 * body itself (currency re-denomination / tax manipulation), just reached
 * through the org's own billing config instead.
 *
 * After the fix:
 *   - `currency` is restricted to a small explicit allowlist (`USD` only for
 *     now); any other value is rejected with 400 by the route schema.
 *   - `taxRate` must be within [0, 1]; a negative value (or > 1) is rejected
 *     with 400 by the route schema.
 *   - Changing EITHER field at all — even to an already-valid value — is
 *     restricted to a genuine platform admin (403 otherwise), mirroring the
 *     `isPlatformAdminRequest` gate #654 added to the sibling invoice route.
 *     An org's own admin may still update billingEmail/paymentMethod/
 *     autoPay/metadata through this same route.
 *
 * Hermetic: registers the real route module with its service/middleware
 * dependencies mocked out — same technique as
 * `billing-routes-invoice-manual-items-authz.test.ts`.
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

const upsertBillingConfigMock = vi.fn();
vi.mock('@/services/billing-service', () => ({
  createInvoice: vi.fn(),
  findOverlappingInvoice: vi.fn(),
  createSubscription: vi.fn(),
  getBillingConfig: vi.fn(),
  getInvoice: vi.fn(),
  listInvoices: vi.fn(),
  listSubscriptions: vi.fn(),
  markInvoicePaid: vi.fn(),
  upsertBillingConfig: (...args: unknown[]) => upsertBillingConfigMock(...args),
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

describe('PUT /v1/enterprise/billing/config — currency/taxRate validation', () => {
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
    upsertBillingConfigMock.mockReset();
    upsertBillingConfigMock.mockResolvedValue(undefined);
    recordSecurityEventMock.mockReset();
    isPlatformAdminRequestMock.mockReset();
    isPlatformAdminRequestMock.mockReturnValue(false);
  });

  const basePayload = { billingEmail: 'billing@example.com' };

  it('rejects an org admin (non-platform-admin) setting an arbitrary currency with 400/403, never persisting it', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/enterprise/billing/config',
      payload: { ...basePayload, currency: 'XYZ' },
    });

    // Whichever guard fires first (schema 400 or platform-admin 403), the
    // write must never happen.
    expect([400, 403]).toContain(res.statusCode);
    expect(upsertBillingConfigMock).not.toHaveBeenCalled();
  });

  it('rejects an org admin (non-platform-admin) setting a negative taxRate with 400/403, never persisting it', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/enterprise/billing/config',
      payload: { ...basePayload, taxRate: -0.5 },
    });

    expect([400, 403]).toContain(res.statusCode);
    expect(upsertBillingConfigMock).not.toHaveBeenCalled();
  });

  it('rejects a taxRate above 100% (> 1) with 400', async () => {
    isPlatformAdminRequestMock.mockReturnValue(true);
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/enterprise/billing/config',
      payload: { ...basePayload, taxRate: 1.5 },
    });

    expect(res.statusCode).toBe(400);
    expect(upsertBillingConfigMock).not.toHaveBeenCalled();
  });

  it('rejects an org admin (non-platform-admin) setting currency even to an already-valid value (USD) with 403', async () => {
    isPlatformAdminRequestMock.mockReturnValue(false);
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/enterprise/billing/config',
      payload: { ...basePayload, currency: 'USD' },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('billing_currency_tax_rate_forbidden');
    expect(upsertBillingConfigMock).not.toHaveBeenCalled();
    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'billing_config_currency_tax_rate_denied' })
    );
  });

  it('still lets an org admin (non-platform-admin) update fields untouched by this exploit (billingEmail/autoPay/metadata)', async () => {
    isPlatformAdminRequestMock.mockReturnValue(false);
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/enterprise/billing/config',
      payload: { ...basePayload, autoPay: true, metadata: { note: 'ok' } },
    });

    expect(res.statusCode).toBe(204);
    expect(upsertBillingConfigMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid currency/taxRate (USD, 0.08) from a genuine platform admin and persists it (204)', async () => {
    isPlatformAdminRequestMock.mockReturnValue(true);
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/enterprise/billing/config',
      payload: { ...basePayload, currency: 'USD', taxRate: 0.08 },
    });

    expect(res.statusCode).toBe(204);
    expect(upsertBillingConfigMock).toHaveBeenCalledTimes(1);
    expect(upsertBillingConfigMock.mock.calls[0][0]).toMatchObject({
      currency: 'USD',
      taxRate: 0.08,
    });
  });

  it('rejects even a platform admin setting an unsupported currency with 400 (allowlist has no admin bypass)', async () => {
    isPlatformAdminRequestMock.mockReturnValue(true);
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/enterprise/billing/config',
      payload: { ...basePayload, currency: 'EUR' },
    });

    expect(res.statusCode).toBe(400);
    expect(upsertBillingConfigMock).not.toHaveBeenCalled();
  });
});
