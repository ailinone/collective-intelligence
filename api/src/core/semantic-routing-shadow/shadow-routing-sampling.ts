// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-sampling.ts — MVP 8C.0
 *
 * Deterministic shadow sampling. Same `(requestId, sampleRate)` ALWAYS
 * yields the same in/out decision. No Math.random.
 *
 * Algorithm: 32-bit FNV-1a hash of requestId, mapped to [0, 1), compared
 * to sampleRate. requestId='' degrades to deterministic-false.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Returns true when the request should be shadow-evaluated.
 *
 *   sampleRate=0   → always false
 *   sampleRate=1   → always true (when requestId non-empty)
 *   sampleRate=0.1 → ~10% of requests, deterministic per requestId
 */
export function shouldSample(
  requestId: string,
  sampleRate: number,
): boolean {
  if (!Number.isFinite(sampleRate)) return false;
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return requestId.length > 0;
  if (requestId.length === 0) return false;
  const normalised = hashToUnitInterval(requestId);
  return normalised < sampleRate;
}

/**
 * 32-bit FNV-1a hash mapped to [0, 1). Pure function.
 */
function hashToUnitInterval(s: string): number {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  // Convert to unsigned 32-bit, then to [0, 1).
  const unsigned = h >>> 0;
  return unsigned / 0x100000000;
}
