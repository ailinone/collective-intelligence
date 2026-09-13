<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-026: `SELECTION_USE_FULL_CACHE_INDEX` Rollout Readiness (default stays OFF)

**Status**: Accepted (decision: do not change the default; documents the preconditions for revisiting)
**Date**: 2026-09-09
**Context**: Operator directive — "HuggingFace deve funcionar com todos os modelos disponíveis de inferência", i.e. no artificial ceiling on how much of the catalog real selection can consider.
**Related**: PR #481 (feature, merged, flag default OFF), PR #525 (perf fix for the flag's own code path, open/not merged), PR #523 (concurrent-load benchmark, open/not merged, stacked on #525), PR #531 (SharedArrayBuffer + `worker_threads` feasibility investigation, merged, docs-only — `investigation/sab-worker-feasibility/REPORT.md`), `api/docs/CAPACITY-SCALING-PLAN-10K-USERS.md`, `api/src/middleware/admission-control.ts`, `api/src/core/selection/dynamic-model-selector.ts` (`getBucketFairCandidateUids`, `getFullCacheFairCandidateModels`, `isFullCacheIndexEnabled`)

## Context

`dynamic-model-selector.ts`'s default candidate-retrieval path (`getBucketFairCandidateUids`, SQL-backed) draws from two independently-bounded slices of the catalog: `curatedCandidateTake` and `aggregatedCandidateTake`, both defaulting to 400 (800 total, `api/src/config/model-selection-config.ts`). The aggregated bucket is ~99.997% HuggingFace (73,782 of the catalog's 111,666 rows, live 2026-09-08 audit). Any fixed-size slice of that bucket structurally caps how many HF models a real selection can ever consider, independent of how fair the slice itself is — which is exactly the "no artificial ceiling" requirement this ADR was opened to satisfy.

PR #481 (merged) already built and shipped a correct, tested, additive alternative: `getFullCacheFairCandidateModels`, gated behind `SELECTION_USE_FULL_CACHE_INDEX` (default `false`). It filters/ranks directly against the full in-process catalog cache (`model-catalog-service.ts`'s `byId`/`byProvider`/`byCapability` indices) instead of a bounded SQL query — every non-disabled catalog row is visited on every call, removing the 400/bucket ceiling entirely. Correctness is verified (`full-cache-fair-candidate-retrieval.test.ts`, `catalog-indices.test.ts`) and the underlying logic is not in question.

This ADR was opened to answer one question: **should that flag's default become `true`?**

## Decision

**No — the default stays `false`.** The mechanism is correct; shipping it as the fleet-wide default today is not safe. This is a "not yet", not a "no" — see the preconditions below.

## Why: a real, measured architectural problem, not caution for its own sake

`getFullCacheFairCandidateModels` is 100% synchronous, CPU-bound JavaScript that scans the **entire** catalog on every single call (by design — a structural-contract test in `full-cache-fair-candidate-retrieval.test.ts` guards against ever early-exiting that scan, after a real historical "0 curated / 800 aggregated" incident). Node is single-threaded for JS execution: while this function runs, the event loop cannot service *any other in-flight request on the same process* — not a callback, not a timer, not another request's I/O completion.

The SQL path it would replace (`getBucketFairCandidateUids`) is `await`ed. Postgres does the work off the Node process, so concurrent requests on that path genuinely overlap (bounded by the pg connection pool, a different ceiling — see the direct comparison below). Flipping this flag does not just change *where* candidates come from; it converts an I/O-bound wait into a CPU-bound block on the one thread every other request also depends on.

### Measured evidence (real, reproduced 2026-09-09, not estimated)

