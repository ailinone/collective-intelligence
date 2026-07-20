// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { schedule, type ScheduledTask } from 'node-cron';
import { config } from '@/config';
import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { narrowAs } from '@/utils/type-guards';
import { createUsageInvoiceFromUsage } from '@/services/billing-service';

let reconciliationTask: ScheduledTask | null = null;

export function startBillingUsageReconciliationJob(): void {
  if (!config.payments.stripe.enabled) {
    logger.warn('Stripe billing disabled - usage reconciliation job not scheduled');
    return;
  }

  if (reconciliationTask) {
    return;
  }

  const cron = config.payments.stripe.usageReconciliationCron || '0 2 * * *';

  reconciliationTask = schedule(cron, async () => {
    try {
      await runUsageReconciliationCycle();
    } catch (error) {
      logger.error({ error }, 'Usage reconciliation job failed');
    }
  });

  logger.info({ cron }, 'Usage reconciliation job scheduled');
}

export async function stopBillingUsageReconciliationJob(): Promise<void> {
  if (reconciliationTask) {
    reconciliationTask.stop();
    reconciliationTask = null;
    logger.info('Usage reconciliation job stopped');
  }
}

export async function runUsageReconciliationCycle(referenceDate = new Date()): Promise<void> {
  // R9 fix: First, retry any stale invoices stuck in Stripe sync (billing saga recovery)
  try {
    await retryStaleStripeInvoices();
  } catch (err) {
    logger.error({ err }, 'Stale invoice reconciliation failed — continuing with usage reconciliation');
  }

  const { start, end } = previousDayWindow(referenceDate);

  const organizations = await prisma.usageEvent.findMany({
    where: {
      timestamp: {
        gte: start,
        lt: end,
      },
      eventType: 'chat.completion',
    },
    distinct: ['organizationId'],
    select: { organizationId: true },
  });

  if (!organizations.length) {
    logger.info(
      { periodStart: start.toISOString(), periodEnd: end.toISOString() },
      'No usage events found for reconciliation period'
    );
    return;
  }

  for (const org of organizations) {
    const organizationId = org.organizationId;
    try {
      const invoice = await createUsageInvoiceFromUsage(organizationId, start, end);
      if (invoice) {
        logger.info(
          {
            organizationId,
            invoiceId: invoice.id,
            periodStart: start.toISOString(),
            periodEnd: end.toISOString(),
            total: invoice.total,
          },
          'Usage invoice generated'
        );
      } else {
        logger.info(
          {
            organizationId,
            periodStart: start.toISOString(),
            periodEnd: end.toISOString(),
          },
          'Usage invoice skipped (no billable cost)'
        );
      }
    } catch (error) {
      logger.error(
        {
          error,
          organizationId,
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
        },
        'Failed to generate usage invoice'
      );
    }
  }
}

/**
 * R9 fix: Retry stale invoices stuck in 'pending_stripe_sync' or 'stripe_sync_failed'.
 * Queries for invoices that have been in these states for >5 minutes and attempts
 * to re-sync them with Stripe. This closes the billing saga recovery loop (RFC-006).
 */
async function retryStaleStripeInvoices(): Promise<void> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes stale threshold

  const staleInvoices = await prisma.invoice.findMany({
    where: {
      status: { in: ['pending_stripe_sync', 'stripe_sync_failed'] },
      updatedAt: { lt: cutoff },
    },
    take: 50, // Process in batches to avoid overload
    orderBy: { updatedAt: 'asc' },
  });

  if (staleInvoices.length === 0) return;

  logger.info({ count: staleInvoices.length }, 'Found stale invoices for Stripe reconciliation');

  for (const invoice of staleInvoices) {
    try {
      // If the invoice already has a stripeInvoiceId, it was partially synced — sync status from Stripe
      if (invoice.stripeInvoiceId) {
        const { syncInvoiceFromStripe } = await import('@/services/billing-service.js');
        // Fetch current status from Stripe
        const Stripe = (await import('stripe')).default;
        const { config: appConfig } = await import('@/config/index.js');
        const stripe = new Stripe(appConfig.payments.stripe.secretKey!, {
          apiVersion: appConfig.payments.stripe.apiVersion as import('stripe').Stripe.LatestApiVersion,
        });
        const stripeInvoice = await stripe.invoices.retrieve(invoice.stripeInvoiceId);
        await syncInvoiceFromStripe(narrowAs<import('stripe').Stripe.Invoice>(stripeInvoice));
        logger.info({ invoiceId: invoice.id, stripeId: invoice.stripeInvoiceId }, 'Stale invoice re-synced from Stripe');
      } else {
        // No stripeInvoiceId — the Stripe call never happened. Mark as failed for manual review.
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            status: 'stripe_sync_failed',
            lastError: `Stale pending_stripe_sync for ${Math.round((Date.now() - invoice.updatedAt.getTime()) / 60000)}min — Stripe invoice never created. Manual review required.`,
          },
        });
        logger.warn({ invoiceId: invoice.id }, 'Stale invoice without Stripe ID — marked as failed for manual review');
      }
    } catch (err) {
      logger.error({ invoiceId: invoice.id, err }, 'Failed to reconcile stale invoice');
    }
  }
}

function previousDayWindow(reference: Date): { start: Date; end: Date } {
  const end = startOfUtcDay(reference);
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - 1);
  return { start, end };
}

function startOfUtcDay(date: Date): Date {
  const start = new Date(date.getTime());
  start.setUTCHours(0, 0, 0, 0);
  return start;
}
