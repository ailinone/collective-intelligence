// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { randomUUID } from 'node:crypto';
import { Prisma, prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { serializeError } from '@/utils/type-guards';
import { config } from '@/config';
import {
  billingInvoicesTotal,
  billingRevenueUsd,
  billingSubscriptionEvents,
} from '@/utils/metrics';
import type Stripe from 'stripe';
import type {
  BillingConfig,
  BillingSubscription,
  BillingPaymentMethod,
  BillingSetupIntent,
  CostEvent,
  CostMetrics,
  CreateInvoiceRequest,
  Invoice,
  InvoiceItem,
  SubscriptionRequest,
  BillingPlan,
  BillingPrice,
} from '@/types';
import {
  isStripeEnabled,
  upsertCustomer as stripeUpsertCustomer,
  createSetupIntent as stripeCreateSetupIntent,
  attachPaymentMethod as stripeAttachPaymentMethod,
  detachPaymentMethod as stripeDetachPaymentMethod,
  listPaymentMethods as stripeListPaymentMethods,
  createSubscription as stripeCreateSubscription,
  cancelSubscription as stripeCancelSubscription,
  createInvoice as stripeCreateInvoice,
  createInvoiceItem as stripeCreateInvoiceItem,
  finalizeInvoice as stripeFinalizeInvoice,
  payInvoice as stripePayInvoice,
  retrieveInvoice as stripeRetrieveInvoice,
} from '@/services/payments/stripe-gateway';
import {
  getBillingPrice,
  listBillingPlans,
  syncStripeCatalog,
} from '@/services/billing-plan-service';
import { toInputJson } from '@/utils/json';
import { aggregateUsageCosts } from '@/services/billing-usage-aggregation';
import { ApplicationError, ResourceNotFoundError } from '@/utils/custom-errors';

const log = logger.child({ component: 'billing-service' });
type InvoiceWithItems = Prisma.InvoiceGetPayload<{ include: { items: true } }>;
type SubscriptionWithPrice = Prisma.BillingSubscriptionGetPayload<{ include: { price: true } }>;

function jsonValueToRecord(
  value: Prisma.JsonValue | null | undefined
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function mapStripeInvoiceStatus(status?: Stripe.Invoice.Status | null): Invoice['status'] {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'open':
    case 'uncollectible':
    case 'void':
      return status === 'uncollectible' ? 'overdue' : status === 'void' ? 'cancelled' : 'pending';
    case 'paid':
      return 'paid';
    default:
      return 'pending';
  }
}

function mapStripeSubscriptionStatus(
  status?: Stripe.Subscription.Status | null
): BillingSubscription['status'] {
  switch (status) {
    case 'active':
    case 'trialing':
    case 'past_due':
      return 'active';
    case 'canceled':
      return 'cancelled';
    case 'incomplete':
    case 'incomplete_expired':
    case 'unpaid':
      return 'expired';
    default:
      return 'active';
  }
}

async function ensureStripeCustomerId(
  organizationId: string,
  billingEmail: string,
  organizationName?: string
): Promise<string | undefined> {
  if (!isStripeEnabled()) {
    return undefined;
  }

  const profile = await prisma.billingProfile.findUnique({
    where: { organizationId },
  });

  const customer = await stripeUpsertCustomer({
    customerId: profile?.stripeCustomerId,
    email: billingEmail,
    name: organizationName ?? billingEmail,
    metadata: {
      organizationId,
    },
  });

  if (!profile) {
    await prisma.billingProfile.create({
      data: {
        organizationId,
        billingEmail,
        autoPay: true,
        stripeCustomerId: customer.id,
      },
    });
  } else if (profile.stripeCustomerId !== customer.id) {
    await prisma.billingProfile.update({
      where: { organizationId },
      data: { stripeCustomerId: customer.id },
    });
  }

  return customer.id;
}

export async function upsertBillingConfig(configInput: BillingConfig): Promise<void> {
  const organizationId = configInput.organizationId;
  const billingEmail = configInput.billingEmail;

  let stripeCustomerId: string | undefined;
  if (isStripeEnabled()) {
    stripeCustomerId = await ensureStripeCustomerId(organizationId, billingEmail);
  }

  const profileMetadata = toInputJson(configInput.metadata) ?? Prisma.JsonNull;

  await prisma.billingProfile.upsert({
    where: { organizationId },
    create: {
      organizationId,
      billingEmail,
      paymentMethod: configInput.paymentMethod ?? null,
      defaultPaymentMethodId: configInput.defaultPaymentMethodId ?? null,
      autoPay: configInput.autoPay ?? false,
      taxRate: configInput.taxRate ? new Prisma.Decimal(configInput.taxRate) : null,
      currency: configInput.currency ?? 'USD',
      metadata: profileMetadata,
      stripeCustomerId: stripeCustomerId ?? null,
    },
    update: {
      billingEmail,
      paymentMethod: configInput.paymentMethod ?? null,
      defaultPaymentMethodId: configInput.defaultPaymentMethodId ?? null,
      autoPay: configInput.autoPay ?? false,
      taxRate: configInput.taxRate ? new Prisma.Decimal(configInput.taxRate) : null,
      currency: configInput.currency ?? 'USD',
      metadata: profileMetadata,
      stripeCustomerId: stripeCustomerId ?? undefined,
      updatedAt: new Date(),
    },
  });
}

export async function getBillingConfig(organizationId: string): Promise<BillingConfig | null> {
  const profile = await prisma.billingProfile.findUnique({
    where: { organizationId },
  });

  if (!profile) {
    return null;
  }

  return {
    organizationId,
    billingEmail: profile.billingEmail,
    paymentMethod: profile.paymentMethod ?? undefined,
    defaultPaymentMethodId: profile.defaultPaymentMethodId ?? undefined,
    autoPay: profile.autoPay,
    taxRate: profile.taxRate ? Number(profile.taxRate) : undefined,
    currency: profile.currency ?? 'USD',
    stripeCustomerId: profile.stripeCustomerId ?? undefined,
    stripePortalUrl: profile.stripePortalUrl ?? undefined,
    metadata: jsonValueToRecord(profile.metadata),
  };
}

export async function createInvoice(request: CreateInvoiceRequest): Promise<Invoice> {
  const periodStart = new Date(request.periodStart);
  const periodEnd = new Date(request.periodEnd);

  const rawItems = request.items ?? buildInvoiceItems(request.costMetrics, request.costEvents);
  const items = rawItems.map((item) => ({
    ...item,
    id: item.id ?? randomUUID(),
  }));

  const subtotal = items.reduce((sum, item) => sum + item.total, 0);

  const profile = await prisma.billingProfile.findUnique({
    where: { organizationId: request.organizationId },
  });

  const taxRate = profile?.taxRate ? Number(profile.taxRate) : 0;
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;
  const currency = request.currency ?? profile?.currency ?? 'USD';

  const invoice = await prisma.$transaction(async (tx) => {
    const invoiceMetadata = toInputJson(request.metadata) ?? Prisma.JsonNull;
    const createdInvoice = await tx.invoice.create({
      data: {
        organizationId: request.organizationId,
        periodStart,
        periodEnd,
        subtotal: new Prisma.Decimal(subtotal),
        tax: new Prisma.Decimal(tax),
        total: new Prisma.Decimal(total),
        currency,
        status: 'pending_stripe_sync', // I1 fix: saga pattern — starts as pending, transitions on Stripe result
        dueDate: new Date(periodEnd.getTime() + 30 * 24 * 60 * 60 * 1000),
        metadata: invoiceMetadata,
      },
    });

    if (items.length > 0) {
      await tx.invoiceItem.createMany({
        data: items.map((item) => ({
          id: item.id ?? randomUUID(),
          invoiceId: createdInvoice.id,
          description: item.description,
          quantity: item.quantity,
          unitPrice: new Prisma.Decimal(item.unitPrice),
          total: new Prisma.Decimal(item.total),
          metadata: toInputJson(item.metadata) ?? Prisma.JsonNull,
          billingPriceId:
            item.metadata && typeof item.metadata.billingPriceId === 'string'
              ? item.metadata.billingPriceId
              : null,
          stripePriceId:
            item.metadata && typeof item.metadata.stripePriceId === 'string'
              ? item.metadata.stripePriceId
              : undefined,
        })),
      });
    }

    return createdInvoice;
  });

  let stripeCustomerId = profile?.stripeCustomerId ?? undefined;

  // I1 fix (RFC-006): Saga pattern — Stripe calls wrapped with status tracking.
  // On success: status → stripe_synced/paid. On failure: status → stripe_sync_failed + lastError.
  // Reconciliation job queries WHERE status='pending_stripe_sync' AND updated_at < 5min to retry.
  if (isStripeEnabled()) {
    try {
      const metadataBillingEmail =
        typeof request.metadata?.billingEmail === 'string'
          ? request.metadata.billingEmail
          : undefined;
      stripeCustomerId =
        stripeCustomerId ??
        (await ensureStripeCustomerId(
          request.organizationId,
          profile?.billingEmail ?? metadataBillingEmail ?? request.organizationId
        ));

      if (stripeCustomerId) {
        for (const item of items) {
          const rawBillingPriceId = item.metadata?.billingPriceId;
          const billingPriceId = typeof rawBillingPriceId === 'string' ? rawBillingPriceId : null;
          let stripePriceId =
            typeof item.metadata?.stripePriceId === 'string'
              ? item.metadata.stripePriceId
              : undefined;

          if (!stripePriceId && billingPriceId) {
            const billingPrice = await getBillingPrice(billingPriceId);
            stripePriceId = billingPrice?.stripePriceId;
          }

          const invoiceItemMetadata: Record<string, string> = {
            invoice_id: invoice.id,
          };
          if (billingPriceId) {
            invoiceItemMetadata.billing_price_id = billingPriceId;
          }

          await stripeCreateInvoiceItem({
            customerId: stripeCustomerId,
            priceId: stripePriceId,
            amount: stripePriceId ? undefined : Math.round(item.total * 100),
            currency: stripePriceId ? undefined : currency,
            description: item.description,
            quantity: item.quantity,
            metadata: invoiceItemMetadata,
          });
        }

        const stripeInvoice = await stripeCreateInvoice({
          customerId: stripeCustomerId,
          metadata: {
            invoice_id: invoice.id,
            organization_id: request.organizationId,
          },
        });

        const finalizedInvoice = await stripeFinalizeInvoice(stripeInvoice.id);
        let syncedInvoice = finalizedInvoice;

        if (config.payments.stripe.invoiceCollectionMethod === 'charge_automatically') {
          try {
            syncedInvoice = await stripePayInvoice(finalizedInvoice.id);
          } catch (error) {
            log.warn({ invoiceId: finalizedInvoice.id, error }, 'Stripe auto-payment failed');
          }
        }

        const paymentIntent =
          typeof syncedInvoice.payment_intent === 'string'
            ? syncedInvoice.payment_intent
            : syncedInvoice.payment_intent?.id;

        // I1 fix: Mark as stripe_synced (or paid) — saga success path
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            stripeInvoiceId: syncedInvoice.id,
            stripePaymentIntentId: paymentIntent ?? null,
            stripeCustomerId,
            hostedInvoiceUrl: syncedInvoice.hosted_invoice_url ?? null,
            status: mapStripeInvoiceStatus(syncedInvoice.status),
            paidAt:
              syncedInvoice.status === 'paid' && syncedInvoice.status_transitions?.paid_at
                ? new Date(syncedInvoice.status_transitions.paid_at * 1000)
                : invoice.paidAt,
            lastSyncedAt: new Date(),
            lastError: null, // Clear any previous error
          },
        });
      }
    } catch (stripeError: unknown) {
      // I1 fix: Saga failure path — mark as stripe_sync_failed for reconciliation
      const errorMessage = stripeError instanceof Error ? stripeError.message : String(stripeError);
      log.error({ invoiceId: invoice.id, error: errorMessage }, 'Stripe sync failed — invoice marked for reconciliation');
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: 'stripe_sync_failed',
          lastError: errorMessage,
        },
      }).catch((updateErr) => {
        log.error({ invoiceId: invoice.id, updateErr: serializeError(updateErr) }, 'Failed to mark invoice as stripe_sync_failed');
      });
      // Don't re-throw — the DB invoice exists, reconciliation job will retry
    }
  }

  const freshInvoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoice.id },
    include: { items: true },
  });

  const invoiceDto = mapInvoiceRecord(freshInvoice);
  billingInvoicesTotal.inc({
    source: stripeCustomerId ? 'stripe' : 'manual',
    status: invoiceDto.status,
  });
  billingRevenueUsd.inc(invoiceDto.total);

  return invoiceDto;
}

