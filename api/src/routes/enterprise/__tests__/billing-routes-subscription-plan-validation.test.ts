// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for the `plan` validation gap on
 * `POST /v1/enterprise/billing/subscriptions`.
 *
 * Before the fix: the route's JSON schema declared `plan: { type: 'string' }`
 * with no further constraint — any string at all (including an empty one, or
 * one containing control characters / unbounded length) was accepted,
 * persisted to `billingSubscription.plan`, and forwarded as Stripe
 * subscription metadata (`subscription_plan`). `billingCycle`, declared right
 * next to it in the same schema, was already a closed 2-value enum.
 *
 * After the fix: `plan` is bounded to a slug-shaped string
 * (`minLength`/`maxLength`/`pattern`), matching real plan identifiers used
 * across this codebase and the `billing` service (e.g. 'sandbox',
 * 'professional', 'team', 'starter', 'pro', 'enterprise'). It is
 * deliberately NOT a closed enum — see the `SubscriptionRequest.plan` doc
 * comment in `types/index.ts` for why `plan` has no single fixed universe of
 * valid values in this system.
 *
 * Hermetic: registers the real route module (so the assertions track the
 * actual schema, not a hand-copied one) with its service/middleware
 * dependencies mocked out — same technique as
 * `src/tests/security/billing-route-authz.test.ts`.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async () => {},
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
vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: vi.fn(),
}));

const createSubscriptionMock = vi.fn();
vi.mock('@/services/billing-service', () => ({
  createInvoice: vi.fn(),
  createSubscription: (...args: unknown[]) => createSubscriptionMock(...args),
  getBillingConfig: vi.fn(),
  getInvoice: vi.fn(),
  listInvoices: vi.fn(),
  listSubscriptions: vi.fn(),
  markInvoicePaid: vi.fn(),
  upsertBillingConfig: vi.fn(),
  cancelSubscription: vi.fn(),
  listAvailableBillingPlans: vi.fn(),
  listPaymentMethodsForOrganization: vi.fn(),
  createSetupIntentForOrganization: vi.fn(),
  attachPaymentMethodToOrganization: vi.fn(),
  detachPaymentMethodFromOrganization: vi.fn(),
}));

import { registerEnterpriseBillingRoutes } from '@/routes/enterprise/billing-routes';

describe('POST /v1/enterprise/billing/subscriptions — plan validation', () => {
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
    createSubscriptionMock.mockReset();
  });

  const basePayload = { billingCycle: 'monthly' as const };

  it('rejects an empty plan with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/subscriptions',
      payload: { ...basePayload, plan: '' },
    });

    expect(res.statusCode).toBe(400);
    expect(createSubscriptionMock).not.toHaveBeenCalled();
  });

  it('rejects a plan containing whitespace/control characters with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/subscriptions',
      payload: { ...basePayload, plan: 'starter plan\n' },
    });

    expect(res.statusCode).toBe(400);
    expect(createSubscriptionMock).not.toHaveBeenCalled();
  });

  it('rejects an overly long plan (>64 chars) with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/subscriptions',
      payload: { ...basePayload, plan: 'a'.repeat(65) },
    });

    expect(res.statusCode).toBe(400);
    expect(createSubscriptionMock).not.toHaveBeenCalled();
  });

  it('rejects a request missing plan entirely with 400 (required field, unchanged)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/subscriptions',
      payload: { ...basePayload },
    });

    expect(res.statusCode).toBe(400);
    expect(createSubscriptionMock).not.toHaveBeenCalled();
  });

  it.each(['sandbox', 'professional', 'team', 'starter', 'pro', 'enterprise', 'custom_plan-123'])(
    'accepts a valid slug-shaped plan %s and reaches the handler (200)',
    async (plan) => {
      createSubscriptionMock.mockResolvedValue({
        id: 'sub_test_123',
        organizationId: 'org_test_123',
        plan,
        status: 'active',
        billingCycle: 'monthly',
        amount: 0,
        currency: 'USD',
        startDate: Date.now(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/enterprise/billing/subscriptions',
        payload: { ...basePayload, plan },
      });

      expect(res.statusCode).toBe(200);
      expect(createSubscriptionMock).toHaveBeenCalledTimes(1);
      expect(createSubscriptionMock.mock.calls[0][0]).toMatchObject({ plan });
    }
  );

  it('still rejects an invalid billingCycle with 400 (existing enum, unchanged)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/subscriptions',
      payload: { plan: 'starter', billingCycle: 'weekly' },
    });

    expect(res.statusCode).toBe(400);
    expect(createSubscriptionMock).not.toHaveBeenCalled();
  });
});
