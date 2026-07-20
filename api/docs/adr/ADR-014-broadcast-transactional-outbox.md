<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-014: Broadcast uses Transactional Outbox Pattern

**Status**: Accepted
**Date**: 2026-04-17
**Context**: Broadcast feature (observability trace distribution to external platforms)
**Supersedes**: N/A
**Related**: ADR-001 (DomainEventOutbox), ARCHITECTURE-GOVERNANCE §2

## Context

The Broadcast feature distributes trace envelopes (routing decisions + execution feedback) to external observability platforms (Langfuse, Datadog, etc.). Two delivery models were considered:

1. **Fire-and-forget async publish** inside the chat.completions request handler
2. **Transactional outbox**: write envelope to a DB table within the same transaction as business data, then a separate worker drains the outbox to destinations

## Decision

We use **Transactional Outbox** (pattern formalized in ADR-001 for domain events), introducing a dedicated `broadcast_trace_outbox` table distinct from `domain_event_outbox`.

The envelope is written via `BroadcastOutboxWriter.enqueue(envelope, tx)` inside an existing Prisma transaction. A BullMQ-scheduled poller (`broadcast-outbox-drainer`, per ARCHITECTURE-GOVERNANCE §3) reads unprocessed envelopes and fans out to configured destinations.

## Rationale

- **At-least-once delivery**: crashes between API response and publish cannot lose traces
- **Consistency with request**: if the business write fails, the broadcast never fires (atomic rollback)
- **Replay capability**: 7-day retention on outbox enables DLQ replay and debugging
- **Alignment with governance §2**: no direct publish from request handlers
- **Already-proven pattern**: same mechanism as domain events, same operational playbooks

## Consequences

### Positive
- Durability guarantee equivalent to the request itself
- No additional infrastructure (reuses PostgreSQL + BullMQ already in place)
- Observable via SQL: `SELECT * FROM broadcast_trace_outbox WHERE enqueued_at < NOW() - INTERVAL '30 seconds' AND drained_at IS NULL` reveals lag

### Negative
- +1 write per request (envelope row). Mitigated: envelope is a single JSONB column; write cost is bounded.
- Poller adds ~1-2s p99 latency between request completion and destination arrival. Acceptable for observability.

## Implementation Notes

- Write path: `BroadcastOutboxWriter.enqueue()` MUST be called inside the same `prisma.$transaction` as the business data (chat completion record).
- Drain path: `broadcastOutboxDrainerJob` registered via BullMQ `upsertJobScheduler()` with 1s interval.
- Retention: envelopes purged after 7 days via scheduled cleanup job.
- The separate `broadcast_delivery` table tracks per-destination delivery status (many-to-many with `broadcast_trace_outbox`).
