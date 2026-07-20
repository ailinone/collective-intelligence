// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Organization Tier Upgraded Event Handler
 * Application Layer: Event Handler
 *
 * Handles OrganizationTierUpgradedEvent
 * - Send confirmation email
 * - Update billing
 * - Enable new features
 */

import { injectable } from 'tsyringe';
import { OrganizationTierUpgradedEvent } from '@/domain/events/organization-tier-upgraded.event';
import { logger } from '@/utils/logger';

@injectable()
export class OrganizationTierUpgradedEventHandler {
  private log = logger.child({ component: 'org-tier-upgraded-handler' });

  async handle(event: OrganizationTierUpgradedEvent): Promise<void> {
    this.log.info(
      {
        organizationId: event.aggregateId,
        oldTier: event.oldTier,
        newTier: event.newTier,
      },
      'Organization tier upgraded event received'
    );

    // Future: Send upgrade confirmation email
    // const org = await organizationRepository.findById(event.aggregateId);
    // await emailService.sendTierUpgradeConfirmation(org, event.newTier);

    // Future: Update billing
    // await billingService.applyNewTier(event.aggregateId, event.newTier);

    // Future: Enable new tier features
    // await featureService.enableTierFeatures(event.aggregateId, event.newTier);

    // Log for analytics
    this.log.info(
      {
        organizationId: event.aggregateId,
        event: 'tier_upgraded',
        oldTier: event.oldTier,
        newTier: event.newTier,
        timestamp: event.occurredAt,
      },
      'Tier upgrade processed'
    );
  }
}
