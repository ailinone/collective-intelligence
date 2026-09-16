<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-028: SAB Worker Memory Ceiling — Canary 3 OOM (2026-09-16)

**Status**: Accepted (Layer 1 + Layer 3 implemented and shipped this PR, flag default stays OFF; Layer 2 documented as pending/conditional, not implemented)
**Date**: 2026-09-16
**Context**: ADR-027 shipped the `SharedArrayBuffer` + `worker_threads` candidate index (`SELECTION_USE_SAB_CANDIDATE_INDEX`, default OFF) and its own "Canary 2" section already found and fixed one production OOM-adjacent incident (capability-mask truncation + an unmultiplied metadata blob default). This ADR documents a THIRD incident — a real container OOM-kill, not just a failed build — found on a canary run today, its full root cause, and the three-layer remediation plan this PR implements the first two layers of.
**Related**: ADR-027 (`sab-worker-candidate-index.md` — the mechanism this incident occurred in; "Canary 2" section is the direct predecessor of this one), ADR-026 (`full-cache-index-rollout-readiness.md` — the event-loop-blocking problem this whole design exists to solve), `api/src/core/selection/sab-candidate-index/` (worker.ts, manager.ts, capacity.ts, schema.ts, encode.ts, worker-memory-guard.ts — all touched by this PR).

## What happened (Canary 3, 2026-09-16)

`SELECTION_USE_SAB_CANDIDATE_INDEX=true` was enabled on a single `ci_api` replica (container memory limit: 4 GiB). The replica's `MainThread` process was OOM-killed by the kernel within minutes of starting, at ~4.1 GB RSS — inside the container's own cgroup limit, not a host-wide OOM. Manual rollback restored the replica to normal immediately. No user-facing outage: the flag was off on every other replica, and this one replica's traffic share was small.

## Root cause (verified against real code and real production data — not speculated)

Six independent, compounding facts, each confirmed against the code or a live measurement:

1. **The Redis-first fetch parses a >100MB unfragmented string.** `worker.ts`'s `fetchCatalogModels()` (pre this PR) read the fleet-wide catalog snapshot from Redis and ran `JSON.parse(raw)` on it as a single string. ADR-027's own "Worker transient heap cost" section had already measured this at ~521MB worker heapUsed against a 96,118-row catalog (2026-09-10) — this PR did not discover that number, it discovered that nobody had connected it to today's incident.
2. **The catalog grew ~18% same-day.** A grace-period bug fix earlier in the day grew the active catalog from ~99,019 to ~116,627 models. The Redis-parse peak in point 1 scales roughly linearly with row count, so today's real peak was measurably higher than the 2026-09-10 measurement it was still being reasoned about with.
3. **The SharedArrayBuffers were always allocated at the full 200,000-row design ceiling**, regardless of the real catalog size. `capacity.ts`'s `MAX_MODELS` (200,000) fed directly into `METADATA_BLOB_BYTES` (`MAX_MODELS x METADATA_BYTES_PER_MODEL` = 195.31 MiB per generation) and every per-model SoA field — a fixed ~477 MiB of headroom the process paid for on every boot, whether the catalog needed it or not. At 116,627 real rows that day, roughly 60% of that allocation was pure margin for a catalog size the deployment might not reach for a long time.
4. **The Postgres-fallback path already protects `ci_db`, but not the worker's own heap.** ADR-027's "Canary 2" fix (`postgres-paged-fetch.ts`) made the Postgres fallback keyset-paginated on the SERVER side — a real, correct fix for the `ci_db` OOM that canary hit. But `fetchCatalogModelsPaged` still accumulated every page's mapped rows into one `const models: Model[] = []` in the WORKER's own heap before returning. The database side was protected; the worker process's own memory was not.
5. **`encodeGeneration` genuinely needs the full row set before it can write anything**, which rules out a naive "stream and discard" fix. `measureBlobs()` first computes exact byte totals via a full `JSON.stringify` pass (deliberately uncached — the code comment already explains this trades CPU for ~110MB less resident heap), and the encoder then computes a global per-provider fairness ranking (`selectCuratedFairUids`'s own logic, precomputed once here) before it can decide each model's final slot in the curated-order array. This is a REAL constraint, not an oversight: page-by-page streaming without first knowing every row would require re-deriving the fairness ranking after the fact, which is exactly the kind of two-pass rewrite ADR-027 avoided taking on originally.
6. **The real per-row metadata size was NOT the problem.** A live, read-only query against `ci_db` on the day of the incident measured 116,683 active rows, average metadata 938 bytes, maximum 13,757 bytes, zero rows above 50 KB — a real summed metadata size of ~104.4 MiB, comfortably under the 195.3 MiB blob ceiling. The OOM was the SUM of points 1 and 3 (a large transient Redis-parse spike plus a large permanent fixed allocation), stacked on top of the process's own pre-existing 1.6–2.8 GiB baseline (measured previously, without SAB) — not any single oversized row or blob.

## Decision

Fix this in three layers, landed as separate PRs/commits so each is independently reviewable and revertible:

- **Layer 1** (this PR, low risk / high return): eliminate the Redis-parse peak from the SAB worker's own fetch path entirely, and stop always allocating the full 200,000-row ceiling regardless of real catalog size.
- **Layer 2** (documented here, NOT implemented in this PR): rewrite `encodeGeneration` as a genuine two-pass, page-discarding encoder. Conditional on Layer 1's own measured results — see "Layer 2" below for why.
- **Layer 3** (this PR, operational safety net): instrument the worker's real RSS during every rebuild and abort gracefully, before publishing, if it crosses a configurable threshold — the same fail-closed philosophy `SabEncodeCapacityError` already uses for capacity overflow, now also covering the memory dimension no capacity check can see.

## Layer 1: eliminate the avoidable memory cost

### 1a. The SAB worker's rebuild fetch is now Postgres-only by default

`worker.ts`'s fetch is now selected by `SAB_CANDIDATE_WORKER_SOURCE` (default `'postgres-only'`): the worker's OWN rebuild fetch never attempts the Redis fleet-wide snapshot at all — it goes straight to the already-paginated, already-bounded `fetchCatalogModelsPaged` path ADR-027's "Canary 2" hardened (keyset pagination on `uid`, a per-page `statement_timeout`, `SAB_CANDIDATE_WORKER_FETCH_PAGE_SIZE` rows per page). This closes the single largest contributor identified above (point 1) without touching `ci_db` load characteristics at all — the paged fetch was already safe from the database's point of view; this change only removes the WORKER-side `JSON.parse` spike, which was strictly larger than the paged-fetch path's own transient cost even before this PR (ADR-027's own numbers: ~521MB Redis-parse peak vs. ~280MB unpaged-Postgres peak at the same row count, and the paged fetch is cheaper still).

