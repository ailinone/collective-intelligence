// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DB-constraint follow-up to #654 (self-service invoice-fraud fix).
 *
 * #654 closed the double-billing gap with an application-level check
 * (findOverlappingInvoice: a SELECT run before createInvoice()'s INSERT) —
 * but that check is check-then-act with no lock and no DB constraint tying
 * the two operations together. Two concurrent callers for the same
 * organization + an overlapping period (the daily usage-reconciliation job
 * racing a self-service POST, or two racing self-service calls) can both
 * pass the SELECT before either INSERT commits, producing two invoices that
 * both get charged in Stripe.
 *
 * The backstop is a GiST exclusion constraint on `invoices`
 * (no_overlapping_invoice_period, see
 * prisma/migrations/20260927000000_invoice_period_no_overlap_exclusion) that
 * makes the DB itself reject the second concurrent INSERT. This suite proves
 * createInvoice() (billing-service.ts) translates that DB rejection into
 * InvoicePeriodOverlapError instead of either (a) letting the raw
 * Prisma/Postgres error leak upward as an unclassified 500, or (b) silently
 * swallowing it and returning as if a second invoice had been created.
 *
 * No live Postgres was available to exercise the constraint itself in this
 * sandbox (Docker Desktop's engine was not reachable) — the constraint's SQL
 * was instead verified by careful reading (see the migration's own comment
 * for the reasoning: EXCLUDE vs UNIQUE, tsrange vs tstzrange, the partial
 * `WHERE status <> 'cancelled'`). This suite instead proves the
 * application-side translation by mocking `prisma.$transaction` to reject
 * with the same shape Prisma surfaces for an unmapped DB constraint
 * violation (P2004, carrying the constraint's name in the message — Prisma
 * has no schema-known code for EXCLUDE constraints, unlike P2002 for a
 * schema-declared UNIQUE).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  billingProfileFindUnique: vi.fn(),
  transaction: vi.fn(),
  invoiceFindUniqueOrThrow: vi.fn(),
  isStripeEnabled: vi.fn(() => false),
  logWarn: vi.fn(),
}));

vi.mock('@/database/client', () => ({
  Prisma: {
    JsonNull: null,
    Decimal: class Decimal {
      constructor(public value: number) {}
      valueOf() {
        return this.value;
      }
    },
  },
  prisma: {
    billingProfile: { findUnique: h.billingProfileFindUnique },
    invoice: { findUniqueOrThrow: h.invoiceFindUniqueOrThrow },
    $transaction: h.transaction,
  },
}));

vi.mock('@/services/payments/stripe-gateway', () => ({
  isStripeEnabled: h.isStripeEnabled,
  upsertCustomer: vi.fn(),
  createSetupIntent: vi.fn(),
  attachPaymentMethod: vi.fn(),
  detachPaymentMethod: vi.fn(),
  retrievePaymentMethod: vi.fn(),
  listPaymentMethods: vi.fn(),
  createSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
  createInvoice: vi.fn(),
  createInvoiceItem: vi.fn(),
  finalizeInvoice: vi.fn(),
  payInvoice: vi.fn(),
  retrieveInvoice: vi.fn(),
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
    child: () => ({ info: vi.fn(), debug: vi.fn(), warn: h.logWarn, error: vi.fn() }),
  },
}));

import { createInvoice } from '@/services/billing-service';
import { InvoicePeriodOverlapError } from '@/utils/custom-errors';

/**
 * Shape-compatible with `isPrismaKnownRequestError`
 * (utils/prisma-error-helpers.ts), which structurally checks for an own
 * `code` string plus `meta`/`clientVersion` presence — this mirrors what
 * `@prisma/client` actually throws for an unmapped DB constraint violation
 * without depending on constructing the real (internal) error class.
 */
function fakeExclusionConstraintError(): Error {
  return Object.assign(
    new Error(
      'Invalid `prisma.invoice.create()` invocation:\n' +
        'A constraint failed on the database: `conflicting key value violates exclusion ' +
        'constraint "no_overlapping_invoice_period"`'
    ),
    {
      code: 'P2004',
      clientVersion: '7.10.0',
      meta: { database_error: 'conflicting key value' },
    }
  );
}

function fakeUnrelatedUniqueConstraintError(): Error {
  // Same P-code family, but a different constraint entirely — must NOT be
  // misclassified as an invoice-period overlap.
  return Object.assign(new Error('Unique constraint failed on the fields: (`stripe_invoice_id`)'), {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: { target: ['stripe_invoice_id'] },
  });
}