**1. Sequential cost** (`full-cache-index-benchmark.test.ts`, run against this exact branch — i.e. *with* PR #525's partial-sort perf fix already applied — via `vitest.ci.config.ts`, the project's real CI config):

- `getFullCacheFairCandidateModels` alone: avg **91.1ms**, max **291.9ms** over 20 calls against the real 111,666-row production catalog shape.
- Full `findModelsByRequirements`, warm catalog cache (the realistic steady-state case): **631.9ms** — this **failed** the test's own generous 500ms bound (`expected 631.86 to be less than 500`). Machine contention on the shared dev host inflates this number, but the test exists precisely because "single-digit to low-double-digit ms" was the claimed steady state, and even a generous bound did not hold in a real run.

**2. Concurrent-load cost** (`full-cache-index-concurrent-load-benchmark.test.ts`, same run, same branch — this is the test PR #523 built specifically to answer "what happens under concurrent load", which a sequential average cannot expose):

| N (concurrent) | Total wall-clock | Throughput | Effective p50 latency | Event-loop-lag probe max gap |
|---:|---:|---:|---:|---:|
| 1 | 204.9ms | 4.9 req/s | 202.6ms | 205.9ms |
| 10 | 1,581.0ms | 6.3 req/s | 1,072.4ms | 1,612.9ms |
| 50 | 4,995.0ms | 10.0 req/s | 1,874.2ms | 4,995.4ms |
| 100 | 7,594.1ms | 13.2 req/s | 4,025.9ms | 7,594.8ms |
| 300 | 22,389.8ms | 13.4 req/s | 11,416.1ms | 22,417.1ms |
| 500 | 32,465.3ms | 15.4 req/s | 14,606.8ms | 32,505.0ms |

The event-loop-lag column (a real `setImmediate`-probe measurement — the delay before a scheduled macrotask actually runs — not an inference from the batch's own reported duration) tracks the batch wall-clock almost exactly at every N: the event loop is unavailable to every *other* in-flight request for essentially the full duration of the batch. At N=500, the median concurrent request waits **14.6 seconds** behind requests queued ahead of it on the same replica, and the last one waits **32.5 seconds**. Throughput plateaus at ~13-15 req/s regardless of concurrency — a hard per-replica ceiling, not a transient slope.

**3. Independent corroboration** — `investigation/sab-worker-feasibility/REPORT.md` (PR #531, merged, docs-only), a from-scratch investigation using a verified byte-identical 1:1 port of this exact function (`current-map-approach.mjs`, correctness-checked 7/7 against the real implementation), found the same failure mode independently. Re-run fresh today (`node investigation/sab-worker-feasibility/bench.mjs`, pre-#525 baseline logic, same 111,666-row fixture):

| N | Map approach: wall-clock | Map approach: event-loop max delay | SAB+worker_threads: wall-clock | SAB+worker_threads: event-loop max delay |
|---:|---:|---:|---:|---:|
| 1 | 92.3ms | 97.2ms | 50.5ms | 50.6ms |
| 10 | 614.1ms | 614.7ms | 105.0ms | 105.1ms |
| 50 | 5,044.8ms | 5,065.6ms | 140.0ms | 140.2ms |
| 100 | 12,460.4ms | 12,460.6ms | 365.6ms | 365.7ms |
| 300 | 27,987.7ms | 27,988.0ms | 586.1ms | 586.2ms |
| 500 | 41,018.8ms | 41,019.1ms | 886.3ms | 888.6ms |

At N=500: the proposed (but unbuilt) SharedArrayBuffer + `worker_threads` redesign is **~46x faster wall-clock** and moves the event-loop-blockage from ~41 seconds to under 1 second — proof that the blocking is fixable, but not with the mechanism this flag ships today.

**4. The SQL path's own real concurrent-load numbers** (`full-cache-index-concurrent-load-benchmark-db.test.ts`, PR #523 — run as part of this ADR's verification, against a real Testcontainers-provisioned Postgres with `DB_POOL_MAX=100`, the same pool size production uses per replica, seeded with the same 111,666-row production shape):

| N (concurrent) | Total wall-clock | Successful throughput | Failures | Latency p50 | Latency p95 | Latency max |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 252.0ms | 4.0 req/s | 0/1 | 251.4ms | 251.4ms | 251.4ms |
| 10 | 1,569.7ms | 6.4 req/s | 0/10 | 962.1ms | 1,542.0ms | 1,565.3ms |
| 50 | 4,683.2ms | 10.7 req/s | 0/50 | 2,928.0ms | 4,478.8ms | 4,679.2ms |
| 100 | 6,484.5ms | 15.4 req/s | 0/100 | 1,460.4ms | 6,118.2ms | 6,443.0ms |
| 300 | 14,910.0ms | 20.1 req/s | 0/300 | 8,346.3ms | 14,086.4ms | 14,890.9ms |
| 500 | 14,731.8ms | 33.9 req/s | 0/500 | 129.4ms | 13,416.5ms | 14,618.4ms |

**Direct comparison at N=500** (same machine, same run, same 111,666-row catalog shape): the SQL path (today's default) finishes the whole batch in **14.7s** with **zero failures** and **33.9 req/s** throughput; the in-memory full-cache-index path (this flag, ON) takes **32.5s** — more than double — for the same batch, capping at **15.4 req/s**. The SQL path's own tail latency is real and not free (p95/p99 do reach double-digit seconds once N crosses its 100-connection pool), but that is a *different, more familiar failure mode* (pg-pool queueing — tunable via `DB_POOL_MAX`, PgBouncer, read replicas) than the in-memory path's event-loop starvation, which has no equivalent tuning knob today and additionally blocks every OTHER request type on the same process (not just other selection calls). Neither path is free at N=500 on this host; the SQL path is measurably, concretely better on every axis measured here (wall-clock, throughput, failure count).

### Why this is a real production risk right now, not a theoretical one

Two facts about the current environment turn "slow under synthetic load" into "unsafe to default on":

1. **Zero CPU headroom.** `api/docs/CAPACITY-SCALING-PLAN-10K-USERS.md` §1.3 (live-measured): "Both `ci_api` replicas already run at ~100% of a full core from baseline background work alone" — before this flag adds a mandatory per-request full-catalog scan on top.
2. **No enforcing backpressure.** `api/src/middleware/admission-control.ts` — this repo's own event-loop-lag safety net — ships with `ADMISSION_CONTROL_ENFORCE=false` by default and its resource-pressure thresholds (`maxEventLoopDelay` etc.) deliberately **unset**, because (the module's own doc, quoting the capacity plan) "no load test has ever produced a committed result in this repo" and guessing risks shedding legitimate traffic. In its current, correct, cautious configuration, admission control would **log** the event-loop stalls measured above, not prevent them, from reaching real users.

Combined: there is currently no mechanism in this codebase that would stop the 14-32 second tail-latency scenario measured above from reaching real users if this flag were the fleet-wide default during a real traffic burst.

## Preconditions before this can safely become the default

In rough priority order:

1. **Move the O(catalog) scan off the main thread.** The investigation above found no way to remove the blocking, only to shrink its constant factor (PR #525). `investigation/sab-worker-feasibility/REPORT.md`'s SharedArrayBuffer + `worker_threads` design is verified-correct and viable, but not yet implemented as shipped code, and carries its own undischarged costs: a documented ~8x per-replica memory increase (56.75MB vs 7.16MB), and a non-obvious "the worker must own its own data-source connection, never receive catalog rows via `postMessage`" constraint — violating it was measured to reintroduce a 1.2-1.7 SECOND main-thread block on every refresh cycle, comparable to or worse than the problem being solved.
2. **Merge PR #525 regardless of this decision.** Its partial-sort fix (`partialSortPrefixByComparator`, replacing two "sort everything to take the top K" antipatterns) is a strict, zero-behavior-change improvement shared by both the SQL path and this one (~1.4-1.6x measured in that PR's own before/after). It does not resolve the blocking, but there's no reason to withhold it.
3. ~~Load-test the SQL path's own concurrency ceiling before treating it as the baseline to beat.~~ **Done as part of this ADR** — see the direct comparison above (`full-cache-index-concurrent-load-benchmark-db.test.ts`, PR #523, run against a real Testcontainers Postgres with `DB_POOL_MAX=100`). The SQL path degrades too at N≥300 (its own pool becomes the ceiling — a real, separate concern worth its own follow-up: `DB_POOL_MAX`/replica × 2 replicas + 1 worker ≈ 300 potential connections vs Postgres's live `max_connections=200`, per `CAPACITY-SCALING-PLAN-10K-USERS.md`), but it fails zero requests and beats the in-memory path on every measured axis at the same N.
4. **Turn on `ADMISSION_CONTROL_ENFORCE` with real, load-test-derived thresholds** before or together with this flag, so a regression sheds load with a controlled 503 instead of silently stacking request latency to tens of seconds.

## Alternatives considered

- **Just raise `SELECTION_CURATED_TAKE`/`SELECTION_AGGREGATED_TAKE` (already env-overridable today, no deploy needed) instead of the flag.** This is real, safe headroom available immediately on the existing async SQL path — but `curatedCandidateTake + aggregatedCandidateTake`'s current 800-row ceiling is independently cited in `CAPACITY-SCALING-PLAN-10K-USERS.md` as a deliberate, previously-reasoned bound on the *downstream* scoring/rerank loop's own cost (which runs `Promise.all` over every candidate). Raising it meaningfully (not by a token amount) needs its own dedicated load test of that downstream loop, which is out of scope for this ADR and was not performed here. Left as a follow-up, not a substitute decision made silently inside this one.
- **Ship the flag on behind a canary/percentage rollout instead of a blanket default.** Plausible future path once Precondition 1 lands, but this repo has no existing canary/percentage-rollout mechanism for selection-path flags today; building one is itself outside this ADR's scope.

## Consequence

The 400/bucket (800 total) ceiling on real selection's HuggingFace visibility remains in place for now. This is an accepted, documented trade-off, not an oversight: the alternative (defaulting the flag on today) trades a bounded, well-understood SQL latency cost for an unbounded, currently-unguarded event-loop-blocking risk on a fleet already at ~100% CPU with no enforcing backpressure. Revisit this ADR once Precondition 1 (and ideally 2-4) are satisfied.

## Verification performed for this ADR

All runs below were executed against `origin/main` merged with PR #525 (perf fix) and PR #523 (concurrent-load benchmarks) — the best-case, most-optimized state of the flag's code path available, so this decision is not penalizing an unoptimized baseline:

- `npx tsc --noEmit`: clean, exit 0.
- `vitest run --config vitest.ci.config.ts src/core/selection/`: **16 test files, 104 tests, all passed**, exit 0 (578s wall — includes the two full-cache-index benchmark files and the new DB-backed concurrent-load benchmark, all in the same run). No regressions to the existing suite from either open PR's changes.
- `vitest run --config vitest.ci.config.ts` on the two in-memory full-cache-index benchmark files standalone: 2/3 passed; the one failure is the sequential warm-cache 500ms bound (631.9ms observed — cited above), not a correctness failure.
- `node investigation/sab-worker-feasibility/bench.mjs`: re-run fresh, numbers cited above.
- This ADR's own conclusion does not depend on machine-contention-sensitive absolute numbers alone — the *event-loop-lag probe* (a direct, falsifiable measurement, not an inference) and the *zero-vs-nonzero failure count* between the two paths at identical N are the load-bearing evidence, and both are structural properties of the two implementations, not artifacts of this particular shared dev host's load.
