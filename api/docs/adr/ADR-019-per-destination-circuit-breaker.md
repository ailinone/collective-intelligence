<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-019: Per-Destination Circuit Breaker & Tenant Isolation

**Status**: Accepted
**Date**: 2026-04-17
**Context**: Broadcast feature, failure isolation
**Related**: L3 Circuit Breaker (`core/resilience/distributed-circuit-breaker.ts`)

## Context

When a destination (e.g., Datadog) experiences an outage, the drainer may retry indefinitely, consuming resources and blocking other destinations. Options:

1. **Global circuit breaker** (one state for all destinations)
2. **Per-destination circuit breaker**
3. **Per-tenant-per-destination circuit breaker**

## Decision

**Per-destination-id circuit breaker** (option 2), with tenant-level isolation achieved via separate destination rows rather than a nested dimension.

Reuses the existing `DistributedCircuitBreaker` abstraction (Redis-backed state, governance §1 compliant).

## Rationale

- **Failure isolation**: Datadog outage does not affect Langfuse delivery
- **Tenant isolation is automatic**: each tenant has their own destination rows with their own circuit states, because `destination_id` is row-scoped
- **Avoids cardinality explosion**: one circuit per destination row (bounded) vs. tenant × destination (unbounded)
- **Simpler mental model**: ops team inspects `broadcast_circuit_state{destination_id="dst_abc123"}` metrics directly

## State Machine

Standard three-state circuit breaker:
- **CLOSED** (normal): all requests attempted
- **OPEN** (tripped): requests fail-fast; envelopes accumulate in outbox
- **HALF_OPEN** (probing): limited requests allowed to test recovery

### Trip Conditions

Trip on **any** of:
- Failure rate > 50% over last 20 requests
- Consecutive failures ≥ 5
- Response latency p99 > 30s over rolling window

### Recovery

- `OPEN → HALF_OPEN` after 60s
- `HALF_OPEN → CLOSED` after 3 consecutive successes
- `HALF_OPEN → OPEN` on any failure

## Error Classification

Not all failures trip the circuit. We classify:

| Error Class | Example | Trip? | Retry? |
|---|---|---|---|
| `network` | ECONNRESET, ETIMEDOUT | YES | YES (exp backoff) |
| `5xx` | 500, 502, 503, 504 | YES | YES |
| `rate_limit` | 429 | NO (use Retry-After) | YES |
| `4xx_auth` | 401, 403 | NO (alert + DLQ) | NO |
| `4xx_bad_request` | 400, 422 | NO (permanent failure → DLQ) | NO |
| `payload_too_large` | 413 | NO (split or drop → DLQ) | NO |

## Tenant Isolation & Backpressure

If tenant A generates 1M traces/min that all fail to destination X, the circuit trips and tenant A's envelopes accumulate in the outbox — but tenant B's envelopes to destination Y are unaffected.

**Per-tenant outbox write rate limit** is a separate safeguard (§governance future work): prevents a single tenant from filling the outbox table. Implemented via token bucket keyed by `(tenant_id, tenant_type)`.

## Observability

Metrics (Prometheus, per-destination):
- `broadcast_circuit_state{destination_id, state}` (gauge: 0=closed, 1=half_open, 2=open)
- `broadcast_circuit_transitions_total{destination_id, from, to}` (counter)
- `broadcast_circuit_rejections_total{destination_id}` (counter: fail-fast due to OPEN)

Alerts:
- Any circuit `OPEN` for >10 min → page ops
- Global `open_circuit_count > 3` simultaneously → possible network issue, page ops

## Consequences

### Positive
- Failure isolation across destinations and tenants
- Reuses proven L3 circuit breaker infrastructure
- Observable at the destination granularity

### Negative
- Circuit state for unused destinations incurs small Redis overhead (negligible: ~100 bytes/destination)
- HALF_OPEN probing sends real traffic; a persistently broken destination will see repeated probe cycles. Mitigated: probe interval doubles after each failed recovery (capped at 1h)

## Implementation Notes

- Wrap destination `send()` calls with `circuitBreaker.execute(destinationId, fn)`
- Errors classified by `classifyError(err): ErrorClass` (pure function)
- DLQ path: after `max_attempts` retries OR on `4xx_bad_request`/`4xx_auth`, envelope moves to `broadcast_dlq` with full context
