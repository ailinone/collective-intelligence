// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-calibrated-optimizer.ts — MVP 8B.7
 *
 * Calibrated ensemble selector. Replaces the MVP 8A optimizer's
 * additive marginal-gain math with:
 *   - bounded marginal-gain (maxTotalLift, maxPerAdditionalModelLift)
 *   - calibrated peer-lift (per task type + strategy, from history)
 *   - one of 8 ensemble estimators chosen on train-CV
 *   - uncertainty + variance penalties
 *   - fallback decision uses calibrated expectedJudge (not summed gains)
 *
 * The output shape is `EnsemblePlan` from MVP 8A so downstream consumers
 * (composer, adapter, trace) need NO changes.
 *
 * Pure. Deterministic. No I/O.
 */

import { pairKey } from '../../contribution/pair-contribution-profile';
import type { ContributionAwareScore } from '../../contribution/contribution-aware-candidate-scorer';
import { computeParetoFrontier, type ParetoExtractors } from '../cost-quality-frontier';
import type {
  EnsemblePlan,
  EnsembleParetoStatus,
  EnsembleStrategyId,
  MarginalContributionRecord,
  ParetoEnsembleBaselines,
  RejectedCandidateRecord,
} from '../ensemble-plan-types';
import type {
  EnsembleEstimator,
  EnsembleExpectedJudgeEstimate,
} from './ensemble-calibration-types';
import type { EnsembleLiftPolicy } from './ensemble-lift-policy';
import type { PeerLiftCalibrationResult } from './peer-lift-calibrator';
import { lookupPeerLift } from './peer-lift-calibrator';
import type { PairContributionProfile } from '../../contribution/pair-contribution-profile';

// ─── Public types ───────────────────────────────────────────────────────

export interface EnsembleCalibratedOptimizerInput {
  readonly candidates: readonly ContributionAwareScore[];
  readonly baseline: ParetoEnsembleBaselines;
  readonly taskType: string;
  readonly strategyId?: string;
  readonly peerLiftCalibration: PeerLiftCalibrationResult;
  readonly liftPolicy: EnsembleLiftPolicy;
  readonly estimator: EnsembleEstimator;
  readonly pairProfiles?: ReadonlyMap<string, PairContributionProfile>;
}

export interface EnsembleCalibratedOptimizerResult {
  readonly ensemblePlan: EnsemblePlan;
  readonly estimate: EnsembleExpectedJudgeEstimate;
  readonly usedEstimator: string;
  readonly nonFallbackCandidateConsidered: boolean;
  readonly fallbackReason?: string;
}

// ─── Main entry ─────────────────────────────────────────────────────────