export async function createUsageInvoiceFromUsage(
  organizationId: string,
  periodStart: Date,
  periodEnd: Date
): Promise<Invoice | null> {
  const existing = await prisma.invoice.findFirst({
    where: {
      organizationId,
      periodStart,
      periodEnd,
    },
    include: { items: true },
  });

  if (existing) {
    return mapInvoiceRecord(existing as InvoiceWithItems);
  }

  const { metrics, events } = await aggregateUsageCosts({
    organizationId,
    periodStart,
    periodEnd,
  });

  if (!events.length && (!metrics.totalCost || metrics.totalCost <= 0)) {
    return null;
  }

  const invoice = await createInvoice({
    organizationId,
    periodStart: periodStart.getTime(),
    periodEnd: periodEnd.getTime(),
    costMetrics: metrics,
    costEvents: events,
    metadata: {
      source: 'usage_reconciliation',
      node: 'auto',
      total_cost: metrics.totalCost,
      event_count: events.length,
    },
  });

  return invoice;
}

export async function listInvoices(organizationId: string): Promise<Invoice[]> {
  const invoices = await prisma.invoice.findMany({
    where: { organizationId },
    include: { items: true },
    orderBy: { periodStart: 'desc' },
  });

  return invoices.map(mapInvoiceRecord);
}

