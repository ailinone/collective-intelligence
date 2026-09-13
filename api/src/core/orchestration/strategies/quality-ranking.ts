// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Calibrated quality ranking — never order by a number that may be an
 * unmeasured placeholder without telling it apart from a real measurement.
 *
 * The defect this closes
 * ──────────────────────
 * `model.performance.quality` carries TWO incomparable things on one 0-1
 * scale:
 *
 *   1. A MEASUREMENT, written by `ModelRepository.updateModelPerformance`
 *      — the only writer of real observations, fed by
 *      model-validation-service from actual probe results.
 *   2. A DISCOVERY PRIOR, written by `central-model-discovery-service`'s
 *      `bulkUpsertModels` for every freshly discovered model.
 *
 * Nothing at the ranking sites distinguished them, so a plain
 * `b.performance.quality - a.performance.quality` fails in both regimes:
 *
 *   - ALL-PRIOR POOL. Every candidate carries the identical discovery
 *     constant, every pairwise difference is 0, and the sort is a no-op.
 *     The executor order silently degrades to whatever order the pool
 *     arrived in (catalog recency), while the code reads as if it ranked
 *     by quality. A placebo sort — the ordering looks intentional and is
 *     not.
 *   - MIXED POOL. A measured score typically lands BELOW the optimistic
 *     discovery prior, so `quality DESC` prefers models with NO execution
 *     history over models measured to be good. This is the regression that
 *     got PR #420 reverted (b7cb7ee0): making the upsert preserve
 *     measurements is correct at the write layer but, on its own, turns an
 *     accidental inversion into a deterministic one.
 *
 * Both failure modes have the same root: the comparator cannot tell a
 * measurement from a prior. Fixing the write layer alone does not fix the
 * comparator, and vice versa — so this module fixes the read side, and is
 * built to compose with the write-side calibration rather than duplicate
 * it.
 *
 * The rule
 * ────────
 * Rank measurements against measurements. A prior is not evidence, so it
 * is not allowed to compete on the measured scale at its nominal value:
 * it is placed at the CENTRE OF THE MEASURED DISTRIBUTION of the very
 * pool being ranked (the median of the candidates that do carry
 * measurements). That is the only position that makes the two scales
 * comparable without inventing a number:
 *
 *   - a measured-good model outranks an unmeasured one,
 *   - a measured-bad model sinks below an unmeasured one,
 *   - an unmeasured model sits where an average measured model sits.
 *
 * The median is DERIVED FROM THE CANDIDATES AT RANK TIME. No constant is
 * hardcoded here, and no threshold is assumed: when the pool contains no
 * measurements at all (today's state, since discovery writes a prior for
 * every row) the priors simply tie, and the ordering falls through to the
 * deterministic tie-break below instead of to arbitrary catalog order.
 * `informative` reports that case so the caller can log it rather than
 * present an arbitrary pick as a quality decision.
 *
 * Provenance detection
 * ────────────────────
 * Read in order of authority, using whatever the record actually carries:
 *
 *   1. `source` / `samples` — the explicit provenance stamp. Not written
 *      on `main` today; this is the shape the discovery write-layer
 *      calibration introduces, and reading it here means this comparator
 *      becomes exact the moment that lands, with no change on this side.
 *   2. `lastValidated` — already declared on `ModelPerformance` and
 *      already read as precisely this discriminator by
 *      model-validation-service ("modelos nunca validados", absence =>
 *      never measured => top validation priority).
 *   3. Otherwise: treated as a prior. Fail-safe direction — an
 *      unstamped record is assumed NOT to be evidence, so a genuine
 *      measurement can never be outranked by something merely assumed to
 *      be one.
 *
 * Tie-breaks never re-open the same hole
 * ──────────────────────────────────────
 * `reliability` and `latencyMs` come from the same dual-scale field and
 * carry their own discovery constants, so they are only ever compared
 * between candidates of the SAME provenance. Across provenance the chain
 * falls through to the model id, which is stable and reproducible. The
 * guarantee is absolute: at no link in the chain can a placeholder beat a
 * measurement.
 */

import type { Model } from '@/types';

/**
 * Where a model's performance numbers came from.
 *
 * `'prior'` covers both an explicit discovery prior and a record with no
 * provenance at all — for ranking purposes they are the same thing: not
 * evidence.
 */
export type QualityProvenance = 'measured' | 'prior';

/** Result of ranking a candidate pool. */
export interface QualityRanking {
  /**
   * Comparator for `Array.prototype.sort`, best first. Closes over the
   * candidate pool it was built from — the calibration point depends on
   * that pool, so do NOT reuse it to sort a different set.
   */
  readonly comparator: (a: Model, b: Model) => number;
  /** Candidates carrying a real measurement. */
  readonly measuredCount: number;
  /** Candidates carrying a prior, or no provenance at all. */
  readonly priorCount: number;
  /**
   * Whether `quality` actually carried decision-relevant signal for this
   * pool: true when at least one candidate is measured. When false the
   * order is deterministic but NOT a quality judgement, and callers
   * should say so rather than imply the pick was earned.
   */
  readonly informative: boolean;
}

