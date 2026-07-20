// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-types.ts — MVP 5B
 *
 * Pure types for the StrategyPlanner. No I/O. No runtime imports
 * beyond MVP 4 types (ModelScoreResult) and MVP 1 types.
 */

import type { ExplicitPinInfo, PrivacyMode, RouteKind } from '../registry/types';
import type { ModelScoreResult } from '../scoring/model-scorer';

// ─── StrategyKind ───────────────────────────────────────────────────────

/**
 * The 11 strategy kinds the planner may emit. `no_viable_strategy` is
 * the sentinel for "I could not produce a plan" — distinct from a plan
 * that picks zero candidates by accident.
 */
export type StrategyKind =
  | 'single_best'
  | 'local_first'
  | 'cost_cascade'
  | 'quality_cascade'
  | 'parallel_diverse'
  | 'consensus'
  | 'debate'
  | 'expert_panel'
  | 'critique_repair'
  | 'tri_role_collective'
  | 'no_viable_strategy';

/** Lightweight complexity bucket used by the planner. */
export type StrategyComplexity = 'low' | 'medium' | 'high' | 'extreme';

/** Risk level used by the planner. */
export type StrategyRiskLevel = 'low' | 'medium' | 'high';

/** Coarse sensitivity tag (matches MVP 4's `Sensitivity` type). */
export type StrategySensitivity = 'low' | 'medium' | 'high';

// ─── StrategyPlanningContext ────────────────────────────────────────────

/**
 * The categorical context the planner consumes. This is a coarse
 * projection — no prompts, no PII. The MVP 5B planner does not infer
 * this from raw messages (TaskProfiler is a later MVP); callers
 * construct it manually or from a fixture.
 */
export interface StrategyPlanningContext {
  readonly taskType: string;
  readonly complexity: StrategyComplexity;
  readonly riskLevel: StrategyRiskLevel;
  readonly privacyMode: PrivacyMode;
  readonly costSensitivity: StrategySensitivity;
  readonly latencySensitivity: StrategySensitivity;
  readonly confidenceNeeded: number;
  readonly explicitModelPin?: ExplicitPinInfo | null;
}

// ─── Coarse cost / latency classes attached to the plan ────────────────

export type StrategyCostClass = 'free' | 'low' | 'mid' | 'high' | 'unknown';
export type StrategyLatencyClass = 'low' | 'mid' | 'high' | 'unknown';

// ─── StrategyPlan ───────────────────────────────────────────────────────

/**
 * Result of the planner. Describes WHAT to execute (selected routes),
 * the fallback chain, the parallelism budget, and the rationale.
 *
 * The plan is purely declarative — it never executes anything.
 */
export interface StrategyPlan {
  readonly strategy: StrategyKind;
  readonly selectedRouteIds: readonly string[];
  readonly fallbackRouteIds: readonly string[];
  readonly maxParallelism: number;
  readonly estimatedCostClass: StrategyCostClass;
  readonly estimatedLatencyClass: StrategyLatencyClass;
  /** [0, 1] confidence the planner has in this choice. */
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly constraintsApplied: readonly string[];
}

// ─── Route metadata supplied alongside candidates ───────────────────────

/**
 * Per-route metadata the planner uses for decisions involving
 * routeKind / locality. Supplied as a Map keyed by routeId. When
 * omitted, the planner falls back to `breakdown.localPreference` as
 * the only local-vs-cloud signal (sufficient for `local_preferred`
 * and `local_required` modes, since the scorer populates that field
 * exactly when those modes apply).
 */
export interface PlannerRouteMetadata {
  readonly routeId: string;
  readonly routeKind: RouteKind;
}

// ─── Input / Result ─────────────────────────────────────────────────────

import type { StrategyPolicy } from './strategy-policy';

export interface StrategyPlannerInput {
  readonly candidates: readonly ModelScoreResult[];
  readonly context: StrategyPlanningContext;
  readonly policy?: Partial<StrategyPolicy>;
  /** Optional per-route metadata. Recommended for full-fidelity decisions. */
  readonly routesInfo?: ReadonlyMap<string, PlannerRouteMetadata>;
}

export interface StrategyRejectionRecord {
  readonly strategy: StrategyKind;
  readonly reason: string;
}

export interface StrategyPlannerResult {
  readonly plan: StrategyPlan;
  readonly rejectedStrategies: readonly StrategyRejectionRecord[];
}
