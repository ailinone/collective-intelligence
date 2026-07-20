// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OrganizationTierDowngraded Domain Event
 * Emitted when organization downgrades tier
 */

import { BaseDomainEvent, DomainEventProps } from './base-domain-event';

export interface OrganizationTierDowngradedData {
  organizationId: string;
  oldTier: string;
  newTier: string;
  reason?: string;
}

export class OrganizationTierDowngradedEvent extends BaseDomainEvent {
  private readonly data: OrganizationTierDowngradedData;

  private constructor(props: DomainEventProps, data: OrganizationTierDowngradedData) {
    super(props, 'OrganizationTierDowngraded');
    this.data = data;
  }

  /**
   * Factory method
   */
  static create(data: OrganizationTierDowngradedData): OrganizationTierDowngradedEvent {
    return new OrganizationTierDowngradedEvent(
      {
        occurredAt: new Date(),
        aggregateId: data.organizationId,
        eventVersion: 1,
      },
      data
    );
  }

  /**
   * Get event payload
   */
  getData(): Record<string, unknown> {
    return { ...this.data };
  }

  get organizationId(): string {
    return this.data.organizationId;
  }

  get oldTier(): string {
    return this.data.oldTier;
  }

  get newTier(): string {
    return this.data.newTier;
  }

  get reason(): string | undefined {
    return this.data.reason;
  }
}
