// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RotateApiKey Command Handler
 * CQRS Pattern: Command Handler
 *
 * C1 fix (ADR-001): Events written to outbox within same $transaction as business data.
 * No direct eventBus.publish() — outbox poller handles delivery.
 */

import { injectable, inject } from 'tsyringe';
import { RotateApiKeyCommand } from '../commands/rotate-api-key.command';
import { IUserRepository } from '@/domain/repositories/iuser-repository';
import { UserId } from '@/domain/value-objects/user-id';
import { BaseDomainEvent } from '@/domain/events/base-domain-event';
import { prisma } from '@/database/client';
import { narrowAs } from '@/utils/type-guards';
import { writeEventsToOutbox } from '@/infrastructure/events/outbox-writer';

export interface RotateApiKeyResult {
  success: boolean;
  newKeyId?: string;
  gracePeriodEnds?: Date;
  error?: string;
}

@injectable()
export class RotateApiKeyHandler {
  constructor(
    @inject('IUserRepository') private readonly userRepository: IUserRepository,
  ) {}

  async execute(command: RotateApiKeyCommand): Promise<RotateApiKeyResult> {
    try {
      // 1. Load user aggregate
      const userId = UserId.create(command.userId);
      const userAggregate = await this.userRepository.findAggregateById(userId);

      if (!userAggregate) {
        return {
          success: false,
          error: 'User not found',
        };
      }

      // 2. Verify API key belongs to user
      const apiKey = userAggregate.getApiKey(command.apiKeyId);

      if (!apiKey) {
        return {
          success: false,
          error: 'API key not found or does not belong to user',
        };
      }

      // 3. Rotate API key (creates new key, starts grace period)
      const newKey = userAggregate.rotateApiKey(command.apiKeyId, command.reason);

      // 4. Save aggregate + outbox events in SINGLE atomic transaction (C1 fix)
      await prisma.$transaction(async (tx) => {
        await this.userRepository.saveAggregate(userAggregate, tx);

        const events = userAggregate.getDomainEvents() as BaseDomainEvent[];
        await writeEventsToOutbox(narrowAs<Parameters<typeof writeEventsToOutbox>[0]>(tx), events, 'User');
      });

      // 5. Calculate grace period end
      const gracePeriodDays = apiKey.toPersistence().gracePeriodDays;
      const gracePeriodEnds = new Date();
      gracePeriodEnds.setDate(gracePeriodEnds.getDate() + gracePeriodDays);

      // NO eventBus.publishMany() here — outbox poller handles delivery (C1 fix)

      return {
        success: true,
        newKeyId: newKey.id,
        gracePeriodEnds,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}