export async function getInvoice(
  organizationId: string,
  invoiceId: string
): Promise<Invoice | null> {
  const invoice = await prisma.invoice.findFirst({
    where: {
      organizationId,
      id: invoiceId,
    },
    include: { items: true },
  });

  if (!invoice) {
    return null;
  }

  return mapInvoiceRecord(invoice);
}

function mapInvoiceRecord(invoice: InvoiceWithItems): Invoice {
  return {
    id: invoice.id,
    organizationId: invoice.organizationId,
    periodStart: invoice.periodStart.getTime(),
    periodEnd: invoice.periodEnd.getTime(),
    items: invoice.items.map((item) => {
      const itemMetadata = jsonValueToRecord(item.metadata) ?? {};
      return {
        id: item.id,
        description: item.description,
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        total: Number(item.total),
        metadata: {
          ...itemMetadata,
          billingPriceId: item.billingPriceId ?? undefined,
          stripePriceId: item.stripePriceId ?? undefined,
        },
      };
    }),
    subtotal: Number(invoice.subtotal),
    tax: Number(invoice.tax),
    total: Number(invoice.total),
    currency: invoice.currency,
    status: invoice.status as Invoice['status'],
    dueDate: invoice.dueDate.getTime(),
    createdAt: invoice.createdAt.getTime(),
    paidAt: invoice.paidAt?.getTime(),
    hostedInvoiceUrl: invoice.hostedInvoiceUrl ?? undefined,
    stripeInvoiceId: invoice.stripeInvoiceId ?? undefined,
    stripePaymentIntentId: invoice.stripePaymentIntentId ?? undefined,
    stripeCustomerId: invoice.stripeCustomerId ?? undefined,
    lastSyncedAt: invoice.lastSyncedAt?.getTime(),
    metadata: jsonValueToRecord(invoice.metadata),
  };
}