const baseRequest = {
  organizationId: 'org_test_123',
  periodStart: Date.parse('2026-09-25T00:00:00.000Z'),
  periodEnd: Date.parse('2026-09-26T00:00:00.000Z'),
  costMetrics: { totalCost: 12.5 },
  costEvents: [],
} as const;

function mockSuccessfulInsert(invoiceId: string) {
  h.transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
    const tx = {
      invoice: { create: vi.fn().mockResolvedValue({ id: invoiceId }) },
      invoiceItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    return fn(tx);
  });
  h.invoiceFindUniqueOrThrow.mockResolvedValueOnce({
    id: invoiceId,
    organizationId: baseRequest.organizationId,
    periodStart: new Date(baseRequest.periodStart),
    periodEnd: new Date(baseRequest.periodEnd),
    items: [],
    subtotal: 0,
    tax: 0,
    total: 0,
    currency: 'USD',
    status: 'pending_stripe_sync',
    dueDate: new Date(baseRequest.periodEnd + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    paidAt: null,
    hostedInvoiceUrl: null,
    stripeInvoiceId: null,
    stripePaymentIntentId: null,
    stripeCustomerId: null,
    lastSyncedAt: null,
    metadata: {},
  });
}

describe('createInvoice — DB exclusion-constraint conflict handling', () => {
  beforeEach(() => {
    h.billingProfileFindUnique.mockReset().mockResolvedValue(null);
    h.transaction.mockReset();
    h.invoiceFindUniqueOrThrow.mockReset();
    h.isStripeEnabled.mockReset().mockReturnValue(false);
    h.logWarn.mockReset();
  });

  it('translates a no_overlapping_invoice_period DB violation into InvoicePeriodOverlapError (409), not a raw 500', async () => {
    h.transaction.mockRejectedValueOnce(fakeExclusionConstraintError());

    // Confirm the translated error carries the same contract the route's
    // pre-check (findOverlappingInvoice) already returns to callers.
    try {
      await createInvoice({ ...baseRequest });
      expect.unreachable('createInvoice should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvoicePeriodOverlapError);
      expect((error as InvoicePeriodOverlapError).statusCode).toBe(409);
      expect((error as InvoicePeriodOverlapError).code).toBe('invoice_period_overlap');
    }

    // Never reaches the post-insert re-fetch — nothing was actually persisted.
    expect(h.invoiceFindUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('does not misclassify an unrelated constraint violation as an invoice-period overlap', async () => {
    h.transaction.mockRejectedValueOnce(fakeUnrelatedUniqueConstraintError());

    try {
      await createInvoice({ ...baseRequest });
      expect.unreachable('createInvoice should have thrown');
    } catch (error) {
      expect(error).not.toBeInstanceOf(InvoicePeriodOverlapError);
      expect((error as Error).message).toContain('stripe_invoice_id');
    }
  });

  it('does not swallow an unrelated (non-constraint) error either', async () => {
    h.transaction.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

    await expect(createInvoice({ ...baseRequest })).rejects.toThrow(
      'connection terminated unexpectedly'
    );
  });

  /**
   * The actual concurrency proof: two attempts to create an invoice for the
   * same organization + period. The first "wins" the race (its INSERT
   * commits); the second represents a concurrent request that lost the race
   * at the DB constraint. Exactly one invoice is created; the loser gets
   * InvoicePeriodOverlapError, never a second invoice and never a bare
   * unclassified error.
   */
  it('of two racing attempts for the same period, exactly one invoice is created and the other gets InvoicePeriodOverlapError', async () => {
    mockSuccessfulInsert('inv_winner');
    h.transaction.mockRejectedValueOnce(fakeExclusionConstraintError());

    const [winner, loserResult] = await Promise.allSettled([
      createInvoice({ ...baseRequest }),
      createInvoice({ ...baseRequest }),
    ]);

    expect(winner.status).toBe('fulfilled');
    if (winner.status === 'fulfilled') {
      expect(winner.value.id).toBe('inv_winner');
    }

    expect(loserResult.status).toBe('rejected');
    if (loserResult.status === 'rejected') {
      expect(loserResult.reason).toBeInstanceOf(InvoicePeriodOverlapError);
    }

    // Exactly one successful DB row materialized (one findUniqueOrThrow
    // re-fetch, corresponding to the one commit); the second attempt never
    // got that far.
    expect(h.invoiceFindUniqueOrThrow).toHaveBeenCalledTimes(1);
  });
});