export function optimizeEnsembleCalibrated(
  input: EnsembleCalibratedOptimizerInput,
): EnsembleCalibratedOptimizerResult {
  const policy = input.liftPolicy;
  const rejected: RejectedCandidateRecord[] = [];

  // 1. Filter accepted (scorer-level rejections).
  const accepted: ContributionAwareScore[] = [];
  for (const c of input.candidates) {
    if (c.rejected) {
      rejected.push({
        modelId: c.modelId,
        reason:
          c.rejectionReasons.length > 0
            ? c.rejectionReasons.join(',')
            : 'rejected_by_scorer',
      });
      continue;
    }
    accepted.push(c);
  }
  if (accepted.length === 0) {
    return wrapFallback(
      input,
      input.candidates,
      rejected,
      'no_accepted_candidates',
    );
  }

  // 2. Sort by totalScore desc (with deterministic tiebreakers).
  const sorted = [...accepted].sort(compareScores);

  // 3. Pareto frontier (info only — annotation, not exclusion).
  const extractors: ParetoExtractors<ContributionAwareScore> = {
    quality: (c) => c.expectedJudge,
    cost: (c) => c.estimatedCostUsd,
    tieKey: (c) => c.routeId,
  };
  const frontier = computeParetoFrontier(sorted, extractors);
  const frontierIds = new Set(frontier.map((f) => f.routeId));

  // 4. Greedy growth with BOUNDED marginal-gain caps.
  const peerLift = lookupPeerLift(
    input.peerLiftCalibration,
    input.taskType,
    input.strategyId,
  );
  const seed = sorted[0];
  const members: ContributionAwareScore[] = [seed];
  const marginal: MarginalContributionRecord[] = [
    {
      modelId: seed.modelId,
      marginalQualityGain: seed.expectedJudge,
      marginalCostUsd: seed.estimatedCostUsd,
      accepted: true,
      reason: 'seed_anchor',
    },
  ];

  const baselineCost = input.baseline.singleModelCostUsd;
  const costCeiling = baselineCost * policy.maxCostRatioVsSingle;
  let runningCost = seed.estimatedCostUsd;
  let totalLift = 0;

  for (const c of sorted) {
    if (c.routeId === seed.routeId) continue;
    if (members.length >= 3) {
      marginal.push({
        modelId: c.modelId,
        marginalQualityGain: 0,
        marginalCostUsd: c.estimatedCostUsd,
        accepted: false,
        reason: 'max_models_reached',
      });
      continue;
    }
    const newCost = runningCost + c.estimatedCostUsd;
    if (newCost > costCeiling) {
      marginal.push({
        modelId: c.modelId,
        marginalQualityGain: 0,
        marginalCostUsd: c.estimatedCostUsd,
        accepted: false,
        reason: 'cost_ceiling_exceeded',
      });
      continue;
    }
    // Bounded per-model lift.
    const candidateLift = Math.min(
      policy.maxPerAdditionalModelLift,
      Math.max(0, peerLift),
    );
    // Bounded total lift.
    if (totalLift + candidateLift > policy.maxTotalLift) {
      marginal.push({
        modelId: c.modelId,
        marginalQualityGain: 0,
        marginalCostUsd: c.estimatedCostUsd,
        accepted: false,
        reason: 'total_lift_ceiling_exceeded',
      });
      continue;
    }
    members.push(c);
    runningCost = newCost;
    totalLift += candidateLift;
    marginal.push({
      modelId: c.modelId,
      marginalQualityGain: candidateLift,
      marginalCostUsd: c.estimatedCostUsd,
      accepted: true,
      reason: candidateLift > 0 ? 'calibrated_peer_lift' : 'zero_peer_lift',
    });
  }

  // Annotate dominated candidates that weren't used.
  for (const c of sorted) {
    if (!frontierIds.has(c.routeId) && !members.find((m) => m.routeId === c.routeId)) {
      rejected.push({ modelId: c.modelId, reason: 'pareto_dominated' });
    }
  }

  // 5. Compute calibrated expectedJudge for the ensemble.
  const memberProfiles = members.map((m) => ({
    modelId: m.modelId,
    judgeMean: m.expectedJudge,
    judgeMedian: m.expectedJudge,
    judgeP80: m.expectedJudge,
  }));
  const pairProfile = lookupPairProfile(members, input.taskType, input.pairProfiles);
  const estimate = input.estimator.estimate({
    members,
    memberProfiles,
    pairProfile,
    peerLift,
    uncertaintyPenaltyWeight: policy.uncertaintyPenaltyWeight,
    singleBaselineJudge: input.baseline.singleModelJudge,
  });

  // 6. Decide: ensemble OR single_fallback.
  const judgeOk =
    estimate.expectedJudge >=
    input.baseline.singleModelJudge * policy.minExpectedJudgeRatioVsSingle;
  const costOk = runningCost <= costCeiling;
  const enoughMembers = members.length >= 2;
  const nonFallbackCandidateConsidered = enoughMembers && (judgeOk || costOk);

  if (!enoughMembers || !judgeOk || !costOk) {
    const reasons: string[] = [];
    if (!enoughMembers) reasons.push('below_min_members');
    if (!judgeOk) reasons.push('expected_judge_below_baseline');
    if (!costOk) reasons.push('ensemble_cost_above_ceiling');
    return wrapFallback(input, input.candidates, rejected, reasons.join(','), nonFallbackCandidateConsidered);
  }

  // 7. Final plan — paretoStatus driven by calibrated metrics.
  const status = classifyParetoStatus(
    estimate.expectedJudge,
    runningCost,
    input.baseline,
    policy,
  );
  const strategyId: EnsembleStrategyId = 'parallel';
  const plan: EnsemblePlan = {
    strategyId,
    selectedRouteIds: Object.freeze(members.map((m) => m.routeId)),
    selectedModelIds: Object.freeze(members.map((m) => m.modelId)),
    expectedJudge: estimate.expectedJudge,
    expectedCostUsd: runningCost,
    expectedQualityPerDollar:
      runningCost > 1e-9 ? Math.min(estimate.expectedJudge / runningCost, 10_000) : 0,
    baselineJudge: input.baseline.singleModelJudge,
    baselineCostUsd: input.baseline.singleModelCostUsd,
    paretoStatus: status,
    marginalContributions: Object.freeze(marginal),
    rejectedCandidates: Object.freeze(rejected),
    explanation: buildExplanation(
      estimate,
      runningCost,
      members.length,
      input.baseline,
      policy,
    ),
  };
  return Object.freeze({
    ensemblePlan: Object.freeze(plan),
    estimate,
    usedEstimator: input.estimator.name,
    nonFallbackCandidateConsidered,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

function wrapFallback(
  input: EnsembleCalibratedOptimizerInput,
  allCandidates: readonly ContributionAwareScore[],
  rejected: readonly RejectedCandidateRecord[],
  reason: string,
  nonFallbackCandidateConsidered = false,
): EnsembleCalibratedOptimizerResult {
  const usable = allCandidates.filter((c) => !c.rejected);
  const sorted = [...usable].sort(compareScores);
  const top = sorted[0];
  const plan: EnsemblePlan = top
    ? {
        strategyId: 'single_fallback',
        selectedRouteIds: Object.freeze([top.routeId]),
        selectedModelIds: Object.freeze([top.modelId]),
        expectedJudge: top.expectedJudge,
        expectedCostUsd: top.estimatedCostUsd,
        expectedQualityPerDollar:
          top.estimatedCostUsd > 1e-9
            ? Math.min(top.expectedJudge / top.estimatedCostUsd, 10_000)
            : 0,
        baselineJudge: input.baseline.singleModelJudge,
        baselineCostUsd: input.baseline.singleModelCostUsd,
        paretoStatus: 'single_fallback',
        marginalContributions: Object.freeze([
          {
            modelId: top.modelId,
            marginalQualityGain: top.expectedJudge,
            marginalCostUsd: top.estimatedCostUsd,
            accepted: true,
            reason: 'fallback_seed',
          },
        ]),
        rejectedCandidates: Object.freeze(rejected),
        explanation: `single_fallback;reason=${reason}`,
      }
    : {
        strategyId: 'single_fallback',
        selectedRouteIds: Object.freeze([]),
        selectedModelIds: Object.freeze([]),
        expectedJudge: 0,
        expectedCostUsd: 0,
        expectedQualityPerDollar: 0,
        baselineJudge: input.baseline.singleModelJudge,
        baselineCostUsd: input.baseline.singleModelCostUsd,
        paretoStatus: 'single_fallback',
        marginalContributions: Object.freeze([]),
        rejectedCandidates: Object.freeze(rejected),
        explanation: `single_fallback_no_candidates;reason=${reason}`,
      };
  return Object.freeze({
    ensemblePlan: Object.freeze(plan),
    estimate: Object.freeze({
      estimatorName: input.estimator.name,
      expectedJudge: plan.expectedJudge,
      uncertainty: 0,
      lowerBound: plan.expectedJudge,
      reasons: Object.freeze(['fallback']),
    }),
    usedEstimator: input.estimator.name,
    nonFallbackCandidateConsidered,
    fallbackReason: reason,
  });
}

function lookupPairProfile(
  members: readonly ContributionAwareScore[],
  taskType: string,
  pairProfiles: ReadonlyMap<string, PairContributionProfile> | undefined,
): import('./ensemble-calibration-types').EnsembleCalibrationExamplePairProfile | undefined {
  if (!pairProfiles || members.length !== 2) return undefined;
  const key = pairKey(members[0].modelId, members[1].modelId);
  const p = pairProfiles.get(key);
  if (!p || p.taskType !== taskType) return undefined;
  return Object.freeze({
    modelA: p.modelA,
    modelB: p.modelB,
    judgeMean: p.judgeMean,
    costMean: p.costMean,
    paretoWinRate: p.paretoWinRate,
    complementarityScore: p.complementarityScore,
    riskScore: p.riskScore,
  });
}

function classifyParetoStatus(
  expectedJudge: number,
  expectedCost: number,
  baseline: ParetoEnsembleBaselines,
  policy: EnsembleLiftPolicy,
): EnsembleParetoStatus {
  const judgeOk =
    expectedJudge >= baseline.singleModelJudge * policy.minExpectedJudgeRatioVsSingle;
  const costOk =
    expectedCost <= baseline.singleModelCostUsd * policy.maxCostRatioVsSingle;
  if (judgeOk && costOk) return 'beats_baseline';
  if (judgeOk && !costOk) return 'cost_tradeoff';
  if (!judgeOk && costOk) return 'quality_tradeoff';
  return 'dominated';
}

function buildExplanation(
  estimate: EnsembleExpectedJudgeEstimate,
  expectedCost: number,
  memberCount: number,
  baseline: ParetoEnsembleBaselines,
  policy: EnsembleLiftPolicy,
): string {
  return [
    `strategy=parallel`,
    `members=${memberCount}`,
    `estimator=${estimate.estimatorName}`,
    `expectedJudge=${estimate.expectedJudge.toFixed(4)}`,
    `uncertainty=${estimate.uncertainty.toFixed(4)}`,
    `lowerBound=${estimate.lowerBound.toFixed(4)}`,
    `expectedCost=${expectedCost.toFixed(6)}`,
    `baselineJudge=${baseline.singleModelJudge.toFixed(4)}`,
    `baselineCost=${baseline.singleModelCostUsd.toFixed(6)}`,
    `policy.maxTotalLift=${policy.maxTotalLift}`,
    `policy.maxPerAdditionalModelLift=${policy.maxPerAdditionalModelLift}`,
  ].join(';');
}

function compareScores(a: ContributionAwareScore, b: ContributionAwareScore): number {
  if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
  if (a.estimatedCostUsd !== b.estimatedCostUsd) return a.estimatedCostUsd - b.estimatedCostUsd;
  if (a.routeId !== b.routeId) return a.routeId < b.routeId ? -1 : 1;
  return 0;
}
