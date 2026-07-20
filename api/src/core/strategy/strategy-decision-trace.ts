// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-decision-trace.ts — MVP 5B
 *
 * Pure type for audit / explainability. The planner does NOT produce
 * a trace directly in MVP 5B — the trace shape is declared here so a
 * future MVP (or callers in admin endpoints) can serialize the
 * planner's decision audit consistently.
 *
 * The trace is intentionally categorical-only — no prompts, no PII.
 */

import type {
  StrategyKind,
  StrategyPlan,
  StrategyRejectionRecord,
  StrategyPlanningContext,
} from './strategy-types';

/**
 * Projection of the planning context safe to serialize alongside the
 * trace. Excludes the `explicitModelPin.authorizingPolicy` free-text
 * field for safety (re-included via redaction layer if needed).
 */
export interface StrategyPlanningContextSummary {
  readonly taskType: string;
  readonly complexity: string;
  readonly riskLevel: string;
  readonly privacyMode: string;
  readonly costSensitivity: string;
  readonly latencySensitivity: string;
  readonly confidenceNeeded: number;
  readonly hasExplicitPin: boolean;
}

export interface StrategyDecisionTrace {
  readonly contextSnapshot: StrategyPlanningContextSummary;
  readonly candidateCount: number;
  readonly evaluatedStrategies: readonly StrategyRejectionRecord[];
  readonly plan: StrategyPlan;
  readonly selectedStrategy: StrategyKind;
}

/** Pure helper — converts the full context into the categorical summary. */
export function summariseContext(
  ctx: StrategyPlanningContext,
): StrategyPlanningContextSummary {
  return {
    taskType: ctx.taskType,
    complexity: ctx.complexity,
    riskLevel: ctx.riskLevel,
    privacyMode: ctx.privacyMode,
    costSensitivity: ctx.costSensitivity,
    latencySensitivity: ctx.latencySensitivity,
    confidenceNeeded: ctx.confidenceNeeded,
    hasExplicitPin: !!ctx.explicitModelPin,
  };
}
