// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared fixtures for MVP 5B strategy planner tests.
 *
 * Pure data. No I/O.
 */

import type { ModelScoreResult } from '../../../scoring/model-scorer';
import { zeroBreakdown, type ScoreBreakdown } from '../../../scoring/score-breakdown';
import type {
  PlannerRouteMetadata,
  StrategyPlanningContext,
} from '../../strategy-types';

/**
 * Builds a synthetic ModelScoreResult with custom overrides. Defaults
 * are deterministic and reasonable for a current_and_routable
 * candidate.
 */
export function makeResult(
  overrides: Partial<ModelScoreResult> & {
    breakdownOverrides?: Partial<ScoreBreakdown>;
  } = {},
): ModelScoreResult {
  const { breakdownOverrides, ...rest } = overrides;
  return {
    routeId: 'r-default',
    canonicalModelId: 'c-default',
    offeringId: 'o-default',
    totalScore: 0.7,
    breakdown: {
      ...zeroBreakdown(),
      capabilityFit: 1,
      freshness: 0.8,
      routeReliability: 0.9,
      latencyScore: 0.6,
      costEfficiency: 0.5,
      contextFit: 1,
      localPreference: 0,
      riskPenalty: 0,
      ...breakdownOverrides,
    },
    rejected: false,
    rejectionReasons: [],
    freshnessStatus: 'current_and_routable',
    ...rest,
  };
}

/** Standard low-risk, low-complexity context (defaults to "standard" privacy). */
export const STANDARD_CONTEXT: StrategyPlanningContext = Object.freeze({
  taskType: 'general',
  complexity: 'low',
  riskLevel: 'low',
  privacyMode: 'standard',
  costSensitivity: 'low',
  latencySensitivity: 'low',
  confidenceNeeded: 0.5,
});

/** High-risk context for collective-strategy tests. */
export const HIGH_RISK_CONTEXT: StrategyPlanningContext = Object.freeze({
  taskType: 'medical',
  complexity: 'medium',
  riskLevel: 'high',
  privacyMode: 'standard',
  costSensitivity: 'low',
  latencySensitivity: 'low',
  confidenceNeeded: 0.95,
});

/** Extreme complexity context. */
export const EXTREME_COMPLEXITY_CONTEXT: StrategyPlanningContext = Object.freeze({
  taskType: 'research',
  complexity: 'extreme',
  riskLevel: 'medium',
  privacyMode: 'standard',
  costSensitivity: 'low',
  latencySensitivity: 'low',
  confidenceNeeded: 0.9,
});

/** High latency sensitivity context. */
export const FAST_CONTEXT: StrategyPlanningContext = Object.freeze({
  taskType: 'autocomplete',
  complexity: 'low',
  riskLevel: 'low',
  privacyMode: 'standard',
  costSensitivity: 'low',
  latencySensitivity: 'high',
  confidenceNeeded: 0.5,
});

/** High cost sensitivity context. */
export const CHEAP_CONTEXT: StrategyPlanningContext = Object.freeze({
  taskType: 'summarisation',
  complexity: 'medium',
  riskLevel: 'low',
  privacyMode: 'standard',
  costSensitivity: 'high',
  latencySensitivity: 'low',
  confidenceNeeded: 0.5,
});

/** High complexity + high confidence context (quality cascade). */
export const QUALITY_CASCADE_CONTEXT: StrategyPlanningContext = Object.freeze({
  taskType: 'analysis',
  complexity: 'high',
  riskLevel: 'low',
  privacyMode: 'standard',
  costSensitivity: 'low',
  latencySensitivity: 'low',
  confidenceNeeded: 0.95,
});

/** Local-required context. */
export const LOCAL_REQUIRED_CONTEXT: StrategyPlanningContext = Object.freeze({
  taskType: 'pii-extraction',
  complexity: 'medium',
  riskLevel: 'medium',
  privacyMode: 'local_required',
  costSensitivity: 'low',
  latencySensitivity: 'low',
  confidenceNeeded: 0.7,
});

/** Local-preferred context. */
export const LOCAL_PREFERRED_CONTEXT: StrategyPlanningContext = Object.freeze({
  taskType: 'analysis',
  complexity: 'medium',
  riskLevel: 'low',
  privacyMode: 'local_preferred',
  costSensitivity: 'low',
  latencySensitivity: 'low',
  confidenceNeeded: 0.6,
});

/** Helper to build routesInfo map. */
export function makeRoutesInfo(
  entries: ReadonlyArray<PlannerRouteMetadata>,
): ReadonlyMap<string, PlannerRouteMetadata> {
  const m = new Map<string, PlannerRouteMetadata>();
  for (const e of entries) m.set(e.routeId, e);
  return m;
}
