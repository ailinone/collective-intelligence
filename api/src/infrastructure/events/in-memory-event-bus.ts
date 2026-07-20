// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * In-Memory Event Bus
 * Infrastructure Layer: Event-driven architecture
 *
 * Simple, reliable event bus for domain events
 * - Synchronous by default (can be async)
 * - In-process (for distributed, use RabbitMQ/Kafka)
 * - Type-safe subscriptions
 */

import { injectable } from 'tsyringe';
import { IEventBus, EventHandler } from './event-bus.interface';
import { BaseDomainEvent } from '@/domain/events/base-domain-event';
import { serializeError } from '@/utils/type-guards';
import { logger } from '@/utils/logger';

@injectable()
export class InMemoryEventBus implements IEventBus {
  private subscriptions = new Map<string, Set<EventHandler>>();
  private log = logger.child({ component: 'event-bus' });

  /**
   * Publish a single event
   * Executes all registered handlers for the event type
   */
  async publish<T extends BaseDomainEvent>(event: T): Promise<void> {
    const eventType = event.eventName || event.constructor.name;
    const handlers = this.subscriptions.get(eventType);

    if (!handlers || handlers.size === 0) {
      this.log.debug({ eventType }, 'No handlers registered for event');
      return;
    }

    this.log.info({ eventType, handlerCount: handlers.size }, 'Publishing event');

    // Execute all handlers (in parallel for performance)
    const promises: Promise<void>[] = [];

    for (const handler of handlers) {
      promises.push(
        Promise.resolve(handler(event)).catch((error) => {
          this.log.error({ error: serializeError(error), eventType, event }, 'Event handler failed');
          // Don't throw - allow other handlers to execute
        })
      );
    }

    await Promise.all(promises);

    this.log.debug({ eventType }, 'Event published successfully');
  }

  /**
   * Publish multiple events
   * Useful for publishing aggregate events in batch
   */
  async publishMany(events: BaseDomainEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    this.log.info({ eventCount: events.length }, 'Publishing multiple events');

    // Publish all events in parallel
    await Promise.all(events.map((event) => this.publish(event)));

    this.log.debug({ eventCount: events.length }, 'All events published');
  }

  /**
   * Subscribe to an event type
   */
  subscribe<T extends BaseDomainEvent>(eventType: string, handler: EventHandler<T>): void {
    if (!this.subscriptions.has(eventType)) {
      this.subscriptions.set(eventType, new Set());
    }

    const handlers = this.subscriptions.get(eventType)!;
    handlers.add(handler as EventHandler);

    this.log.info({ eventType, totalHandlers: handlers.size }, 'Event handler subscribed');
  }

  /**
   * Unsubscribe from an event type
   */
  unsubscribe(eventType: string, handler: EventHandler): void {
    const handlers = this.subscriptions.get(eventType);

    if (!handlers) {
      return;
    }

    handlers.delete(handler);

    if (handlers.size === 0) {
      this.subscriptions.delete(eventType);
    }

    this.log.info({ eventType }, 'Event handler unsubscribed');
  }

  /**
   * Clear all subscriptions
   * Useful for testing
   */
  clearAll(): void {
    this.subscriptions.clear();
    this.log.info('All event subscriptions cleared');
  }

  /**
   * Get subscription count
   */
  getSubscriptionCount(eventType?: string): number {
    if (eventType) {
      return this.subscriptions.get(eventType)?.size || 0;
    }

    // Total across all event types
    let total = 0;
    for (const handlers of this.subscriptions.values()) {
      total += handlers.size;
    }
    return total;
  }

  /**
   * Get all registered event types
   */
  getRegisteredEventTypes(): string[] {
    return Array.from(this.subscriptions.keys());
  }
}
