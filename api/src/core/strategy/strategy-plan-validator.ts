// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-plan-validator.ts — MVP 5B
 *
 * Pure validator. Verifies a StrategyPlan is well-formed:
 *
 *   - no_viable_strategy MUST have empty selectedRouteIds
 *   - single_best MUST have at most 1 selectedRouteId
 *   - collective strategies MUST respect maxParallelism
 *   - local_required MUST NOT include external routes
 *     (when route info is provided)
 *   - explicit pin MUST NOT have fallback when policy forbids
 *   - selectedRouteIds MUST NOT have duplicates
 *   - fallbackRouteIds MUST NOT duplicate selectedRouteIds
 *   - confidence MUST be in [0, 1]
 *
 * Pure. No I/O.
 */

import type { ExplicitPinInfo, PrivacyMode, RouteKind } from '../registry/types';
import type { StrategyPlan } from './strategy-types';
import type { StrategyPolicy } from './strategy-policy';

const SELF_HOSTED_KINDS: ReadonlySet<string> = new Set(['local', 'self_hosted']);
const COLLECTIVE_STRATEGIES: ReadonlySet<string> = new Set([
  'consensus',
  'debate',
  'expert_panel',
  'critique_repair',
  'tri_role_collective',
  'parallel_diverse',
]);

export interface StrategyPlanValidationContext {
  readonly privacyMode?: PrivacyMode;
  readonly routeKindById?: ReadonlyMap<string, RouteKind>;
  readonly policy?: StrategyPolicy;
  readonly explicitModelPin?: ExplicitPinInfo | null;
}

export interface StrategyPlanValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function validateStrategyPlan(
  plan: StrategyPlan,
  ctx: StrategyPlanValidationContext = {},
): StrategyPlanValidationResult {
  const errors: string[] = [];

  // 1. confidence in [0, 1]
  if (
    !Number.isFinite(plan.confidence) ||
    plan.confidence < 0 ||
    plan.confidence > 1
  ) {
    errors.push(`confidence_out_of_range:${plan.confidence}`);
  }

  // 2. no duplicates within selected
  const selectedSet = new Set(plan.selectedRouteIds);
  if (selectedSet.size !== plan.selectedRouteIds.length) {
    errors.push('duplicate_in_selectedRouteIds');
  }

  // 3. fallback must not overlap with selected
  for (const id of plan.fallbackRouteIds) {
    if (selectedSet.has(id)) {
      errors.push(`fallback_overlaps_selected:${id}`);
    }
  }

  // 4. fallback no duplicates within itself
  const fallbackSet = new Set(plan.fallbackRouteIds);
  if (fallbackSet.size !== plan.fallbackRouteIds.length) {
    errors.push('duplicate_in_fallbackRouteIds');
  }

  // 5. no_viable_strategy must have NO selected
  if (plan.strategy === 'no_viable_strategy' && plan.selectedRouteIds.length > 0) {
    errors.push('no_viable_strategy_has_selected_routes');
  }

  // 6. single_best must have at most 1 selected
  if (plan.strategy === 'single_best' && plan.selectedRouteIds.length > 1) {
    errors.push(
      `single_best_too_many_selected:${plan.selectedRouteIds.length}`,
    );
  }

  // 7. local_first must have at most 1 selected
  if (plan.strategy === 'local_first' && plan.selectedRouteIds.length > 1) {
    errors.push(`local_first_too_many_selected:${plan.selectedRouteIds.length}`);
  }

  // 8. collective strategies must respect maxParallelism
  if (COLLECTIVE_STRATEGIES.has(plan.strategy)) {
    if (plan.selectedRouteIds.length > plan.maxParallelism) {
      errors.push(
        `collective_exceeds_maxParallelism:${plan.selectedRouteIds.length}>${plan.maxParallelism}`,
      );
    }
    if (plan.maxParallelism < 1) {
      errors.push(`collective_zero_parallelism`);
    }
  }

  // 9. local_required must not include cloud routes (when info supplied)
  if (ctx.privacyMode === 'local_required' && ctx.routeKindById) {
    for (const rid of plan.selectedRouteIds) {
      const kind = ctx.routeKindById.get(rid);
      if (kind && !SELF_HOSTED_KINDS.has(kind)) {
        errors.push(`local_required_includes_external_route:${rid}`);
      }
    }
    for (const rid of plan.fallbackRouteIds) {
      const kind = ctx.routeKindById.get(rid);
      if (kind && !SELF_HOSTED_KINDS.has(kind)) {
        errors.push(`local_required_fallback_includes_external_route:${rid}`);
      }
    }
  }

  // 10. explicit pin: no fallback when policy forbids
  if (
    ctx.explicitModelPin &&
    ctx.policy &&
    !ctx.policy.allowFallbackForExplicitPin &&
    plan.fallbackRouteIds.length > 0
  ) {
    errors.push('explicit_pin_has_fallback_but_policy_forbids');
  }

  return {
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  };
}
