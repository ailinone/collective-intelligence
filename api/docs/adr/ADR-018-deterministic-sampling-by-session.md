<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-018: Deterministic Sampling by session_id (Hash-based)

**Status**: Accepted
**Date**: 2026-04-17
**Context**: Broadcast feature, per-destination sampling rate

## Context

Each destination has a configurable sampling rate (0.0 – 1.0) to control data volume. Naive random sampling (`Math.random() < rate`) produces fragmented sessions: some requests of a multi-turn conversation are sampled, others aren't — making debugging impossible.

## Decision

Sampling is **deterministic per session**: a stable hash of `(destination_id, session_id)` maps to a [0, 1) value. If the value is < `sampling_rate`, the envelope is sent. All envelopes within the same session therefore have identical sampling outcomes **for a given destination**.

Requests without `session_id` fall back to deterministic sampling by `request_id` (i.e., independent per-request decisions — no coherency expected).

## Rationale

- **Complete sessions**: debugging a multi-turn workflow never shows partial data
- **Reproducibility**: given the same `(destination, session_id)`, the sampling decision is identical across replays and destinations (if configured identically)
- **Independence across destinations**: each destination's hash is salted by `destination_id`, so two destinations at 50% sampling won't receive the same halves (preserves A/B style comparisons)
- **No coordination needed**: stateless hash-based sampling is trivial to scale horizontally

## Algorithm

```
h = SipHash-2-4(key = destination_id, input = session_id)
bucket = (h mod 10_000) / 10_000.0   // bucket ∈ [0, 1)
include = bucket < sampling_rate
```

**Hash choice**: HMAC-SHA256 truncated to 64 bits.

Rationale for deviating from the original SipHash-2-4 proposal:
- SipHash is not in `node:crypto` — adopting it would require a new dependency
  (`@stablelib/siphash` or a hand-rolled implementation) for a function that
  sits on the hot path of every broadcast. The operational risk of a less-tested
  implementation outweighs the microbenchmark difference.
- HMAC-SHA256 preserves the critical properties we need from SipHash:
  keyed (prevents adversarial prefix collisions on session_id),
  deterministic, uniform output distribution.
- Performance is comfortable: HMAC-SHA256 on a 128-byte input runs at
  ~500 MB/s on modern CPUs. At 10k traces/sec × ~60-byte input × N destinations,
  this is negligible compared to the JSON serialization that follows.
- Node's `node:crypto` HMAC is native C/OpenSSL — no JavaScript hot loop.
- Already used elsewhere in broadcast (pseudonymization, ADR-016) — consistent
  cryptographic surface area.

The key used for HMAC is a per-process-static 32-byte salt derived from the
destination id: `hmac_key = HKDF(static-broadcast-salt, info=destination_id)`.
This gives the per-destination independence property (two destinations at 50%
sampling rate will not see the same half of traffic).

## Edge Cases

| Scenario | Behavior |
|---|---|
| No `session_id` in request | Fall back to deterministic hash on `request_id` (per-request independence) |
| `sampling_rate = 0` | Always exclude (no hash needed, short-circuit) |
| `sampling_rate = 1` | Always include (no hash needed, short-circuit) |
| `sampling_rate = 0.0001` | Still deterministic; small bucket window, but consistent |
| Cross-destination consistency desired | User can configure same `sampling_rate` across destinations; they will receive overlapping but not identical subsets (salted by destination_id) |

## Consequences

### Positive
- Debuggable sampling: "which sessions did Langfuse see?" is answerable offline by recomputing hashes
- No shared state required between pods
- Resilient to restart: deterministic means no "lost" sampling state

### Negative
- Adversarial session_id values could in theory bias sampling, but SipHash keying mitigates this
- Users cannot see "different slices" on different destinations without varying config

## Implementation Notes

- Module: `src/broadcast/application/sampling-decision.ts`
- Function: `shouldSample(destinationId, sessionId, samplingRate): boolean`
- Pure function; no I/O; extensively unit-tested.
- Use a **keyed** hash, not plain SHA-256, to prevent prefix-attack collisions (not a practical issue here, but defense in depth).

## Explicit Non-Goal

We do NOT implement head-based sampling (random at trace start, propagated via trace context). That's the OTEL standard but requires coordination across spans. Since broadcast sees the full envelope at the end of the request, session-based is simpler and more aligned with the "complete sessions" goal.
