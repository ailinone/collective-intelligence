// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { Prisma, prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import {
  isStripeEnabled,
  listActiveProducts,
  listActivePrices,
} from '@/services/payments/stripe-gateway';
import type { BillingPlan, BillingPrice } from '@/types';
import type Stripe from 'stripe';
import { toInputJson } from '@/utils/json';

const log = logger.child({ service: 'billing-plan-service' });

function parseNumber(value?: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJson<T>(value?: string | null): T | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    log.warn({ value, error }, 'Failed to parse JSON metadata value');
    return undefined;
  }
}

function mapPlanStatus(active: boolean): BillingPlan['status'] {
  return active ? 'active' : 'inactive';
}

function mapBillingCycle(interval?: Stripe.Price.Recurring.Interval): BillingPrice['billingCycle'] {
  if (interval === 'year') return 'yearly';
  return 'monthly';
}

function mapUsageType(
  usageType?: Stripe.Price.Recurring.UsageType | null
): BillingPrice['usageType'] {
  if (usageType === 'metered') {
    return 'metered';
  }
  return 'licensed';
}

function jsonToRecord(
  value: Prisma.JsonValue | null | undefined
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export async function syncStripeCatalog(): Promise<{
  plansUpserted: number;
  pricesUpserted: number;
  plansDeactivated: number;
  pricesDeactivated: number;
}> {
  if (!isStripeEnabled()) {
    log.warn('Stripe integration disabled – skipping catalog sync');
    return { plansUpserted: 0, pricesUpserted: 0, plansDeactivated: 0, pricesDeactivated: 0 };
  }

  const [products, prices] = await Promise.all([listActiveProducts(), listActivePrices()]);

  const existingPlans = await prisma.billingPlan.findMany({
    select: { id: true, stripeProductId: true, status: true },
  });
  const existingPrices = await prisma.billingPrice.findMany({
    select: { id: true, stripePriceId: true, active: true },
  });

  const planMap = new Map<string, { id: string; status: string }>();
  existingPlans.forEach((plan) => {
    if (plan.stripeProductId) {
      planMap.set(plan.stripeProductId, plan);
    }
  });

  const priceMap = new Map<string, { id: string; active: boolean }>();
  existingPrices.forEach((price) => {
    if (price.stripePriceId) {
      priceMap.set(price.stripePriceId, price);
    }
  });

  let plansUpserted = 0;
  let pricesUpserted = 0;

  const activePlanIds = new Set<string>();
  const activePriceIds = new Set<string>();

  for (const product of products) {
    const organizationId = product.metadata?.organization_id ?? null;
    const features = parseJson<Record<string, unknown>>(product.metadata?.features) ?? undefined;
    const featuresInput = features ? toInputJson(features) : Prisma.JsonNull;
    const metadataInput = toInputJson(product.metadata) ?? Prisma.JsonNull;
    const trialDays =
      parseNumber(product.metadata?.trial_days) ??
      (product.default_price && typeof product.default_price === 'object'
        ? ((product.default_price as Stripe.Price).recurring?.trial_period_days ?? undefined)
        : undefined);

    const plan = await prisma.billingPlan.upsert({
      where: { stripeProductId: product.id },
      update: {
        organizationId: organizationId ? organizationId : null,
        name: product.name,
        description: product.description ?? undefined,
        tier: product.metadata?.tier,
        status: mapPlanStatus(product.active),
        features: featuresInput,
        trialDays: trialDays ?? null,
        metadata: metadataInput,
        updatedAt: new Date(),
      },
      create: {
        organizationId: organizationId ? organizationId : null,
        name: product.name,
        description: product.description ?? undefined,
        tier: product.metadata?.tier,
        status: mapPlanStatus(product.active),
        features: featuresInput,
        trialDays: trialDays ?? null,
        stripeProductId: product.id,
        metadata: metadataInput,
      },
    });

    activePlanIds.add(plan.id);
    plansUpserted += 1;
  }

  for (const price of prices) {
    if (!price.product || typeof price.product === 'string') {
      continue;
    }
    const product = price.product as Stripe.Product;

    const planRecord = await prisma.billingPlan.findUnique({
      where: { stripeProductId: product.id },
      select: { id: true },
    });
    if (!planRecord) {
      log.warn({ priceId: price.id, productId: product.id }, 'Skipping price without synced plan');
      continue;
    }

    const recurring = price.recurring;
    const amount =
      price.unit_amount != null
        ? price.unit_amount / 100
        : price.unit_amount_decimal
          ? Number(price.unit_amount_decimal) / 100
          : 0;

    const metadataInput = toInputJson(price.metadata) ?? Prisma.JsonNull;

    const upsertedPrice = await prisma.billingPrice.upsert({
      where: { stripePriceId: price.id },
      update: {
        billingPlanId: planRecord.id,
        currency: price.currency,
        amount: new Prisma.Decimal(amount),
        billingCycle: mapBillingCycle(recurring?.interval),
        intervalCount: recurring?.interval_count ?? 1,
        usageType: mapUsageType(recurring?.usage_type),
        taxBehavior: price.tax_behavior ?? undefined,
        active: price.active,
        metadata: metadataInput,
        updatedAt: new Date(),
      },
      create: {
        billingPlanId: planRecord.id,
        stripePriceId: price.id,
        currency: price.currency,
        amount: new Prisma.Decimal(amount),
        billingCycle: mapBillingCycle(recurring?.interval),
        intervalCount: recurring?.interval_count ?? 1,
        usageType: mapUsageType(recurring?.usage_type),
        taxBehavior: price.tax_behavior ?? undefined,
        active: price.active,
        metadata: metadataInput,
      },
    });

    activePriceIds.add(upsertedPrice.id);
    pricesUpserted += 1;
  }

  const plansDeactivated = await prisma.billingPlan.updateMany({
    where: {
      stripeProductId: { not: null },
      id: { notIn: Array.from(activePlanIds) },
      status: 'active',
    },
    data: {
      status: 'inactive',
    },
  });

  const pricesDeactivated = await prisma.billingPrice.updateMany({
    where: {
      stripePriceId: { not: null },
      id: { notIn: Array.from(activePriceIds) },
      active: true,
    },
    data: {
      active: false,
    },
  });

  log.info(
    {
      plansUpserted,
      pricesUpserted,
      plansDeactivated: plansDeactivated.count,
      pricesDeactivated: pricesDeactivated.count,
    },
    'Stripe catalog synchronised'
  );

  return {
    plansUpserted,
    pricesUpserted,
    plansDeactivated: plansDeactivated.count,
    pricesDeactivated: pricesDeactivated.count,
  };
}

export async function listBillingPlans(): Promise<BillingPlan[]> {
  const plans = await prisma.billingPlan.findMany({
    where: { status: { in: ['active', 'inactive'] } },
    orderBy: [{ status: 'desc' }, { name: 'asc' }],
    include: {
      prices: true,
    },
  });

  return plans.map((plan) => ({
    id: plan.id,
    organizationId: plan.organizationId ?? undefined,
    name: plan.name,
    description: plan.description ?? undefined,
    tier: plan.tier ?? undefined,
    status: plan.status as BillingPlan['status'],
    features: jsonToRecord(plan.features),
    trialDays: plan.trialDays ?? undefined,
    stripeProductId: plan.stripeProductId ?? undefined,
    metadata: jsonToRecord(plan.metadata),
    prices: plan.prices.map((price) => ({
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
      metadata: jsonToRecord(price.metadata),
    })),
  }));
}

export async function getBillingPrice(priceId: string): Promise<BillingPrice | null> {
  const price = await prisma.billingPrice.findUnique({
    where: { id: priceId },
  });
  if (!price) return null;
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
    metadata: jsonToRecord(price.metadata),
  };
}
