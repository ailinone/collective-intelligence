// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * candidate-sorter.ts — deterministic ordering of scored candidates.
 *
 * MVP 5A invariants:
 *   - Pure. No Math.random, no Date.now.
 *   - Stable comparator with documented tie-breakers.
 *   - Sort key order:
 *       1. rejected=false BEFORE rejected=true
 *       2. totalScore desc
 *       3. routeId asc (lexicographic)
 *       4. canonicalModelId asc
 *       5. offeringId asc
 *   - Array.sort in V8 is stable; the comparator guarantees a TOTAL
 *     ordering with the tie-breakers, so input order is irrelevant.
 */

import type { ModelScoreResult } from '../scoring/model-scorer';

/**
 * Comparator for `Array.prototype.sort`. Returns a negative number if
 * `a` should come before `b`, positive if after, zero if exactly equal
 * (no fall-through to insertion order because tie-breakers cover all
 * fields of identity).
 */
export function compareCandidates(a: ModelScoreResult, b: ModelScoreResult): number {
  // 1. accepted before rejected
  if (a.rejected !== b.rejected) return a.rejected ? 1 : -1;
  // 2. totalScore desc
  if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
  // 3. routeId asc
  if (a.routeId !== b.routeId) return a.routeId < b.routeId ? -1 : 1;
  // 4. canonicalModelId asc
  if (a.canonicalModelId !== b.canonicalModelId)
    return a.canonicalModelId < b.canonicalModelId ? -1 : 1;
  // 5. offeringId asc
  if (a.offeringId !== b.offeringId) return a.offeringId < b.offeringId ? -1 : 1;
  return 0;
}

/**
 * Returns a NEW sorted array. Does not mutate the input.
 */
export function sortCandidates(
  results: readonly ModelScoreResult[],
): readonly ModelScoreResult[] {
  return [...results].sort(compareCandidates);
}
