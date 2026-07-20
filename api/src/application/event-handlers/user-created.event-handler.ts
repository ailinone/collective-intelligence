// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * User Created Event Handler
 * Application Layer: Event Handler
 *
 * Handles UserCreatedEvent
 * - Send welcome email (future)
 * - Log user creation
 * - Initialize user resources
 */

import { injectable } from 'tsyringe';
import { UserCreatedEvent } from '@/domain/events/user-created.event';
import { logger } from '@/utils/logger';

@injectable()
export class UserCreatedEventHandler {
  private log = logger.child({ component: 'user-created-handler' });

  async handle(event: UserCreatedEvent): Promise<void> {
    this.log.info(
      {
        userId: event.aggregateId,
        email: event.email,
        organizationId: event.organizationId,
      },
      'User created event received'
    );

    // Future: Send welcome email
    // await emailService.sendWelcomeEmail(event.email, event.userId);

    // Future: Initialize user resources
    // await resourceService.initializeUserResources(event.userId);

    // Log for analytics
    this.log.info(
      {
        userId: event.aggregateId,
        event: 'user_created',
        timestamp: event.occurredAt,
      },
      'User creation processed'
    );
  }
}
