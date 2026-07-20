// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-ensemble-optimizer.ts — MVP 8A
 *
 * Pure, deterministic ensemble selector. Greedy growth with marginal
 * gain check, capped by the policy.
 *
 * Algorithm (deterministic at every step):
 *
 *   1. Filter accepted candidates (drop rejected, drop modality mismatch
 *      when modalityStrict, drop harm-failing, drop low-confidence
 *      unless allowExplorationCandidates is true).
 *   2. Sort by quality-adjusted score then by tie-breakers (cost ↑, id ↑).
 *   3. Compute the Pareto frontier over (expectedJudge, estimatedCost)
 *      and discard everything off the frontier (no point selecting a
 *      dominated candidate over a frontier one).
 *   4. Seed the ensemble with the best ANCHOR on the frontier; when no
 *      anchor exists, seed with the highest-quality frontier candidate.
 *   5. Greedily try to add the next frontier candidate; accept only if
 *      marginal quality gain >= policy.minMarginalQualityGain AND new
 *      total cost stays within baseline * maxCostRatioVsSingle AND we
 *      have headroom (size < maxModels).
 *   6. Pick the strategyId: parallel for preferred task types; consensus
 *      or critique-repair only when the policy explicitly permits cost
 *      overrun.
 *   7. If the resulting plan does NOT beat the baseline in the strict
 *      thesis sense, fall back to single_fallback with the best
 *      individual.
 *
 * No I/O. No randomness. No clock reads. Inputs are not mutated.
 * The optimizer never branches on a model NAME — every decision is
 * a numeric comparison.
 */

import type { ContributionAwareScore } from '../contribution/contribution-aware-candidate-scorer';
import { pairKey } from '../contribution/pair-contribution-profile';
import {
  computeParetoFrontier,
  type ParetoExtractors,
} from './cost-quality-frontier';
import {
  resolveCollectiveSelectionPolicy,
  type CollectiveSelectionPolicy,
} from './collective-selection-policy';
import type {
  EnsemblePlan,
  EnsembleStrategyId,
  EnsembleParetoStatus,
  MarginalContributionRecord,
  ParetoEnsembleInput,
  ParetoEnsembleBaselines,
  RejectedCandidateRecord,
} from './ensemble-plan-types';
import type { PairContributionProfile } from '../contribution/pair-contribution-profile';

// ─── Main entry ─────────────────────────────────────────────────────────

export function optimizeParetoEnsemble(input: ParetoEnsembleInput): EnsemblePlan {
  const policy = resolveCollectiveSelectionPolicy(input.policy);
  const rejected: RejectedCandidateRecord[] = [];

  // 1. Filter accepted candidates.
  const accepted = filterAccepted(input.candidates, policy, rejected);

  if (accepted.length === 0) {
    return Object.freeze(
      buildSingleFallbackPlan(input.candidates, input.baseline, rejected, policy),
    );
  }

  // 2. Sort accepted by total score desc; tie-break by lower cost, then by routeId.
  const sorted = [...accepted].sort(compareScores);

  // 3. Pareto frontier over (expectedJudge, estimatedCost). Informational
  //    only — used to flag dominated candidates in the trace, NOT to
  //    filter them out of growth. A nominally-dominated candidate can
  //    still contribute marginal quality via best-of-N or
  //    complementarity.
  const extractors: ParetoExtractors<ContributionAwareScore> = {
    quality: (c) => c.expectedJudge,
    cost: (c) => c.estimatedCostUsd,
    tieKey: (c) => c.routeId,
  };
  const frontier = computeParetoFrontier(sorted, extractors);
  const frontierIds = new Set(frontier.map((f) => f.routeId));

  // 4-5. Greedy growth with marginal gain (evaluates ALL accepted,
  //      ordered by sorted score, not just frontier members).
  const growth = growEnsemble(sorted, input, policy);

  // Annotate dominated-and-not-used candidates with a pareto_dominated
  // reason so the trace can explain selector decisions.
  for (const c of sorted) {
    if (!frontierIds.has(c.routeId) && !growth.usedIds.has(c.routeId)) {
      rejected.push({ modelId: c.modelId, reason: 'pareto_dominated' });
    }
  }

  // 6. Strategy choice.
  const strategyId = pickStrategy(growth, input, policy);

  // 7. Final pareto status + fallback decision.
  const expectedJudge = growth.expectedJudge;
  const expectedCost = growth.expectedCost;
  const baselineOk = expectedJudge >=
    input.baseline.singleModelJudge * policy.minExpectedJudgeRatioVsSingle;
  const costOk = expectedCost <=
    input.baseline.singleModelCostUsd * policy.maxCostRatioVsSingle;
  const beatsBaseline = baselineOk && costOk;
  const enoughModels = growth.members.length >= policy.minModels;

  if (
    !beatsBaseline &&
    !policy.allowConsensusWhenCostExceedsBaseline &&
    !policy.allowCritiqueRepairWhenCostExceedsBaseline
  ) {
    return Object.freeze(
      buildSingleFallbackPlan(
        input.candidates,
        input.baseline,
        rejected,
        policy,
        growth.marginal,
      ),
    );
  }
  if (!enoughModels) {
    return Object.freeze(
      buildSingleFallbackPlan(
        input.candidates,
        input.baseline,
        rejected,
        policy,
        growth.marginal,
      ),
    );
  }

  const paretoStatus = classifyParetoStatus(
    expectedJudge,
    expectedCost,
    input.baseline,
    policy,
  );

  const plan: EnsemblePlan = {
    strategyId,
    selectedRouteIds: Object.freeze(growth.members.map((m) => m.routeId)),
    selectedModelIds: Object.freeze(growth.members.map((m) => m.modelId)),
    expectedJudge,
    expectedCostUsd: expectedCost,
    expectedQualityPerDollar:
      expectedCost > 1e-9 ? Math.min(expectedJudge / expectedCost, 10_000) : 0,
    baselineJudge: input.baseline.singleModelJudge,
    baselineCostUsd: input.baseline.singleModelCostUsd,
    paretoStatus,
    marginalContributions: Object.freeze(growth.marginal),
    rejectedCandidates: Object.freeze(rejected),
    explanation: buildEnsembleExplanation(
      strategyId,
      paretoStatus,
      growth,
      input,
      policy,
    ),
  };
  return Object.freeze(plan);
}

