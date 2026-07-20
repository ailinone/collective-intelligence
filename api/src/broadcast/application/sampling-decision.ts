// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Deterministic sampling — maps (destinationId, sessionId) → bucket ∈ [0, 1).
 *
 * See ADR-018 (Deterministic Sampling by session_id).
 *
 * The hash is keyed by a per-destination derived salt so that two destinations
 * at the same sampling rate receive overlapping but not identical subsets —
 * this preserves A/B comparison semantics while keeping sampling stateless.
 *
 * Properties verified by unit tests:
 *   1. DETERMINISTIC — same inputs always produce same decision
 *   2. COMPLETE SESSIONS — same sessionId within a destination → same decision
 *   3. RATE ACCURACY — over a large N, ~rate of sessions pass through
 *   4. SHORT-CIRCUITS — rate=0 never passes; rate=1 always passes
 *   5. DESTINATION INDEPENDENCE — same sessionId across destinations varies
 *   6. FALLBACK — missing sessionId uses requestId (per-request independence)
 */

import { createHmac, hkdfSync } from 'node:crypto';

// ─── Constants ──────────────────────────────────────────────────────────

/**
 * Static salt for the HKDF key derivation. Changing this value invalidates all
 * previously-computed sampling decisions — not a problem operationally, but
 * treat as stable. Bump only to force resampling across the fleet.
 */
const STATIC_SALT = Buffer.from(
  'ailin-broadcast-sampling-salt:v1',
  'utf8',
);

/**
 * Number of buckets. Smaller means coarser-grained sampling rates; 10_000
 * gives us 0.01% precision which is far finer than any realistic rate setting.
 */
const BUCKET_COUNT = 10_000;

// ─── Public API ─────────────────────────────────────────────────────────

export interface SamplingDecisionInput {
  destinationId: string;
  /** Preferred grouping key. Use whatever identifies a logical "session". */
  sessionId?: string | null;
  /** Fallback key when sessionId is absent. Ensures a decision is always made. */
  requestId: string;
  /** Per-destination sampling rate, [0, 1]. Values outside are clamped. */
  samplingRate: number;
}

export interface SamplingDecision {
  include: boolean;
  /** The bucket used for the decision, in [0, 1). Useful for audit logs. */
  bucket: number;
  /** Whether we fell back to requestId because sessionId was absent. */
  fallbackToRequestId: boolean;
}

/**
 * Decide whether an envelope should be sent to a given destination.
 */
export function decideSampling(input: SamplingDecisionInput): SamplingDecision {
  const rate = clamp01(input.samplingRate);

  // Short-circuits — save a hash computation and guarantee boundary semantics.
  if (rate <= 0) return { include: false, bucket: 1, fallbackToRequestId: false };
  if (rate >= 1) return { include: true, bucket: 0, fallbackToRequestId: false };

  const fallbackToRequestId = !input.sessionId;
  const hashInput = input.sessionId ?? input.requestId;

  const bucket = hashToBucket(input.destinationId, hashInput);
  return {
    include: bucket < rate,
    bucket,
    fallbackToRequestId,
  };
}

/**
 * Convenience wrapper matching the ADR's `shouldSample` signature.
 */
export function shouldSample(
  destinationId: string,
  sessionIdOrRequestId: string,
  samplingRate: number,
): boolean {
  return decideSampling({
    destinationId,
    sessionId: sessionIdOrRequestId,
    requestId: sessionIdOrRequestId,
    samplingRate,
  }).include;
}

// ─── Internals ──────────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1; // also handles +Infinity (>= 1)
  return v;
}

/**
 * Derive a per-destination HMAC key via HKDF-SHA256.
 * Caching keys per destination saves the HKDF call on the hot path.
 */
const keyCache = new Map<string, Buffer>();
function destinationKey(destinationId: string): Buffer {
  const cached = keyCache.get(destinationId);
  if (cached) return cached;
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      STATIC_SALT,
      Buffer.alloc(0),
      Buffer.from(`broadcast-sampling:${destinationId}`, 'utf8'),
      32,
    ),
  );
  // Bound the cache — destination count is small in practice (<10k) but guard
  // against pathological churn.
  if (keyCache.size > 10_000) keyCache.clear();
  keyCache.set(destinationId, key);
  return key;
}

/**
 * Reduce an HMAC-SHA256 tag to a bucket in [0, 1). Use the first 8 bytes as a
 * big-endian unsigned 64-bit integer and mod by BUCKET_COUNT. The bias
 * introduced by modulo on 2^64 is < 2^-44 — cryptographically negligible.
 */
function hashToBucket(destinationId: string, input: string): number {
  const hmac = createHmac('sha256', destinationKey(destinationId));
  hmac.update(input);
  const digest = hmac.digest();
  // BigInt arithmetic avoids JS number precision issues on the high 32 bits.
  const hi = BigInt(digest.readUInt32BE(0));
  const lo = BigInt(digest.readUInt32BE(4));
  const u64 = (hi << 32n) | lo;
  const bucket = Number(u64 % BigInt(BUCKET_COUNT)) / BUCKET_COUNT;
  return bucket;
}

/**
 * Escape hatch for tests / debug tooling — resets the per-destination key
 * cache. Never call in production code paths.
 */
export function __resetSamplingKeyCacheForTests(): void {
  keyCache.clear();
}
