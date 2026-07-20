// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * collective-selection-policy.ts — MVP 8A
 *
 * Pure config object that encodes the operator's thesis around
 * collective selection. The default is the STRICT thesis:
 *   - expected judge >= single baseline
 *   - expected cost  <= single baseline
 *   - maximise CONTRIBUTIVE models, not raw model count
 */

export interface CollectiveSelectionPolicy {
  readonly maxModels: number;
  readonly minModels: number;

  /** Ensemble.expectedCost / baselineCost must stay <= this ratio. */
  readonly maxCostRatioVsSingle: number;
  /** Ensemble.expectedJudge / baselineJudge must stay >= this ratio. */
  readonly minExpectedJudgeRatioVsSingle: number;

  /** Minimum marginal quality gain required to add another model. */
  readonly minMarginalQualityGain: number;
  /** Reject candidates whose harm rate exceeds this. */
  readonly maxHarmRate: number;
  /** Reject candidates whose contribution confidence is below this. */
  readonly minContributionConfidence: number;

  readonly allowExplorationCandidates: boolean;
  readonly maxExplorationCandidates: number;

  /** TaskTypes that should prefer `parallel` over `consensus`/`critique-repair`. */
  readonly preferParallelForTaskTypes: readonly string[];
  readonly allowConsensusWhenCostExceedsBaseline: boolean;
  readonly allowCritiqueRepairWhenCostExceedsBaseline: boolean;

  /** When true, modality mismatch is a hard reject. */
  readonly modalityStrict: boolean;
}

export const DEFAULT_COLLECTIVE_SELECTION_POLICY: CollectiveSelectionPolicy = Object.freeze({
  maxModels: 3,
  minModels: 2,

  maxCostRatioVsSingle: 1.0,
  minExpectedJudgeRatioVsSingle: 1.0,

  minMarginalQualityGain: 0.02,
  maxHarmRate: 0.25,
  minContributionConfidence: 0.4,

  allowExplorationCandidates: false,
  maxExplorationCandidates: 0,

  preferParallelForTaskTypes: Object.freeze(['code-generation']),
  allowConsensusWhenCostExceedsBaseline: false,
  allowCritiqueRepairWhenCostExceedsBaseline: false,

  modalityStrict: true,
});

/**
 * Returns a policy that merges caller overrides onto the default.
 * Frozen output.
 */
export function resolveCollectiveSelectionPolicy(
  override?: Partial<CollectiveSelectionPolicy>,
): CollectiveSelectionPolicy {
  if (!override) return DEFAULT_COLLECTIVE_SELECTION_POLICY;
  return Object.freeze({
    ...DEFAULT_COLLECTIVE_SELECTION_POLICY,
    ...override,
    preferParallelForTaskTypes: Object.freeze(
      Array.from(
        override.preferParallelForTaskTypes ??
          DEFAULT_COLLECTIVE_SELECTION_POLICY.preferParallelForTaskTypes,
      ),
    ),
  });
}
