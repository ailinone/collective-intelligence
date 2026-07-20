// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Event Subscriptions Setup
 * Infrastructure Layer: Event-driven architecture
 *
 * Registers all event handlers to the event bus
 */

import { container } from 'tsyringe';
import { IEventBus } from './event-bus.interface';
import { UserCreatedEventHandler } from '@/application/event-handlers/user-created.event-handler';
import { ApiKeyRotatedEventHandler } from '@/application/event-handlers/api-key-rotated.event-handler';
import { OrganizationTierUpgradedEventHandler } from '@/application/event-handlers/organization-tier-upgraded.event-handler';
import { UserCreatedEvent } from '@/domain/events/user-created.event';
import { ApiKeyRotatedEvent } from '@/domain/events/api-key-rotated.event';
import { OrganizationTierUpgradedEvent } from '@/domain/events/organization-tier-upgraded.event';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'event-subscriptions' });

/**
 * Setup all event subscriptions
 * Called during application bootstrap
 */
export function setupEventSubscriptions(): void {
  try {
    const eventBus = container.resolve<IEventBus>('IEventBus');

    // Resolve event handlers
    const userCreatedHandler = container.resolve(UserCreatedEventHandler);
    const apiKeyRotatedHandler = container.resolve(ApiKeyRotatedEventHandler);
    const orgTierUpgradedHandler = container.resolve(OrganizationTierUpgradedEventHandler);

    // Subscribe to events
    eventBus.subscribe('UserCreated', (event) => {
      if (event.eventName === 'UserCreated') {
        userCreatedHandler.handle(event as UserCreatedEvent);
      }
    });
    eventBus.subscribe('ApiKeyRotated', (event) => {
      if (event.eventName === 'ApiKeyRotated') {
        apiKeyRotatedHandler.handle(event as ApiKeyRotatedEvent);
      }
    });
    eventBus.subscribe('OrganizationTierUpgraded', (event) => {
      if (event.eventName === 'OrganizationTierUpgraded') {
        orgTierUpgradedHandler.handle(event as OrganizationTierUpgradedEvent);
      }
    });

    const subscriptionCount = eventBus.getSubscriptionCount();
    const eventTypes = eventBus.getRegisteredEventTypes?.() || [];

    log.info(
      {
        subscriptionCount,
        eventTypes,
      },
      '✅ Event subscriptions setup complete'
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ error: errorMessage }, 'Failed to setup event subscriptions');
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Get Event Bus instance
 */
export function getEventBus(): IEventBus {
  return container.resolve<IEventBus>('IEventBus');
}
