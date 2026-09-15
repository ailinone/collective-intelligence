<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Selection candidate-cap benchmark — BLOCKED (no measurements) — 2026-09-12

**Status: NOT RUN. This document contains zero measured numbers, by design.**
The measurement harness requires a working Docker daemon (Testcontainers), and
Docker is broken on the measurement machine today. Per the operating rule for
this work item — *MEASURE, NEVER ESTIMATE* — no latency, statement-count, RSS,
or EXPLAIN figures are invented here. The pipeline map this benchmark was to
ground was re-verified instead (see below). Re-run this benchmark on a machine
with a working Docker engine before touching `curatedCandidateTake` /
`aggregatedCandidateTake`.

## What was verified (code facts, not measurements)

The companion map [`2026-09-11-selection-pipeline-map.md`](./2026-09-11-selection-pipeline-map.md)
(lost with the previous session's worktree, re-committed to main 967fd944) was
re-checked line-by-line against the code at `967fd944` on 2026-09-12. Every
reference sampled verified exactly, including:

| Map claim | Verified at |
|---|---|
| 800 = `curatedCandidateTake(400)` + `aggregatedCandidateTake(400)` | `api/src/config/model-selection-config.ts:26-27` |
| Env overrides `SELECTION_CURATED_TAKE` / `SELECTION_AGGREGATED_TAKE` | `dynamic-model-selector.ts:1389-1396` (`readTakeEnvOverride` :483-488) |
| Curated bucket = full-bucket snapshot, 120s TTL, take applied in memory | `dynamic-model-selector.ts:190-235` (TTL const :196), fail-open negative cache :232 |
| `selectCuratedFairUids` round-robin, `ceil(take × share)` per-provider cap | `dynamic-model-selector.ts:381-479` (cap at :416, `curatedMaxProviderShare` 0.15) |
| Aggregated take IS a SQL LIMIT (the only live per-request cut) | `getAggregatedBucketUids` :529-559, `LIMIT` :548, 200ms `statement_timeout` backstop :517 |
| Popularity reserve `min(100, floor(aggregatedTake/4))` | `dynamic-model-selector.ts:1402-1405` |
| Default SQL path + hydration `findMany(uid IN …)` | `dynamic-model-selector.ts:1533-1592` (hydration :1565-1568) |
| Capability filter runs AFTER the cut (the gap SAB fixes) | `dynamic-model-selector.ts:1685-1759`; SAB reader filters during scan, pre-take: `sab-candidate-index/reader.ts:152-186` (`rowPasses` :163/:180) |
| Selection cache 5 min (`cacheExpiryMs`) | `dynamic-model-selector.ts:1294-1321`, cleared :3774-3789 |
| Provider health = 7-day `request_logs` aggregate (PR #576 removes) | `error-learning-system.ts:306-310` → called from :1980 |
| `learning_buckets` batched prefetch scales with pool size | `prefetchModelPerformance` :2355-2358 → :3717-3769 |
| `calculateRecentTrend` per-candidate query (PR #576 removes) | trigger :2932-2937, body :3106-3139 |
| Never-collapse fallback `take: min(limit*3, 800)` | `dynamic-model-selector.ts:1594-1608` |

Production-shape reference points already recorded in the repo's own test
suites (from `sab-worker-concurrent-load-benchmark.test.ts`'s module doc, which
cites live-prod audits): a curated bucket spanning dozens of providers with one non-premium aggregator supplying the large majority of rows, an aggregated bucket concentrated in a single provider, and a total catalog size in the low hundreds of thousands of rows and growing.

## Why the benchmark did not run (docker failure record)

Recovery attempts on the Windows docker-gbash host, 2026-09-12 (all times UTC):

1. `docker context show` → `desktop-linux`. Initial `docker ps` → pipe
   `//./pipe/dockerDesktopLinuxEngine` not found (engine down).
2. Launched Docker Desktop → pipe appeared, but API returned `Internal Server
   Error` for ~4 min, then the CLI began hanging on every call indefinitely.
3. Full restart cycle: killed `Docker Desktop.exe` + `com.docker.backend.exe`,
   `wsl --shutdown`, relaunched → identical wedge.
4. Direct VM inspection (`wsl -d docker-desktop`): VM boots, `dockerd.log`
   shows `Daemon has completed initialization` at 17:54:25 — but the live
   process table contains only `init`/`Relay`/`sh`; **no dockerd, no
   containerd**. `/var/run/docker.sock` does not exist; `/proc/net/tcp` shows
   only DNS :53 listening. dockerd starts, logs success, then dies; the
   Windows-side pipe proxy then hangs forever.
5. No TCP daemon port exposed (2375 refused), no local (non-docker) Postgres
   on the machine. Testcontainers has no reachable engine.

Fix needed before this benchmark can run: repair/reinstall Docker Desktop
(suspect WSL/engine crash-loop; check `~/.docker/daemon.json`, Docker Desktop
version, WSL kernel). A `docker ps` that lists containers within seconds of
`docker context show` is the gate.

## Methodology (ready to execute — clone the existing harness pattern)

Reuse the self-contained benchmark pattern of
`api/src/core/selection/sab-candidate-index/__tests__/sab-worker-concurrent-load-benchmark.test.ts`
(own `PostgreSqlContainer('pgvector/pgvector:pg16')` lifecycle, manual
migration apply, deterministic hash-seeded production-shape rows, fixed-seed):
its `applyMigrations` + `NAMED_CURATED_PROVIDERS` seed shape are the template.

- **N (total catalog rows)**: 5k, 20k, 50k, 150k (150k mandatory — today's real
  size; scale the curated/aggregated provider mix proportionally to the real production ratio, keeping a many-provider curated shape).
- **Caps**: (400+400) current, (1000+1000), (2000+2000) via
  `SELECTION_CURATED_TAKE` / `SELECTION_AGGREGATED_TAKE` (no code change
  needed — verified env path above). Include a curated-snapshot-cold cell and
  a steady-state (warm snapshot) cell: the curated branch's DB cost is
  amortized behind the 120s TTL, so per-request cost is dominated by the
  aggregated LIMIT + hydration + prefetch.
- **Per cell**: ≥20 iterations after ≥3 warmup, fixed seed; report median,
  p95, max, variance. Metrics: wall-clock of the full selection path (entry →
  `selectModels` return), statement count (instrument `databaseQueries` +
  pg `pg_stat_statements` or a query-counter on the pg pool), node peak RSS
  (`process.memoryUsage.rss()` high-water), and `EXPLAIN (ANALYZE, BUFFERS)`
  for the aggregated-bucket SQL at N=150k per cap.
- **Measure current main** (health-scores + `calculateRecentTrend` included);
  optionally re-run the two cells with those two queries stubbed to account
  for unmerged PR #576's effect as a sensitivity note.
- Conservative container posture (operator rule): one Postgres container at a
  time, `--memory 1g` via `.withCreateContainerModifier`, remove containers +
  volumes at the end (`docker ps -a --filter label=org.testcontainers=true`).

## Decision state

**No keep-vs-raise decision is possible without the data. The cap stays at
800.** No config change is proposed on this branch. Structural facts that will
matter when the data arrives (all verified above, none speculative):

- Raising the cap multiplies per-request work that scales with the *take*
  (hydration row count, `learning_buckets` IN-list size, scoring fan-out) —
  not with N, except through the aggregated LIMIT's scan depth under
  `models_usage_count_idx` and the 120s curated snapshot.
- The 200ms `BUCKET_FAIR_QUERY_TIMEOUT_MS` backstop means a large take that
  pushes the aggregated query past ~200ms fails OPEN to the empty bucket (not
  slow) — the benchmark must watch for that cliff, since it silently changes
  the shape of what is measured rather than degrading latency.
- The SAB-relevant cost (capability filter after the cut) shows up as
  recall-vs-cap trade-off data: at take=400, how many of the hydrated rows
  survive `requiredCapabilities` — i.e. how much of the 800 is wasted on rows
  a pre-filter would never have returned.
