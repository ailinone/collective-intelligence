<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-023: Inventory Lifecycle Policy (`active` / `stale` / `inactive`)

**Status**: Accepted
**Date**: 2026-04-24
**Context**: HCRA baseline — separating catalog-availability from observation-freshness at 6,868-model scale
**Related**: ADR-022 (HCRA), `src/capability/inventory-lifecycle-policy.ts`, `scripts/hcra-lifecycle-classify.ts`, `scripts/hcra-recalibrated-baseline.ts`
**Supersedes (in part)**: the implicit "status='active' == fresh" assumption in pre-recalibration coverage baselines

## Context

On 2026-04-24 the HCRA coverage baseline showed a residual `-21` delta on `mcp` capability after the `tool-surface-family@v1` synthetic origin was removed. Forensic analysis (`scripts/_inventory-forensics.ts`) attributed the full delta to **stale `aihubmix` rows**: hub entries whose `updated_at` was older than the discovery cycle, still flagged `status='active'` but no longer published by the origin. The historical baseline (`mcp=1111`) was computed against the entire `status='active'` population and therefore silently included these ghosts.

Three symptoms converged:

1. **Baseline drift looked like regression**: comparing a fresh measurement against a baseline computed under a looser definition produced a false negative signal (a "regression" that was entirely external drift).
2. **The classification rule lived in 6+ scripts**: the same SQL `CASE` expression + thresholds (`STALE_HOURS=48`, `INACTIVE_DAYS=7`) were pasted inline across `hcra-lifecycle-classify.ts`, `hcra-recalibrated-baseline.ts`, `_inventory-forensics.ts`, `_snapshot.ts`, `_active-regression-check.ts`, `_provider-lifecycle-audit.ts`. A silent drift between two consumers would have produced divergent classifications.
3. **`status` conflated two ideas**: the `models.status` column attempted to carry both *catalog availability* (active / deprecated / withdrawn) and *observation freshness* (seen recently / stale / gone). When operators hand-edited `status`, they overwrote freshness state.

## Decision

### 1. Orthogonality between `status` and `lifecycle_status`

Two independent columns, each governed by a different process:

| Column | Semantics | Source of truth | Write cadence |
|---|---|---|---|
| `models.status` | Catalog-level statement: active / deprecated / withdrawn | Operator intent; housekeeping | Rare, manual |
| `models.lifecycle_status` | Freshness bucket: active / stale / inactive | Discovery pipeline `updated_at` | Every classifier run (~hourly) |

A row with `status='active' AND lifecycle_status='inactive'` is a **contradiction signal**: the catalog says "this is available" while observed reality says "the origin stopped publishing it". Catalog-dead providers (entire provider stuck in `inactive`) are housekeeping candidates for `status='deprecated'`; individual inactive rows are not.

### 2. Rule (Eixo 2)

```
active   := updated_at >= NOW() - STALE_HOURS      (default 48h)
stale    := STALE_HOURS <= age < INACTIVE_DAYS     (default 7d grace window)
inactive := updated_at <  NOW() - INACTIVE_DAYS
```

### 3. Invariants

- **I1**: `STALE_HOURS > 0`
- **I2**: `INACTIVE_DAYS > 0`
- **I3**: `INACTIVE_DAYS * 24 > STALE_HOURS` — inactive threshold must be strictly later than the stale threshold, otherwise the `stale` bucket collapses and the grace window vanishes.
- **I4**: The three buckets partition the universe (SQL `CASE` ordering enforces exclusivity; every row with a non-NULL `updated_at` belongs to exactly one bucket).

`resolveLifecycleThresholds()` validates I1/I2/I3 at runtime. Violations throw before any SQL executes.

### 4. Canonical module

`src/capability/inventory-lifecycle-policy.ts` is the single source of truth. It exports:

- `DEFAULT_STALE_HOURS = 48`, `DEFAULT_INACTIVE_DAYS = 7`
- `resolveLifecycleThresholds(env)` → validated `{ staleHours, inactiveDays }`
- `classifyExpressionSql(column, thresholds)` → SQL `CASE` for bucket assignment
- `reasonExpressionSql(column, thresholds)` → SQL `CASE` for stable, machine-parseable reason strings
- `LIVE_UNIVERSE_WHERE = "status = 'active' AND lifecycle_status = 'active'"` — SLO-grade filter
- `HISTORICAL_UNIVERSE_WHERE = "status = 'active'"` — pre-recalibration baseline filter (audit-only)
- `hasLifecycleColumn(query)` — gate for environments where the classifier hasn't run yet
- `POLICY_SUMMARY = { adr: 'ADR-023', version: 1, ... }` — runtime constant emitted by scripts for operator record