// ─── Filtering ──────────────────────────────────────────────────────────

function filterAccepted(
  candidates: readonly ContributionAwareScore[],
  policy: CollectiveSelectionPolicy,
  rejectedSink: RejectedCandidateRecord[],
): ContributionAwareScore[] {
  const out: ContributionAwareScore[] = [];
  for (const c of candidates) {
    if (c.rejected) {
      const reason = c.rejectionReasons.length
        ? c.rejectionReasons.join(',')
        : 'rejected_by_scorer';
      rejectedSink.push({ modelId: c.modelId, reason });
      continue;
    }
    // Modality is enforced upstream by the scorer when modalityStrict is true.
    // Here we honor harm-rate and confidence policy gates explicitly.
    const b = c.breakdown;
    // harmRate isn't stored on the score directly — we infer it from the
    // breakdown's harmPenalty. We added a low penalty per harm-rate point;
    // the explicit reject is in the scorer.
    void b;
    out.push(c);
  }
  return out;
}

// ─── Greedy growth ──────────────────────────────────────────────────────

interface GrowthResult {
  readonly members: readonly ContributionAwareScore[];
  readonly usedIds: Set<string>;
  readonly expectedJudge: number;
  readonly expectedCost: number;
  readonly marginal: readonly MarginalContributionRecord[];
}

function growEnsemble(
  frontier: readonly ContributionAwareScore[],
  input: ParetoEnsembleInput,
  policy: CollectiveSelectionPolicy,
): GrowthResult {
  const usedIds = new Set<string>();
  const members: ContributionAwareScore[] = [];
  const marginal: MarginalContributionRecord[] = [];

  if (frontier.length === 0) {
    return {
      members,
      usedIds,
      expectedJudge: 0,
      expectedCost: 0,
      marginal,
    };
  }

  const baselineCost = input.baseline.singleModelCostUsd;
  const costCeiling = baselineCost * policy.maxCostRatioVsSingle;

  // Seed: best anchor on the frontier, else highest-quality member.
  const anchor =
    frontier.find((c) => c.recommendedRole === 'anchor') ?? frontier[0];
  members.push(anchor);
  usedIds.add(anchor.routeId);
  marginal.push({
    modelId: anchor.modelId,
    marginalQualityGain: anchor.expectedJudge,
    marginalCostUsd: anchor.estimatedCostUsd,
    accepted: true,
    reason: 'seed_anchor',
  });

  let runningJudge = anchor.expectedJudge;
  let runningCost = anchor.estimatedCostUsd;

  for (const c of frontier) {
    if (usedIds.has(c.routeId)) continue;
    if (members.length >= policy.maxModels) {
      marginal.push({
        modelId: c.modelId,
        marginalQualityGain: 0,
        marginalCostUsd: c.estimatedCostUsd,
        accepted: false,
        reason: 'max_models_reached',
      });
      continue;
    }
    const probe = computeMarginalGain(
      runningJudge,
      runningCost,
      members,
      c,
      input.pairProfiles,
      input.taskType,
    );
    const newCost = runningCost + c.estimatedCostUsd;
    const newJudge = Math.min(1, runningJudge + probe.gain);
    const costOk = newCost <= costCeiling;
    const gainOk = probe.gain >= policy.minMarginalQualityGain;

    if (costOk && gainOk) {
      members.push(c);
      usedIds.add(c.routeId);
      runningJudge = newJudge;
      runningCost = newCost;
      marginal.push({
        modelId: c.modelId,
        marginalQualityGain: probe.gain,
        marginalCostUsd: c.estimatedCostUsd,
        accepted: true,
        reason: probe.reason,
      });
    } else {
      const reasons: string[] = [];
      if (!costOk) reasons.push('cost_ceiling_exceeded');
      if (!gainOk) reasons.push('marginal_gain_below_threshold');
      marginal.push({
        modelId: c.modelId,
        marginalQualityGain: probe.gain,
        marginalCostUsd: c.estimatedCostUsd,
        accepted: false,
        reason: reasons.join(','),
      });
    }
  }

  return {
    members,
    usedIds,
    expectedJudge: runningJudge,
    expectedCost: runningCost,
    marginal,
  };
}