This has **zero effect on any other consumer of the Redis snapshot** — `model-catalog-service.ts`'s own cold path, and every other reader of `CATALOG_REDIS_KEY`, are completely unchanged. Only this one worker's own rebuild fetch changes.

A `SAB_CANDIDATE_WORKER_SOURCE=redis-first` escape hatch preserves the exact pre-ADR-028 fetch order (Redis first, Postgres fallback) behind an env var, for a same-config rollback if the paginated Postgres path itself ever becomes the bottleneck on some future deployment — with the explicit understanding that doing so reintroduces the exact risk this ADR closes.

### 1b. SharedArrayBuffers are now sized dynamically, not fixed at the 200,000-row ceiling

`capacity.ts` gained `computeEffectiveMaxModels(liveRowCount)`: `min(MAX_MODELS, ceil(liveRowCount x (1 + SAB_CANDIDATE_MAX_MODELS_MARGIN)))`, margin defaulting to 30%. `MAX_MODELS` (env `SAB_CANDIDATE_MAX_MODELS`, default 200,000) remains the hard, never-exceeded ceiling — this is additive headroom management, not a new ceiling.

`buildCapacityConfig(maxModels)` derives every size-dependent bound (curated/aggregated caps, the metadata blob size) from that single number, and is the ONE function both `manager.ts` (allocating buffers) and `worker.ts` (independently recomputing the same layout to verify against the buffers it was handed via `workerData.effectiveMaxModels`) call — so the two sides cannot derive different layouts from the same number. `schema.ts`'s `computeLayout()` gained an optional `CapacityOverride` parameter; called with no argument (every pre-ADR-028 call site) it is byte-for-byte identical to before.

