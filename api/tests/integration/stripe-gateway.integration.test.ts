// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Stripe from 'stripe';

describe('Stripe Gateway Integration (real API)', () => {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const runStripeIntegration =
    Boolean(stripeSecretKey) &&
    !['sk_test_mock', 'sk_live_mock', 'sk_test_placeholder'].includes(stripeSecretKey || '');
  const testIfStripeReady = runStripeIntegration ? it : it.skip;

  let stripe: Stripe;
  let upsertCustomer: typeof import('@/services/payments/stripe-gateway').upsertCustomer;
  let createSetupIntent: typeof import('@/services/payments/stripe-gateway').createSetupIntent;
  let createPortalSession: typeof import('@/services/payments/stripe-gateway').createPortalSession;
  let listActivePrices: typeof import('@/services/payments/stripe-gateway').listActivePrices;
  let listActiveProducts: typeof import('@/services/payments/stripe-gateway').listActiveProducts;
  const createdCustomerIds: string[] = [];
  const createdPaymentMethodIds: string[] = [];
  const createdProductIds: string[] = [];
  const createdPriceIds: string[] = [];

  beforeAll(async () => {
    if (!runStripeIntegration || !stripeSecretKey) {
      return;
    }

    process.env.STRIPE_ENABLED = process.env.STRIPE_ENABLED || 'true';
    process.env.STRIPE_API_VERSION = process.env.STRIPE_API_VERSION || '2024-06-20';
    process.env.STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || 'https://example.com/billing/success';
    process.env.STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL || 'https://example.com/billing/cancel';
    process.env.STRIPE_CUSTOMER_PORTAL_RETURN_URL =
      process.env.STRIPE_CUSTOMER_PORTAL_RETURN_URL || 'https://example.com/billing/portal';
    delete process.env.STRIPE_API_BASE_URL;

    stripe = new Stripe(stripeSecretKey, {
      apiVersion: process.env.STRIPE_API_VERSION as Stripe.LatestApiVersion,
    });

    const testProduct = await stripe.products.create({
      name: `Ailin Integration Product ${Date.now()}`,
      description: 'Temporary product for integration tests',
    });
    createdProductIds.push(testProduct.id);

    const testPrice = await stripe.prices.create({
      unit_amount: 1999,
      currency: 'usd',
      product: testProduct.id,
      recurring: { interval: 'month' },
    });
    createdPriceIds.push(testPrice.id);

    vi.resetModules();

    const gateway = await import('@/services/payments/stripe-gateway');
    upsertCustomer = gateway.upsertCustomer;
    createSetupIntent = gateway.createSetupIntent;
    createPortalSession = gateway.createPortalSession;
    listActivePrices = gateway.listActivePrices;
    listActiveProducts = gateway.listActiveProducts;
  }, 120000);

  afterAll(async () => {
    if (!runStripeIntegration) {
      return;
    }

    for (const paymentMethodId of createdPaymentMethodIds) {
      try {
        await stripe.paymentMethods.detach(paymentMethodId);
      } catch {
        // ignore cleanup errors
      }
    }

    for (const customerId of createdCustomerIds) {
      try {
        await stripe.customers.del(customerId);
      } catch {
        // ignore cleanup errors
      }
    }

    for (const priceId of createdPriceIds) {
      try {
        await stripe.prices.update(priceId, { active: false });
      } catch {
        // ignore cleanup errors
      }
    }

    for (const productId of createdProductIds) {
      try {
        await stripe.products.update(productId, { active: false });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  testIfStripeReady('creates and updates customers through Stripe', async () => {
    const created = await upsertCustomer({
      email: `integration+stripe-${Date.now()}@ailin.dev`,
      name: 'Stripe Integration Tester',
    });

    expect(created.id).toMatch(/^cus_/);
    createdCustomerIds.push(created.id);

    const updated = await upsertCustomer({
      customerId: created.id,
      email: `integration+stripe-updated-${Date.now()}@ailin.dev`,
      name: 'Stripe Integration Tester Updated',
      metadata: { tenant: 'enterprise' },
    });

    expect(updated.email).toContain('integration+stripe-updated');
    await stripe.customers.retrieve(created.id);
  }, 20000);

  testIfStripeReady('creates setup intents and portal sessions', async () => {
    const customer = await upsertCustomer({
      email: `integration+setup-${Date.now()}@ailin.dev`,
      name: 'Setup Intent Owner',
    });
    createdCustomerIds.push(customer.id);

    const setupIntent = await createSetupIntent({ customerId: customer.id });
    expect(setupIntent.id).toMatch(/^seti_/);
    expect(setupIntent.customer).toBe(customer.id);

    try {
      const session = await createPortalSession({
        customerId: customer.id,
        returnUrl: 'https://example.com/billing/dashboard',
      });

      expect(session.id).toMatch(/^bps_/);
      expect(session.url).toMatch(/^https?:\/\//);
    } catch (error) {
      if (
        error instanceof Stripe.errors.StripeInvalidRequestError &&
        typeof error.message === 'string' &&
        error.message.includes('default configuration')
      ) {
        expect(error.message).toContain('default configuration');
      } else {
        throw error;
      }
    }
  }, 20000);

  testIfStripeReady('lists catalog data from Stripe mock server', async () => {
    const prices = await listActivePrices();
    expect(Array.isArray(prices)).toBe(true);
    expect(prices.some((price) => createdPriceIds.includes(price.id))).toBe(true);

    const products = await listActiveProducts();
    expect(Array.isArray(products)).toBe(true);
    expect(products.some((product) => createdProductIds.includes(product.id))).toBe(true);
  }, 20000);

  testIfStripeReady('attaches payment method using raw Stripe client against mock server', async () => {
    const customer = await stripe.customers.create({
      email: `integration+payment-${Date.now()}@ailin.dev`,
    });
    createdCustomerIds.push(customer.id);

    const paymentMethod = await stripe.paymentMethods.create({
      type: 'card',
      card: { token: 'tok_visa' },
    });
    createdPaymentMethodIds.push(paymentMethod.id);

    const attached = await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id });
    expect(attached.id).toBe(paymentMethod.id);
  }, 20000);
});