/** Narrow accessor — `performance` is optional on some code paths. */
function performanceOf(model: Model): Record<string, unknown> | undefined {
  const perf = (model as { performance?: unknown }).performance;
  return perf && typeof perf === 'object' ? (perf as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Classify a model's performance record as a measurement or a prior.
 *
 * Exported for the regression tests and for other ranking sites that need
 * the same distinction without building a full ranking.
 */
export function classifyQualityProvenance(model: Model): QualityProvenance {
  const perf = performanceOf(model);
  if (!perf) return 'prior';

  // 1. Explicit provenance stamp (write-layer calibration). Authoritative
  //    when present: a record that says it is a prior IS a prior, even if
  //    it also carries a stale `lastValidated`.
  const source = perf.source;
  if (typeof source === 'string') {
    return source === 'measured' ? 'measured' : 'prior';
  }

  // 2. Sample count. Zero samples is a prior by definition.
  const samples = finiteNumber(perf.samples);
  if (samples !== undefined) {
    return samples > 0 ? 'measured' : 'prior';
  }

  // 3. Validation timestamp — the discriminator `ModelPerformance`
  //    already declares. Only a real, parseable instant counts.
  const lastValidated = perf.lastValidated;
  if (lastValidated instanceof Date) {
    return Number.isNaN(lastValidated.getTime()) ? 'prior' : 'measured';
  }
  if (typeof lastValidated === 'string' || typeof lastValidated === 'number') {
    return Number.isNaN(new Date(lastValidated).getTime()) ? 'prior' : 'measured';
  }

  // 4. No provenance of any kind — not evidence.
  return 'prior';
}

/** Quality figure on the record, when it is a usable number. */
function qualityOf(model: Model): number | undefined {
  const perf = performanceOf(model);
  return perf ? finiteNumber(perf.quality) : undefined;
}

/** Median of a non-empty numeric list. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Build a calibrated quality ranking over `candidates`.
 *
 * Regimes, all three of which this handles without a hardcoded constant:
 *
 *   - EVERY candidate measured  → identical to a plain quality sort.
 *   - NO candidate measured     → all keys tie; deterministic tie-break
 *                                 replaces arbitrary catalog order, and
 *                                 `informative` is false.
 *   - MIXED                     → priors rank at the measured median.
 *
 * @param candidates The pool being ranked. The calibration point is
 *                   computed from exactly this set.
 */
export function rankByCalibratedQuality(candidates: readonly Model[]): QualityRanking {
  const provenance = new Map<string, QualityProvenance>();
  const measuredQualities: number[] = [];
  let measuredCount = 0;

  for (const model of candidates) {
    const kind = classifyQualityProvenance(model);
    provenance.set(model.id, kind);
    if (kind === 'measured') {
      measuredCount++;
      // A record can be stamped as measured yet carry no usable score;
      // it still counts as measured, but it cannot move the calibration
      // point.
      const quality = qualityOf(model);
      if (quality !== undefined) measuredQualities.push(quality);
    }
  }

  const informative = measuredQualities.length > 0;

  // The position a non-evidence record occupies on the measured scale.
  // Undefined when nothing has been measured — then every prior ties, and
  // no prior can be compared against a measurement because there is none.
  const calibrationPoint = informative ? median(measuredQualities) : undefined;

  const kindOf = (model: Model): QualityProvenance =>
    provenance.get(model.id) ?? classifyQualityProvenance(model);

  /**
   * Ranking key. A measurement uses its own score; a prior is pinned to
   * the calibration point so its nominal optimism cannot buy it a place
   * it did not earn.
   */
  const keyOf = (model: Model): number => {
    if (kindOf(model) === 'measured') return qualityOf(model) ?? 0;
    return calibrationPoint ?? 0;
  };

  const comparator = (a: Model, b: Model): number => {
    const byKey = keyOf(b) - keyOf(a);
    if (byKey !== 0) return byKey;

    // Same rank on the calibrated scale. Secondary signals come from the
    // same dual-scale field, so they are only trustworthy between
    // candidates of the same provenance — comparing them across
    // provenance would smuggle the placeholder back in through the side
    // door.
    if (kindOf(a) === kindOf(b)) {
      const perfA = performanceOf(a);
      const perfB = performanceOf(b);

      const relA = finiteNumber(perfA?.reliability);
      const relB = finiteNumber(perfB?.reliability);
      if (relA !== undefined && relB !== undefined && relA !== relB) return relB - relA;

      const latA = finiteNumber(perfA?.latencyMs);
      const latB = finiteNumber(perfB?.latencyMs);
      if (latA !== undefined && latB !== undefined && latA !== latB) return latA - latB;
    }

    // Deterministic last resort. Not a quality judgement — but stable and
    // reproducible, where the previous behaviour silently inherited
    // catalog ordering.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

  return {
    comparator,
    measuredCount,
    priorCount: candidates.length - measuredCount,
    informative,
  };
}