`encode.ts`'s capacity checks were changed to read bounds from the `GenerationViews` themselves (`views.metadataBlob.length`, `views.idStrOffset.length`, etc.) rather than from `capacity.ts`'s fixed module-level constants. This is not just a refactor to support dynamic sizing — it is a strictly more correct invariant than before: the encoder is now bounded by whatever buffer it was ACTUALLY given, for any allocation size, rather than by a constant that could in principle silently disagree with the real buffer (the class of bug that would have been a silent out-of-bounds write, not a caught capacity error).

**Growth and shrink policy** (`manager.ts`'s `maybeResizeAfterBuild`): the FIRST allocation a process ever makes always uses the fixed ceiling (`MAX_MODELS`) — there is no live row-count signal yet, and (see "Why not a startup `SELECT count(*)`" below) sizing the first allocation from a real query was deliberately rejected. After every SUCCESSFUL build, the manager compares the real `rowCount` against the current allocation:
- **Grows** when usage crosses 90% of current capacity AND the ceiling hasn't already been reached — proactive, never urgent (a build that just succeeded already proves the current capacity was sufficient for TODAY).
- **Shrinks** when the freshly-computed ideal size would be 60% or less of the current allocation — a real, meaningful overprovisioning, not a rounding-driven flap on every rebuild.
- A resize reallocates fresh `SharedArrayBuffer`s and starts a new worker against them (`scheduleResize`) — deliberately a "stop the old, start the new" transition, not a live three-generation swap. `SharedArrayBuffer`'s own `grow()`/`transfer()` can only extend a single buffer's END; it cannot re-lay-out a struct-of-arrays schema where every field must grow together (the same reasoning the original feasibility investigation used to choose fixed capacity over a growable buffer in the first place). During the brief gap between retiring the old worker and the new one completing its first build, reads return `null` — the SAME, already-relied-upon fail-open cold-start contract every caller (`dynamic-model-selector.ts`) already handles. A resize is expected to fire a handful of times over a long-running replica's life (crossing the growth/shrink thresholds), never once per rebuild cycle, so this brief gap is an accepted trade-off against the real complexity of a live swap. The ORDINARY rebuild path (every cycle that does not resize) is completely untouched and keeps its existing zero-downtime double-buffer flip.
- `SAB_CANDIDATE_DYNAMIC_RESIZE=false` disables resizing after the first allocation entirely (kept for hermetic tests that need a fixed-size buffer for their whole lifetime, and available as an operator escape hatch).

**Why not a startup `SELECT count(*)` to pre-size the FIRST allocation** (a deliberate deviation from a literal reading of "query the count at startup"): `ensureSabCandidateIndexStarted()` must stay fully synchronous — it is called fire-and-forget from the request hot path (`dynamic-model-selector.ts`), and the existing test suite (`manager-rebuild-failed-metrics.test.ts`, `sab-worker-concurrent-load-benchmark.test.ts`) asserts the worker exists synchronously immediately after it returns. A separate async count query would either have to block that synchronous contract (unacceptable) or race the worker's own first fetch for no real benefit. The first successful build already produces an exact, real row count for free (`GenerationMeta.rowCount`) — `maybeResizeAfterBuild` uses that, with zero extra queries and zero timing races, to right-size every allocation AFTER the first one. The cost of this choice is that the very first allocation after a process boot still pays for the full ceiling; the benefit is a provably race-free, contract-preserving design. Given the memory ceiling itself is not the incident's root cause (point 3 above is a real but secondary contributor next to point 1), this trade-off was judged worth it.

### Real, measured effect of Layer 1 (this session, real Testcontainers Postgres, 111,666 seeded rows, default config)

- `lastSource` is `'postgres'` on every build (never `'redis'`) in the default mode, as designed.
- First real build from Postgres: 111,666 rows in ~6.4–6.9s (comparable to ADR-027's own pre-existing paginated-fetch timings — Layer 1 does not change the paginated fetch itself).
- Worker peak RSS across a fresh boot + one out-of-cycle rebuild + N=1..500 concurrent-read benchmark: 687 MB → 1,561–1,627 MB (climbing over the run as more of the SharedArrayBuffer pages get touched — the buffers are backed lazily by the kernel, exactly as ADR-027 documented; this is the resident cost of TOUCHED pages, not the ~455 MiB virtual figure). This is comfortably under the 3,200 MB default Layer 3 abort threshold (see below) at today's real catalog size, with real headroom to spare.
- At 111,666 real rows against the default 200,000 ceiling, `computeEffectiveMaxModels` would resolve to `ceil(111,666 x 1.3) = 145,166` on any SUBSEQUENT allocation (below the 60%-of-ceiling shrink trigger of 120,000, so no resize actually fires here — the ceiling-sized first allocation is already close enough to right-sized at this row count not to churn). The dynamic-sizing benefit is largest for catalogs meaningfully smaller than 200,000 (e.g. a staging deployment, or a production catalog earlier in its growth curve) and largest of all against a shrunk, growing catalog moving back up through the growth-threshold repeatedly.

## Layer 2 (documented, NOT implemented this PR — conditional on further measurement)

A genuine two-pass encoder:
- **Pass 1 (light)**: read only the fields `selectCuratedFairUids`'s fairness ranking actually needs (provider id, model id, usage count) — enough to compute the global curated-order/aggregated-order assignment without materializing full `Model` objects or their metadata.
- **Pass 2 (heavy)**: re-fetch (or re-iterate, page by page) with the FULL row shape, writing each row directly into its ALREADY-KNOWN slot (from pass 1) and discarding each page immediately after writing — never holding more than one page's worth of full `Model` objects in the worker's heap at once.

This is real, structural additional complexity (two fetch passes instead of one, and the ranking computation would need to survive being separated from the row data it currently walks in the same loop) and is being deferred until there is real evidence Layer 1 alone does not leave a comfortable margin. Based on this session's own measurements above (peak ~1.6 GB against a 3.2 GB abort threshold and a 4 GB container limit, at TODAY's ~116,627-row catalog), Layer 1 currently looks sufficient — but the catalog is still growing, and Layer 2 is the natural next lever if a future canary or the Layer 3 metrics below show the margin closing. **This PR does not implement Layer 2.**

## Layer 3: operational safety net (this PR)

`worker-memory-guard.ts` (new, deliberately dependency-free and pure — see its own module doc for why: `worker.ts` cannot be imported directly in a normal test process, so this logic is extracted the same way `postgres-paged-fetch.ts`/`worker-database-url.ts` already extract other worker-side logic for hermetic unit testing):

- `resolveMemoryAbortThresholdBytes()`: `SAB_WORKER_MEMORY_ABORT_THRESHOLD_MB` (default 3200 MB — for a 4096 MB container, leaving ~800 MB / ~19.5% margin for the main thread's own usage and whatever a checkpoint gap misses, matching the same generous-but-not-reckless spirit as `manager.ts`'s existing `resolveWorkerResourceLimits()`).
- `checkMemoryThreshold(checkpoint, currentRssBytes, thresholdBytes, tracker)`: records the peak RSS seen so far and throws `SabWorkerMemoryAbortError` (same fail-closed shape as `SabEncodeCapacityError`) once RSS crosses the threshold.

`worker.ts`'s `runRebuild()` calls this at three checkpoints per rebuild attempt — before the fetch, after the fetch, and after the encode but BEFORE publishing (the `Atomics.store` block that flips `ACTIVE_GEN`) — using real `process.memoryUsage().rss` (not `heapUsed`: RSS is what the container cgroup's OOM killer actually acts on, and it is the only one of the two that also covers the `SharedArrayBuffer` pages, the pg driver's native buffers, and every other off-heap allocation `heapUsed` misses). An abort at any checkpoint discards the in-progress generation entirely — the inactive buffer slot may have been partially written, but `ACTIVE_GEN` never flips to it — and reports `rebuild-failed{reason="memory"}` through the SAME `runRebuild()` catch block and the SAME "last-good generation keeps serving" contract every other rebuild failure already has. No new crash-handling code was needed.

The peak RSS observed is reported on EVERY rebuild message (`peakRssBytes`, both `rebuilt` and `rebuild-failed`) — not only failures — so the memory profile of ordinary, successful rebuilds is visible too, closing the exact observability gap ADR-027's "Canary 2" section found for the capacity dimension ("nothing in Prometheus showed any of this... every SAB metric read exactly like a process that had just booted"). Two new gauges follow the existing push-model convention (`manager.ts`'s `handleWorkerMessage`, same as every other SAB metric):