export async function markInvoicePaid(organizationId: string, invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId },
  });

  if (!invoice) {
    return;
  }

  let paidAt = new Date();
  let status: Invoice['status'] = 'paid';
  let paymentIntentId: string | null = invoice.stripePaymentIntentId ?? null;

  if (isStripeEnabled() && invoice.stripeInvoiceId) {
    try {
      const paidStripeInvoice = await stripePayInvoice(invoice.stripeInvoiceId);
      const refreshed = await stripeRetrieveInvoice(paidStripeInvoice.id);
      status = mapStripeInvoiceStatus(refreshed.status);
      paymentIntentId =
        typeof refreshed.payment_intent === 'string'
          ? refreshed.payment_intent
          : (refreshed.payment_intent?.id ?? null);
      paidAt =
        refreshed.status === 'paid' && refreshed.status_transitions?.paid_at
          ? new Date(refreshed.status_transitions.paid_at * 1000)
          : paidAt;
    } catch (error) {
      log.error(
        { invoiceId: invoice.stripeInvoiceId, error },
        'Failed to mark Stripe invoice as paid'
      );
      throw error;
    }
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status,
      paidAt,
      stripePaymentIntentId: paymentIntentId,
      lastSyncedAt: new Date(),
    },
  });
}

export async function createSubscription(
  request: SubscriptionRequest
): Promise<BillingSubscription> {
  const billingPrice = request.priceId ? await getBillingPrice(request.priceId) : null;
  const currency = billingPrice?.currency ?? request.currency ?? 'USD';
  const amount = billingPrice?.amount ?? request.amount ?? 0;
  const billingCycle = billingPrice?.billingCycle ?? request.billingCycle;

  const profile = await prisma.billingProfile.findUnique({
    where: { organizationId: request.organizationId },
  });

  let stripeCustomerId = profile?.stripeCustomerId ?? undefined;
  if (isStripeEnabled()) {
    stripeCustomerId =
      stripeCustomerId ??
      (await ensureStripeCustomerId(
        request.organizationId,
        profile?.billingEmail ?? request.organizationId
      ));
  }

  let stripeSubscription: Stripe.Subscription | undefined;
  if (
    isStripeEnabled() &&
    stripeCustomerId &&
    (billingPrice?.stripePriceId ||
      (request.metadata && typeof request.metadata.stripePriceId === 'string'))
  ) {
    const stripePriceId =
      billingPrice?.stripePriceId ?? (request.metadata as Record<string, string>).stripePriceId;
    const subscriptionMetadata: Record<string, string> = {
      organization_id: request.organizationId,
      subscription_plan: request.plan,
    };
    if (billingPrice?.id) {
      subscriptionMetadata.billing_price_id = billingPrice.id;
    }

    stripeSubscription = await stripeCreateSubscription({
      customerId: stripeCustomerId,
      priceId: stripePriceId!,
      trialDays: request.trialDays,
      defaultPaymentMethodId:
        request.paymentMethodId ?? profile?.defaultPaymentMethodId ?? undefined,
      cancelAtPeriodEnd: request.cancelAtPeriodEnd,
      metadata: subscriptionMetadata,
    });
  }

  const subscription = await prisma.billingSubscription.create({
    data: {
      organizationId: request.organizationId,
      plan: request.plan,
      status: stripeSubscription
        ? mapStripeSubscriptionStatus(stripeSubscription.status)
        : 'active',
      billingCycle,
      amount: new Prisma.Decimal(amount),
      currency,
      startDate: stripeSubscription?.start_date
        ? new Date(stripeSubscription.start_date * 1000)
        : new Date(),
      endDate: stripeSubscription?.ended_at
        ? new Date(stripeSubscription.ended_at * 1000)
        : undefined,
      paymentMethodId: request.paymentMethodId ?? null,
      metadata: toInputJson(request.metadata) ?? Prisma.JsonNull,
      priceId: billingPrice?.id ?? request.priceId ?? null,
      currentPeriodStart: stripeSubscription?.current_period_start
        ? new Date(stripeSubscription.current_period_start * 1000)
        : undefined,
      currentPeriodEnd: stripeSubscription?.current_period_end
        ? new Date(stripeSubscription.current_period_end * 1000)
        : undefined,
      cancelAtPeriodEnd:
        stripeSubscription?.cancel_at_period_end ?? request.cancelAtPeriodEnd ?? false,
      stripeSubscriptionId: stripeSubscription?.id ?? null,
      stripeCustomerId: stripeCustomerId ?? null,
      stripeStatus: stripeSubscription?.status ?? null,
      stripeDefaultPaymentMethodId:
        typeof stripeSubscription?.default_payment_method === 'string'
          ? stripeSubscription.default_payment_method
          : ((stripeSubscription?.default_payment_method as Stripe.PaymentMethod | undefined)?.id ??
            null),
    },
  });

  const subscriptionWithPrice = await prisma.billingSubscription.findUniqueOrThrow({
    where: { id: subscription.id },
    include: { price: true },
  });

  billingSubscriptionEvents.inc({ event: 'created' });

  return mapSubscriptionRecord(subscriptionWithPrice);
}

