// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provenance and calibration for `models.performance`.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * Discovery wrote the literal `{latencyMs:1000, throughput:100, quality:0.8,
 * reliability:0.95}` for EVERY discovered model and the bulk upsert used
 * `performance = EXCLUDED.performance`, so every sync flattened whatever
 * `model-validation-service` had actually measured back onto that constant.
 * The field feeds live ranking:
 *
 *   model-repository.ts      minQuality filter, ORDER BY quality/reliability
 *   dynamic-model-selector   intrinsicQuality on the no-samples branch
 *   images-orchestration     quality-based candidate ordering
 *
 * ── Why the obvious fix was reverted ──────────────────────────────────────
 * PR #420 changed the upsert to `COALESCE(models.performance,
 * EXCLUDED.performance)` so a measurement survived. That made the ranking
 * WORSE, measurably (revert b7cb7ee0): a measured score typically lands BELOW
 * the optimistic 0.8 constant, so `ORDER BY quality DESC` began preferring
 * models with NO execution history — deterministically, where before it did so
 * only by accident. `findPremiumModels` shows the same pathology from the other
 * side: it filters `minQuality >= 0.8`, which with a 0.8 constant admits every
 * never-measured model and excludes every model measured below 0.8. "Premium"
 * meant "never measured".
 *
 * The revert named the real defect precisely: one ranking field carrying two
 * incomparable scales, and no write policy can fix that.
 *
 * ── The correction ────────────────────────────────────────────────────────
 * Make the two scales comparable, then preservation becomes safe.
 *
 * 1. PROVENANCE. Every record says what it is: `source: 'discovery_prior'` with
 *    `samples: 0`, or `source: 'measured'` with `samples > 0` and a
 *    `measuredAt`. Before this, prior and measurement were indistinguishable.
 *
 * 2. CALIBRATED PRIOR. The prior is no longer a hardcoded optimism. It is the
 *    MEDIAN OF THE MEASURED POPULATION, recomputed from the catalog: an
 *    unmeasured model sits exactly at the centre of what measurement actually
 *    produces, so a measured-good model outranks it and a measured-bad model
 *    sinks below it. That is the comparability the revert asked for, and it
 *    needs no change to the hot ORDER BY / filter expressions (so the
 *    functional indexes on this path keep matching).
 *
 *    While the catalog holds no measurements — today's state — the median is
 *    undefined and the prior falls back to the historical constants, so day-one
 *    behaviour is byte-identical to before this change. The calibration only
 *    engages as real measurements accumulate, which is exactly when the
 *    incomparability starts to matter.
 *
 * 3. NON-DESTRUCTIVE UPSERT. Discovery refreshes a prior; it never overwrites a
 *    measurement.
 *
 * ── Fields with no telemetry, stated rather than papered over ─────────────
 * `throughput` has NO writer anywhere in the codebase. Nothing measures it, so
 * there is nothing to feed an EMA with, and it is dropped from the prior rather
 * than replaced by another invented constant. This is safe precisely because
 * its only consumer already supplies the same default itself:
 * `ORDER BY ... COALESCE((m.performance->>'throughput')::numeric, 100)`.
 *
 * `latencyMs` IS measured (validation probes write the observed average), but
 * it is kept in the prior: unlike quality/reliability it is not a 0-1 score, and
 * `dynamic-model-selector` reads it as `performance?.latencyMs || 0`, where a
 * missing value would read as "instantaneous" and flatter an unmeasured model
 * rather than neutralise it.
 *
 * `reliability` is measured by the same validation path as `quality` and is
 * calibrated identically.
 */
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'model-performance-baseline' });

/** `performance.source` for a record that is a prior, not a measurement. */
export const PERFORMANCE_SOURCE_PRIOR = 'discovery_prior';
/** `performance.source` for a record produced from observed executions. */
export const PERFORMANCE_SOURCE_MEASURED = 'measured';

/**
 * Fallback prior values, used ONLY while the catalog contains no measurement to
 * calibrate against. Deliberately identical to the constants discovery has
 * always written, so an uncalibrated system behaves exactly as it did before.
 */
export const FALLBACK_PRIOR_QUALITY = 0.8;
export const FALLBACK_PRIOR_RELIABILITY = 0.95;
export const FALLBACK_PRIOR_LATENCY_MS = 1000;

/** How long a computed baseline is reused before the catalog is re-read. */
const BASELINE_TTL_MS = 5 * 60 * 1000;

export interface DiscoveryPerformancePrior {
  latencyMs: number;
  quality: number;
  reliability: number;
  source: typeof PERFORMANCE_SOURCE_PRIOR;
  samples: 0;
  measuredAt: null;
  /** True when quality/reliability came from the measured population. */
  calibrated: boolean;
}

export interface MeasuredPerformanceBaseline {
  quality: number | null;
  reliability: number | null;
  measuredModels: number;
}

interface CachedBaseline {
  value: MeasuredPerformanceBaseline;
  expiresAt: number;
}

let cachedBaseline: CachedBaseline | null = null;

/** Test seam — drops the memoised baseline. */
export function resetMeasuredPerformanceBaselineCache(): void {
  cachedBaseline = null;
}

/**
 * True when a `performance` record carries an actual measurement rather than a
 * discovery prior. Records written before provenance existed have neither
 * marker and are therefore treated as priors — correct, because discovery had
 * been overwriting them on every sync anyway.
 */
export function isMeasuredPerformance(performance: unknown): boolean {
  if (!performance || typeof performance !== 'object' || Array.isArray(performance)) return false;
  const record = performance as Record<string, unknown>;
  if (record.source === PERFORMANCE_SOURCE_MEASURED) return true;
  const samples = Number(record.samples);
  return Number.isFinite(samples) && samples > 0;
}

/**
 * Median quality/reliability across models that actually carry a measurement.
 * Returns nulls when nothing has been measured yet.
 *
 * Runs once per discovery sync (memoised for {@link BASELINE_TTL_MS}), never on
 * a request path.
 */
export async function getMeasuredPerformanceBaseline(): Promise<MeasuredPerformanceBaseline> {
  const now = Date.now();
  if (cachedBaseline && cachedBaseline.expiresAt > now) {
    return cachedBaseline.value;
  }

  const empty: MeasuredPerformanceBaseline = {
    quality: null,
    reliability: null,
    measuredModels: 0,
  };

  try {
    const rows = await prisma.$queryRaw<
      Array<{ quality: number | null; reliability: number | null; measured: bigint | number }>
    >`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY (performance->>'quality')::numeric
        )::float8 AS quality,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY (performance->>'reliability')::numeric
        )::float8 AS reliability,
        COUNT(*) AS measured
      FROM models
      WHERE status = 'active'
        AND (
          performance->>'source' = ${PERFORMANCE_SOURCE_MEASURED}
          OR COALESCE((performance->>'samples')::numeric, 0) > 0
        )
        AND (performance->>'quality') IS NOT NULL
    `;

    const row = rows[0];
    if (!row) {
      cachedBaseline = { value: empty, expiresAt: now + BASELINE_TTL_MS };
      return empty;
    }

    const value: MeasuredPerformanceBaseline = {
      quality: typeof row.quality === 'number' && Number.isFinite(row.quality) ? row.quality : null,
      reliability:
        typeof row.reliability === 'number' && Number.isFinite(row.reliability)
          ? row.reliability
          : null,
      measuredModels: Number(row.measured ?? 0),
    };
    cachedBaseline = { value, expiresAt: now + BASELINE_TTL_MS };
    return value;
  } catch (error) {
    // A baseline we cannot compute must never block discovery — fall back to
    // the historical constants, which is the pre-change behaviour.
    log.warn({ error }, 'Measured performance baseline unavailable; using fallback prior');
    cachedBaseline = { value: empty, expiresAt: now + BASELINE_TTL_MS };
    return empty;
  }
}

/**
 * The `performance` record discovery writes for a model it has no measurement
 * for. Calibrated against the measured population when one exists.
 */
export async function getDiscoveryPerformancePrior(): Promise<DiscoveryPerformancePrior> {
  const baseline = await getMeasuredPerformanceBaseline();
  const calibrated = baseline.quality !== null || baseline.reliability !== null;

  return {
    latencyMs: FALLBACK_PRIOR_LATENCY_MS,
    quality: baseline.quality ?? FALLBACK_PRIOR_QUALITY,
    reliability: baseline.reliability ?? FALLBACK_PRIOR_RELIABILITY,
    source: PERFORMANCE_SOURCE_PRIOR,
    samples: 0,
    measuredAt: null,
    calibrated,
  };
}

/**
 * The `performance` branch of the models bulk-upsert ON CONFLICT clause.
 *
 * Exported so the preservation rule can be asserted without a database: this
 * SQL *is* the behaviour, and `performance = EXCLUDED.performance` silently
 * destroyed measured data for months while every test passed.
 *
 * Reads as: keep the row's own record when it is a MEASUREMENT; otherwise take
 * the incoming (freshly calibrated) prior. `performance` is `jsonb NOT NULL
 * DEFAULT '{}'`, so a first insert lands on the ELSE branch, not on a NULL
 * check.
 */
export const MODEL_UPSERT_PERFORMANCE_SET = `performance = CASE
            WHEN models.performance->>'source' = '${PERFORMANCE_SOURCE_MEASURED}'
              OR COALESCE((models.performance->>'samples')::numeric, 0) > 0
            THEN models.performance
            ELSE EXCLUDED.performance
          END`;

export interface MeasuredPerformanceStamp {
  source: typeof PERFORMANCE_SOURCE_MEASURED;
  samples: number;
  measuredAt: string;
}

/**
 * Provenance stamp applied whenever real observations are written to a model's
 * performance record. `samples` accumulates so the record can say how much
 * evidence stands behind it.
 */
export function buildMeasuredPerformanceStamp(
  existing: unknown,
  newSamples = 1
): MeasuredPerformanceStamp {
  const previous =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? Number((existing as Record<string, unknown>).samples)
      : 0;
  const carried = Number.isFinite(previous) && previous > 0 ? previous : 0;
  const added = Number.isFinite(newSamples) && newSamples > 0 ? Math.floor(newSamples) : 1;

  return {
    source: PERFORMANCE_SOURCE_MEASURED,
    samples: carried + added,
    measuredAt: new Date().toISOString(),
  };
}
