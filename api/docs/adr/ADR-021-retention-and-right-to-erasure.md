<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-021: Retention Policy & Right to Erasure (GDPR Art. 5(1)(e), Art. 17; LGPD Art. 16)

**Status**: Accepted
**Date**: 2026-04-17
**Context**: Broadcast feature — compliance with storage limitation and data subject rights
**Related**: ADR-014 (Outbox), ADR-016 (Privacy Redactor), ADR-019 (DLQ)

## Context

The broadcast pipeline persists trace data at multiple stages:

| Table | Content | Why it exists |
|-------|---------|---------------|
| `broadcast_trace_outbox` | Full envelope (may include PII) | Durability between request and drain |
| `broadcast_delivery` | Per-destination status + last_error | Retry & observability |
| `broadcast_dlq` | `envelope_snapshot` (may include PII) | Manual replay after permanent failure |
| `routing_event` | Routing decisions per request | Audit, debugging (30-day window) |
| `domain_event_outbox` | Domain events (not trace data) | Already covered by ADR-001 |

Each storage has distinct retention pressure:
- **GDPR Art. 5(1)(e) "storage limitation"**: only as long as necessary for the stated purpose
- **GDPR Art. 17 "right to erasure"**: data subjects can request deletion
- **LGPD Art. 16**: parallel retention limitation; Art. 18 parallel erasure right
- **Operational need**: debugging requires some lookback window

## Decision

### 1. Retention periods (documented + enforced)

| Table | Retention | Purpose Justification |
|-------|-----------|----------------------|
| `broadcast_trace_outbox` (drained) | **7 days** | Replay & debugging; beyond 7d an incident would be investigated via destination data, not ours |
| `broadcast_trace_outbox` (undrained) | **24h** hard cap | If not drained in 24h, DLQ; we don't retain indefinitely |
| `broadcast_delivery` | **30 days** | SLO reporting, retry debugging |
| `broadcast_dlq` | **30 days** | Manual replay window; after 30d envelope snapshot is purged but metadata kept 90d for audit counts |
| `broadcast_dlq.envelope_snapshot` column | **30 days** (purged to NULL after) | Limit PII exposure; keep lifecycle metadata |
| `routing_event` | **30 days** | Matches original L11 design; longer-term patterns land in analytics warehouse (separate pipeline) |
| `broadcast_processed_trace` | **30 days** (partitioned by week) | Idempotency horizon |

Enforcement: BullMQ-scheduled cleanup job `broadcast-retention-enforcer` runs daily, deletes/nullifies rows past retention, emits Prometheus metric `broadcast_retention_purged_rows_total{table}`.

### 2. Right to Erasure flow

A tenant admin can submit an erasure request identifying a specific end-user. The system must:
1. Derive all pseudonyms for that user across active destinations (deterministic HMAC — see ADR-016)
2. Delete matching rows from `broadcast_trace_outbox`, `broadcast_delivery`, `broadcast_dlq`, `routing_event`
3. **Forward the deletion request to destinations** that support programmatic deletion (Langfuse, Datadog have DSAR APIs); otherwise emit a manual-action ticket
4. Record the erasure in an immutable audit log (`broadcast_erasure_log` — new table in next migration)
5. Issue a completion certificate to the requester (GDPR Art. 19 "notification obligation")

Endpoint: `POST /api/broadcast/admin/erasure-requests`
Payload: `{ targetType: 'end_user' | 'api_key', targetId: string, reason: string }`
RBAC: only `organization_admin` role (for org-scope) or the user themselves (for user-scope).

### 3. Encryption at rest for PII columns

- `broadcast_trace_outbox.envelope` — stored in a PostgreSQL schema with transparent encryption (filesystem-level; relies on GCP SQL CMEK or equivalent infra control). No app-layer encryption: the column is read by the drainer on every tick and app-layer encryption would add unacceptable overhead.
- `broadcast_dlq.envelope_snapshot` — same approach.
- For customers requiring column-level encryption: future extension with KMS envelope (out of MVP scope).

### 4. Backup implications

Database backups inherit retention. The backup retention policy (currently 14 days for PITR + 90 days for weekly snapshots) is **longer than** broadcast retention. Acknowledged trade-off: a data subject's erasure request cannot reach data in backups without a full backup restore & re-anonymize cycle, which is operationally infeasible.

**Mitigation (documented in DPA with customers):** data in backups is considered "archived" and is only restored under catastrophic recovery scenarios; restored data is immediately subject to re-application of any pending erasure requests via the audit log.

This trade-off is standard industry practice and accepted under GDPR Article 17(3)(b) exceptions (compliance with legal obligations — here, disaster recovery capability).

## Rationale

- **7 days on outbox**: long enough for same-week debugging; short enough that "why do you have my data?" has a defensible answer.
- **30 days elsewhere**: balances operational visibility against minimization. Anything analytic-longer belongs in a separate compliance-reviewed warehouse.
- **Pseudonym-based erasure**: by pseudonymizing with a deterministic HMAC, we retain the ability to find and delete a specific user's data **without storing their real identifier in the broadcast tables**. This is a GDPR best practice — it makes the system both minimization-friendly AND erasure-capable.
- **Explicit DPA language on backups**: avoiding this trap requires saying it upfront; unspoken assumptions break audits.

## Consequences

### Positive
- Provable compliance with Art. 5(1)(e) (storage limitation) and Art. 17 (erasure)
- Clean separation of retention policy from storage implementation
- Auditable via the erasure log + cleanup metrics
- Erasure endpoint is implementable as a single SQL + HTTP-call flow

### Negative
- Cleanup job is a new scheduled workload (low cost; uses existing BullMQ infra)
- Backup re-application of erasure is not fully automated. Documented trade-off.
- Customers on destinations without DSAR APIs will have to fulfill part of the request manually. Documented in destination-specific walkthroughs.

## Implementation Notes

- New table `broadcast_erasure_log` (next migration):
  ```sql
  CREATE TABLE broadcast_erasure_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by    UUID NOT NULL,
    target_type     TEXT NOT NULL CHECK (target_type IN ('end_user','api_key','session')),
    target_id_hash  TEXT NOT NULL,              -- SHA-256 of target_id, not plain
    pseudonyms_used JSONB NOT NULL,              -- pseudonyms deleted
    destinations    JSONB NOT NULL,              -- destinations contacted
    rows_deleted    JSONB NOT NULL,              -- {table: count}
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    error           TEXT
  );
  ```
- Cleanup job: `src/broadcast/application/retention-enforcer.ts`, registered via BullMQ `upsertJobScheduler()` (compliance with ARCHITECTURE-GOVERNANCE §3).
- Erasure handler: `src/broadcast/application/erasure-handler.ts`.

## References

- GDPR Art. 5(1)(e), Art. 17, Art. 19, Art. 17(3)(b)
- LGPD Art. 16, Art. 18 III
- ISO 27001 A.5.34 "Privacy and protection of personally identifiable information"
- [ICO guidance on Storage Limitation](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/the-principles/storage-limitation/)
