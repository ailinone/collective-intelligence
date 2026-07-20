// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Inventory Lifecycle Policy — canonical, single-source-of-truth.
 *
 * ## Why this module exists
 *
 * Before this module, the `active`/`stale`/`inactive` classification rule
 * was duplicated inline across 6+ scripts
 * (`hcra-lifecycle-classify.ts`, `hcra-recalibrated-baseline.ts`,
 * `_inventory-forensics.ts`, `_snapshot.ts`, `_active-regression-check.ts`,
 * `_provider-lifecycle-audit.ts`). The constants (`STALE_HOURS=48`,
 * `INACTIVE_DAYS=7`), the SQL `CASE` expression, and the reason-string
 * format lived in each consumer independently. A silent drift between
 * two consumers would have produced divergent classifications and
 * silently contaminated the coverage baseline it was meant to protect.
 *
 * This module centralises the policy so every consumer imports the
 * exact same rule and every future change goes through one diff.
 *
 * ## Scope
 *
 * This module governs the freshness lifecycle of `models` rows — i.e.
 * how recently our discovery pipeline last observed a model from its
 * origin (native API or hub). It is **intentionally orthogonal** to
 * `models.status` (the catalog availability flag:
 * active/deprecated/withdrawn):
 *
 *   - `models.status`            → catalog-level availability statement
 *   - `models.lifecycle_status`  → observation-freshness of the row
 *
 * A row with `status='active'` AND `lifecycle_status='inactive'` is
 * a catalog statement that contradicts observed reality — the hub
 * has stopped publishing it for longer than the grace window. This
 * distinction is what Eixo 1 asks for and what the SLO-grade baseline
 * must honour.
 *
 * ## Rule (Eixo 2)
 *
 * A model is:
 *
 *   - `active`   — `updated_at >= NOW() - STALE_THRESHOLD`
 *                  (seen within the last `STALE_HOURS`; at most one
 *                  discovery-cycle stale). Tolerates one transient
 *                  cycle failure without false inactive.
 *   - `stale`    — `updated_at` older than `STALE_HOURS` but newer
 *                  than `INACTIVE_DAYS`. Observation-only bucket;
 *                  the model is still in its grace window.
 *   - `inactive` — `updated_at < NOW() - INACTIVE_DAYS`. The origin
 *                  has stopped publishing for longer than the grace
 *                  window. Candidate for exclusion from coverage
 *                  baselines and for eventual `status='deprecated'`
 *                  housekeeping.
 *
 * ## Invariants
 *
 *   I1: STALE_HOURS > 0
 *   I2: INACTIVE_DAYS > 0
 *   I3: INACTIVE_DAYS * 24 > STALE_HOURS (inactive threshold must be
 *       strictly later than stale threshold; otherwise the `stale`
 *       bucket collapses to empty and the grace window vanishes).
 *   I4: The three buckets partition the universe (no row can belong
 *       to more than one bucket; every active row belongs to exactly
 *       one). This is enforced by the SQL CASE ordering below.
 *
 * ## Operator knobs
 *
 * `STALE_HOURS` and `INACTIVE_DAYS` can be overridden at runtime via
 * environment variables (respecting validation above). The override
 * path is used for:
 *
 *   - tuning the thresholds in staging without a redeploy
 *   - tightening the stale window during incident response (e.g.
 *     STALE_HOURS=24 to flag drift faster)
 *   - lengthening the window during planned hub outages
 *
 * If you are adding a third downstream consumer, import from this
 * module. Do NOT recompute the thresholds or re-paste the CASE
 * expression. If a consumer needs a slightly different rule (e.g.
 * a per-provider override), extend this module rather than forking.
 */

/**
 * The closed set of lifecycle statuses. Every value of
 * `models.lifecycle_status` MUST be one of these literals.
 * A new status literal is a policy change that requires updating
 * this enum, the SQL classifier, and ADR-023.
 */
export const INVENTORY_LIFECYCLE_STATUSES = [
  'active',
  'stale',
  'inactive',
] as const;

export type InventoryLifecycleStatus =
  (typeof INVENTORY_LIFECYCLE_STATUSES)[number];

/** Default grace window: a model remains `active` if seen within this window. */
export const DEFAULT_STALE_HOURS = 48;

/** Default inactive threshold: beyond this, a model is classified `inactive`. */
export const DEFAULT_INACTIVE_DAYS = 7;

export interface LifecyclePolicyThresholds {
  /** Hours since `updated_at` after which a model is no longer `active`. */
  readonly staleHours: number;
  /** Days since `updated_at` after which a model is classified `inactive`. */
  readonly inactiveDays: number;
}

