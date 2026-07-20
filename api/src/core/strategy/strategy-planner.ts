// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-planner.ts — MVP 5B
 *
 * Pure, offline strategy planner. Transforms a pre-ranked candidate
 * set + categorical context into a `StrategyPlan`.
 *
 * MVP 5B invariants (enforced by tests):
 *   - Pure function. No I/O. No DB. No provider. No TEI. No HNSW.
 *   - Deterministic — no Date.now, no Math.random.
 *   - Does NOT mutate input.
 *   - Does NOT match on model NAMES anywhere. Decisions use only
 *     `scoreBreakdown`, `totalScore`, optional routeKind, localPreference,
 *     costEfficiency, latencyScore + the categorical context.
 *   - Honors the Explicit Model Pin Invariant.
 *   - Honors `local_required`: NEVER plans a cloud route.
 *
 * Decision flow (first match returns; remaining considered for the
 * `rejectedStrategies` audit):
 *
 *   0. candidates empty                              → no_viable_strategy
 *   1. explicit pin                                  → single_best (pinned only)
 *   2. local_required & no local candidate          → no_viable_strategy
 *   3. extreme complexity + enough candidates       → critique_repair / expert_panel
 *   4. high risk + enough candidates                → consensus
 *   5. high latency sensitivity                     → single_best (fastest)
 *   6. high cost sensitivity + ≥ N candidates       → cost_cascade
 *   7. high complexity + high confidence needed     → quality_cascade
 *   8. local_preferred + competitive local          → local_first
 *   9. parallel_diverse (when canonicals diverse)   → parallel_diverse
 *  10. default                                       → single_best (top)
 */

import type { ModelScoreResult } from '../scoring/model-scorer';
import type {
  PlannerRouteMetadata,
  StrategyCostClass,
  StrategyKind,
  StrategyLatencyClass,
  StrategyPlan,
  StrategyPlannerInput,
  StrategyPlannerResult,
  StrategyPlanningContext,
  StrategyRejectionRecord,
} from './strategy-types';
import { resolveStrategyPolicy, type StrategyPolicy } from './strategy-policy';

// ─── Self-hosted classification (data, not logic) ───────────────────────

const SELF_HOSTED_KINDS: ReadonlySet<string> = new Set(['local', 'self_hosted']);

// ─── Helpers ────────────────────────────────────────────────────────────

interface PlanInternal {
  readonly strategy: StrategyKind;
  readonly selectedRouteIds: readonly string[];
  readonly fallbackRouteIds: readonly string[];
  readonly maxParallelism: number;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly constraintsApplied: readonly string[];
}

/**
 * Returns true when the candidate's route is local/self-hosted —
 * using `routesInfo` when supplied, else `breakdown.localPreference`
 * as a proxy (sufficient in `local_preferred` / `local_required`
 * modes, since the MVP 4 scorer populates that field exactly when
 * those modes apply).
 */
function isLocal(
  c: ModelScoreResult,
  routesInfo: ReadonlyMap<string, PlannerRouteMetadata> | undefined,
): boolean {
  const meta = routesInfo?.get(c.routeId);
  if (meta) return SELF_HOSTED_KINDS.has(meta.routeKind);
  return c.breakdown.localPreference === 1;
}

function distinctCanonicalCount(candidates: readonly ModelScoreResult[]): number {
  const s = new Set<string>();
  for (const c of candidates) s.add(c.canonicalModelId);
  return s.size;
}

function estimateCostClass(
  candidates: readonly ModelScoreResult[],
): StrategyCostClass {
  if (candidates.length === 0) return 'unknown';
  // Use the MAX costEfficiency among selected (higher efficiency → cheaper).
  let maxEff = 0;
  for (const c of candidates) {
    if (c.breakdown.costEfficiency > maxEff) maxEff = c.breakdown.costEfficiency;
  }
  if (maxEff >= 0.95) return 'free';
  if (maxEff >= 0.7) return 'low';
  if (maxEff >= 0.4) return 'mid';
  return 'high';
}

function estimateLatencyClass(
  candidates: readonly ModelScoreResult[],
): StrategyLatencyClass {
  if (candidates.length === 0) return 'unknown';
  let maxLatScore = 0;
  for (const c of candidates) {
    if (c.breakdown.latencyScore > maxLatScore) maxLatScore = c.breakdown.latencyScore;
  }
  if (maxLatScore >= 0.8) return 'low';
  if (maxLatScore >= 0.5) return 'mid';
  return 'high';
}

