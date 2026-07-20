// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * UserCreated Domain Event
 * Emitted when a new user is created
 */

import { BaseDomainEvent, DomainEventProps } from './base-domain-event';

export interface UserCreatedData {
  userId: string;
  email: string;
  name: string;
  organizationId: string;
  role: string;
}

export class UserCreatedEvent extends BaseDomainEvent {
  private readonly data: UserCreatedData;

  constructor(props: DomainEventProps, data: UserCreatedData) {
    super(props, 'UserCreated');
    this.data = data;
  }

  /**
   * Factory method
   */
  static create(data: UserCreatedData): UserCreatedEvent {
    return new UserCreatedEvent(
      {
        occurredAt: new Date(),
        aggregateId: data.userId,
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
  get userId(): string {
    return this.data.userId;
  }

  get email(): string {
    return this.data.email;
  }

  get organizationId(): string {
    return this.data.organizationId;
  }
}
