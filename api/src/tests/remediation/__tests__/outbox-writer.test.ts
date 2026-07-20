// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration test: Outbox Writer (C1 — ADR-001)
 * Proves: writeEventsToOutbox creates correct outbox records within a transaction client.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock the request context
vi.mock('@/api/middleware/request-context', () => ({
  getCorrelationId: () => 'test-correlation-123',
}));

describe('outbox-writer', () => {
  it('writes events to outbox with correct structure', async () => {
    const { writeEventsToOutbox } = await import('@/infrastructure/events/outbox-writer');
    const { BaseDomainEvent } = await import('@/domain/events/base-domain-event');

    // Create a concrete event for testing
    class TestEvent extends BaseDomainEvent {
      constructor(aggregateId: string) {
        super({ occurredAt: new Date(), aggregateId, eventVersion: 1 }, 'TestEvent');
      }
      getData() { return { test: true }; }
    }

    const event = new TestEvent('aggregate-1');
    const createdRecords: unknown[] = [];

    // Mock transaction client
    const mockTx = {
      domainEventOutbox: {
        create: vi.fn().mockImplementation(async (args: { data: unknown }) => {
          createdRecords.push(args.data);
          return args.data;
        }),
      },
    };

    await writeEventsToOutbox(mockTx, [event], 'TestAggregate');

    expect(createdRecords).toHaveLength(1);
    const record = createdRecords[0] as Record<string, unknown>;
    expect(record).toMatchObject({
      eventId: event.eventId,
      aggregateId: 'aggregate-1',
      aggregateType: 'TestAggregate',
      eventName: 'TestEvent',
      eventVersion: 1,
      payload: { test: true },
      occurredAt: event.occurredAt,
    });
    // Verify metadata contains correlationId (from event, which gets it from constructor or request context)
    expect((record.metadata as Record<string, unknown>).correlationId).toBeTruthy();
    expect(typeof (record.metadata as Record<string, unknown>).correlationId).toBe('string');
  });

  it('handles empty events array without error', async () => {
    const { writeEventsToOutbox } = await import('@/infrastructure/events/outbox-writer');
    const mockTx = { domainEventOutbox: { create: vi.fn() } };

    await writeEventsToOutbox(mockTx, [], 'TestAggregate');
    expect(mockTx.domainEventOutbox.create).not.toHaveBeenCalled();
  });
});

describe('BaseDomainEvent C1 extensions', () => {
  it('generates unique eventId per instance', async () => {
    const { BaseDomainEvent } = await import('@/domain/events/base-domain-event');
    class E extends BaseDomainEvent {
      constructor() { super({ occurredAt: new Date(), aggregateId: 'a', eventVersion: 1 }, 'E'); }
      getData() { return {}; }
    }
    const e1 = new E();
    const e2 = new E();
    expect(e1.eventId).toBeTruthy();
    expect(e2.eventId).toBeTruthy();
    expect(e1.eventId).not.toBe(e2.eventId);
  });

  it('includes eventId and correlationId in toJSON', async () => {
    const { BaseDomainEvent } = await import('@/domain/events/base-domain-event');
    class E extends BaseDomainEvent {
      constructor() { super({ occurredAt: new Date(), aggregateId: 'a', eventVersion: 1, correlationId: 'corr-1' }, 'E'); }
      getData() { return { key: 'val' }; }
    }
    const json = new E().toJSON();
    expect(json).toHaveProperty('eventId');
    expect(json).toHaveProperty('correlationId', 'corr-1');
    expect(json).toHaveProperty('data', { key: 'val' });
  });
});
