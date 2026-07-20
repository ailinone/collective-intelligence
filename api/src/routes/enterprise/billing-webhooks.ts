// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { config } from '@/config';
import { logger } from '@/utils/logger';
import { syncInvoiceFromStripe, syncSubscriptionFromStripe } from '@/services/billing-service';
import { prisma } from '@/database/client';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

const log = logger.child({ route: 'stripe-webhook' });

export async function registerBillingWebhookRoutes(server: FastifyInstance): Promise<void> {
  server.post(
    '/v1/billing/webhooks/stripe',
    {
      config: {
        rawBody: true,
      },
      schema: {
        hide: true,
      },
    },
    async (request, reply) => {
      if (!config.payments.stripe.enabled || !config.payments.stripe.webhookSecret) {
        return reply.status(503).send({ message: 'Stripe payments disabled' });
      }

      const signature = request.headers['stripe-signature'];
      if (!signature) {
        return reply.status(400).send({ message: 'Missing Stripe-Signature header' });
      }

      const extendedRequest = request as ExtendedFastifyRequest & { rawBody?: Buffer };
      const rawBody = extendedRequest.rawBody;
      if (!rawBody || !Buffer.isBuffer(rawBody)) {
        return reply.status(400).send({ message: 'Raw body not available for verification' });
      }

      let event: Stripe.Event;
      try {
        const stripe = new Stripe(config.payments.stripe.secretKey!, {
          apiVersion: config.payments.stripe.apiVersion as Stripe.LatestApiVersion,
        });
        event = stripe.webhooks.constructEvent(
          rawBody,
          signature,
          config.payments.stripe.webhookSecret!
        );
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Stripe webhook signature verification failed');
        return reply.status(400).send({ message: 'Invalid signature' });
      }

      // G6 hardened (ADR-007): Idempotency via upsert-gate pattern.
      // Instead of check-then-process-then-record (non-atomic), we INSERT first.
      // If the INSERT succeeds, we own this event. If it fails with unique violation,
      // another delivery already claimed it. This is effectively a distributed lock
      // using the DB unique constraint — no race window between check and process.
      try {
        await prisma.processedWebhookEvent.create({
          data: { eventId: event.id, eventType: event.type },
        });
        // INSERT succeeded — we own this event, proceed to processing below
      } catch (insertErr: unknown) {
        // Check if unique constraint violation (event already claimed by another delivery)
        const errCode = (insertErr as { code?: string })?.code;
        const errMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (errCode === 'P2002' || errMsg.includes('unique') || errMsg.includes('duplicate')) {
          log.debug({ eventId: event.id, eventType: event.type }, 'Duplicate Stripe webhook — already claimed, skipping');
          return reply.status(200).send({ received: true, duplicate: true });
        }
        // Non-unique error (DB brownout, connection failure) — fail-open with warning
        // Trade-off: availability > exactly-once under DB outage. Documented per ADR-007.
        log.warn({ err: insertErr, eventId: event.id }, 'Webhook dedup INSERT failed — proceeding without dedup (fail-open)');
      }

      try {
        switch (event.type) {
          case 'invoice.paid':
          case 'invoice.payment_failed':
          case 'invoice.payment_action_required':
          case 'invoice.finalized': {
            const invoice = event.data.object as Stripe.Invoice;
            await syncInvoiceFromStripe(invoice);
            break;
          }
          case 'customer.subscription.created':
          case 'customer.subscription.updated':
          case 'customer.subscription.deleted':
          case 'customer.subscription.trial_will_end': {
            const subscription = event.data.object as Stripe.Subscription;
            await syncSubscriptionFromStripe(subscription);
            break;
          }
          default:
            log.debug({ eventType: event.type }, 'Unhandled Stripe webhook event');
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage, eventType: event.type }, 'Failed to process Stripe webhook');
        // Release the idempotency claim BEFORE returning 500. Without this,
        // Stripe's retry hits the unique-violation path above, is treated as a
        // duplicate, and the event is acknowledged WITHOUT ever being processed
        // — a transient processing failure became a permanently lost event.
        // Deleting the claim keeps the upsert-gate lock for the happy path while
        // letting the retry re-claim after a failure.
        await prisma.processedWebhookEvent
          .delete({ where: { eventId: event.id } })
          .catch((releaseErr: unknown) => {
            log.warn(
              { err: releaseErr, eventId: event.id },
              'Failed to release webhook claim after processing failure — manual replay may be needed'
            );
          });
        return reply.status(500).send({ message: 'Failed to process event' });
      }

      // Event already recorded BEFORE processing (upsert-gate pattern above).
      // No post-processing record needed — the INSERT-first approach is atomic.
      return reply.status(200).send({ received: true });
    }
  );
}
