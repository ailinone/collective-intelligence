// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Outbox Poller — Transactional Outbox delivery engine
 * C1 fix (ADR-001): Reads unpublished events from domain_event_outbox and delivers them
 * via the in-memory event bus. Marks as delivered on success. Poison events (5+ failures)
 * are logged and skipped.
 *
 * This is the ONLY code path that should call eventBus.publish() in production.
 * Command handlers MUST write to the outbox table instead of publishing directly.
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import type { IEventBus } from './event-bus.interface';
import { serializeError } from '@/utils/type-guards';
import { BaseDomainEvent } from '@/domain/events/base-domain-event';

const log = logger.child({ component: 'outbox-poller' });

// ── Metrics (lazily resolved) ──
let outboxUnpublishedGauge: { set: (value: number) => void } | null = null;
let outboxPublishLatency: { observe: (value: number) => void } | null = null;
let outboxPoisonTotal: { inc: (labels: Record<string, string>) => void } | null = null;
let outboxPublishedTotal: { inc: () => void } | null = null;

async function ensureMetrics() {
  if (outboxUnpublishedGauge) return;
  try {
    const promClient = await import('prom-client');
    outboxUnpublishedGauge = new promClient.Gauge({ name: 'ailin_dev_outbox_unpublished_count', help: 'Unpublished events in outbox' });
    outboxPublishLatency = new promClient.Histogram({ name: 'ailin_dev_outbox_publish_latency_seconds', help: 'Time from event creation to publish' });
    outboxPoisonTotal = new promClient.Counter({ name: 'ailin_dev_outbox_poison_events_total', help: 'Events that exceeded max delivery attempts', labelNames: ['event_name'] });
    outboxPublishedTotal = new promClient.Counter({ name: 'ailin_dev_outbox_published_total', help: 'Total events successfully published from outbox' });
  } catch {
    // Metrics unavailable — non-fatal
  }
}

const POLL_INTERVAL_MS = 500;
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const METRICS_INTERVAL_MS = 10_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let metricsTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

/**
 * Concrete event class for deserializing outbox records.
 * The poller doesn't need to know the specific event subclass —
 * it reconstructs a generic domain event that the bus can route by eventName.
 */
class OutboxDomainEvent extends BaseDomainEvent {
  private readonly data: Record<string, unknown> = {};

  constructor(
    eventId: string,
    eventName: string,
    aggregateId: string,
    eventVersion: number,
    occurredAt: Date,
    correlationId: string,
    causationId: string | undefined,
    data: Record<string, unknown>,
  ) {
    super(
      { occurredAt, aggregateId, eventVersion, correlationId, causationId },
      eventName,
    );
    // Override the auto-generated eventId with the stored one (for dedup)
    (this as { eventId: string }).eventId = eventId;
    this.data = data;
  }

  getData(): Record<string, unknown> {
    return this.data;
  }
}

/**
 * Single poll cycle: read unpublished events, publish, mark delivered.
 */
async function pollOnce(eventBus: IEventBus): Promise<number> {
  if (isPolling) return 0; // Guard against overlapping polls
  isPolling = true;

  try {
    // Atomically read and claim a batch (increment attempts to prevent double-pickup)
    const events = await prisma.$transaction(async (tx) => {
      const batch = await tx.domainEventOutbox.findMany({
        where: {
          publishedAt: null,
          attempts: { lt: MAX_ATTEMPTS },
        },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });

      if (batch.length === 0) return [];

      // Claim the batch by incrementing attempts
      await tx.domainEventOutbox.updateMany({
        where: { id: { in: batch.map((e) => e.id) } },
        data: { attempts: { increment: 1 } },
      });

      return batch;
    });

    if (events.length === 0) return 0;

    let published = 0;
    for (const record of events) {
      try {
        const metadata = (record.metadata as Record<string, unknown>) || {};
        const payload = (record.payload as Record<string, unknown>) || {};

        const event = new OutboxDomainEvent(
          record.eventId,
          record.eventName,
          record.aggregateId,
          record.eventVersion,
          record.occurredAt,
          (metadata.correlationId as string) || record.eventId,
          metadata.causationId as string | undefined,
          payload,
        );

        await eventBus.publish(event);

        await prisma.domainEventOutbox.update({
          where: { id: record.id },
          data: { publishedAt: new Date() },
        });

        const latencyS = (Date.now() - record.createdAt.getTime()) / 1000;
        outboxPublishLatency?.observe(latencyS);
        outboxPublishedTotal?.inc();
        published++;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        await prisma.domainEventOutbox.update({
          where: { id: record.id },
          data: { lastError: errorMessage },
        }).catch(() => {}); // Non-fatal if this update fails

        if (record.attempts + 1 >= MAX_ATTEMPTS) {
          outboxPoisonTotal?.inc({ event_name: record.eventName });
          log.error(
            { eventId: record.eventId, eventName: record.eventName, attempts: record.attempts + 1, error: errorMessage },
            'Outbox event exceeded max delivery attempts (poison)'
          );
        } else {
          log.warn(
            { eventId: record.eventId, eventName: record.eventName, attempt: record.attempts + 1, error: errorMessage },
            'Outbox event delivery failed, will retry'
          );
        }
      }
    }

    if (published > 0) {
      log.debug({ published, total: events.length }, 'Outbox poll cycle completed');
    }

    return published;
  } catch (err) {
    log.error({ err }, 'Outbox poll cycle failed');
    return 0;
  } finally {
    isPolling = false;
  }
}

/**
 * Collect outbox metrics (unpublished count).
 */
async function collectMetrics(): Promise<void> {
  try {
    const count = await prisma.domainEventOutbox.count({
      where: { publishedAt: null },
    });
    outboxUnpublishedGauge?.set(count);
  } catch {
    // Non-fatal
  }
}

/**
 * Start the outbox poller.
 * Call from index.ts (API process) and/or queue-runner.ts (worker process).
 * Only one poller should run per process (guarded by isPolling flag).
 *
 * @param eventBus - The IEventBus instance to publish through
 */
export async function startOutboxPoller(eventBus: IEventBus): Promise<void> {
  if (pollTimer) {
    log.debug('Outbox poller already running');
    return;
  }

  await ensureMetrics();

  pollTimer = setInterval(() => {
    pollOnce(eventBus).catch((err) => {
      log.error({ err: serializeError(err) }, 'Outbox poller interval error');
    });
  }, POLL_INTERVAL_MS);

  metricsTimer = setInterval(() => {
    collectMetrics().catch(() => {});
  }, METRICS_INTERVAL_MS);

  log.info({ pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE, maxAttempts: MAX_ATTEMPTS }, 'Outbox poller started');
}

/**
 * Stop the outbox poller gracefully.
 */
export async function stopOutboxPoller(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
  log.info('Outbox poller stopped');
}

/**
 * Manually trigger a poll cycle (useful for testing).
 */
export async function pollOutboxNow(eventBus: IEventBus): Promise<number> {
  return pollOnce(eventBus);
}