export async function listSubscriptions(organizationId: string): Promise<BillingSubscription[]> {
  const subscriptions = await prisma.billingSubscription.findMany({
    where: { organizationId },
    include: { price: true },
    orderBy: { createdAt: 'desc' },
  });

  return subscriptions.map(mapSubscriptionRecord);
}

export async function cancelSubscription(
  organizationId: string,
  subscriptionId: string,
  cancelAtPeriodEnd: boolean
): Promise<void> {
  const subscription = await prisma.billingSubscription.findFirst({
    where: { id: subscriptionId, organizationId },
  });

  if (!subscription) {
    return;
  }

  let stripeStatus: BillingSubscription['status'] = 'cancelled';
  let endDate = cancelAtPeriodEnd ? undefined : new Date();

  if (isStripeEnabled() && subscription.stripeSubscriptionId) {
    const cancelled = await stripeCancelSubscription(
      subscription.stripeSubscriptionId,
      cancelAtPeriodEnd
    );
    stripeStatus = mapStripeSubscriptionStatus(cancelled.status);
    endDate = cancelled.ended_at ? new Date(cancelled.ended_at * 1000) : endDate;
  }

  await prisma.billingSubscription.update({
    where: { id: subscriptionId },
    data: {
      status: stripeStatus,
      endDate,
      cancelAtPeriodEnd,
      updatedAt: new Date(),
      stripeStatus:
        isStripeEnabled() && subscription.stripeSubscriptionId
          ? stripeStatus
          : subscription.stripeStatus,
    },
  });

  billingSubscriptionEvents.inc({ event: cancelAtPeriodEnd ? 'cancel_requested' : 'cancelled' });
}

