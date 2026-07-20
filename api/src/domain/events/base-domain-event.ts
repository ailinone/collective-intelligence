// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Base Domain Event
 * All domain events extend this
 *
 * DDD Pattern: Domain Events
 * - Immutable
 * - Past tense naming (UserCreated, not CreateUser)
 * - Contains all data needed by subscribers
 *
 * C1 fix (ADR-001): Added eventId for deduplication and correlationId for tracing.
 * ADR-005: correlationId is mandatory for cross-flow traceability.
 */

import { randomUUID } from 'crypto';

export interface DomainEventProps {
  occurredAt: Date;
  aggregateId: string;
  eventVersion: number;
  /** Optional: inherits from request context if not provided */
  correlationId?: string;
  /** Optional: the eventId of the event that caused this one */
  causationId?: string;
}

export abstract class BaseDomainEvent {
  /** Unique identifier for this event instance (for outbox deduplication) */
  public readonly eventId: string;
  public readonly occurredAt: Date;
  public readonly aggregateId: string;
  public readonly eventVersion: number;
  public readonly eventName: string;
  /** Traces this event back to the originating HTTP request */
  public readonly correlationId: string;
  /** The eventId of the event that triggered this one (causal chain) */
  public readonly causationId?: string;

  constructor(props: DomainEventProps, eventName: string) {
    this.eventId = randomUUID();
    this.occurredAt = props.occurredAt;
    this.aggregateId = props.aggregateId;
    this.eventVersion = props.eventVersion;
    this.eventName = eventName;
    this.correlationId = props.correlationId || randomUUID();
    this.causationId = props.causationId;
  }

  /**
   * Get event data for serialization
   */
  abstract getData(): Record<string, unknown>;

  /**
   * Serialize to JSON for event store / outbox
   */
  toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventName: this.eventName,
      occurredAt: this.occurredAt.toISOString(),
      aggregateId: this.aggregateId,
      eventVersion: this.eventVersion,
      correlationId: this.correlationId,
      causationId: this.causationId,
      data: this.getData(),
    };
  }
}