- `ci_sab_candidate_index_worker_peak_rss_bytes` — peak RSS from the most recent rebuild attempt (successful or aborted).
- `ci_sab_candidate_index_max_models_effective` — the effective `MAX_MODELS` the currently-allocated buffers are sized for (Layer 1's dynamic sizing made this genuinely variable over a process's lifetime, unlike the pre-ADR-028 fixed ceiling).

`ci_sab_candidate_index_build_failures_total{reason}` gained a fourth label value, `"memory"`, alongside the existing `capacity`/`fetch`/`other`.

## Preconditions before a NEW canary (Canary 4)

Everything ADR-027's own Preconditions 1–4 already required still applies (a real percentage rollout or single-replica soak, `ready` reaching 1, `build_failures_total` staying at 0 in steady state, watching capability-mask headroom). This ADR adds:

5. **Real RSS delta must be re-measured under this PR's actual changes**, not just this session's Testcontainers benchmark (which is a real end-to-end exercise of the real compiled/tsx-executed `worker.ts`, but not a real production traffic pattern or a real 116,627+-row catalog). Watch `ci_sab_candidate_index_worker_peak_rss_bytes` and `ci_sab_candidate_index_max_models_effective` from the very first rebuild.
6. **`ci_sab_candidate_index_build_failures_total{reason="memory"}` staying at 0** is now part of a successful canary's definition, exactly like the existing `reason="capacity"`/`reason="fetch"` bars.
7. **Do not raise `SAB_WORKER_MEMORY_ABORT_THRESHOLD_MB` above a value that leaves comfortable room under the container's real memory limit** without first re-confirming the main thread's own steady-state RSS on the target deployment (ADR-027's own "Worker transient heap cost" section already flags the main thread's ~1.6–2.8 GiB baseline as a real, separate cost this worker's own budget sits on top of).
8. **This PR does NOT self-authorize re-enabling `SELECTION_USE_SAB_CANDIDATE_INDEX`** — a new canary, run and evaluated after this PR is reviewed and merged, is required, per the same discipline ADR-027's own Precondition 4 already established for the post-Canary-2 fix.

## Verification performed for this PR

- `pnpm exec tsc --noEmit -p tsconfig.json`: clean, exit 0.
- `pnpm exec eslint` on every new/modified file (`sab-candidate-index/`, `observability/ci-metrics.ts`): 0 problems.
- Full existing `sab-candidate-index` suite plus this PR's new test files, `vitest run --config vitest.ci.config.ts src/core/selection/sab-candidate-index/`: **13 test files, 76 tests, all passing** — including the real, Testcontainers-Postgres-backed `sab-worker-concurrent-load-benchmark.test.ts` (real compiled/tsx-executed `worker.ts` spawned as a genuine `worker_threads.Worker`, 111,666 real seeded rows, Redis deliberately unreachable), which continues to pass unmodified and confirms Layer 1's `postgres-only` default fetch path and Layer 1's dynamic-layout wiring both work end to end against real infrastructure, not only against mocks.
- Broader regression: `vitest run --config vitest.ci.config.ts src/core/selection/` (the full selection module, including `dynamic-model-selector`/`full-cache-index-*` suites) plus the two `model-catalog-service`/`catalog-indices` files ADR-027 itself touched: **31 test files, 200 tests, all passing**, zero regressions.
- New tests added this PR: `capacity-dynamic-sizing.test.ts` (10 cases — margin math, ceiling clamping, `buildCapacityConfig` derivation, and a regression guard that `computeLayout()` with no argument stays byte-identical to before ADR-028), `worker-fetch-source.test.ts` (3 cases — default mode never calls Redis and uses the paged Postgres path exclusively; `redis-first` mode restores the old order and falls back correctly; `redis-first` mode returns Redis rows directly without touching Postgres when the snapshot is present), `worker-memory-guard.test.ts` (6 cases — threshold resolution/env override, peak tracking, the abort throw's message content, and that a caller's control flow correctly stops at the first crossed checkpoint), `manager-dynamic-resize.test.ts` (4 cases — shrink-then-grow across two resize cycles with exact target-size assertions, ceiling clamping on a resize target, staying put at the ceiling with high usage, and the `SAB_CANDIDATE_DYNAMIC_RESIZE=false` opt-out).
- `manager-rebuild-failed-metrics.test.ts` (pre-existing) was adjusted to stub `SAB_CANDIDATE_DYNAMIC_RESIZE=false`, since its synthetic 3-row/`MAX_MODELS=16` fixture would otherwise cross this PR's new shrink threshold as an unrelated side effect of a test that predates dynamic resizing and isn't testing it.
- No production canary was attempted as part of this PR — per the task's own instruction, that is explicitly deferred to a future session after review and merge.
