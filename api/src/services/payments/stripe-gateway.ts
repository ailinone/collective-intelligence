// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import Stripe from 'stripe';
import { config } from '@/config';
import { logger } from '@/utils/logger';

const stripeConfig = config.payments.stripe;
const log = logger.child({ component: 'stripe-gateway' });

let stripeClient: Stripe | null = null;

function ensureStripeClient(): Stripe {
  if (!stripeConfig.enabled) {
    throw new Error(
      'Stripe integration is disabled. Set STRIPE_ENABLED=true to activate payments.'
    );
  }
  if (!stripeConfig.secretKey) {
    throw new Error('Stripe secret key is not configured. Set STRIPE_SECRET_KEY.');
  }
  if (!stripeClient) {
    const options: Stripe.StripeConfig = {
      apiVersion: stripeConfig.apiVersion as Stripe.LatestApiVersion,
      maxNetworkRetries: 2,
      timeout: stripeConfig.clientRetryMs,
    };

    if (stripeConfig.apiBaseUrl) {
      const url = new URL(stripeConfig.apiBaseUrl);
      options.host = url.hostname;
      options.port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
      options.protocol = url.protocol.replace(':', '') as 'https' | 'http';
    }

    stripeClient = new Stripe(stripeConfig.secretKey, options);
    log.info({ apiVersion: stripeConfig.apiVersion }, 'Stripe client initialised');
  }
  return stripeClient;
}

export function isStripeEnabled(): boolean {
  return stripeConfig.enabled && !!stripeConfig.secretKey;
}

export async function upsertCustomer(params: {
  customerId?: string | null;
  email: string;
  name?: string;
  metadata?: Stripe.MetadataParam;
}): Promise<Stripe.Customer> {
  const stripe = ensureStripeClient();
  if (params.customerId) {
    return stripe.customers.update(params.customerId, {
      email: params.email,
      name: params.name,
      metadata: params.metadata,
    });
  }
  return stripe.customers.create({
    email: params.email,
    name: params.name,
    metadata: params.metadata,
  });
}

export async function createPortalSession(params: {
  customerId: string;
  returnUrl?: string;
}): Promise<Stripe.BillingPortal.Session> {
  const stripe = ensureStripeClient();
  return stripe.billingPortal.sessions.create({
    customer: params.customerId,
    return_url: params.returnUrl ?? stripeConfig.customerPortalReturnUrl ?? stripeConfig.successUrl,
  });
}

export async function createSetupIntent(params: {
  customerId: string;
  paymentMethodTypes?: string[];
}): Promise<Stripe.SetupIntent> {
  const stripe = ensureStripeClient();
  return stripe.setupIntents.create({
    customer: params.customerId,
    payment_method_types: params.paymentMethodTypes ?? ['card'],
  });
}

export async function attachPaymentMethod(params: {
  customerId: string;
  paymentMethodId: string;
  setDefault?: boolean;
}): Promise<Stripe.PaymentMethod> {
  const stripe = ensureStripeClient();
  const paymentMethod = await stripe.paymentMethods.attach(params.paymentMethodId, {
    customer: params.customerId,
  });
  if (params.setDefault) {
    await stripe.customers.update(params.customerId, {
      invoice_settings: {
        default_payment_method: params.paymentMethodId,
      },
    });
  }
  return paymentMethod;
}

export async function detachPaymentMethod(paymentMethodId: string): Promise<Stripe.PaymentMethod> {
  const stripe = ensureStripeClient();
  return stripe.paymentMethods.detach(paymentMethodId);
}

export interface StripeSubscriptionParams {
  customerId: string;
  priceId: string;
  quantity?: number;
  trialDays?: number;
  defaultPaymentMethodId?: string;
  metadata?: Stripe.MetadataParam;
  cancelAtPeriodEnd?: boolean;
}

export async function createSubscription(
  params: StripeSubscriptionParams
): Promise<Stripe.Subscription> {
  const stripe = ensureStripeClient();
  return stripe.subscriptions.create({
    customer: params.customerId,
    items: [
      {
        price: params.priceId,
        quantity: params.quantity ?? 1,
      },
    ],
    trial_period_days: params.trialDays,
    metadata: params.metadata,
    payment_behavior:
      stripeConfig.invoiceCollectionMethod === 'charge_automatically'
        ? 'default_incomplete'
        : 'pending_if_incomplete',
    collection_method: stripeConfig.invoiceCollectionMethod,
    days_until_due:
      stripeConfig.invoiceCollectionMethod === 'send_invoice'
        ? stripeConfig.invoiceDaysUntilDue
        : undefined,
    cancel_at_period_end: params.cancelAtPeriodEnd ?? false,
    default_payment_method: params.defaultPaymentMethodId,
    automatic_tax: { enabled: stripeConfig.automaticTax },
  });
}