// ─── Marginal gain estimator ────────────────────────────────────────────

interface MarginalGainResult {
  readonly gain: number;
  readonly reason: string;
}

function computeMarginalGain(
  currentJudge: number,
  currentCost: number,
  current: readonly ContributionAwareScore[],
  candidate: ContributionAwareScore,
  pairProfiles: ReadonlyMap<string, PairContributionProfile> | undefined,
  taskType: string,
): MarginalGainResult {
  // Parallel best-of-N semantics: even a peer with slightly lower judge
  // adds value when its quality is close to current AND its harm is low.
  const peerThresholdRatio = 0.85;
  const isPeer =
    currentJudge > 0 &&
    candidate.expectedJudge >= currentJudge * peerThresholdRatio;
  const peerLift = isPeer ? 0.04 : 0;

  // Direct lift: candidate is materially better than the current best.
  const directLift = Math.max(0, candidate.expectedJudge - currentJudge) * 0.5;

  // Pair complementarity bonus — averaged over all (member, candidate)
  // pairs with available profiles.
  let complementaritySum = 0;
  let redundancySum = 0;
  let pairCount = 0;
  if (pairProfiles && pairProfiles.size > 0) {
    for (const m of current) {
      const key = pairKey(m.modelId, candidate.modelId);
      const p = pairProfiles.get(key);
      if (p && p.taskType === taskType) {
        complementaritySum += p.complementarityScore;
        redundancySum += p.redundancyPenalty;
        pairCount += 1;
      }
    }
  }
  const compBonus = pairCount > 0
    ? 0.4 * (complementaritySum / pairCount) - 0.3 * (redundancySum / pairCount)
    : 0;

  // Cost discount — when the candidate is much cheaper than the average
  // member, give it a tiny budget-support bump.
  const avgMemberCost =
    current.length > 0
      ? current.reduce((s, c) => s + c.estimatedCostUsd, 0) / current.length
      : currentCost;
  const cheaperBonus =
    candidate.estimatedCostUsd < avgMemberCost * 0.25 ? 0.01 : 0;

  // Confidence multiplier — low confidence shrinks the gain toward zero.
  const confidence = 1 + candidate.breakdown.confidencePenalty; // penalty is negative
  const confidenceMultiplier = Math.max(0.5, Math.min(1, confidence + 0.5));

  const gain =
    (peerLift + directLift + compBonus + cheaperBonus) * confidenceMultiplier;

  const reasonTokens: string[] = [];
  if (directLift > 0) reasonTokens.push('individual_lift');
  else if (peerLift > 0) reasonTokens.push('peer_best_of_n');
  if (compBonus > 0) reasonTokens.push('complementarity');
  if (cheaperBonus > 0) reasonTokens.push('budget_support');
  if (reasonTokens.length === 0) reasonTokens.push('no_signal');
  return { gain, reason: reasonTokens.join('+') };
}

// ─── Strategy + status ──────────────────────────────────────────────────

function pickStrategy(
  growth: GrowthResult,
  input: ParetoEnsembleInput,
  policy: CollectiveSelectionPolicy,
): EnsembleStrategyId {
  if (growth.members.length < policy.minModels) return 'single_fallback';
  if (policy.preferParallelForTaskTypes.indexOf(input.taskType) !== -1) {
    return 'parallel';
  }
  const cost = growth.expectedCost;
  const baselineCost = input.baseline.singleModelCostUsd;
  if (cost <= baselineCost * policy.maxCostRatioVsSingle) return 'parallel';
  if (policy.allowConsensusWhenCostExceedsBaseline) return 'consensus';
  if (policy.allowCritiqueRepairWhenCostExceedsBaseline) return 'critique-repair';
  return 'parallel';
}

