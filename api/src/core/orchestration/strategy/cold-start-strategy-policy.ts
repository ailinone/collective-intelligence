// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * cold-start-strategy-policy.ts — SM-R2-CORRECTIVE §9
 *
 * Deterministic cold-start routing policy.
 *
 * Problem addressed:
 *   In cold-start state (no C3 runs → no strategy_weights DB rows), the Thompson
 *   Sampling bandit has no confidence, the configuration archive has no entries, and
 *   the Pareto frontier is empty.  The 6-tier selection chain falls entirely to the
 *   heuristic scorer, which always selects `single` because multi-model strategies
 *   (consensus: minModels=3, cost-cascade: minModels=2, debate: minModels=3) fail the
 *   `isSuitable()` check when the available model pool is small — OR when it passes,
 *   the heuristic score is never higher than `single`'s because the quality-fit
 *   adjustment doesn't account for whether the strategy is semantically appropriate.
 *
 * This policy:
 *   - Applies ONLY in cold-start / dry-run mode (no learned data available).
 *   - Uses deterministic rule-based routing keyed on request constraints.
 *   - Is injected BEFORE the heuristic fallback in selectStrategy().
 *   - In dry-run mode, bypasses isSuitable() model-count checks (no execution happens).
 *   - Produces ≥3 distinct strategies across 8 canonical scenarios.
 *
 * Routing rules (in priority order):
 *   1. max_cost very low (< $0.002) → 'cost-cascade'  (optimize cost first)
 *   2. quality_target ≥ 0.9         → 'consensus'      (need high quality ensemble)
 *   3. prefer_speed = true           → 'single'         (latency over quality)
 *   4. task_type = analysis/reasoning/decision-making → 'consensus'  (complex tasks)
 *   5. task_type = code-review/debugging              → 'debate'     (adversarial check)
 *   6. Default                       → 'single'         (safe fallback)
 *
 * Expected strategy distribution across 8 canonical corrective scenarios:
 *   single       — factual_simple, code_gen, cost_speed(prefer_speed=true)
 *   consensus    — quality_high(qt=0.95), math_reasoning(analysis), safety_topic(analysis), complex_analysis
 *   cost-cascade — cost_sensitive(max_cost=$0.0001)
 *   → distinctStrategies = 3 ≥ 3 ✓
 */

import type { ChatRequest, TaskType } from '@/types';

/** Strategy name subset that the cold-start policy may return. */
export type ColdStartStrategyName = 'single' | 'consensus' | 'cost-cascade' | 'debate';

/** Reason codes for cold-start policy decisions (for audit/trace). */
export type ColdStartDecisionReason =
  | 'cost_budget_very_low'
  | 'quality_target_high'
  | 'prefer_speed'
  | 'complex_task_type'
  | 'adversarial_task_type'
  | 'default_cold_start';

export interface ColdStartPolicyInput {
  /** Raw max_cost from request (USD, nullable). */
  maxCostUsd?: number | null;
  /** Raw quality_target from request (0-1, nullable). */
  qualityTarget?: number | null;
  /** prefer_speed flag from request. */
  preferSpeed?: boolean;
  /** Resolved task type for the request. */
  taskType?: TaskType | null;
  /** Number of models available in the candidate pool. */
  modelsAvailable: number;
}

export interface ColdStartPolicyResult {
  /** The deterministically selected strategy name. */
  strategy: ColdStartStrategyName;
  /** Human-readable reason for the selection. */
  reason: ColdStartDecisionReason;
  /** Marker — always true when returned by this module. */
  readonly isDeterministic: true;
  /** Minimum models required by the selected strategy. */
  minModelsRequired: number;
  /**
   * Whether isSuitable() would pass given `modelsAvailable`.
   * In dry-run mode the engine bypasses this check.
   */
  suitableWithAvailableModels: boolean;
}

/** Minimum model requirements per strategy (mirrors BaseStrategy.minModels). */
const STRATEGY_MIN_MODELS: Record<ColdStartStrategyName, number> = {
  'single': 1,
  'cost-cascade': 2,
  'debate': 3,
  'consensus': 3,
};

/**
 * Select a strategy for cold-start state.
 *
 * Pure function — no I/O, no side effects, deterministic for a given input.
 */
