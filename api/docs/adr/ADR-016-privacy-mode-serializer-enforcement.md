<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-016: Privacy Mode Enforced at Serializer, Not Destination

**Status**: Accepted
**Date**: 2026-04-17
**Context**: Broadcast feature, GDPR/CCPA compliance, per-destination privacy policy

## Context

Privacy Mode strips prompts/completions from traces before they leave the system. The question is **where** the redaction happens in the pipeline:

1. At the **destination adapter** (right before HTTP send)
2. At the **serializer** (during TraceEnvelope → OTLP conversion)
3. At **envelope construction** (before write to outbox)

## Decision

Redaction happens at **layer 2: the serializer**. The raw, unredacted TraceEnvelope is persisted in `broadcast_trace_outbox`. Each destination independently configures Privacy Mode, and the serializer applies redaction per-destination at drain time.

## Rationale

- **Single source of truth**: one serializer, one redaction logic, property-based tested.
- **Per-destination flexibility**: send full traces to Langfuse (debugging), privacy-redacted to Datadog (cost monitoring). Aligns with OpenRouter's model.
- **Replay safety**: if an envelope is replayed after a policy change, the new policy is applied. Raw envelope never escapes without going through the serializer.
- **Defense against rogue destination**: a compromised destination adapter cannot bypass redaction; the redaction output is what it receives.
- **Observability**: we can emit a metric `broadcast_redaction_applied_total{destination_id,field}` for audit.

## Why Not Option 3 (envelope construction)?

If redaction happened before the outbox, we would lose the ability to send full traces to destination A and redacted traces to destination B from the same request. The cost (7-day retention of raw prompts) is mitigated by:
- Encryption at rest (DB-level via pgcrypto or filesystem encryption)
- Short retention (7 days)
- Tenant-level row-level security on outbox rows

## What Gets Redacted — Three-Tier Classification (ISO 27001 A.5.12)

We adopt a formal data-classification model aligned with GDPR/LGPD/ISO 27001:

| Tier | Definition | Default treatment |
|------|-----------|-------------------|
| **T1 — Direct Identifier** | Identifies a person (userId, sessionId, email) | **Pseudonymize** (GDPR Art. 32(1)(a)) |
| **T2 — Quasi-Identifier** | Re-identifiable in combination (tags, trace labels, free text) | **Redact** (`[REDACTED]`) |
| **T3 — Operational** | About caller's system, not users (env, feature, version) | **Pass** |
| **T4 — Technical** | Pure metrics (tokens, latency, cost) | **Pass** |

### Field-by-field treatment

| Field | Tier | Treatment when Privacy Mode ON |
|-------|------|-----|
| `content.messages[].content` | T2 | `[REDACTED]` |
| `content.choices[].message.content` | T2 | `[REDACTED]` |
| `content.tool_calls[].function.arguments` | T2 | `{}` |
| `status.errorMessage` | T2 | `[REDACTED]` (may embed prompt fragments) |
| `content.messages[].role` | T4 | pass |
| `generation.usage.*` / `generation.timing.*` | T4 | pass |
| `routing.*` (bandit, circuit, credit) | T4 | pass |
| `custom.userId` | T1 | **pseudonymize** (HMAC-SHA256 per destination) |
| `custom.sessionId` | T1 | **pseudonymize** |
| `custom.environment` | T3 | pass |
| `custom.feature` | T3 | pass |
| `custom.version` | T3 | pass |
| `custom.parentSpanId` | T3 | pass (OTEL topology, not PII) |
| `custom.traceId` | T2 | `[REDACTED]` (may embed user/tenant info) |
| `custom.traceName` / `spanName` / `generationName` | T2 | `[REDACTED]` (user-supplied labels) |
| `custom.tags` | T2 | `[REDACTED]` (free-form, unbounded risk) |
| `custom.*` (any other key) | T2 | `[REDACTED]` (**deny-by-default** per GDPR Art. 5(1)(c)) |

### Pseudonymization details

- Algorithm: `HMAC-SHA256(key=destinationKey, input=fieldName || 0x1F || value)`
- Output: `"pseu_" + first_16_hex_chars_of_digest`
- Key: per-destination secret (separate from config encryption key), stored in the same encrypted config blob
- Properties:
  - **Deterministic per destination** — enables within-destination correlation
  - **Cross-destination collision-resistant** — destination A's pseudonyms cannot join destination B's
  - **Irreversible without key** — qualifies as GDPR Art. 32(1)(a) pseudonymization safeguard
  - **Salted by field name** — prevents accidental cross-field joins

### Compliance mapping

- **GDPR Art. 25** (Privacy by Default): deny-by-default on `custom.*`, Privacy Mode recommended as the production configuration.
- **GDPR Art. 5(1)(b/c)** (Purpose Limitation + Minimisation): observability traces have operational purpose; T1/T2 data is not necessary.
- **GDPR Art. 32(1)(a)** (Pseudonymisation): HMAC is a recognized technical safeguard.
- **GDPR Recital 26**: pseudonymous data is still PII but has lighter processing constraints.
- **LGPD Art. 6 III** (necessidade): parallel to Art. 5(1)(c).
- **ISO 27001 A.5.12 / A.8.11**: explicit classification + masking controls.

## Implementation Notes

- `src/broadcast/domain/privacy-redactor.ts` exposes a pure function `redact(envelope, policy): RedactedEnvelope`.
- Property-based tests (fast-check) verify that redaction is **idempotent**, **monotonic** (redacting more fields never reveals less), and **complete** (no PII field survives when enabled).
- The redactor returns a new envelope; input is never mutated.
- Redacted envelopes carry a marker attribute `broadcast.privacy_mode_applied = true` so downstream auditors can detect.

## Consequences

### Positive
- Provable privacy via property tests
- Per-destination flexibility
- Audit trail of redaction events

### Negative
- Raw prompts live in `broadcast_trace_outbox` for up to 7 days. Mitigated by encryption + access controls.
- Serializer must know all destination policies at serialize time. Acceptable: policy is a simple boolean + field list.
