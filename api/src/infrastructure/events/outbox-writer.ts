// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Outbox Writer — Writes domain events to the outbox table within a Prisma transaction.
 * C1 fix (ADR-001): This is the ONLY correct way to "publish" domain events.
 *
 * Usage in command handlers:
 *   await prisma.$transaction(async (tx) => {
 *     await tx.user.create({ data: ... });
 *     await writeEventsToOutbox(tx, aggregate.getDomainEvents(), 'User');
 *   });
 *
 * The outbox poller (outbox-poller.ts) will then pick up and publish these events.
 */

import { randomUUID } from 'crypto';
import { BaseDomainEvent } from '@/domain/events/base-domain-event';
import { getCorrelationId } from '@/api/middleware/request-context';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'outbox-writer' });

/**
 * Minimal Prisma transaction client interface for outbox writes.
 * Avoids importing the full PrismaClient type which causes circular deps.
 */
interface OutboxTransactionClient {
  domainEventOutbox: {
    create: (args: {
      data: {
        eventId: string;
        aggregateId: string;
        aggregateType: string;
        eventName: string;
        eventVersion: number;
        payload: unknown;
        metadata: unknown;
        occurredAt: Date;
      };
    }) => Promise<unknown>;
  };
}

/**
 * Write domain events to the outbox table within an existing Prisma transaction.
 * This ensures the events are persisted atomically with the business data.
 *
 * @param tx - The Prisma transaction client (from $transaction callback)
 * @param events - Domain events to write (from aggregate.getDomainEvents())
 * @param aggregateType - The aggregate type name (e.g., 'User', 'Organization')
 */
export async function writeEventsToOutbox(
  tx: OutboxTransactionClient,
  events: BaseDomainEvent[],
  aggregateType: string,
): Promise<void> {
  if (events.length === 0) return;

  const correlationId = getCorrelationId() || randomUUID();

  for (const event of events) {
    await tx.domainEventOutbox.create({
      data: {
        eventId: event.eventId,
        aggregateId: event.aggregateId,
        aggregateType,
        eventName: event.eventName,
        eventVersion: event.eventVersion,
        payload: event.getData(),
        metadata: {
          correlationId: event.correlationId || correlationId,
          causationId: event.causationId,
        },
        occurredAt: event.occurredAt,
      },
    });
  }

  log.debug(
    { count: events.length, aggregateType, eventNames: events.map((e) => e.eventName) },
    'Domain events written to outbox'
  );
}
