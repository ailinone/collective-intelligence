// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for the billing-service side of the invoice-fraud /
 * payment-method BOLA fixes:
 *
 * - attach/detachPaymentMethodToOrganization must refuse a Stripe
 *   PaymentMethod owned by a different Stripe customer (Stripe's detach API
 *   takes no customer parameter, so without this check any org admin could
 *   detach another tenant's card by id).
 * - markInvoicePaid must not flip an invoice to `paid` without charging it
 *   through Stripe unless the caller is a platform administrator (otherwise an
 *   org admin could mark a `stripe_sync_failed` invoice paid with no money
 *   moving, and reconciliation never revisits `paid` invoices).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  billingProfileFindUnique: vi.fn(),
  billingProfileUpdate: vi.fn(),
  invoiceFindFirst: vi.fn(),
  invoiceUpdate: vi.fn(),
  isStripeEnabled: vi.fn(() => true),
  retrievePaymentMethod: vi.fn(),
  attachPaymentMethod: vi.fn(),
  detachPaymentMethod: vi.fn(),
  payInvoice: vi.fn(),
  retrieveInvoice: vi.fn(),
}));

vi.mock('@/database/client', () => ({
  Prisma: { JsonNull: null, Decimal: class {} },
  prisma: {
    billingProfile: { findUnique: h.billingProfileFindUnique, update: h.billingProfileUpdate },
    invoice: { findFirst: h.invoiceFindFirst, update: h.invoiceUpdate },
  },
}));

vi.mock('@/services/payments/stripe-gateway', () => ({
  isStripeEnabled: h.isStripeEnabled,
  retrievePaymentMethod: h.retrievePaymentMethod,
  attachPaymentMethod: h.attachPaymentMethod,
  detachPaymentMethod: h.detachPaymentMethod,
  payInvoice: h.payInvoice,
  retrieveInvoice: h.retrieveInvoice,
  upsertCustomer: vi.fn(),
  createSetupIntent: vi.fn(),
  listPaymentMethods: vi.fn(),
  createSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
  createInvoice: vi.fn(),
  createInvoiceItem: vi.fn(),
  finalizeInvoice: vi.fn(),
}));

vi.mock('@/services/billing-plan-service', () => ({
  getBillingPrice: vi.fn(),
  listBillingPlans: vi.fn(),
  syncStripeCatalog: vi.fn(),
}));

vi.mock('@/services/billing-usage-aggregation', () => ({
  aggregateUsageCosts: vi.fn(),
}));

vi.mock('@/utils/metrics', () => ({
  billingInvoicesTotal: { inc: vi.fn() },
  billingRevenueUsd: { inc: vi.fn() },
  billingSubscriptionEvents: { inc: vi.fn() },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

import {
  attachPaymentMethodToOrganization,
  detachPaymentMethodFromOrganization,
  markInvoicePaid,
} from '@/services/billing-service';

const ORG = 'org_mine';
const MY_CUSTOMER = 'cus_mine';

beforeEach(() => {
  vi.clearAllMocks();
  h.isStripeEnabled.mockReturnValue(true);
  h.billingProfileFindUnique.mockResolvedValue({
    organizationId: ORG,
    billingEmail: 'billing@example.test',
    stripeCustomerId: MY_CUSTOMER,
    defaultPaymentMethodId: null,
  });
});

describe('detachPaymentMethodFromOrganization ownership', () => {
  it('refuses to detach a payment method owned by another Stripe customer', async () => {
    h.retrievePaymentMethod.mockResolvedValue({ id: 'pm_victim', customer: 'cus_victim' });

    await expect(detachPaymentMethodFromOrganization(ORG, 'pm_victim')).rejects.toThrow();
    expect(h.detachPaymentMethod).not.toHaveBeenCalled();
  });

  it('detaches a payment method owned by the caller customer', async () => {
    h.retrievePaymentMethod.mockResolvedValue({ id: 'pm_mine', customer: MY_CUSTOMER });

    await detachPaymentMethodFromOrganization(ORG, 'pm_mine');
    expect(h.detachPaymentMethod).toHaveBeenCalledWith('pm_mine');
  });
});

describe('attachPaymentMethodToOrganization ownership', () => {
  it('refuses a payment method already owned by another Stripe customer', async () => {
    h.retrievePaymentMethod.mockResolvedValue({ id: 'pm_victim', customer: { id: 'cus_victim' } });

    await expect(attachPaymentMethodToOrganization(ORG, 'pm_victim', true)).rejects.toThrow(
      /different customer/
    );
    expect(h.attachPaymentMethod).not.toHaveBeenCalled();
  });

  it('attaches a payment method with no owner yet', async () => {
    h.retrievePaymentMethod.mockResolvedValue({ id: 'pm_new', customer: null });
    h.attachPaymentMethod.mockResolvedValue({ id: 'pm_new', type: 'card', card: null });

    await attachPaymentMethodToOrganization(ORG, 'pm_new', false);
    expect(h.attachPaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: MY_CUSTOMER, paymentMethodId: 'pm_new' })
    );
  });
});

describe('markInvoicePaid without a Stripe charge', () => {
  it('refuses a non-platform-admin marking an invoice with no Stripe invoice as paid', async () => {
    h.invoiceFindFirst.mockResolvedValue({
      id: 'inv_1',
      organizationId: ORG,
      stripeInvoiceId: null,
      status: 'stripe_sync_failed',
    });

    await expect(markInvoicePaid(ORG, 'inv_1')).rejects.toThrow(/platform administrator/);
    expect(h.invoiceUpdate).not.toHaveBeenCalled();
    expect(h.payInvoice).not.toHaveBeenCalled();
  });

  it('refuses a non-platform-admin when Stripe is disabled', async () => {
    h.isStripeEnabled.mockReturnValue(false);
    h.invoiceFindFirst.mockResolvedValue({
      id: 'inv_2',
      organizationId: ORG,
      stripeInvoiceId: 'in_2',
    });

    await expect(markInvoicePaid(ORG, 'inv_2', { allowManualMark: false })).rejects.toThrow();
    expect(h.invoiceUpdate).not.toHaveBeenCalled();
  });

  it('still charges through Stripe for a non-platform-admin when a Stripe invoice exists', async () => {
    h.invoiceFindFirst.mockResolvedValue({
      id: 'inv_3',
      organizationId: ORG,
      stripeInvoiceId: 'in_3',
      stripePaymentIntentId: null,
    });
    h.payInvoice.mockResolvedValue({ id: 'in_3' });
    h.retrieveInvoice.mockResolvedValue({
      id: 'in_3',
      status: 'paid',
      payment_intent: 'pi_3',
      status_transitions: { paid_at: 1_700_000_000 },
    });

    await markInvoicePaid(ORG, 'inv_3');
    expect(h.payInvoice).toHaveBeenCalledWith('in_3');
    expect(h.invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'paid' }) })
    );
  });

  it('lets a platform admin record an out-of-band payment', async () => {
    h.invoiceFindFirst.mockResolvedValue({
      id: 'inv_4',
      organizationId: ORG,
      stripeInvoiceId: null,
      stripePaymentIntentId: null,
    });

    await markInvoicePaid(ORG, 'inv_4', { allowManualMark: true });
    expect(h.payInvoice).not.toHaveBeenCalled();
    expect(h.invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'paid' }) })
    );
  });
});
