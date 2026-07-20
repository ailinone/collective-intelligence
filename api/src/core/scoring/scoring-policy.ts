// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * scoring-policy.ts — defaults + thresholds for the structural scorer.
 *
 * MVP 4 invariants:
 *   - Pure constants + types. No I/O. No env reads at top level.
 *   - Defaults are documented to be conservative — they boost native
 *     route kinds modestly, weight capability fit highest, and add a
 *     small risk penalty for preview models.
 *
 * Production callers in later MVPs override these via a Redis-backed
 * `RuntimeRoutingConfigProvider`. For tests, callers pass an override.
 */

import type { ScoreBreakdownWeights } from './score-breakdown';

// ─── Freshness sub-policy ───────────────────────────────────────────────

export interface FreshnessPolicy {
  /** When true, preview models are allowed (with penalty). Default false. */
  readonly allowPreview: boolean;
  /** When true, deprecated/legacy models are allowed (heavy penalty). Default false. */
  readonly allowDeprecated: boolean;
}

// ─── Scoring policy ─────────────────────────────────────────────────────

export interface ScoringPolicy {
  readonly weights: ScoreBreakdownWeights;
  readonly thresholds: {
    /** Below this capabilityFit, the candidate is rejected. [0, 1]. */
    readonly minCapabilityFit: number;
    /** Below this routeReliability, the candidate is penalised. [0, 1]. */
    readonly minRouteReliability: number;
    /** Below this total score, the candidate is not selectable. */
    readonly minScoreForSelection: number;
  };
  readonly freshness: FreshnessPolicy;
}

// ─── Defaults ───────────────────────────────────────────────────────────

/**
 * Default weights. CapabilityFit and freshness lead; cost is moderate;
 * localPreference is a small thumb-on-scale; riskPenalty is bounded.
 *
 * These numbers are intentionally conservative — the goal in MVP 4 is
 * to produce sensible orderings on the fixture, not to optimise.
 */
export const DEFAULT_SCORE_WEIGHTS: ScoreBreakdownWeights = Object.freeze({
  capabilityFit: 0.20,
  freshness: 0.15,
  routeReliability: 0.15,
  latencyScore: 0.10,
  costEfficiency: 0.10,
  contextFit: 0.10,
  localPreference: 0.10,
  riskPenalty: 0.10,
});

export const DEFAULT_SCORING_POLICY: ScoringPolicy = Object.freeze({
  weights: DEFAULT_SCORE_WEIGHTS,
  thresholds: Object.freeze({
    minCapabilityFit: 1.0, // ALL required capabilities must match
    minRouteReliability: 0.0, // tolerated until tracker provides real data
    minScoreForSelection: 0.0,
  }),
  freshness: Object.freeze({
    allowPreview: false,
    allowDeprecated: false,
  }),
});

// ─── Sensitivity → policy fragment ──────────────────────────────────────

/**
 * Maps a coarse-grained sensitivity tag to a policy fragment. Returned
 * fragments do NOT replace the full policy — they only adjust the
 * weights for the request. Used in `ModelScoringContext` to express
 * "this caller prioritises cost" or similar.
 */
export type Sensitivity = 'low' | 'medium' | 'high';

export function costSensitivityToWeightMultiplier(s: Sensitivity): number {
  if (s === 'high') return 2.5;
  if (s === 'medium') return 1.0;
  return 0.4;
}

export function latencySensitivityToWeightMultiplier(s: Sensitivity): number {
  if (s === 'high') return 2.5;
  if (s === 'medium') return 1.0;
  return 0.4;
}