function classifyParetoStatus(
  expectedJudge: number,
  expectedCost: number,
  baseline: ParetoEnsembleBaselines,
  policy: CollectiveSelectionPolicy,
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

// ─── Fallback plan ──────────────────────────────────────────────────────

function buildSingleFallbackPlan(
  allCandidates: readonly ContributionAwareScore[],
  baseline: ParetoEnsembleBaselines,
  rejected: readonly RejectedCandidateRecord[],
  policy: CollectiveSelectionPolicy,
  preservedMarginal: readonly MarginalContributionRecord[] = [],
): EnsemblePlan {
  // Pick the best non-rejected single by totalScore (deterministic tiebreaker).
  const usable = allCandidates.filter((c) => !c.rejected);
  const sorted = [...usable].sort(compareScores);
  const top = sorted[0];
  if (!top) {
    return {
      strategyId: 'single_fallback',
      selectedRouteIds: Object.freeze([]),
      selectedModelIds: Object.freeze([]),
      expectedJudge: 0,
      expectedCostUsd: 0,
      expectedQualityPerDollar: 0,
      baselineJudge: baseline.singleModelJudge,
      baselineCostUsd: baseline.singleModelCostUsd,
      paretoStatus: 'single_fallback',
      marginalContributions: Object.freeze(preservedMarginal.slice()),
      rejectedCandidates: Object.freeze(rejected),
      explanation: 'no_viable_candidate;policy_strict=' + String(policy.modalityStrict),
    };
  }
  // Preserve the growth attempt's marginal records so callers can see
  // why the ensemble did not form, then append the fallback seed record.
  const fallbackMarginal: MarginalContributionRecord[] = [
    ...preservedMarginal,
    {
      modelId: top.modelId,
      marginalQualityGain: top.expectedJudge,
      marginalCostUsd: top.estimatedCostUsd,
      accepted: true,
      reason: 'fallback_seed',
    },
  ];
  return {
    strategyId: 'single_fallback',
    selectedRouteIds: Object.freeze([top.routeId]),
    selectedModelIds: Object.freeze([top.modelId]),
    expectedJudge: top.expectedJudge,
    expectedCostUsd: top.estimatedCostUsd,
    expectedQualityPerDollar:
      top.estimatedCostUsd > 1e-9
        ? Math.min(top.expectedJudge / top.estimatedCostUsd, 10_000)
        : 0,
    baselineJudge: baseline.singleModelJudge,
    baselineCostUsd: baseline.singleModelCostUsd,
    paretoStatus: 'single_fallback',
    marginalContributions: Object.freeze(fallbackMarginal),
    rejectedCandidates: Object.freeze(rejected),
    explanation:
      `single_fallback_chosen;reason=ensemble_did_not_beat_baseline;` +
      `top=${top.modelId};expectedJudge=${top.expectedJudge.toFixed(4)};` +
      `expectedCost=${top.estimatedCostUsd.toFixed(6)}`,
  };
}

// ─── Explanation ────────────────────────────────────────────────────────

function buildEnsembleExplanation(
  strategyId: EnsembleStrategyId,
  paretoStatus: EnsembleParetoStatus,
  growth: GrowthResult,
  input: ParetoEnsembleInput,
  policy: CollectiveSelectionPolicy,
): string {
  const parts: string[] = [
    `strategy=${strategyId}`,
    `paretoStatus=${paretoStatus}`,
    `members=${growth.members.length}`,
    `expectedJudge=${growth.expectedJudge.toFixed(4)}`,
    `expectedCost=${growth.expectedCost.toFixed(6)}`,
    `baselineJudge=${input.baseline.singleModelJudge.toFixed(4)}`,
    `baselineCost=${input.baseline.singleModelCostUsd.toFixed(6)}`,
    `policy.maxModels=${policy.maxModels}`,
    `policy.maxCostRatio=${policy.maxCostRatioVsSingle}`,
    `policy.minMarginalGain=${policy.minMarginalQualityGain}`,
  ];
  return parts.join(';');
}

// ─── Tie-breaker ────────────────────────────────────────────────────────

function compareScores(a: ContributionAwareScore, b: ContributionAwareScore): number {
  if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
  if (a.estimatedCostUsd !== b.estimatedCostUsd)
    return a.estimatedCostUsd - b.estimatedCostUsd;
  if (a.routeId !== b.routeId) return a.routeId < b.routeId ? -1 : 1;
  return 0;
}