function pickTopByLatencyScore(
  candidates: readonly ModelScoreResult[],
): ModelScoreResult | undefined {
  if (candidates.length === 0) return undefined;
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (c.breakdown.latencyScore > best.breakdown.latencyScore) {
      best = c;
      continue;
    }
    // Tie-breaker: routeId asc for determinism.
    if (
      c.breakdown.latencyScore === best.breakdown.latencyScore &&
      c.routeId < best.routeId
    ) {
      best = c;
    }
  }
  return best;
}

function sortByCostEfficiencyDesc(
  candidates: readonly ModelScoreResult[],
): readonly ModelScoreResult[] {
  return [...candidates].sort((a, b) => {
    if (a.breakdown.costEfficiency !== b.breakdown.costEfficiency) {
      return b.breakdown.costEfficiency - a.breakdown.costEfficiency;
    }
    return a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0;
  });
}

function selectFirstDiverseCanonicals(
  candidates: readonly ModelScoreResult[],
  count: number,
): readonly ModelScoreResult[] {
  const seen = new Set<string>();
  const out: ModelScoreResult[] = [];
  for (const c of candidates) {
    if (seen.has(c.canonicalModelId)) continue;
    seen.add(c.canonicalModelId);
    out.push(c);
    if (out.length >= count) break;
  }
  return out;
}

// ─── Plan builders (return PlanInternal) ────────────────────────────────

function buildNoViable(reasons: readonly string[]): PlanInternal {
  return {
    strategy: 'no_viable_strategy',
    selectedRouteIds: [],
    fallbackRouteIds: [],
    maxParallelism: 0,
    confidence: 0,
    reasons,
    constraintsApplied: [],
  };
}

function buildSingleBest(
  c: ModelScoreResult,
  reasons: readonly string[],
  constraints: readonly string[],
  fallback: readonly string[] = [],
): PlanInternal {
  return {
    strategy: 'single_best',
    selectedRouteIds: [c.routeId],
    fallbackRouteIds: fallback,
    maxParallelism: 1,
    confidence: Math.min(1, Math.max(0, c.totalScore)),
    reasons,
    constraintsApplied: constraints,
  };
}

// ─── Main planner ───────────────────────────────────────────────────────

