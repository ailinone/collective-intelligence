// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ApiKeyRotated Domain Event
 * Emitted when API key rotation is initiated
 */

import { BaseDomainEvent, DomainEventProps } from './base-domain-event';

export interface ApiKeyRotatedData {
  apiKeyId: string;
  oldKeyId: string;
  newKeyId: string;
  userId: string;
  organizationId: string;
  reason: 'manual' | 'auto-rotation' | 'security';
  gracePeriodDays: number;
}

export class ApiKeyRotatedEvent extends BaseDomainEvent {
  private readonly data: ApiKeyRotatedData;

  constructor(props: DomainEventProps, data: ApiKeyRotatedData) {
    super(props, 'ApiKeyRotated');
    this.data = data;
  }

  /**
   * Factory method
   */
  static create(data: ApiKeyRotatedData): ApiKeyRotatedEvent {
    return new ApiKeyRotatedEvent(
      {
        occurredAt: new Date(),
        aggregateId: data.oldKeyId,
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
  get oldKeyId(): string {
    return this.data.oldKeyId;
  }

  get newKeyId(): string {
    return this.data.newKeyId;
  }

  get reason(): string {
    return this.data.reason;
  }
}
