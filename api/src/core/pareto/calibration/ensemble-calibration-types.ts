// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-calibration-types.ts — MVP 8B.7
 *
 * Types for the ensemble-level calibration layer. The blocker found in
 * MVP 8B.6 was that per-model judge calibration could not fix the
 * additive marginal-gain stacking inside the optimizer; this layer
 * calibrates the ensemble's `expectedJudge` directly using:
 *   - peer-lift learned from historical ensemble executions
 *   - bounded marginal-gain caps
 *   - one of 8 ensemble estimators selected on train CV
 *
 * Pure types — no runtime imports beyond MVP 8A/8B.
 */

import type {
  ContributionAwareScore,
} from '../../contribution/contribution-aware-candidate-scorer';

// ─── Calibration example (one ensemble execution in the train set) ──────

export interface EnsembleCalibrationExampleMemberProfile {
  readonly modelId: string;
  readonly judgeMean: number;
  readonly judgeMedian: number;
  readonly judgeP80: number;
  readonly judgeStdDev?: number;
  readonly contributionScore?: number;
  readonly harmScore?: number;
}

export interface EnsembleCalibrationExamplePairProfile {
  readonly modelA: string;
  readonly modelB: string;
  readonly judgeMean?: number;
  readonly costMean?: number;
  readonly paretoWinRate?: number;
  readonly complementarityScore?: number;
  readonly riskScore?: number;
}

export interface EnsembleCalibrationExample {
  readonly executionId: string;
  readonly experimentId: string;
  readonly taskId: string;
  readonly taskType: string;
  readonly strategyId: string;
  readonly effectiveStrategyId: string;

  readonly selectedModelIds: readonly string[];
  readonly selectedRouteIds?: readonly string[];

  readonly observedJudge: number;
  readonly observedCostUsd: number;

  readonly singleBaselineJudge: number;
  readonly singleBaselineCostUsd: number;

  readonly modelProfileJudges: readonly EnsembleCalibrationExampleMemberProfile[];
  readonly pairProfile?: EnsembleCalibrationExamplePairProfile;

  readonly metadata?: {
    readonly complexity?: string;
    readonly modality?: string;
    readonly sampleWeight?: number;
  };
}

// ─── Estimate output ────────────────────────────────────────────────────

export interface EnsembleExpectedJudgeEstimate {
  readonly estimatorName: string;
  readonly expectedJudge: number;
  readonly uncertainty: number;
  readonly lowerBound: number;
  readonly reasons: readonly string[];
}

// ─── Calibration metrics (replay summary) ───────────────────────────────

export interface EnsembleCalibrationMetrics {
  readonly evaluatedRows: number;
  readonly expectedVsObservedJudgeError: number;
  readonly medianError: number;
  readonly p80Error: number;
  readonly nonFallbackRate: number;
  readonly fallbackRate: number;
  readonly qualityAndCostSuccessRate: number;
  readonly qualityGeSingleRate: number;
  readonly costLeSingleRate: number;
  readonly costPredictionError: number;
  readonly taskTypeErrors: Record<string, number>;
  readonly fallbackReasonDistribution: Record<string, number>;
  readonly coverageRate: number;
  readonly pairWinnerSelectedTotal: number;
  readonly cheapGoodPreservedTotal: number;
  readonly unjustifiedCollectiveAvoidedTotal: number;
  readonly expensiveConsensusAvoidedTotal: number;
  readonly harmfulModelAvoidedTotal: number;
  readonly modalityMismatchAvoidedTotal: number;
  readonly multiMiniPoolAvoidedTotal: number;
}

// ─── Estimator catalog input ────────────────────────────────────────────

export interface EnsembleEstimateInput {
  /** Candidates in the proposed ensemble (anchor first, supports after). */
  readonly members: readonly ContributionAwareScore[];
  /** Per-member historical profile data (matches members in order). */
  readonly memberProfiles: readonly EnsembleCalibrationExampleMemberProfile[];
  /** Pair-aware profile (when 2 members + pair history available). */
  readonly pairProfile?: EnsembleCalibrationExamplePairProfile;
  /** Calibrated peer lift for this task type / strategy. */
  readonly peerLift: number;
  /** Per-task variance penalty weight from policy. */
  readonly uncertaintyPenaltyWeight: number;
  /** Single-baseline judge (used by anchor reference). */
  readonly singleBaselineJudge: number;
}

export interface EnsembleEstimator {
  readonly name: string;
  estimate(input: EnsembleEstimateInput): EnsembleExpectedJudgeEstimate;
}