function mapSubscriptionRecord(subscription: SubscriptionWithPrice): BillingSubscription {
  return {
    id: subscription.id,
    organizationId: subscription.organizationId,
    plan: subscription.plan,
    status: subscription.status as BillingSubscription['status'],
    billingCycle: subscription.billingCycle as BillingSubscription['billingCycle'],
    amount: Number(subscription.amount),
    currency: subscription.currency,
    startDate: subscription.startDate.getTime(),
    endDate: subscription.endDate?.getTime(),
    priceId: subscription.priceId ?? undefined,
    stripeSubscriptionId: subscription.stripeSubscriptionId ?? undefined,
    stripeCustomerId: subscription.stripeCustomerId ?? undefined,
    stripeStatus: subscription.stripeStatus ?? undefined,
    currentPeriodStart: subscription.currentPeriodStart?.getTime(),
    currentPeriodEnd: subscription.currentPeriodEnd?.getTime(),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? undefined,
    defaultPaymentMethodId: subscription.stripeDefaultPaymentMethodId ?? undefined,
    metadata: jsonValueToRecord(subscription.metadata),
    price: subscription.price ? mapBillingPriceEntity(subscription.price) : undefined,
  };
}

function buildInvoiceItems(metrics?: CostMetrics, events?: CostEvent[]): InvoiceItem[] {
  if (events && events.length > 0) {
    return events.map((event) => ({
      description: event.category
        ? `${event.category} (${event.model ?? 'usage'})`
        : `Usage ${event.model ?? ''}`.trim(),
      quantity: 1,
      unitPrice: event.cost,
      total: event.cost,
      metadata: {
        tokensUsed: event.tokensUsed,
        model: event.model,
        category: event.category,
      },
    }));
  }

  if (metrics) {
    return Object.entries(metrics.costByModel ?? {}).map(([model, cost]) => ({
      description: `API usage - ${model}`,
      quantity: 1,
      unitPrice: cost,
      total: cost,
      metadata: {
        model,
        tokenUsage: metrics.tokenUsage,
      },
    }));
  }

  return [];
}

type BillingPriceRecord = {
  id: string;
  billingPlanId: string;
  stripePriceId: string | null;
  currency: string;
  amount: Prisma.Decimal;
  billingCycle: string;
  intervalCount: number;
  usageType: string;
  taxBehavior: string | null;
  active: boolean;
  metadata: Prisma.JsonValue | null;
};

function mapBillingPriceEntity(
  price: BillingPriceRecord | null | undefined
): BillingPrice | undefined {
  if (!price) return undefined;
  return {
    id: price.id,
    billingPlanId: price.billingPlanId,
    stripePriceId: price.stripePriceId ?? undefined,
    currency: price.currency,
    amount: Number(price.amount),
    billingCycle: price.billingCycle as BillingPrice['billingCycle'],
    intervalCount: price.intervalCount,
    usageType: price.usageType as BillingPrice['usageType'],
    taxBehavior: price.taxBehavior ?? undefined,
    active: price.active,
    metadata: jsonValueToRecord(price.metadata),
  };
}

