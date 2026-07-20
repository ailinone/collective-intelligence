// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ablation Configuration — Class 3 Validation Infrastructure
 *
 * Defines the ablation framework for isolating the causal contribution
 * of each system component. Without ablation, it's impossible to attribute
 * performance gains to specific mechanisms (P0.2).
 *
 * Components that can be ablated:
 * - memory: Skip enrichWithMemories() in BaseStrategy
 * - bandit: Use random strategy selection instead of Thompson Sampling
 * - archive: Skip configuration archive lookup
 * - pareto: Skip Pareto frontier update and lookup
 * - critique: Skip self-critique / critique-repair rounds
 * - feedback-loop: Skip quality gate + retry (single attempt only)
 * - shadow: Skip shadow evaluation
 * - knowledge-graph: Skip KG enrichment and routing
 * - triage: Skip triage classification, use default strategy
 * - debate-rounds: Limit to single round (no multi-turn debate)
 */

/** Components that can be individually disabled for ablation studies */
export type AblationComponent =
  | 'memory'
  | 'bandit'
  | 'archive'
  | 'pareto'
  | 'critique'
  | 'feedback-loop'
  | 'shadow'
  | 'knowledge-graph'
  | 'triage'
  | 'debate-rounds';

/** All ablation components for iteration */
export const ALL_ABLATION_COMPONENTS: AblationComponent[] = [
  'memory',
  'bandit',
  'archive',
  'pareto',
  'critique',
  'feedback-loop',
  'shadow',
  'knowledge-graph',
  'triage',
  'debate-rounds',
];

/** Ablation mode configuration for experiment runner */
export interface AblationModeConfig {
  mode: 'ablation';
  /** Base strategy to run with components disabled */
  strategy: string;
  /** Display name for reports (e.g., "Debate -memory") */
  displayName: string;
  /** Components to disable */
  disableComponents: AblationComponent[];
}

/** Runtime ablation flags propagated through OrchestrationContext */
export interface AblationFlags {
  /** Components currently disabled */
  disabled: Set<AblationComponent>;
  /** Whether this execution is part of an ablation study */
  isAblation: boolean;
  /** Label for this ablation condition (e.g., "-memory", "full") */
  conditionLabel: string;
}

/** Create ablation flags from a list of disabled components */
export function createAblationFlags(
  disableComponents: AblationComponent[] = [],
  conditionLabel?: string
): AblationFlags {
  return {
    disabled: new Set(disableComponents),
    isAblation: disableComponents.length > 0,
    conditionLabel: conditionLabel ?? (disableComponents.length > 0
      ? `-${disableComponents.join('-')}`
      : 'full'),
  };
}

/** No ablation — all components active (control condition) */
export const NO_ABLATION: AblationFlags = {
  disabled: new Set(),
  isAblation: false,
  conditionLabel: 'full',
};

/** Check if a specific component is ablated (disabled) */
export function isAblated(flags: AblationFlags | undefined, component: AblationComponent): boolean {
  if (!flags) return false;
  return flags.disabled.has(component);
}

/**
 * Generate the standard ablation matrix for a given strategy.
 * Returns one AblationModeConfig per component (each disabling one component)
 * plus the full control condition.
 */
export function generateAblationMatrix(strategy: string): AblationModeConfig[] {
  const matrix: AblationModeConfig[] = [];

  // Control condition (no ablation)
  matrix.push({
    mode: 'ablation',
    strategy,
    displayName: `${strategy} (full)`,
    disableComponents: [],
  });

  // One condition per component
  for (const component of ALL_ABLATION_COMPONENTS) {
    matrix.push({
      mode: 'ablation',
      strategy,
      displayName: `${strategy} (-${component})`,
      disableComponents: [component],
    });
  }

  return matrix;
}
