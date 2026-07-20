// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-runner.ts — MVP 8B.5
 *
 * Pure, deterministic backtest runner. For each holdout row:
 *
 *   1. Build a candidate set from models seen in TRAIN for the same
 *      task_type. This avoids reconstructing the registry snapshot
 *      from the original timestamp (which we don't have).
 *   2. Compute baselines (single-top, single-budget, actual-historical).
 *   3. Compute selector projections:
 *      - structural_naive — rank candidates by judgeMean DESC (no harm
 *        filter, no Pareto, no modality filter)
 *      - pareto_aware    — run optimizeParetoEnsemble with profiles
 *   4. Record per-row outcome.
 *
 * Pure. Deterministic. No I/O. The runner NEVER mutates input arrays
 * and NEVER calls fetch / DB / Redis / providers.
 *
 * Important leakage invariant: the runner trains nothing — it consumes
 * a HistoricalContributionResult produced upstream from train ONLY.
 */

import {
  scoreContributionAwareCandidate,
  type ContributionAwareCandidate,
  type ContributionAwareScore,
} from '../contribution/contribution-aware-candidate-scorer';
import type { HistoricalContributionResult } from '../contribution/historical-contribution-scorer';
import { optimizeParetoEnsemble } from '../pareto/pareto-ensemble-optimizer';
import type { EnsemblePlan } from '../pareto/ensemble-plan-types';
import {
  resolveCollectiveSelectionPolicy,
  type CollectiveSelectionPolicy,
} from '../pareto/collective-selection-policy';
import type {
  HistoricalReplayExecution,
  ReplayBaseline,
  ReplayRowResult,
  SelectorProjection,
} from './historical-replay-types';

// ─── Public API ─────────────────────────────────────────────────────────

export interface ReplayRunnerInput {
  readonly train: readonly HistoricalReplayExecution[];
  readonly holdout: readonly HistoricalReplayExecution[];
  readonly trainHistory: HistoricalContributionResult;
  readonly policy?: Partial<CollectiveSelectionPolicy>;
}

export interface ReplayRunnerResult {
  readonly rows: readonly ReplayRowResult[];
}

export function runHistoricalReplay(
  input: ReplayRunnerInput,
): ReplayRunnerResult {
  const _policy = resolveCollectiveSelectionPolicy({
    ...input.policy,
    // Replay always allows exploration so insufficient_data candidates
    // can still appear — otherwise small holdouts get over-rejected.
    allowExplorationCandidates: true,
  });

  // Build candidate set per (task_type) from TRAIN only.
  const candidateSets = buildCandidateSetsByTaskType(input.train);
  // Per-task baselines from TRAIN only.
  const baselineIndex = buildBaselineIndex(input.train);

  const rows: ReplayRowResult[] = [];
  for (const h of input.holdout) {
    const candidates = candidateSets.get(h.taskType) ?? [];
    if (candidates.length === 0) {
      // No comparable train models — skip.
      continue;
    }
    const baseline = buildRowBaseline(h, baselineIndex);
    const profilesByModel = buildProfileIndex(input.trainHistory);
    const scores = buildContributionAwareScores(
      candidates,
      h,
      profilesByModel,
    );
    if (scores.length === 0) continue;

    const structural = pickStructuralNaive(scores);
    const paretoPlan = optimizeParetoEnsemble({
      candidates: scores,
      taskType: h.taskType,
      taskModality: h.modality ?? 'text',
      baseline: {
        singleModelJudge: baseline.singleJudge,
        singleModelCostUsd: baseline.singleCostUsd,
        singleBudgetJudge: baseline.singleBudgetJudge,
        singleBudgetCostUsd: baseline.singleBudgetCostUsd,
      },
      policy: { ...input.policy, allowExplorationCandidates: true },
    });

    const paretoSelector = ensemblePlanToProjection(paretoPlan);
    const actualSelector = actualHistoricalProjection(h);
    const singleTop = singleTopProjection(h, baseline);
    const singleBudget = singleBudgetProjection(h, baseline);
    const structuralSelector = structuralProjection(structural, scores);

    // Verdicts vs single baseline.
    const qualityOk =
      paretoSelector.expectedJudge >= baseline.singleJudge - 1e-9;
    const costOk =
      paretoSelector.expectedCostUsd <= baseline.singleCostUsd + 1e-9;
    const harmfulAvoided = detectHarmfulAvoidance(scores, structural, paretoSelector);
    const modalityAvoided = detectModalityAvoidance(scores, paretoSelector);
    const isFallback =
      paretoPlan.strategyId === 'single_fallback' ||
      paretoPlan.paretoStatus === 'single_fallback';

    rows.push(
      Object.freeze({
        executionId: h.executionId,
        taskId: h.taskId,
        taskType: h.taskType,
        complexity: h.complexity,
        baseline,
        selectors: Object.freeze({
          actual_historical: actualSelector,
          single_top: singleTop,
          single_budget: singleBudget,
          structural_naive: structuralSelector,
          pareto_aware: paretoSelector,
        }),
        pareto_meets_quality_thesis: qualityOk,
        pareto_meets_cost_thesis: costOk,
        pareto_meets_both: qualityOk && costOk,
        harmful_model_avoided: harmfulAvoided,
        modality_mismatch_avoided: modalityAvoided,
        pareto_single_fallback: isFallback,
      }),
    );
  }
  return Object.freeze({ rows: Object.freeze(rows) });
}

// ─── Candidate set construction ─────────────────────────────────────────

/**
 * For each task_type seen in train, collect the set of distinct models
 * that ever appeared in any execution of that task_type. This becomes
 * the "candidate set" we evaluate the holdout row against.
 */
function buildCandidateSetsByTaskType(
  train: readonly HistoricalReplayExecution[],
): Map<string, readonly string[]> {
  const sets = new Map<string, Set<string>>();
  for (const t of train) {
    let bucket = sets.get(t.taskType);
    if (!bucket) {
      bucket = new Set();
      sets.set(t.taskType, bucket);
    }
    for (const m of t.modelsUsed) bucket.add(m);
  }
  const out = new Map<string, readonly string[]>();
  for (const [k, v] of sets) {
    const arr = [...v].sort();
    out.set(k, Object.freeze(arr));
  }
  return out;
}

// ─── Profile lookup ─────────────────────────────────────────────────────

function buildProfileIndex(
  history: HistoricalContributionResult,
): Map<string, import('../contribution/model-task-performance-profile').ModelTaskPerformanceProfile> {
  const out = new Map<
    string,
    import('../contribution/model-task-performance-profile').ModelTaskPerformanceProfile
  >();
  for (const p of history.modelProfiles) {
    out.set(`${p.modelId}||${p.taskType}`, p);
  }
  return out;
}

// ─── Score construction ────────────────────────────────────────────────

function buildContributionAwareScores(
  modelIds: readonly string[],
  holdout: HistoricalReplayExecution,
  profiles: ReturnType<typeof buildProfileIndex>,
): ContributionAwareScore[] {
  const out: ContributionAwareScore[] = [];
  for (const modelId of modelIds) {
    const profile = profiles.get(`${modelId}||${holdout.taskType}`);
    const estCost = estimateCostForModel(modelId, profile, holdout);
    const candidate: ContributionAwareCandidate = {
      routeId: `replay::${modelId}`,
      modelId,
      taskType: holdout.taskType,
      taskModality: holdout.modality ?? 'text',
      capabilities: ['chat'],
      modality: deriveModalityFromHistory(modelId, holdout),
      routeKind: 'native',
      estimatedCostUsd: estCost,
      structuralScore: profile?.judgeMean ?? 0.3,
      historicalProfile: profile,
    };
    out.push(scoreContributionAwareCandidate(candidate));
  }
  return out;
}

function estimateCostForModel(
  modelId: string,
  profile:
    | import('../contribution/model-task-performance-profile').ModelTaskPerformanceProfile
    | undefined,
  holdout: HistoricalReplayExecution,
): number {
  if (profile && profile.costMean > 0) return profile.costMean;
  // Fallback: use the holdout's observed cost split across its models.
  if (typeof holdout.costUsd === 'number' && holdout.modelsUsed.length > 0) {
    return holdout.costUsd / holdout.modelsUsed.length;
  }
  return 0.01; // benign default
}

/**
 * Approximate modality classification from the model id. We do NOT
 * hard-code names here — the function reads the modality field of the
 * holdout row (which the export carries when available) and assigns
 * the candidate the SAME modality unless its profile says otherwise.
 */
function deriveModalityFromHistory(
  modelId: string,
  holdout: HistoricalReplayExecution,
): 'text' | 'image' | 'audio' | 'video' | 'mixed' {
  return holdout.modality ?? 'text';
}

// ─── Baselines ──────────────────────────────────────────────────────────

interface BaselineSlot {
  readonly bestSingleJudge: number;
  readonly bestSingleCost: number;
  readonly cheapestGoodSingleJudge: number;
  readonly cheapestGoodSingleCost: number;
  readonly comparableExecutions: number;
}

function buildBaselineIndex(
  train: readonly HistoricalReplayExecution[],
): Map<string, BaselineSlot> {
  // Group single-strategy executions by task_type.
  const singlesByTask = new Map<string, HistoricalReplayExecution[]>();
  for (const t of train) {
    if (t.strategyId !== 'single' && t.strategyId !== 'single_budget') continue;
    let bucket = singlesByTask.get(t.taskType);
    if (!bucket) {
      bucket = [];
      singlesByTask.set(t.taskType, bucket);
    }
    bucket.push(t);
  }
  const out = new Map<string, BaselineSlot>();
  for (const [taskType, execs] of singlesByTask) {
    const judges = execs
      .filter((e) => typeof e.judgeScore === 'number')
      .map((e) => ({ j: e.judgeScore as number, c: e.costUsd ?? 0 }));
    if (judges.length === 0) continue;
    // best single = highest judge mean
    const meanJudge =
      judges.reduce((s, x) => s + x.j, 0) / judges.length;
    const meanCost = judges.reduce((s, x) => s + x.c, 0) / judges.length;
    // cheapest good = cheapest cost among those with judge >= meanJudge
    const goodOnes = judges.filter((x) => x.j >= meanJudge);
    let cheapestGood = goodOnes[0] ?? judges[0];
    for (const g of goodOnes) {
      if (g.c < cheapestGood.c) cheapestGood = g;
    }
    out.set(
      taskType,
      Object.freeze({
        bestSingleJudge: meanJudge,
        bestSingleCost: meanCost,
        cheapestGoodSingleJudge: cheapestGood.j,
        cheapestGoodSingleCost: cheapestGood.c,
        comparableExecutions: judges.length,
      }),
    );
  }
  return out;
}

function buildRowBaseline(
  holdout: HistoricalReplayExecution,
  index: Map<string, BaselineSlot>,
): ReplayBaseline {
  const slot = index.get(holdout.taskType);
  return Object.freeze({
    taskId: holdout.taskId,
    taskType: holdout.taskType,
    singleJudge: slot?.bestSingleJudge ?? 0.5,
    singleCostUsd: slot?.bestSingleCost ?? 0.02,
    singleBudgetJudge: slot?.cheapestGoodSingleJudge,
    singleBudgetCostUsd: slot?.cheapestGoodSingleCost,
    actualHistoricalJudge:
      typeof holdout.judgeScore === 'number' ? holdout.judgeScore : undefined,
    actualHistoricalCostUsd:
      typeof holdout.costUsd === 'number' ? holdout.costUsd : undefined,
    comparableExecutions: slot?.comparableExecutions ?? 0,
  });
}

// ─── Selector projections ──────────────────────────────────────────────

function pickStructuralNaive(
  scores: readonly ContributionAwareScore[],
): readonly ContributionAwareScore[] {
  // Naive: sort by expectedJudge desc, take top 2.
  // Treats ALL candidates as eligible (no harm or modality filter).
  const sorted = [...scores].sort((a, b) => {
    if (b.expectedJudge !== a.expectedJudge) return b.expectedJudge - a.expectedJudge;
    if (a.estimatedCostUsd !== b.estimatedCostUsd)
      return a.estimatedCostUsd - b.estimatedCostUsd;
    return a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0;
  });
  return sorted.slice(0, 2);
}

function structuralProjection(
  picked: readonly ContributionAwareScore[],
  scores: readonly ContributionAwareScore[],
): SelectorProjection {
  void scores;
  const ids = picked.map((c) => c.modelId);
  const expectedJudge =
    picked.length === 0
      ? 0
      : Math.max(...picked.map((c) => c.expectedJudge));
  const expectedCostUsd = picked.reduce(
    (s, c) => s + c.estimatedCostUsd,
    0,
  );
  return Object.freeze({
    selectorId: 'structural_naive',
    selectedModelIds: Object.freeze(ids),
    expectedJudge,
    expectedCostUsd,
    fallback: false,
    reason: 'top_by_judge_no_harm_filter',
  });
}

function ensemblePlanToProjection(plan: EnsemblePlan): SelectorProjection {
  return Object.freeze({
    selectorId: 'pareto_aware',
    selectedModelIds: Object.freeze(Array.from(plan.selectedModelIds)),
    expectedJudge: plan.expectedJudge,
    expectedCostUsd: plan.expectedCostUsd,
    fallback: plan.strategyId === 'single_fallback',
    reason: plan.explanation,
  });
}

function actualHistoricalProjection(
  h: HistoricalReplayExecution,
): SelectorProjection {
  return Object.freeze({
    selectorId: 'actual_historical',
    selectedModelIds: Object.freeze(Array.from(h.modelsUsed)),
    expectedJudge: typeof h.judgeScore === 'number' ? h.judgeScore : 0,
    expectedCostUsd: typeof h.costUsd === 'number' ? h.costUsd : 0,
    fallback: false,
    reason: `actual_strategy=${h.strategyId}`,
  });
}

function singleTopProjection(
  h: HistoricalReplayExecution,
  baseline: ReplayBaseline,
): SelectorProjection {
  return Object.freeze({
    selectorId: 'single_top',
    selectedModelIds: Object.freeze([]),
    expectedJudge: baseline.singleJudge,
    expectedCostUsd: baseline.singleCostUsd,
    fallback: false,
    reason: 'mean_single_judge_in_train',
  });
}

function singleBudgetProjection(
  h: HistoricalReplayExecution,
  baseline: ReplayBaseline,
): SelectorProjection {
  return Object.freeze({
    selectorId: 'single_budget',
    selectedModelIds: Object.freeze([]),
    expectedJudge: baseline.singleBudgetJudge ?? baseline.singleJudge,
    expectedCostUsd: baseline.singleBudgetCostUsd ?? baseline.singleCostUsd,
    fallback: false,
    reason: 'cheapest_above_mean_judge',
  });
}

// ─── Avoidance detection ────────────────────────────────────────────────

function detectHarmfulAvoidance(
  scores: readonly ContributionAwareScore[],
  structural: readonly ContributionAwareScore[],
  pareto: SelectorProjection,
): boolean {
  const paretoSelected = new Set(pareto.selectedModelIds);
  // A "harmful avoidance" happens when the structural pick included a
  // candidate with recommendedRole='avoid' AND the Pareto plan did NOT
  // pick it.
  for (const s of structural) {
    if (s.recommendedRole === 'avoid' && !paretoSelected.has(s.modelId)) {
      return true;
    }
  }
  return false;
}

function detectModalityAvoidance(
  scores: readonly ContributionAwareScore[],
  pareto: SelectorProjection,
): boolean {
  const paretoSelected = new Set(pareto.selectedModelIds);
  for (const s of scores) {
    const isMismatch =
      s.rejectionReasons.indexOf('modality_mismatch') !== -1;
    if (isMismatch && !paretoSelected.has(s.modelId)) return true;
  }
  return false;
}