export async function createSetupIntentForOrganization(
  organizationId: string
): Promise<BillingSetupIntent> {
  if (!isStripeEnabled()) {
    throw new ApplicationError(
      'Stripe integration is not configured on this server',
      503,
      'stripe_disabled'
    );
  }

  const profile = await prisma.billingProfile.findUnique({
    where: { organizationId },
  });

  if (!profile) {
    throw new ResourceNotFoundError('BillingProfile', organizationId);
  }

  const customerId =
    profile.stripeCustomerId ??
    (await ensureStripeCustomerId(organizationId, profile.billingEmail));

  if (!customerId) {
    throw new ApplicationError(
      'Unable to create Stripe customer for organization',
      502,
      'stripe_customer_create_failed',
      { organizationId }
    );
  }

  const setupIntent = await stripeCreateSetupIntent({
    customerId,
  });

  if (!setupIntent.client_secret) {
    throw new ApplicationError(
      'Stripe did not return a setup intent client secret',
      502,
      'stripe_setup_intent_invalid',
      { customerId }
    );
  }

  return {
    clientSecret: setupIntent.client_secret,
    customerId,
  };
}

export async function listPaymentMethodsForOrganization(
  organizationId: string
): Promise<BillingPaymentMethod[]> {
  if (!isStripeEnabled()) {
    return [];
  }

  const profile = await prisma.billingProfile.findUnique({
    where: { organizationId },
  });

  if (!profile?.stripeCustomerId) {
    return [];
  }

  const methods = await stripeListPaymentMethods(profile.stripeCustomerId);
  return methods.data.map((method) =>
    mapPaymentMethod(method, method.id === profile.defaultPaymentMethodId)
  );
}

export async function attachPaymentMethodToOrganization(
  organizationId: string,
  paymentMethodId: string,
  setDefault: boolean
): Promise<BillingPaymentMethod> {
  if (!isStripeEnabled()) {
    throw new ApplicationError(
      'Stripe integration is not configured on this server',
      503,
      'stripe_disabled'
    );
  }

  const profile = await prisma.billingProfile.findUnique({
    where: { organizationId },
  });
  if (!profile) {
    throw new ResourceNotFoundError('BillingProfile', organizationId);
  }

  const customerId =
    profile.stripeCustomerId ??
    (await ensureStripeCustomerId(organizationId, profile.billingEmail));

  if (!customerId) {
    throw new ApplicationError(
      'Unable to resolve Stripe customer for organization',
      502,
      'stripe_customer_resolve_failed',
      { organizationId }
    );
  }

  const paymentMethod = await stripeAttachPaymentMethod({
    customerId,
    paymentMethodId,
    setDefault,
  });

  if (setDefault) {
    await prisma.billingProfile.update({
      where: { organizationId },
      data: { defaultPaymentMethodId: paymentMethod.id },
    });
  }

  return mapPaymentMethod(paymentMethod, setDefault);
}

export async function detachPaymentMethodFromOrganization(
  organizationId: string,
  paymentMethodId: string
): Promise<void> {
  if (!isStripeEnabled()) {
    return;
  }

  const profile = await prisma.billingProfile.findUnique({
    where: { organizationId },
  });
  if (!profile?.stripeCustomerId) {
    return;
  }

  await stripeDetachPaymentMethod(paymentMethodId);

  if (profile.defaultPaymentMethodId === paymentMethodId) {
    await prisma.billingProfile.update({
      where: { organizationId },
      data: { defaultPaymentMethodId: null },
    });
  }
}

function mapPaymentMethod(method: Stripe.PaymentMethod, isDefault: boolean): BillingPaymentMethod {
  if (method.type === 'card') {
    const card = method.card;
    return {
      id: method.id,
      brand: card?.brand,
      last4: card?.last4,
      expMonth: card?.exp_month,
      expYear: card?.exp_year,
      funding: card?.funding,
      country: card?.country ?? undefined,
      customerId: typeof method.customer === 'string' ? method.customer : undefined,
      default: isDefault,
    };
  }

  return {
    id: method.id,
    brand: undefined,
    last4: undefined,
    expMonth: undefined,
    expYear: undefined,
    funding: undefined,
    country: undefined,
    customerId: typeof method.customer === 'string' ? method.customer : undefined,
    default: isDefault,
  };
}