/**
 * Resolve the policy thresholds from environment overrides, falling back
 * to the canonical defaults. Performs I1/I2/I3 validation — throws if
 * the resolved thresholds violate the partition invariant.
 */
export function resolveLifecycleThresholds(
  env: NodeJS.ProcessEnv = process.env,
): LifecyclePolicyThresholds {
  const staleHours = Number(env.STALE_HOURS ?? DEFAULT_STALE_HOURS);
  const inactiveDays = Number(env.INACTIVE_DAYS ?? DEFAULT_INACTIVE_DAYS);

  if (!Number.isFinite(staleHours) || staleHours <= 0)
    throw new Error(
      `Invalid STALE_HOURS=${env.STALE_HOURS!} — must be a positive number`,
    );
  if (!Number.isFinite(inactiveDays) || inactiveDays <= 0)
    throw new Error(
      `Invalid INACTIVE_DAYS=${env.INACTIVE_DAYS!} — must be a positive number`,
    );
  if (inactiveDays * 24 <= staleHours)
    throw new Error(
      `INACTIVE_DAYS=${inactiveDays} * 24h must be strictly greater than ` +
        `STALE_HOURS=${staleHours} — otherwise the 'stale' bucket collapses ` +
        `to empty and the grace window vanishes (I3 violation).`,
    );

  return { staleHours, inactiveDays };
}

/**
 * Produce the SQL `CASE` expression that classifies a row into one of
 * the three statuses, given the column holding the observation time.
 *
 * The expression is parameterised by the column name so the same
 * classifier can be applied against `models.updated_at`, a CTE alias,
 * or a projected column in a batch-export query.
 *
 * The thresholds are inlined as SQL literals (not bound parameters)
 * because the `INTERVAL '... hours'` construct doesn't accept a
 * parameter placeholder in most driver bindings; the values are
 * sanitised via `Number()` above so injection is not possible.
 */
export function classifyExpressionSql(
  observedAtColumn: string,
  thresholds: LifecyclePolicyThresholds = resolveLifecycleThresholds(),
): string {
  const { staleHours, inactiveDays } = thresholds;
  return `CASE
    WHEN ${observedAtColumn} >= NOW() - INTERVAL '${staleHours} hours' THEN 'active'
    WHEN ${observedAtColumn} >= NOW() - INTERVAL '${inactiveDays} days'  THEN 'stale'
    ELSE 'inactive'
  END`;
}

/**
 * Produce the SQL expression that builds a human-readable `reason`
 * string for non-active rows. `active` rows get NULL (no reason).
 *
 * The reason strings are stable and machine-parseable:
 *   - `no-discovery-since:YYYY-MM-DD`    — for stale rows
 *   - `absent-from-source-for>Nd`        — for inactive rows
 */
export function reasonExpressionSql(
  observedAtColumn: string,
  thresholds: LifecyclePolicyThresholds = resolveLifecycleThresholds(),
): string {
  const { staleHours, inactiveDays } = thresholds;
  return `CASE
    WHEN ${observedAtColumn} >= NOW() - INTERVAL '${staleHours} hours' THEN NULL
    WHEN ${observedAtColumn} >= NOW() - INTERVAL '${inactiveDays} days'
      THEN 'no-discovery-since:' || ${observedAtColumn}::date
    ELSE 'absent-from-source-for>' || ${inactiveDays} || 'd'
  END`;
}

/**
 * WHERE-clause fragment restricting a query to the **live** universe.
 * This is the SLO-grade filter — dashboards, baseline comparisons,
 * and coverage snapshots that claim to measure "current health" must
 * use this fragment. Raw `status='active'` is historical-only.
 *
 * Usage:
 *   SELECT ... FROM models WHERE ${LIVE_UNIVERSE_WHERE}
 *
 * Requires the `lifecycle_status` column to exist. If running against
 * a database that hasn't been classified yet, call `hasLifecycleColumn`
 * first and fall back to `HISTORICAL_UNIVERSE_WHERE` with an audit log.
 */
export const LIVE_UNIVERSE_WHERE =
  `status = 'active' AND lifecycle_status = 'active'` as const;

/**
 * WHERE-clause fragment for the **historical-style** universe — every
 * active-catalog row regardless of freshness. Use ONLY for audit
 * comparisons against pre-recalibration baselines. Do not use for SLOs.
 */
export const HISTORICAL_UNIVERSE_WHERE = `status = 'active'` as const;

/**
 * Check whether the lifecycle_status column exists on the models table
 * of a given pg Pool. Use this to gate the live-universe query when
 * running against environments where the classifier has not been run.
 */
