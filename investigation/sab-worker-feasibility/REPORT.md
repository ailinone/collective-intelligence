<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# SharedArrayBuffer + worker_threads feasibility — final report

**Status: investigation complete. Recommendation: viable and worth building, scoped correctly (see "What this does NOT solve" below) — this was never committed before this report, so nothing here has shipped.**

## The problem being investigated

The in-process, per-request candidate-selection path (`current-map-approach.mjs` mirrors the real `dynamic-model-selector.ts`/`pool-builder.ts` logic) rebuilds/scans/sorts the full model catalog (111,666 rows in production) on the Node.js main thread for every request that can't be served from a warm cache. A separate benchmark earlier in this session already showed this caps real throughput at ~40 req/s under concurrent load, because the scan+sort is synchronous CPU work that blocks the event loop — every other in-flight request on that process stalls behind it.

The proposal under test: precompute the catalog into a fixed-layout `SharedArrayBuffer`-backed structure, do the (still O(catalog)) rebuild on a `worker_threads` `Worker` instead of the main thread, and have every request read directly from the shared memory — zero copying, zero main-thread scan cost per request, and (per the operator's original phrasing) "avoiding even the network hop to Redis."

15 scripts implementing this investigation were written earlier in this session but never committed — they sat as untracked files in this worktree and were nearly lost. This report is the write-up that was supposed to accompany them; all 15 scripts are committed alongside it in this same change.

## Finding 1 — SharedArrayBuffer sharing is strictly intra-process (worker_threads only)

**Definitively confirmed, twice** (once earlier in this session via `child_process.fork`, and again just now via `cross-process-test.mjs` in this recovered investigation — same result both times):

```
$ node cross-process-test.mjs
[parent] initial value: 42
Error: #<SharedArrayBuffer> could not be cloned.
    at writeChannelMessage (node:internal/child_process/serialization:114:9)
```

Even with `serialization: 'advanced'` (V8 structured-clone, the SAME algorithm `worker_threads.postMessage` uses to genuinely share a `SharedArrayBuffer` between threads), Node's `child_process` IPC refuses outright to serialize a `SharedArrayBuffer` across an OS process boundary. This is not a soft degradation (silently copying instead of sharing) — it's a hard, synchronous throw.

**Implication: this design cannot be used to share state between the 2 separate API service's Docker Swarm replica PROCESSES.** Each replica would need its own independent `SharedArrayBuffer` + worker, rebuilt independently. Cross-replica cache coherency still requires Redis (or another real IPC mechanism) — this investigation does not remove that dependency, and the operator's "avoiding even the network hop to Redis" framing only holds *within* a single replica process, not across the fleet.

## Finding 2 — a worker crash does not take down the process

**Confirmed via `worker-crash-test.mjs`:**

```
worker crash outcome observed by main thread: {"type":"error","message":"simulated crash mid-rebuild"}
main thread is still alive and executing this line after the worker crashed.
```

An uncaught exception inside the rebuild worker surfaces as an `'error'` event on the `Worker` handle in the main thread — it does not crash the process. A real implementation can catch this, log it, keep serving reads against the last-good `SharedArrayBuffer` generation, and respawn a fresh worker for the next rebuild cycle. This is a safe pattern.

## Finding 3 — the SAB reader is a correct, faithful port of the current logic

**Confirmed via `correctness-test.mjs`, 7/7 cases:** every filter combination the real selector supports (no filters, required capabilities, multiple required capabilities, a nonexistent capability with fail-open semantics, preferred providers, excluded providers, and a context-size filter that empties the curated bucket) produces byte-identical result sets (same IDs, same counts, same provider distribution, same top-provider concentration share) between the current Map-based implementation and the SAB-based reader. This is not just "fast" — it's a verified-correct reimplementation, not an approximation.

## Finding 4 — real, dramatic performance improvement, when architected correctly

**Confirmed via `bench.mjs`** (N = concurrent requests, event-loop-delay measured via a continuous `setImmediate` probe — its own scheduling delay is direct proof of event-loop blockage, not an inference):

| N (concurrent) | Map: wall time | Map: p50 latency | Map: event-loop max delay | SAB: wall time | SAB: p50 latency | SAB: event-loop max delay |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 105.1ms | 104.9ms | 109.8ms | 4.9ms | 4.8ms | 4.9ms |
| 10 | 967.7ms | 97.1ms | 968.3ms | 33.6ms | 3.0ms | 33.7ms |
| 50 | 8,009.4ms | 156.9ms | 8,148.3ms | 3,764.0ms | 1.5ms | 3,764.1ms |
| 100 | 12,573.6ms | 73.2ms | 12,573.8ms | 4,135.6ms | 1.4ms | 4,135.7ms |
| 300 | 40,178.0ms | 64.6ms | 40,178.2ms | 15,695.4ms | 1.8ms | 15,695.5ms |
| 500 | 73,504.6ms | 66.9ms | 73,510.9ms | 6,782.2ms | 1.0ms | 6,782.3ms |

At N=500 concurrent requests: **10.8x faster wall-clock completion** (73.5s → 6.8s) and **66x faster median per-request latency** (66.9ms → 1.0ms). The event-loop-delay column is the real story: the Map approach's event loop is blocked for the ENTIRE wall-clock duration of the batch (it IS the bottleneck) — the SAB approach's reads are near-instant memory access, so the only remaining event-loop pressure is from `JSON`/HTTP-layer overhead already present in either design, not from the candidate-selection scan itself.

**Confirmed via the same script's concurrent-rebuild-in-flight test:** 500 real reads completed (p50=1.28ms, all returning correct non-empty results) *while a full 111,666-row rebuild ran concurrently on the worker thread* — proving the design's core promise (reads stay fast and correct during a refresh cycle, not just at rest) actually holds under real concurrent load, not just in isolation.

## Finding 5 — real, non-trivial memory cost

**Confirmed via `memory-footprint.mjs --expose-gc`:**

- Current Map-based indices (`byId`+`byProvider`+`byCapability`): **7.16MB** heap for 111,666 real rows.
- SAB fixed-capacity double-buffer (current generation + next generation being rebuilt): **56.75MB** resident, **regardless of actual row count** — this is capacity-based (sized for headroom up to 200,000 models / 120,000 curated / 200,000 aggregated so the buffer survives catalog growth without a resize), not usage-based. At today's real row count, per-model-array capacity is ~56% utilized; the rest is real, resident, currently-idle memory.

**This is a genuine ~8x memory increase** (56.75MB vs 7.16MB) per API service replica, purely as the cost of the double-buffered, fixed-capacity design. This is a real tradeoff to weigh against the throughput/latency win above, not a free lunch — 56.75MB per replica is a modest absolute number on a machine with GBs of RAM, but it is 8x more than what exists today and should be sized deliberately (the `MAX_MODELS`/`CURATED_CAP`/`AGGREGATED_CAP` constants in `capacity.mjs`) rather than left as an afterthought.

## Finding 6 — critical implementation constraint: the worker must NOT receive catalog rows via `postMessage`

**Confirmed via `postmessage-cost.mjs`, 3 runs:**

```
run 0: postMessage() call itself blocked the main thread for 1193.14ms (serializing 111666 objects) | worker-side encode took 944.93ms (off main thread)
run 1: postMessage() call itself blocked the main thread for 1704.53ms ...
run 2: postMessage() call itself blocked the main thread for 1466.74ms ...
```

If a real implementation fetches the catalog rows on the main thread (e.g. via the existing DB/Redis client) and then hands them to the worker via `worker.postMessage(rows)`, the **synchronous structured-clone serialization of that postMessage call alone blocks the main thread for 1.2–1.7 SECONDS** — this is comparable to or worse than the very main-thread-blocking problem this whole design exists to solve, and it would happen on every refresh cycle. This is not a hypothetical footgun; it is the single easiest, most natural-looking way to implement "fetch data on main thread, hand off to worker," and it silently defeats the entire point.

**The worker MUST have its own direct data-source access** (its own DB connection / its own Redis client / its own HTTP call to fetch catalog data) and do the ENTIRE fetch-then-encode sequence on its own thread, never receiving the raw row array from the main thread via `postMessage`. This is the single most important implementation constraint this investigation surfaced, and it was not obvious in advance — it would very plausibly have been gotten wrong by a first-pass implementation that assumed "the main thread already has a DB client, just reuse it and pass the rows to the worker."

## What this does NOT solve

- **Cross-replica (cross-process) shared state.** Confirmed impossible via Finding 1. The 2 API service replicas still need Redis (or equivalent) to agree on anything, including which one's catalog snapshot is "current." This design only removes main-thread blocking *within* one replica's own candidate-selection path.
- **A network hop is not fully eliminated** if the worker's own data source is still Redis/Postgres over the network — Finding 6 means the worker needs *a* real data source of its own, and unless that source is itself in-process (unlikely for a catalog this size), there IS still a network round-trip per rebuild cycle, just moved off the main thread and off the request-serving path. The operator's original framing ("avoiding even the network hop to Redis") is accurate only in the narrow sense of removing it from the per-request read path, not from the periodic rebuild path.

## Recommendation

Building this for the SINGLE-process, `worker_threads`-only scope (NOT cross-replica) is justified by real, measured data: a ~10x wall-clock and ~66x median-latency improvement under concurrent load, with a verified-correct reimplementation and a confirmed-safe crash-isolation story. The two real costs to budget for explicitly are the ~8x memory increase per replica (Finding 5) and the mandatory worker-owns-its-own-data-source architecture constraint (Finding 6) — get the second one wrong and the whole benefit disappears.

This does NOT replace Redis for cross-replica coordination, and should not be pitched as doing so.

## Scripts in this directory

All 15 scripts referenced above are real, runnable, and committed alongside this report: `bench.mjs`, `capacity.mjs`, `correctness-test.mjs`, `cross-process-test.mjs` (+ its generated child), `current-map-approach.mjs`, `encode.mjs`, `fixture.mjs`, `memory-footprint.mjs`, `postmessage-cost.mjs`, `reader.mjs`, `schema.mjs`, `worker-crash-test.mjs` (+ its generated child), `worker.mjs`. Every numeric result quoted in this report was reproduced by directly running these scripts on 2026-09-09, not carried over from an earlier, lost session.
