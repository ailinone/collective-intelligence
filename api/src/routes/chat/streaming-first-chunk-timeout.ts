// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dynamic first-chunk timeout for the streaming fallback chain (2026-07-14).
 *
 * The hot-first candidate reorder (chat-routes.ts) already knows which
 * candidates are PROVEN serving right now vs cold/unknown — but every
 * candidate still waited the same static `STREAMING_FIRST_CHUNK_MS` deadline
 * before this, even a cold one sitting ahead of a hot fallback. Worst case:
 * static timeout, THEN the hot candidate's healthy TTFB — the ~9s spike
 * pattern already documented on the reorder itself.
 *
 * Extracted as a pure function (rather than left inline in the streaming
 * loop) because chat-routes.ts has no unit-test coverage today — this keeps
 * the decision logic testable without mocking the whole route handler.
 */
export function computeDynamicFirstChunkTimeoutMs<T>(
  candidates: readonly T[],
  index: number,
  ranks: ReadonlyMap<T, number> | null,
  staticTimeoutMs: number,
  fallbackTimeoutMs: number,
): number {
  const currentRank = ranks?.get(candidates[index]) ?? 1;
  // Candidate is itself hot, or no rank data at all: full window. A hot
  // candidate is already proven, and with no rank data we have no safety
  // net to justify cutting anyone short.
  if (currentRank === 3 || !ranks) {
    return staticTimeoutMs;
  }
  const hasHotFallbackAhead = candidates
    .slice(index + 1)
    .some((c) => (ranks.get(c) ?? 1) === 3);
  return hasHotFallbackAhead ? fallbackTimeoutMs : staticTimeoutMs;
}
