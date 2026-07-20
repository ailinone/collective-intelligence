<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Architecture Governance Rules

**Status**: Active  
**Effective**: 2026-04-14  
**Context**: Remediation program for enterprise architecture audit (Phases 1-3)

These rules are in effect until all 9 production-grade gates (G1-G9) are satisfied.

## Anti-Regression Rules

### 1. No New In-Memory Stateful Singletons
Any new module in `src/core/learning/` or `src/core/` that stores state in `Map`, `Array`, or `Set` for decision-making or learning purposes **MUST** use `RedisBackedMap` or `RedisBackedSet` from `redis-backed-state.ts`. Pure in-memory state is only acceptable for per-request-scoped variables.

### 2. No Direct Event Publishing from Handlers  
`eventBus.publish()` and `eventBus.publishMany()` are **PROHIBITED** in command handlers. All domain events must be written to the `domain_event_outbox` table via `writeEventsToOutbox()` inside the same `$transaction` as business data. Only the outbox poller may call `eventBus.publish()`.

### 3. No node-cron for Scheduling
`import cron from 'node-cron'` is **PROHIBITED** in new files. All scheduling must use BullMQ `upsertJobScheduler()` via `register-scheduled-jobs.ts`.

### 4. No New Queues Without DLQ
Any new `new Queue()` **MUST** call `setupDLQ()` from `dlq-manager.ts` immediately after creation. Queues without DLQ routing will not pass code review.

### 5. No Webhooks Without Idempotency
Any new inbound webhook handler **MUST** verify event uniqueness against the `processed_webhook_events` table before processing.

### 6. No Breaking Event Schema Changes Without Versioning
Domain event `eventVersion` must be incremented for any schema change. Consumers must support version N and N-1.

### 7. No Shared Instance Fields for Per-Request State
`OrchestrationEngine` and strategy singletons **MUST NOT** store per-request values as instance fields. Use local variables and return tuples.

### 8. No New Features Without Test Coverage
New modules in `src/core/` must have >60% test coverage before merge.

## Production-Grade Gates (G1-G9)

| Gate | Description | Acceptance Criteria |
|------|-------------|-------------------|
| G1 | Outbox eliminates dual-write | 0 events lost in 100 crash tests |
| G2 | Cron single-execution | 0 duplicates in 3-replica x 72h test |
| G3 | DLQ operational | 10/10 failed jobs in DLQ, 5/5 replay success |
| G4 | Race condition eliminated | 0 wrong audit records under concurrency |
| G5 | Shared state convergent | <5% divergence across 3 instances |
| G6 | Webhook idempotent | 0 double-processing in 10x duplicate test |
| G7 | Alerts functional | Alert received in Slack <5min |
| G8 | Tracing cross-flow | correlationId traceable HTTP→event→worker |
| G9 | Auto-recovery | DLQ replay + outbox redeliver without manual intervention |