export function planStrategy(input: StrategyPlannerInput): StrategyPlannerResult {
  const policy = resolveStrategyPolicy(input.policy);
  const { context, candidates, routesInfo } = input;
  const rejected: StrategyRejectionRecord[] = [];

  // ─── 0. Empty candidates ─────────────────────────────────────────────
  if (candidates.length === 0) {
    return wrap(buildNoViable(['empty_candidates']), rejected, candidates);
  }

  // ─── 1. Explicit pin ─────────────────────────────────────────────────
  if (context.explicitModelPin) {
    const pin = context.explicitModelPin;
    const matching = candidates.filter((c) => candidateMatchesPin(c, pin));
    if (matching.length === 0) {
      return wrap(
        buildNoViable(['pin_set_but_no_candidate_matches']),
        rejected,
        candidates,
      );
    }
    const top = matching[0]; // candidates pre-sorted by retriever
    // policy.allowFallbackForExplicitPin: in MVP 5B we NEVER fall back
    // even when policy allows — future MVP introduces the substitution
    // layer. Record reason so the trace is honest.
    const fallback: readonly string[] = [];
    const reasons: string[] = ['explicit_pin_present'];
    if (policy.allowFallbackForExplicitPin) {
      reasons.push('policy_allows_fallback_but_mvp_5b_does_not_substitute');
    }
    return wrap(
      buildSingleBest(top, reasons, ['explicit_pin'], fallback),
      rejected,
      candidates,
    );
  }

  // ─── 2. local_required filter (defensive — retriever already filters) ─
  let pool: readonly ModelScoreResult[] = candidates;
  if (context.privacyMode === 'local_required') {
    const local = candidates.filter((c) => isLocal(c, routesInfo));
    if (local.length === 0) {
      return wrap(
        buildNoViable(['privacy_local_required_no_local_candidate']),
        rejected,
        candidates,
      );
    }
    pool = local;
  }

  // ─── 3. Extreme complexity → critique_repair / expert_panel ─────────
  if (context.complexity === 'extreme') {
    if (
      policy.allowCollectiveForHighRisk &&
      pool.length >= policy.minCandidatesForExpertPanel
    ) {
      const selected = pool.slice(0, policy.minCandidatesForExpertPanel);
      return wrap(
        {
          strategy: 'expert_panel',
          selectedRouteIds: selected.map((c) => c.routeId),
          fallbackRouteIds: pool.slice(selected.length).map((c) => c.routeId),
          maxParallelism: Math.min(selected.length, policy.maxParallelismDefault),
          confidence: averageScore(selected),
          reasons: ['extreme_complexity_expert_panel'],
          constraintsApplied: ['complexity_extreme'],
        },
        rejected,
        candidates,
      );
    }
    if (pool.length >= 2) {
      const selected = pool.slice(0, 2);
      rejected.push({ strategy: 'expert_panel', reason: 'insufficient_candidates_for_expert_panel' });
      return wrap(
        {
          strategy: 'critique_repair',
          selectedRouteIds: selected.map((c) => c.routeId),
          fallbackRouteIds: pool.slice(2).map((c) => c.routeId),
          maxParallelism: 2,
          confidence: averageScore(selected),
          reasons: ['extreme_complexity_critique_repair'],
          constraintsApplied: ['complexity_extreme'],
        },
        rejected,
        candidates,
      );
    }
    rejected.push({
      strategy: 'critique_repair',
      reason: 'insufficient_candidates_for_critique_repair',
    });
    // fall through to default
  }

  // ─── 4. High risk → consensus ────────────────────────────────────────
  if (context.riskLevel === 'high' && policy.allowCollectiveForHighRisk) {
    if (pool.length >= policy.minCandidatesForConsensus) {
      const selected = pool.slice(0, policy.minCandidatesForConsensus);
      return wrap(
        {
          strategy: 'consensus',
          selectedRouteIds: selected.map((c) => c.routeId),
          fallbackRouteIds: pool.slice(selected.length).map((c) => c.routeId),
          maxParallelism: Math.min(selected.length, policy.maxParallelismDefault),
          confidence: averageScore(selected),
          reasons: ['high_risk_consensus'],
          constraintsApplied: ['risk_high'],
        },
        rejected,
        candidates,
      );
    }
    rejected.push({
      strategy: 'consensus',
      reason: 'insufficient_candidates_for_consensus',
    });
  }

  // ─── 5. High latency sensitivity → fastest single ────────────────────
  if (context.latencySensitivity === 'high') {
    const fastest = pickTopByLatencyScore(pool);
    if (fastest) {
      return wrap(
        buildSingleBest(
          fastest,
          ['high_latency_sensitivity_fastest_single'],
          ['latency_sensitivity_high'],
          pool.filter((c) => c.routeId !== fastest.routeId).map((c) => c.routeId),
        ),
        rejected,
        candidates,
      );
    }
  }

  // ─── 6. High cost sensitivity → cost_cascade ─────────────────────────
  if (
    context.costSensitivity === 'high' &&
    pool.length >= policy.costCascadeMinCandidates
  ) {
    const sortedByCost = sortByCostEfficiencyDesc(pool);
    return wrap(
      {
        strategy: 'cost_cascade',
        selectedRouteIds: sortedByCost.slice(0, 1).map((c) => c.routeId),
        fallbackRouteIds: sortedByCost.slice(1).map((c) => c.routeId),
        maxParallelism: 1,
        confidence: clamp01(sortedByCost[0].totalScore),
        reasons: ['high_cost_sensitivity_cost_cascade'],
        constraintsApplied: ['cost_sensitivity_high'],
      },
      rejected,
      candidates,
    );
  }
  if (context.costSensitivity === 'high') {
    rejected.push({ strategy: 'cost_cascade', reason: 'insufficient_candidates_for_cost_cascade' });
  }

  // ─── 7. High complexity + high confidence → quality_cascade ──────────
  if (
    context.complexity === 'high' &&
    context.confidenceNeeded > 0.8 &&
    pool.length >= policy.qualityCascadeMinCandidates
  ) {
    const selected = pool.slice(0, 1);
    return wrap(
      {
        strategy: 'quality_cascade',
        selectedRouteIds: selected.map((c) => c.routeId),
        fallbackRouteIds: pool.slice(1).map((c) => c.routeId),
        maxParallelism: 1,
        confidence: clamp01(selected[0].totalScore),
        reasons: ['high_complexity_high_confidence_quality_cascade'],
        constraintsApplied: ['complexity_high', 'confidence_high'],
      },
      rejected,
      candidates,
    );
  }

  // ─── 8. local_preferred + competitive local → local_first ───────────
  if (context.privacyMode === 'local_preferred') {
    const locals = pool.filter((c) => isLocal(c, routesInfo));
    if (locals.length > 0) {
      const topLocal = locals[0];
      const topAny = pool[0];
      if (topAny.totalScore > 0 && topLocal.totalScore / topAny.totalScore >= policy.localFirstScoreRatio) {
        return wrap(
          {
            strategy: 'local_first',
            selectedRouteIds: [topLocal.routeId],
            fallbackRouteIds: pool
              .filter((c) => c.routeId !== topLocal.routeId)
              .map((c) => c.routeId),
            maxParallelism: 1,
            confidence: clamp01(topLocal.totalScore),
            reasons: ['local_preferred_with_competitive_local'],
            constraintsApplied: ['privacy_local_preferred'],
          },
          rejected,
          candidates,
        );
      }
      rejected.push({
        strategy: 'local_first',
        reason: 'local_score_below_competitive_ratio',
      });
    } else {
      rejected.push({ strategy: 'local_first', reason: 'no_local_candidates' });
    }
  }

  // ─── 9. parallel_diverse (diverse canonicals at medium/high risk) ────
  if (
    (context.riskLevel === 'medium' || context.riskLevel === 'high') &&
    distinctCanonicalCount(pool) >= policy.parallelDiverseMinCanonicals
  ) {
    const selected = selectFirstDiverseCanonicals(pool, policy.parallelDiverseMinCanonicals);
    return wrap(
      {
        strategy: 'parallel_diverse',
        selectedRouteIds: selected.map((c) => c.routeId),
        fallbackRouteIds: pool
          .filter((p) => !selected.some((s) => s.routeId === p.routeId))
          .map((p) => p.routeId),
        maxParallelism: Math.min(selected.length, policy.maxParallelismDefault),
        confidence: averageScore(selected),
        reasons: ['diverse_canonicals_parallel_diverse'],
        constraintsApplied: ['risk_medium_or_high'],
      },
      rejected,
      candidates,
    );
  }

  // ─── 10. Default → single_best ──────────────────────────────────────
  return wrap(
    buildSingleBest(
      pool[0],
      ['default_single_best'],
      [],
      pool.slice(1).map((c) => c.routeId),
    ),
    rejected,
    candidates,
  );
}