export async function updateSubscription(
  subscriptionId: string,
  update: Stripe.SubscriptionUpdateParams
): Promise<Stripe.Subscription> {
  const stripe = ensureStripeClient();
  return stripe.subscriptions.update(subscriptionId, update);
}

export async function cancelSubscription(
  subscriptionId: string,
  cancelAtPeriodEnd: boolean
): Promise<Stripe.Subscription> {
  const stripe = ensureStripeClient();
  if (cancelAtPeriodEnd) {
    return stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  }
  return stripe.subscriptions.cancel(subscriptionId);
}

export async function retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  const stripe = ensureStripeClient();
  return stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['latest_invoice.payment_intent', 'items.data.price.product'],
  });
}

export async function listActivePrices(): Promise<Stripe.Price[]> {
  const stripe = ensureStripeClient();
  const prices: Stripe.Price[] = [];
  let startingAfter: string | undefined;

  do {
    const page = await stripe.prices.list({
      active: true,
      limit: 100,
      expand: ['data.product'],
      starting_after: startingAfter,
    });
    prices.push(...page.data);
    startingAfter = page.has_more ? page.data[page.data.length - 1].id : undefined;
  } while (startingAfter);

  return prices;
}

export async function listActiveProducts(): Promise<Stripe.Product[]> {
  const stripe = ensureStripeClient();
  const products: Stripe.Product[] = [];
  let startingAfter: string | undefined;

  do {
    const page = await stripe.products.list({
      active: true,
      limit: 100,
      starting_after: startingAfter,
    });
    products.push(...page.data);
    startingAfter = page.has_more ? page.data[page.data.length - 1].id : undefined;
  } while (startingAfter);

  return products;
}

export async function createInvoice(params: {
  customerId: string;
  autoAdvance?: boolean;
  collectionMethod?: Stripe.InvoiceCreateParams.CollectionMethod;
  daysUntilDue?: number;
  metadata?: Stripe.MetadataParam;
}): Promise<Stripe.Invoice> {
  const stripe = ensureStripeClient();
  return stripe.invoices.create({
    customer: params.customerId,
    auto_advance: params.autoAdvance ?? true,
    collection_method: params.collectionMethod ?? stripeConfig.invoiceCollectionMethod,
    days_until_due:
      params.collectionMethod === 'send_invoice'
        ? (params.daysUntilDue ?? stripeConfig.invoiceDaysUntilDue)
        : undefined,
    metadata: params.metadata,
  });
}

export async function createInvoiceItem(params: {
  customerId: string;
  priceId?: string;
  amount?: number;
  currency?: string;
  description?: string;
  quantity?: number;
  metadata?: Stripe.MetadataParam;
}): Promise<Stripe.InvoiceItem> {
  const stripe = ensureStripeClient();
  return stripe.invoiceItems.create({
    customer: params.customerId,
    price: params.priceId,
    amount: params.priceId ? undefined : params.amount,
    currency: params.priceId ? undefined : (params.currency ?? stripeConfig.defaultCurrency),
    description: params.description,
    quantity: params.quantity,
    metadata: params.metadata,
  });
}

export async function finalizeInvoice(invoiceId: string): Promise<Stripe.Invoice> {
  const stripe = ensureStripeClient();
  return stripe.invoices.finalizeInvoice(invoiceId);
}

export async function payInvoice(invoiceId: string): Promise<Stripe.Invoice> {
  const stripe = ensureStripeClient();
  return stripe.invoices.pay(invoiceId, {
    paid_out_of_band: stripeConfig.invoiceCollectionMethod === 'send_invoice',
  });
}

export async function retrieveInvoice(invoiceId: string): Promise<Stripe.Invoice> {
  const stripe = ensureStripeClient();
  return stripe.invoices.retrieve(invoiceId, {
    expand: ['payment_intent', 'lines.data.price.product'],
  });
}

export async function listPaymentMethods(
  customerId: string
): Promise<Stripe.ApiList<Stripe.PaymentMethod>> {
  const stripe = ensureStripeClient();
  return stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
  });
}

export async function createCustomerPortalSession(customerId: string, returnUrl?: string) {
  return createPortalSession({ customerId, returnUrl });
}

export function getStripeClient(): Stripe | null {
  return stripeClient;
}