export async function listAvailableBillingPlans(refresh = false): Promise<BillingPlan[]> {
  if (refresh && config.payments.stripe.enabled) {
    try {
      await syncStripeCatalog();
    } catch (error) {
      log.error({ error }, 'Failed to refresh Stripe catalog during plan listing');
    }
  }
  return listBillingPlans();
}

export async function syncInvoiceFromStripe(invoice: Stripe.Invoice): Promise<void> {
  const localInvoice =
    (invoice.metadata?.invoice_id &&
      (await prisma.invoice.findUnique({ where: { id: invoice.metadata.invoice_id } }))) ||
    (await prisma.invoice.findFirst({ where: { stripeInvoiceId: invoice.id } }));

  if (!localInvoice) {
    log.warn({ stripeInvoiceId: invoice.id }, 'Received Stripe invoice for unknown local invoice');
    return;
  }

  const paymentIntentId =
    typeof invoice.payment_intent === 'string'
      ? invoice.payment_intent
      : (invoice.payment_intent?.id ?? null);

  const status = mapStripeInvoiceStatus(invoice.status);

  await prisma.invoice.update({
    where: { id: localInvoice.id },
    data: {
      stripeInvoiceId: invoice.id,
      stripePaymentIntentId: paymentIntentId,
      stripeCustomerId:
        typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id ?? null),
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      status,
      paidAt:
        invoice.status === 'paid' && invoice.status_transitions?.paid_at
          ? new Date(invoice.status_transitions.paid_at * 1000)
          : localInvoice.paidAt,
      dueDate: invoice.due_date ? new Date(invoice.due_date * 1000) : localInvoice.dueDate,
      lastSyncedAt: new Date(),
    },
  });

  billingInvoicesTotal.inc({
    source: 'webhook',
    status,
  });
}

function intervalToBillingCycle(
  interval?: Stripe.Price.Recurring.Interval | null
): BillingSubscription['billingCycle'] {
  return interval === 'year' ? 'yearly' : 'monthly';
}

export async function syncSubscriptionFromStripe(subscription: Stripe.Subscription): Promise<void> {
  const localSubscription =
    (subscription.metadata?.subscription_id &&
      (await prisma.billingSubscription.findUnique({
        where: { id: subscription.metadata.subscription_id },
      }))) ||
    (await prisma.billingSubscription.findFirst({
      where: { stripeSubscriptionId: subscription.id },
    }));

  if (!localSubscription) {
    log.warn(
      { stripeSubscriptionId: subscription.id },
      'Received Stripe subscription without local record'
    );
    return;
  }

  const stripeItem = subscription.items.data[0];
  let billingPriceId = localSubscription.priceId;

  if (stripeItem?.price?.id) {
    const billingPrice = await prisma.billingPrice.findUnique({
      where: { stripePriceId: stripeItem.price.id },
    });
    if (billingPrice) {
      billingPriceId = billingPrice.id;
    }
  }

  await prisma.billingSubscription.update({
    where: { id: localSubscription.id },
    data: {
      status: mapStripeSubscriptionStatus(subscription.status),
      stripeStatus: subscription.status,
      currentPeriodStart: subscription.current_period_start
        ? new Date(subscription.current_period_start * 1000)
        : null,
      currentPeriodEnd: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      stripeCustomerId:
        typeof subscription.customer === 'string'
          ? subscription.customer
          : (subscription.customer?.id ?? null),
      stripeSubscriptionId: subscription.id,
      stripeDefaultPaymentMethodId:
        typeof subscription.default_payment_method === 'string'
          ? subscription.default_payment_method
          : ((subscription.default_payment_method as Stripe.PaymentMethod | undefined)?.id ?? null),
      amount:
        stripeItem?.price?.unit_amount != null
          ? new Prisma.Decimal(stripeItem.price.unit_amount / 100)
          : localSubscription.amount,
      currency: stripeItem?.price?.currency ?? localSubscription.currency,
      billingCycle: intervalToBillingCycle(stripeItem?.price?.recurring?.interval),
      priceId: billingPriceId ?? null,
      updatedAt: new Date(),
    },
  });

  billingSubscriptionEvents.inc({ event: 'webhook' });
}