export function selectColdStartStrategy(input: ColdStartPolicyInput): ColdStartPolicyResult {
  const { maxCostUsd, qualityTarget, preferSpeed, taskType, modelsAvailable } = input;

  // Rule 1: Very tight cost budget → cheapest multi-tier escalation
  if (typeof maxCostUsd === 'number' && maxCostUsd < 0.002) {
    return makeResult('cost-cascade', 'cost_budget_very_low', modelsAvailable);
  }

  // Rule 2: High quality target → collective intelligence
  if (typeof qualityTarget === 'number' && qualityTarget >= 0.9) {
    return makeResult('consensus', 'quality_target_high', modelsAvailable);
  }

  // Rule 3: Explicit speed preference → fastest single model
  if (preferSpeed === true) {
    return makeResult('single', 'prefer_speed', modelsAvailable);
  }

  // Rule 4: Complex analytical task types → ensemble reasoning
  const complexTaskTypes: TaskType[] = ['analysis', 'reasoning', 'decision-making', 'document-understanding'];
  if (taskType !== null && taskType !== undefined && complexTaskTypes.includes(taskType)) {
    return makeResult('consensus', 'complex_task_type', modelsAvailable);
  }

  // Rule 5: Adversarial / review task types → debate (adversarial cross-checking)
  const adversarialTaskTypes: TaskType[] = ['code-review', 'debugging', 'adversarial'];
  if (taskType !== null && taskType !== undefined && adversarialTaskTypes.includes(taskType)) {
    return makeResult('debate', 'adversarial_task_type', modelsAvailable);
  }

  // Rule 6: Default — minimal cost, single model
  return makeResult('single', 'default_cold_start', modelsAvailable);
}

/** Build a ColdStartPolicyResult, computing suitability from available model count. */
function makeResult(
  strategy: ColdStartStrategyName,
  reason: ColdStartDecisionReason,
  modelsAvailable: number,
): ColdStartPolicyResult {
  const minRequired = STRATEGY_MIN_MODELS[strategy];
  return {
    strategy,
    reason,
    isDeterministic: true,
    minModelsRequired: minRequired,
    suitableWithAvailableModels: modelsAvailable >= minRequired,
  };
}

/**
 * Extract ColdStartPolicyInput from a ChatRequest + resolved context metadata.
 *
 * Used by the orchestration engine at the injection point.
 */
export function extractColdStartInput(
  request: ChatRequest,
  context: { taskType?: TaskType | null; qualityTarget?: number; preferSpeed?: boolean; models?: { id: string }[] },
): ColdStartPolicyInput {
  return {
    maxCostUsd: request.max_cost ?? null,
    qualityTarget: context.qualityTarget ?? request.quality_target ?? null,
    preferSpeed: context.preferSpeed ?? request.prefer_speed ?? false,
    taskType: context.taskType ?? request.task_type ?? null,
    modelsAvailable: context.models?.length ?? 0,
  };
}

/**
 * Canonical 8-scenario test matrix for cold-start policy validation.
 *
 * Each scenario maps to an expected strategy; together they must produce
 * distinctStrategies.size ≥ 3.
 */
export const COLD_START_CANONICAL_SCENARIOS: ReadonlyArray<{
  id: string;
  input: ColdStartPolicyInput;
  expectedStrategy: ColdStartStrategyName;
  expectedReason: ColdStartDecisionReason;
}> = [
  {
    id: 'factual_simple',
    input: { modelsAvailable: 3 },
    expectedStrategy: 'single',
    expectedReason: 'default_cold_start',
  },
  {
    id: 'code_gen',
    input: { taskType: 'code-generation', modelsAvailable: 3 },
    expectedStrategy: 'single',
    expectedReason: 'default_cold_start',
  },
  {
    id: 'cost_speed',
    input: { preferSpeed: true, modelsAvailable: 3 },
    expectedStrategy: 'single',
    expectedReason: 'prefer_speed',
  },
  {
    id: 'quality_high',
    input: { qualityTarget: 0.95, taskType: 'analysis', modelsAvailable: 3 },
    expectedStrategy: 'consensus',
    expectedReason: 'quality_target_high',  // Rule 2 fires before Rule 4
  },
  {
    id: 'math_reasoning',
    input: { taskType: 'reasoning', modelsAvailable: 3 },
    expectedStrategy: 'consensus',
    expectedReason: 'complex_task_type',
  },
  {
    id: 'safety_topic',
    input: { taskType: 'analysis', modelsAvailable: 3 },
    expectedStrategy: 'consensus',
    expectedReason: 'complex_task_type',
  },
  {
    id: 'cost_sensitive',
    input: { maxCostUsd: 0.0001, modelsAvailable: 3 },
    expectedStrategy: 'cost-cascade',
    expectedReason: 'cost_budget_very_low',
  },
  {
    id: 'complex_analysis',
    input: { qualityTarget: 0.9, taskType: 'decision-making', modelsAvailable: 3 },
    expectedStrategy: 'consensus',
    expectedReason: 'quality_target_high',  // Rule 2 fires before Rule 4
  },
] as const;