export async function hasLifecycleColumn(
  query: (sql: string) => Promise<{ rows: { exists: boolean }[] }>,
): Promise<boolean> {
  const r = await query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name='models' AND column_name='lifecycle_status'
     ) AS exists`,
  );
  return r.rows[0]?.exists ?? false;
}

/**
 * Probe the most recent classifier evaluation timestamp. Used by the
 * universe resolver to decide whether a requested `'live'` view is
 * trustworthy. Returns `null` when the column does not exist or when
 * no active row has been classified.
 *
 * The caller is expected to cache this value for a short TTL (e.g. 30–60s)
 * to avoid one round-trip per incoming request. A stale cache is fine
 * because the staleness-tolerance is measured in hours, not seconds.
 */
export async function getClassifierLastEvaluatedAt(
  query: (sql: string) => Promise<{ rows: { max: Date | string | null }[] }>,
): Promise<Date | null> {
  try {
    const r = await query(
      `SELECT MAX(lifecycle_evaluated_at) AS max
       FROM models WHERE status='active'`,
    );
    const raw = r.rows[0]?.max;
    if (raw === null || raw === undefined) return null;
    return raw instanceof Date ? raw : new Date(String(raw));
  } catch {
    // Column absent or table missing — caller should have already checked
    // `hasLifecycleColumn`; treat as never-classified for safety.
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Universe resolver (runtime route / service layer)
// ════════════════════════════════════════════════════════════════════════════
//
// Runtime routes and services call `resolveUniverseWhere()` per request to
// turn a caller-supplied `?universe=…` parameter (plus an env default) into
// the actual WHERE fragment to inline into their query. The resolver also
// returns a `mode` label and an optional `warning` so callers can surface
// transparency in their response body (e.g. "this request ran against the
// historical universe because the classifier has not run recently").

/** The two universes a caller can select at runtime. */
export type UniverseMode = 'live' | 'historical';

/** Env var consulted when the caller does not specify a universe. */
export const DEFAULT_UNIVERSE_ENV_VAR = 'HCRA_DEFAULT_UNIVERSE' as const;

/**
 * Resolve the env-default universe. Unknown or missing values fall back to
 * `'historical'` (backwards-compatible). A future lot will flip this default
 * to `'live'` once the scheduled classifier is live in every environment.
 */
export function resolveDefaultUniverse(
  env: NodeJS.ProcessEnv = process.env,
): UniverseMode {
  const raw = (env[DEFAULT_UNIVERSE_ENV_VAR] ?? '').toLowerCase();
  return raw === 'live' ? 'live' : 'historical';
}

/**
 * Context passed to the universe resolver — carries the signals needed to
 * decide whether a requested `'live'` universe is safely usable.
 */
export interface UniverseResolutionContext {
  /** Explicit user choice, if any (e.g. from `?universe=…` query param). */
  readonly requested?: UniverseMode | string | undefined;
  /** Does the `models.lifecycle_status` column exist? Cache at boot. */
  readonly lifecycleColumnExists: boolean;
  /**
   * Most recent `lifecycle_evaluated_at` in the `models` table, if known.
   * `null` when never classified. Callers that don't track this can pass
   * `null` and accept the conservative outcome from `shouldFallbackToHistorical`.
   */
  readonly classifierLastEvaluatedAt: Date | null;
  /** Current time — injectable for deterministic tests. */
  readonly now?: Date;
  /**
   * Maximum tolerated age of the classifier before `live` is considered
   * untrustworthy. Defaults to 6h — three full discovery cycles.
   */
  readonly maxClassifierAgeHours?: number;
}

/**
 * Return value of `resolveUniverseWhere`. Callers inline `sql` into their
 * query, echo `mode` into their response body for observability, and log
 * `warning` when present (do NOT hide it — it is load-bearing telemetry).
 */
export interface UniverseResolution {
  readonly sql: typeof LIVE_UNIVERSE_WHERE | typeof HISTORICAL_UNIVERSE_WHERE;
  readonly mode: UniverseMode;
  readonly warning?: string;
}

/**
 * DESIGN CHOICE POINT (for human contribution):
 *
 * When a caller requests `?universe=live` but one of the safety signals is
 * missing — the `lifecycle_status` column hasn't been added, OR the latest
 * classifier run is older than `maxClassifierAgeHours` — should we fall
 * back to the historical universe?
 *
 * Tradeoffs to weigh:
 *
 *   - **Fall back silently** (return historical, no warning): never breaks
 *     callers, but hides the classifier being stuck. A broken cron can sit
 *     undetected for days. Operationally seductive, epistemically dangerous.
 *
 *   - **Fall back with a warning** (return historical, log + response
 *     metadata): keeps callers working, makes the degraded state visible.
 *     This is what the signature of `UniverseResolution` is designed for.
 *
 *   - **Fail closed** (refuse, let caller decide): surfaces the problem
 *     hardest, but breaks downstream consumers that can't handle a 503.
 *
 * The function below returns `true` when the caller should receive
 * historical results in place of a requested live view. The default
 * implementation is deliberately conservative. Adjust it to your ops
 * reality (cadence, alerting, SLO) — this is one of the few judgment
 * calls in the policy module that ops knowledge shapes correctly.
 *
 * @see resolveUniverseWhere — the only caller of this function.
 */
export function shouldFallbackToHistorical(
  ctx: UniverseResolutionContext,
): { fallback: boolean; reason?: string } {
  // Safety guard: column missing ⇒ live is physically impossible.
  if (!ctx.lifecycleColumnExists) {
    return { fallback: true, reason: 'lifecycle_column_missing' };
  }

  // TODO(operator): choose the staleness tolerance for the classifier.
  // The context carries `classifierLastEvaluatedAt` and `maxClassifierAgeHours`
  // (default 6h). Return `{ fallback: true, reason: 'classifier_stale' }` when
  // the classifier is older than the tolerance. Return `{ fallback: false }`
  // otherwise. A null `classifierLastEvaluatedAt` means the classifier has
  // never run — decide whether that's acceptable (probably not in production).
  //
  // 5–10 lines of code. Default below is conservative (fall back on any
  // uncertainty); replace with your ops policy.
  const now = ctx.now ?? new Date();
  const maxAgeMs = (ctx.maxClassifierAgeHours ?? 6) * 60 * 60 * 1000;
  if (ctx.classifierLastEvaluatedAt === null) {
    return { fallback: true, reason: 'classifier_never_ran' };
  }
  const ageMs = now.getTime() - ctx.classifierLastEvaluatedAt.getTime();
  if (ageMs > maxAgeMs) {
    return { fallback: true, reason: 'classifier_stale' };
  }
  return { fallback: false };
}

/**
 * Resolve the effective universe for a single request.
 *
 * Precedence:
 *   1. Caller's explicit `requested` wins when valid and safe.
 *   2. Env default (`HCRA_DEFAULT_UNIVERSE`) wins when caller omits it.
 *   3. Safety fallback to historical when `shouldFallbackToHistorical` trips.
 *
 * Callers SHOULD echo `mode` into their response body (as a top-level
 * `universe` field) so clients can tell which numbers they got.
 */
export function resolveUniverseWhere(
  ctx: UniverseResolutionContext,
  env: NodeJS.ProcessEnv = process.env,
): UniverseResolution {
  const requestedValid: UniverseMode | undefined =
    ctx.requested === 'live' || ctx.requested === 'historical'
      ? ctx.requested
      : undefined;
  const envDefault = resolveDefaultUniverse(env);
  const desired: UniverseMode = requestedValid ?? envDefault;

  if (desired === 'historical') {
    return { sql: HISTORICAL_UNIVERSE_WHERE, mode: 'historical' };
  }

  // desired === 'live' — evaluate safety.
  const fb = shouldFallbackToHistorical(ctx);
  if (fb.fallback) {
    return {
      sql: HISTORICAL_UNIVERSE_WHERE,
      mode: 'historical',
      warning: `requested_live_fell_back:${fb.reason ?? 'unknown'}`,
    };
  }
  return { sql: LIVE_UNIVERSE_WHERE, mode: 'live' };
}

/**
 * Documentation summary — exposed as a runtime constant so it can be
 * emitted by scripts at startup for the operator record.
 */
export const POLICY_SUMMARY = {
  adr: 'ADR-023',
  version: 1,
  grace: {
    description:
      'Tolerates one transient discovery-cycle failure before escalating ' +
      'to `stale`; tolerates up to `INACTIVE_DAYS` of total absence before ' +
      'escalating to `inactive`.',
    rationale:
      'Discovery runs approximately every 45 minutes; 48h covers ~64 ' +
      'consecutive cycles so a single transient failure cannot flip a row ' +
      'out of `active`. 7 days covers catastrophic regional outages while ' +
      'being tight enough that truly gone models exit the baseline within ' +
      'one week.',
  },
  runtime_override:
    'Override via STALE_HOURS (integer hours) and INACTIVE_DAYS (integer days).',
} as const;
