// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OrganizationTierUpgraded Domain Event
 * Emitted when organization upgrades tier
 */

import { BaseDomainEvent, DomainEventProps } from './base-domain-event';

export interface OrganizationTierUpgradedData {
  organizationId: string;
  oldTier: string;
  newTier: string;
  upgradedBy: string; // userId
  reason?: string;
}

export class OrganizationTierUpgradedEvent extends BaseDomainEvent {
  private readonly data: OrganizationTierUpgradedData;

  constructor(props: DomainEventProps, data: OrganizationTierUpgradedData) {
    super(props, 'OrganizationTierUpgraded');
    this.data = data;
  }

  /**
   * Factory method
   */
  static create(data: OrganizationTierUpgradedData): OrganizationTierUpgradedEvent {
    return new OrganizationTierUpgradedEvent(
      {
        occurredAt: new Date(),
        aggregateId: data.organizationId,
        eventVersion: 1,
      },
      data
    );
  }

  /**
   * Get event data
   */
  getData(): Record<string, unknown> {
    return { ...this.data };
  }

  /**
   * Convenience getters
   */
  get organizationId(): string {
    return this.data.organizationId;
  }

  get oldTier(): string {
    return this.data.oldTier;
  }

  get newTier(): string {
    return this.data.newTier;
  }
}