// ─── Plan ↔ Result wrapping ─────────────────────────────────────────────

function wrap(
  internal: PlanInternal,
  rejected: readonly StrategyRejectionRecord[],
  allCandidates: readonly ModelScoreResult[],
): StrategyPlannerResult {
  // estimate cost/latency from the SELECTED routes (not all candidates).
  const selectedSet = new Set(internal.selectedRouteIds);
  const selectedCandidates = allCandidates.filter((c) => selectedSet.has(c.routeId));

  const plan: StrategyPlan = {
    strategy: internal.strategy,
    selectedRouteIds: Object.freeze([...internal.selectedRouteIds]),
    fallbackRouteIds: Object.freeze([...internal.fallbackRouteIds]),
    maxParallelism: internal.maxParallelism,
    estimatedCostClass: estimateCostClass(selectedCandidates),
    estimatedLatencyClass: estimateLatencyClass(selectedCandidates),
    confidence: clamp01(internal.confidence),
    reasons: Object.freeze([...internal.reasons]),
    constraintsApplied: Object.freeze([...internal.constraintsApplied]),
  };

  return {
    plan,
    rejectedStrategies: Object.freeze([...rejected]),
  };
}

// ─── Misc helpers ───────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function averageScore(arr: readonly ModelScoreResult[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const c of arr) s += c.totalScore;
  return clamp01(s / arr.length);
}

function candidateMatchesPin(
  c: ModelScoreResult,
  pin: NonNullable<StrategyPlanningContext['explicitModelPin']>,
): boolean {
  if (pin.routeId) return c.routeId === pin.routeId;
  if (pin.offeringId) return c.offeringId === pin.offeringId;
  if (pin.canonicalModelId) return c.canonicalModelId === pin.canonicalModelId;
  return true;
}

// Re-export resolveStrategyPolicy for tests/admin callers.
export { resolveStrategyPolicy };
export type { StrategyPolicy };
