// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Event Bus Interface
 * Infrastructure Layer: Event-driven architecture
 *
 * Defines contract for event publishing and subscription
 */

import { BaseDomainEvent } from '@/domain/events/base-domain-event';

/**
 * Event Handler function type
 */
export type EventHandler<T extends BaseDomainEvent = BaseDomainEvent> = (
  event: T
) => Promise<void> | void;

/**
 * Event Bus Interface
 * Abstraction for event publishing and subscription
 */
export interface IEventBus {
  /**
   * Publish a single event
   */
  publish<T extends BaseDomainEvent>(event: T): Promise<void>;

  /**
   * Publish multiple events
   */
  publishMany(events: BaseDomainEvent[]): Promise<void>;

  /**
   * Subscribe to an event
   */
  subscribe<T extends BaseDomainEvent>(eventType: string, handler: EventHandler<T>): void;

  /**
   * Unsubscribe from an event
   */
  unsubscribe(eventType: string, handler: EventHandler): void;

  /**
   * Clear all subscriptions (for testing)
   */
  clearAll(): void;

  /**
   * Get subscription count
   */
  getSubscriptionCount(eventType?: string): number;

  /**
   * Get registered event types (optional, for debugging/monitoring)
   */
  getRegisteredEventTypes?(): string[];
}
