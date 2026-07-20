// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Key Rotated Event Handler
 * Application Layer: Event Handler
 *
 * Handles ApiKeyRotatedEvent
 * - Send notification to user
 * - Log rotation for audit
 * - Update monitoring
 */

import { injectable } from 'tsyringe';
import { ApiKeyRotatedEvent } from '@/domain/events/api-key-rotated.event';
import { logger } from '@/utils/logger';

@injectable()
export class ApiKeyRotatedEventHandler {
  private log = logger.child({ component: 'api-key-rotated-handler' });

  async handle(event: ApiKeyRotatedEvent): Promise<void> {
    const eventData = event.getData();

    this.log.info(
      {
        apiKeyId: event.aggregateId,
        userId: eventData.userId,
        reason: eventData.reason,
        gracePeriodDays: eventData.gracePeriodDays,
      },
      'API key rotated event received'
    );

    // Future: Send notification email
    // await emailService.sendApiKeyRotationNotification(event.userId, {
    //   oldKeyId: event.aggregateId,
    //   newKeyId: event.newKeyId,
    //   gracePeriodEnds: new Date(event.occurredAt.getTime() + event.gracePeriodDays * 24 * 60 * 60 * 1000),
    //   reason: event.reason,
    // });

    // Log for audit trail
    this.log.info(
      {
        apiKeyId: event.aggregateId,
        event: 'api_key_rotated',
        reason: eventData.reason,
        timestamp: event.occurredAt,
      },
      'API key rotation processed'
    );

    // Future: Update monitoring/alerts
    // await monitoringService.trackKeyRotation(event);
  }
}
