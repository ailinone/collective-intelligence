// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * freshness-scorer.ts — freshness coupled with route readiness.
 *
 * MVP 4 invariants:
 *   - Pure function. No I/O.
 *   - LIVES IN `core/scoring/`, NOT in `core/experiment/`. Production
 *     hot path consumes from here; C3 keeps its own copy in
 *     `core/experiment/model-freshness.ts` (untouched).
 *   - Freshness NEVER overrides readiness. A "newer" model that is
 *     `no_credits` / `auth_failed` / `minimal_chat_failed` MUST score
 *     zero (or the appropriate blocked status), with a reason.
 *
 * The scorer takes a single candidate's freshness + readiness signals
 * and returns a normalized score + status + reason. Cross-family
 * comparison is the caller's responsibility (and is meaningless —
 * generationRank is family-scoped).
 */

// ─── Input / Output ─────────────────────────────────────────────────────

/**
 * Coarse lifecycle bucket used by the scorer. Mirrors
 * `CanonicalLifecycle` from MVP 1 + accepts `'legacy'` and
 * `'unknown'` as defensive fallbacks (legacy DB rows may carry these).
 */
export type FreshnessLifecycle =
  | 'current'
  | 'preview'
  | 'deprecated'
  | 'legacy'
  | 'retired'
  | 'unknown';

export interface FreshnessReadiness {
  /** Operability state. Common values: 'healthy', 'auth_failed', etc. */
  readonly healthState: string;
  /** Credit status. Common values: 'has_credits', 'no_credits', 'unknown'. */
  readonly creditStatus: string;
  /** Minimal-chat readiness. Common values: 'verified', 'untested', 'failed'. */
  readonly minimalChatStatus: string;
}

export interface FreshnessPolicy {
  readonly allowPreview?: boolean;
  readonly allowDeprecated?: boolean;
}

export interface FreshnessInput {
  readonly family: string;
  readonly version?: string;
  readonly generationRank?: number;
  readonly releaseDate?: string;
  readonly lifecycle: FreshnessLifecycle;
  readonly routeReadiness: FreshnessReadiness;
  readonly policy?: FreshnessPolicy;
}

export type FreshnessStatus =
  | 'current_and_routable'
  | 'current_but_no_credit'
  | 'current_but_auth_failed'
  | 'current_but_minimal_chat_failed'
  | 'current_but_capability_mismatch'
  | 'preview_allowed'
  | 'preview_blocked'
  | 'stale_but_best_routable'
  | 'deprecated_blocked'
  | 'unknown';

export interface FreshnessScore {
  readonly score: number;
  readonly status: FreshnessStatus;
  readonly reason: string;
}

// ─── Scorer ─────────────────────────────────────────────────────────────

/**
 * Computes a freshness score in [0, 1] coupled with the route's
 * current readiness. Returns ZERO whenever a hard gate fails.
 *
 * Order of evaluation (first match returns):
 *
 *   1. lifecycle = deprecated/legacy/retired
 *        - allowDeprecated false → status='deprecated_blocked', score=0
 *        - allowDeprecated true  → status='stale_but_best_routable', score=0.2
 *
 *   2. lifecycle = preview, allowPreview false
 *        → status='preview_blocked', score=0
 *
 *   3. readiness check (credits → auth → minimal chat)
 *        - no_credits      → status='current_but_no_credit',           score=0
 *        - auth_failed     → status='current_but_auth_failed',         score=0
 *        - minimal_chat=failed → status='current_but_minimal_chat_failed', score=0
 *
 *   4. lifecycle = preview, allowPreview true
 *        → status='preview_allowed', score=0.7
 *
 *   5. lifecycle = current
 *        → status='current_and_routable',
 *          score = 0.6 + (generationRank / (generationRank + 3)) × 0.4 (capped at 1.0)
 *          (defaults to 1.0 when generationRank absent)
 *
 *   6. lifecycle = unknown
 *        → status='stale_but_best_routable', score=0.4
 */
export function scoreFreshness(input: FreshnessInput): FreshnessScore {
  const policy: FreshnessPolicy = input.policy ?? {};
  const lifecycle = input.lifecycle;

  // 1. Deprecated / legacy / retired.
  if (lifecycle === 'deprecated' || lifecycle === 'legacy' || lifecycle === 'retired') {
    if (!policy.allowDeprecated) {
      return {
        score: 0,
        status: 'deprecated_blocked',
        reason: `lifecycle_${lifecycle}_blocked_by_policy`,
      };
    }
    return {
      score: 0.2,
      status: 'stale_but_best_routable',
      reason: `lifecycle_${lifecycle}_allowed_with_penalty`,
    };
  }

  // 2. Preview blocked by policy.
  if (lifecycle === 'preview' && !policy.allowPreview) {
    return {
      score: 0,
      status: 'preview_blocked',
      reason: 'lifecycle_preview_blocked_by_policy',
    };
  }

  // 3. Readiness gates (apply to ALL non-blocked lifecycles).
  if (input.routeReadiness.creditStatus === 'no_credits') {
    return {
      score: 0,
      status: 'current_but_no_credit',
      reason: 'route_no_credits',
    };
  }
  if (input.routeReadiness.healthState === 'auth_failed') {
    return {
      score: 0,
      status: 'current_but_auth_failed',
      reason: 'route_auth_failed',
    };
  }
  if (input.routeReadiness.minimalChatStatus === 'failed') {
    return {
      score: 0,
      status: 'current_but_minimal_chat_failed',
      reason: 'route_minimal_chat_failed',
    };
  }

  // 4. Preview allowed by policy.
  if (lifecycle === 'preview') {
    return {
      score: 0.7,
      status: 'preview_allowed',
      reason: 'lifecycle_preview_allowed_with_policy',
    };
  }

  // 5. Current + routable — happy path.
  if (lifecycle === 'current') {
    let score = 1.0;
    if (typeof input.generationRank === 'number' && input.generationRank > 0) {
      // Soft curve: rank 1 → 0.7, rank 3 → 0.8, rank 10 → ~0.95, asymptote at 1.
      score = Math.min(
        1.0,
        0.6 + (input.generationRank / (input.generationRank + 3)) * 0.4,
      );
    }
    return {
      score,
      status: 'current_and_routable',
      reason: 'current_lifecycle_healthy_route',
    };
  }

  // 6. Unknown lifecycle — stale fallback.
  return {
    score: 0.4,
    status: 'stale_but_best_routable',
    reason: 'unknown_lifecycle',
  };
}

// ─── Status helpers ─────────────────────────────────────────────────────

/** Returns true if the status corresponds to a routable candidate. */
export function isRoutable(status: FreshnessStatus): boolean {
  return (
    status === 'current_and_routable' ||
    status === 'preview_allowed' ||
    status === 'stale_but_best_routable'
  );
}
