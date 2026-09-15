<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Selection hot-path map — current `main` @ 967fd944 (2026-09-11)

Redo of the pipeline-mapping phase of the P2.8 "measure the selection candidate cap"
work item (the previous session's artifact was lost with its unregistered worktree).
All line numbers refer to this commit. Purpose: ground the
[selection-cap benchmark](./2026-09-12-selection-cap-benchmark.md) in the real code
paths, so every number in it maps to a specific query below.

## TL;DR of where the cap actually lives

- The **800 ceiling is `curatedCandidateTake(400) + aggregatedCandidateTake(400)`**,
  set at `api/src/config/model-selection-config.ts:26-27`, overridable per-request-
  boot via `SELECTION_CURATED_TAKE` / `SELECTION_AGGREGATED_TAKE`
  (read at `api/src/core/selection/dynamic-model-selector.ts:1389-1396`).
- **The curated take is NOT a SQL LIMIT.** The curated side loads the *entire*
  curated bucket into a 120s module-level snapshot cache
  (`getCuratedBucketSnapshot`, `dynamic-model-selector.ts:205-235`, TTL at :190-196)
  and applies the take **in memory** per request (`selectCuratedFairUids`,
  :381-479 — per-provider round-robin with a hard
  `ceil(curatedTake × curatedMaxProviderShare)` cap, :416).
- **The aggregated take IS a SQL LIMIT**: `getAggregatedBucketUids`
  (`dynamic-model-selector.ts:529-559`) runs on every request:

  ```sql
  SELECT uid FROM models
  WHERE status <> 'disabled'
    AND metadata @> '{"serverless_callable":true}'::jsonb
    [AND context_window >= $n]                -- only when criteria.contextSize set
  ORDER BY usage_count DESC
  LIMIT <aggregatedUsageTake>                 -- = aggregatedTake − popularity reserve
  ```
  (`buildBucketFilterFragments` :124-140; 200ms `statement_timeout` backstop :517.)
- The aggregated take is split: `aggregatedUsageTake = aggregatedTake −
  min(100, floor(aggregatedTake/4))` popularity reserve (:1397-1405).
- **Capability filtering happens AFTER the cut, in memory**
  (`requiredCapabilities` filter at :1685-1759, over the ≤800 hydrated rows).
  This is the structural gap the SAB index would fix: its reader applies the
  row-level capability filter *during* the scan, before the take is consumed
  (`sab-candidate-index/reader.ts:152-186`), but still caps output at
  `curatedTake`/`aggregatedTake` exactly like the SQL.

## End-to-end path (request → candidates → score → rank)

1. **Entry** `DynamicModelSelector.selectModels()` (:1892) → when no models are
   supplied, calls `findModelsByRequirements()` (:1953).
2. **Selection cache** (5 min, keyed by criteria+maxModels, :1294-1321) — a cache
   hit short-circuits everything below (`databaseQueries: 0`).
3. **Candidate retrieval** (:1382-1608), first matching path wins:
   - `SELECTION_USE_SAB_CANDIDATE_INDEX=true` → worker-thread SharedArrayBuffer
     reader (:1441-1459; flag OFF in prod today).
   - `SELECTION_USE_FULL_CACHE_INDEX=true` → in-process catalog-index scan
     (:1486-1532; OFF).
   - **default SQL path** (:1533-1592):
     `getBucketFairCandidateUids()` (:574-597) =
     `Promise.all([getCuratedBucketSnapshot(), getAggregatedBucketUids()])`,
     then **hydration** `prisma.model.findMany({ where: { uid: { in: uids } } })`
     (:1565-1568) — returns up to `curatedTake + aggregatedTake` full rows
     (JSONB capabilities/metadata/performance included) joined with providers.
   - Popularity seed: cached top-by-`downloads` callable rows
     (`getAggregatedPopularitySeedRows` :981-991, served by partial index
     `models_callable_downloads_idx`), merged in-memory :1572-1592.
   - Never-collapse fallback (:1594-1608): `orderBy usage_count desc take
     min(limit*3, 800)` when the pool would otherwise be <5 rows.
4. **In-memory filters after hydration** (:1611-1842): capability URI/legacy
   two-track filter (:1685-1759), tools (:1773), endpoint (:1798), cost caps
   (:1811-1839), `slice(0, maxModels)` (:1842).
5. **selectModels gates** (per request, DB-backed):
   - provider health avoid-list: `errorLearningSystem.getRecommendations()`
     (:1978-2002) → `getProviderHealthScores()` = **7-day `request_logs`
     aggregate query** (`error-learning-system.ts:309+`). *(Cut by unmerged PR #576.)*
   - unreliable-provider filter (in-memory sliding window, :2016-2062),
     operability gate (:2075-2126), dead-model (:2134-2171), credential
     (:2183-2221), funding (:2230-2270), per-model failure filter (:2273-2300).
6. **History prefetch**: `refreshCacheIfNeeded()` (:2315, clears both caches every
   `cacheExpiryMs`=5min, :3774-3789) then **one batched `learning_buckets`
   IN-query for the whole pool** (`prefetchModelPerformance` :2355-2358 →
   :3717-3769) — the fan-in that scales with the pool size (i.e. with the cap).
7. **Per-candidate fan-out** `Promise.all` over every candidate:
   history hydration (:2360-2431, cache-served), semantic rerank (bounded,
   :2455-2460), **`scoreModel`** (:2467-2500 → :2872+) and `explainScore` per
   candidate. Runtime capability validation is bounded to 25 top candidates
   (:2323-2342). `scoreModel`'s real-time metrics come from the in-memory
   `metricsStore` (`model-performance-tracker.ts:113-117`), but
   `calculateRecentTrend` (:3104) fires a per-candidate
   `model_performance_metrics` query when `history.totalCount ≥ 5` and
   real-time samples <10 (:2932-2937). *(Also cut by PR #576.)*
8. **Final ranking** by score, dedup/top-N per strategy (outside this file).

## Steady-state per-request DB statement count (default SQL path, current main)

| # | Statement | Scales with | Cutoff |
|---|-----------|-------------|--------|
| 1 | Aggregated-bucket `LIMIT aggregatedUsageTake` query | take (LIMIT) | every request |
| 2 | Hydration `findMany(uid IN …)` (~cap rows + provider join) | take (row count) | every request |
| 3 | Provider health scores (7-day `request_logs` aggregate) | catalog-independent | every request (PR #576 removes) |
| 4 | `learning_buckets` batched prefetch | take (IN-list size) | every request |
| 5 | `calculateRecentTrend` per candidate with ≥5 history | take × history density | PR #576 removes |
| — | Curated snapshot (full curated bucket, no LIMIT) | N (curated rows) | ≤1/120s |
| — | Popularity seed (top downloads) | N (callable rows) | cached |

Relevant indexes: `models_usage_count_idx` (initial schema), functional/partial
indexes from migrations `20260801000000_selection_hot_query_functional_indexes`
(`models_callable_downloads_idx`, `models_hub_inventory_class_idx`) and
`20260907000000_selection_bucket_fair_context_indexes`
(`models_curated_context_idx`, `models_aggregated_context_idx`).
