// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * cost-quality-frontier.ts — MVP 8A
 *
 * Pure Pareto-frontier computation over a generic candidate set, given
 * two extractor functions: one for "quality" (maximise) and one for
 * "cost" (minimise).
 *
 * A point P is DOMINATED if there exists Q in the set such that
 *   quality(Q) >= quality(P) AND cost(Q) <= cost(P)
 *   AND (quality(Q) > quality(P) OR cost(Q) < cost(P)).
 *
 * The frontier is the set of non-dominated points, returned in a stable
 * order: ascending cost, then descending quality, then by a caller-
 * supplied tie-breaker key (or, when absent, by the candidate's index
 * in the input).
 *
 * No I/O. No randomness. No clock. Never mutates input.
 */

export interface ParetoExtractors<T> {
  readonly quality: (item: T) => number;
  readonly cost: (item: T) => number;
  /** Optional deterministic tie-breaker. Default: input index. */
  readonly tieKey?: (item: T) => string;
}

/**
 * Returns the Pareto frontier (non-dominated points) in deterministic
 * order. Input is not mutated; the returned array is frozen.
 */
export function computeParetoFrontier<T>(
  candidates: readonly T[],
  extractors: ParetoExtractors<T>,
): readonly T[] {
  if (candidates.length <= 1) return Object.freeze(candidates.slice());
  const indexed = candidates.map((c, i) => ({ c, i }));
  const survivors: typeof indexed = [];
  for (const cand of indexed) {
    let dominated = false;
    for (const other of indexed) {
      if (other === cand) continue;
      if (dominates(other.c, cand.c, extractors)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) survivors.push(cand);
  }
  // Deterministic ordering.
  survivors.sort((a, b) => {
    const ca = extractors.cost(a.c);
    const cb = extractors.cost(b.c);
    if (ca !== cb) return ca - cb;
    const qa = extractors.quality(a.c);
    const qb = extractors.quality(b.c);
    if (qa !== qb) return qb - qa;
    if (extractors.tieKey) {
      const ka = extractors.tieKey(a.c);
      const kb = extractors.tieKey(b.c);
      if (ka !== kb) return ka < kb ? -1 : 1;
    }
    return a.i - b.i;
  });
  return Object.freeze(survivors.map((s) => s.c));
}

/**
 * Returns true when `candidate` is dominated by at least one element of
 * `others`. Strict inequality on either dimension is required for
 * domination (so equal-quality, equal-cost duplicates do NOT dominate
 * each other).
 */
export function isParetoDominated<T>(
  candidate: T,
  others: readonly T[],
  extractors: ParetoExtractors<T>,
): boolean {
  for (const o of others) {
    if (dominates(o, candidate, extractors)) return true;
  }
  return false;
}

// ─── Internals ──────────────────────────────────────────────────────────

function dominates<T>(a: T, b: T, x: ParetoExtractors<T>): boolean {
  const qa = x.quality(a);
  const qb = x.quality(b);
  const ca = x.cost(a);
  const cb = x.cost(b);
  if (qa >= qb && ca <= cb && (qa > qb || ca < cb)) return true;
  return false;
}
