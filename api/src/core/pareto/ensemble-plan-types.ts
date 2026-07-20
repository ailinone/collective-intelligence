// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-plan-types.ts — MVP 8A
 *
 * Pure types for the Pareto ensemble optimizer's input and output.
 */

import type {
  CandidateModality,
  ContributionAwareScore,
} from '../contribution/contribution-aware-candidate-scorer';
import type { CollectiveSelectionPolicy } from './collective-selection-policy';
import type { PairContributionProfile } from '../contribution/pair-contribution-profile';

// ─── Input ──────────────────────────────────────────────────────────────

export interface ParetoEnsembleInput {
  readonly candidates: readonly ContributionAwareScore[];
  readonly taskType: string;
  readonly taskModality: CandidateModality;
  readonly baseline: ParetoEnsembleBaselines;
  readonly policy?: Partial<CollectiveSelectionPolicy>;
  /**
   * Optional pair profiles keyed via the canonical pairKey ordering.
   * Used to add complementarity bonus / redundancy penalty when scoring
   * marginal contribution.
   */
  readonly pairProfiles?: ReadonlyMap<string, PairContributionProfile>;
}

export interface ParetoEnsembleBaselines {
  readonly singleModelJudge: number;
  readonly singleModelCostUsd: number;
  readonly singleBudgetJudge?: number;
  readonly singleBudgetCostUsd?: number;
}

// ─── Output ─────────────────────────────────────────────────────────────

export type EnsembleStrategyId =
  | 'parallel'
  | 'consensus'
  | 'critique-repair'
  | 'single_fallback';

export type EnsembleParetoStatus =
  | 'beats_baseline'
  | 'quality_tradeoff'
  | 'cost_tradeoff'
  | 'dominated'
  | 'single_fallback';

export interface MarginalContributionRecord {
  readonly modelId: string;
  readonly marginalQualityGain: number;
  readonly marginalCostUsd: number;
  readonly accepted: boolean;
  readonly reason: string;
}

export interface RejectedCandidateRecord {
  readonly modelId: string;
  readonly reason: string;
}

export interface EnsemblePlan {
  readonly strategyId: EnsembleStrategyId;
  readonly selectedRouteIds: readonly string[];
  readonly selectedModelIds: readonly string[];

  readonly expectedJudge: number;
  readonly expectedCostUsd: number;
  readonly expectedQualityPerDollar: number;

  readonly baselineJudge: number;
  readonly baselineCostUsd: number;

  readonly paretoStatus: EnsembleParetoStatus;
  readonly marginalContributions: readonly MarginalContributionRecord[];
  readonly rejectedCandidates: readonly RejectedCandidateRecord[];
  readonly explanation: string;
}
