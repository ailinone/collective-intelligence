// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * score-breakdown.ts — explainable score components.
 *
 * MVP 4 invariants:
 *   - Pure types. No I/O.
 *   - The 8 components matched 1:1 to the v1.1 plan §9.1.
 */

// ─── Per-component breakdown ────────────────────────────────────────────

/**
 * All values in [0, 1] EXCEPT `riskPenalty`, which is in [0, 1] and
 * SUBTRACTED from the total. Higher values of the other components are
 * better; higher `riskPenalty` is worse.
 */
export interface ScoreBreakdown {
  readonly capabilityFit: number;
  readonly freshness: number;
  readonly routeReliability: number;
  readonly latencyScore: number;
  readonly costEfficiency: number;
  readonly contextFit: number;
  readonly localPreference: number;
  readonly riskPenalty: number;
}

/**
 * Weighted contribution per component. Tests verify each weight is in
 * [0, 1] and that the sum is finite (no requirement to be 1.0 — the
 * total score is renormalised at the candidate-set level).
 */
export interface ScoreBreakdownWeights {
  readonly capabilityFit: number;
  readonly freshness: number;
  readonly routeReliability: number;
  readonly latencyScore: number;
  readonly costEfficiency: number;
  readonly contextFit: number;
  readonly localPreference: number;
  readonly riskPenalty: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Returns a zeroed `ScoreBreakdown` — useful as a default. */
export function zeroBreakdown(): ScoreBreakdown {
  return Object.freeze({
    capabilityFit: 0,
    freshness: 0,
    routeReliability: 0,
    latencyScore: 0,
    costEfficiency: 0,
    contextFit: 0,
    localPreference: 0,
    riskPenalty: 0,
  });
}

/**
 * Computes the weighted total score. Pure.
 *
 * Formula: sum(weight_i × component_i) − weight_risk × riskPenalty.
 */
export function applyWeights(
  breakdown: ScoreBreakdown,
  weights: ScoreBreakdownWeights,
): number {
  const positive =
    weights.capabilityFit * breakdown.capabilityFit +
    weights.freshness * breakdown.freshness +
    weights.routeReliability * breakdown.routeReliability +
    weights.latencyScore * breakdown.latencyScore +
    weights.costEfficiency * breakdown.costEfficiency +
    weights.contextFit * breakdown.contextFit +
    weights.localPreference * breakdown.localPreference;
  const penalty = weights.riskPenalty * breakdown.riskPenalty;
  return positive - penalty;
}