Every consumer imports from this module. Inline duplication is prohibited.

### 5. Database shape

```sql
ALTER TABLE models
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_reason TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_evaluated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_models_lifecycle_status
  ON models (lifecycle_status) WHERE status='active';
```

Mirrored in `prisma/schema.prisma` as `lifecycleStatus`, `lifecycleReason`, `lifecycleEvaluatedAt`. The partial index is retained as raw DDL (Prisma does not express partial indexes on this schema version); a future migration should formalise it.

### 6. Operator knobs

`STALE_HOURS` and `INACTIVE_DAYS` are overridable via environment variables, subject to I1/I2/I3. Use cases:

- Tightening during incident response: `STALE_HOURS=24` to surface drift faster.
- Loosening during planned hub outage: `STALE_HOURS=96` to avoid a false inactive wave.
- Staging experiments without a redeploy.

### 7. SLO-grade queries

Any query that claims to report "current health" — dashboards, baseline comparisons, bandit recall filters, admin UI coverage matrices — **must** use `${LIVE_UNIVERSE_WHERE}`. Raw `status='active'` is retained only for audit comparisons against pre-recalibration baselines. A `?universe=historical` escape hatch is reserved for intentional historical queries; the default universe is always live.

## Consequences

### Positive

- **One diff to change the rule**: updating `DEFAULT_STALE_HOURS` propagates through classifier, forensics, baseline, snapshot, regression check, and audit scripts atomically.
- **Baseline integrity restored**: coverage numbers are now measured against the set of models the origin still publishes, not a historical snapshot plus ghosts.
- **Regression vs drift are distinguishable**: a drop in `LIVE_UNIVERSE_WHERE` coverage is a code regression; a drop in `HISTORICAL_UNIVERSE_WHERE` coverage with `lifecycle_status<>'active'` on the delta is external drift.
- **Catalog housekeeping is defensible**: a provider in `catalog-dead` bucket (0 active lifecycle rows + >=1 inactive) is a safe candidate for `status='deprecated'` — supported by observed data, not an operator hunch.

### Negative

- **Classifier must run regularly**: if `scripts/hcra-lifecycle-classify.ts` is skipped for a week, `lifecycle_evaluated_at` becomes stale and the partition drifts from reality. Scheduling: every discovery cycle (~hourly) or at least daily.
- **Migration is DDL-only today**: the Prisma schema now mirrors the columns, but a proper migration file (`prisma migrate`) is deferred to a subsequent lot. The DB is correct; the migration artifact trails.
- **SQL literal interpolation is a minor foot-gun**: `INTERVAL '${staleHours} hours'` cannot be a bound parameter in most drivers, so the policy module sanitises via `Number()` and injects as a literal. Future contributors must not switch to a non-numeric expression.

## Alternatives considered

**A. Derive `stale`/`inactive` on every read from `updated_at`**. No stored column. Rejected: every SLO query would pay a CPU penalty for date arithmetic, and the partial index strategy would be unavailable.

**B. Collapse `lifecycle_status` into `status`**. Rejected: would re-conflate the two orthogonal ideas that caused the original baseline drift.

**C. Per-provider thresholds** (e.g. AWS Bedrock discovered daily, OpenRouter hourly). Rejected for now — the 48h grace window already tolerates one missed daily cycle. Revisit if a provider with a legitimately slower discovery cadence emerges.

## Validation

- Unit test: `src/capability/__tests__/inventory-lifecycle-policy.test.ts` asserts I1/I2/I3 violations throw, `classifyExpressionSql` emits the expected SQL structure, and `LIVE_UNIVERSE_WHERE` / `HISTORICAL_UNIVERSE_WHERE` are what consumers expect.
- Integration: run `scripts/hcra-lifecycle-classify.ts` followed by `scripts/hcra-recalibrated-baseline.ts`; the recalibrated `mcp` number minus the historical `mcp` number should equal the count of stale/inactive rows with `mcp` coverage (attribution check in the baseline script output).
- Regression: `scripts/_active-regression-check.ts` must return zero candidates under `LIVE_UNIVERSE_WHERE`; any hit is a real regression, not drift.

## References

- ADR-022 — HCRA (host architecture this policy plugs into)
- `src/capability/inventory-lifecycle-policy.ts` — canonical module
- `scripts/hcra-lifecycle-classify.ts` — classifier (writes `lifecycle_status`)
- `scripts/hcra-recalibrated-baseline.ts` — baseline report
- `scripts/_inventory-forensics.ts` — stale-attribution tool
- `scripts/_provider-lifecycle-audit.ts` — provider-level categorisation
