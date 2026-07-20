// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-routing-pipeline-composer.ts — MVP 8B
 *
 * Offline pipeline that wires:
 *
 *   TaskProfiler
 *   → CandidateRetriever (MVP 5A structural)
 *   → ContributionAwareRetriever (MVP 8B)
 *   → ParetoEnsembleOptimizer (MVP 8A)
 *   → StrategyPlanner (MVP 5B — original)
 *   → ParetoStrategyPlannerAdapter (MVP 8B)
 *   → RoutingDecisionTrace (MVP 3 + paretoSummary)
 *
 * Pure. No fetch, no DB, no Redis, no TEI, no HNSW, no provider call.
 * Deterministic. Never mutates input. Honours explicit pin invariant
 * and local_required via the downstream layers.
 */

import type { ExplicitPinInfo, PrivacyMode, RouteKind } from '../registry/types';
import type { RuntimeModelRegistry } from '../registry/runtime-model-registry';
import type { CandidateRetrievalResult } from '../retrieval/candidate-retrieval-types';
import { retrieveCandidates } from '../retrieval/candidate-retriever';
import {
  rescoreCandidates,
  type ContributionAwareRetrieverResult,
} from '../retrieval/contribution-aware-retriever';
import {
  resolveCollectiveSelectionPolicy,
  type CollectiveSelectionPolicy,
} from '../pareto/collective-selection-policy';
import type {
  EnsemblePlan,
  ParetoEnsembleBaselines,
} from '../pareto/ensemble-plan-types';
import { optimizeParetoEnsemble } from '../pareto/pareto-ensemble-optimizer';
import { planStrategy } from '../strategy/strategy-planner';
import {
  adaptStrategyPlan,
  type ParetoStrategyPlannerResult,
} from '../strategy/pareto-strategy-planner-adapter';
import type { Sensitivity } from '../scoring/scoring-policy';
import type {
  PlannerRouteMetadata,
  StrategyComplexity,
  StrategyPlannerInput,
  StrategyPlanningContext,
  StrategyRiskLevel,
  StrategySensitivity,
} from '../strategy/strategy-types';
import { profileTask } from '../task-profile/task-profiler';
import type {
  TaskProfile,
  TaskProfilerInput,
} from '../task-profile/task-profile-types';
import type { HistoricalContributionResult } from '../contribution/historical-contribution-scorer';
import type {
  RoutingDecisionTrace,
  ParetoTraceSummary,
} from '../routing/routing-decision-trace';
import { redactRoutingTrace } from '../routing/routing-redaction';

// ─── Input / output ─────────────────────────────────────────────────────

export interface ParetoRoutingPipelineInput {
  readonly requestId: string;
  readonly profilerInput: TaskProfilerInput;
  readonly registry: RuntimeModelRegistry;
  readonly historicalContributionResult: HistoricalContributionResult;
  readonly baseline: ParetoEnsembleBaselines;
  readonly policy?: Partial<CollectiveSelectionPolicy>;
  readonly explicitModelPin?: ExplicitPinInfo | null;
  readonly nowIso?: string;
  readonly traceId?: string;
}

export interface ParetoRoutingPipelineResult {
  readonly taskProfile: TaskProfile;
  readonly structuralRetrievalResult: CandidateRetrievalResult;
  readonly contributionResult: ContributionAwareRetrieverResult;
  readonly paretoPlan: EnsemblePlan;
  readonly strategyAdapterResult: ParetoStrategyPlannerResult;
  readonly trace: RoutingDecisionTrace;
}

const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const DEFAULT_TRACE_ID = 'trace-pareto-mvp8b';

// ─── Main entry ─────────────────────────────────────────────────────────

export function composeParetoRoutingPipeline(
  input: ParetoRoutingPipelineInput,
): ParetoRoutingPipelineResult {
  const _policy = resolveCollectiveSelectionPolicy(input.policy);
  const pin: ExplicitPinInfo | null = input.explicitModelPin ?? null;
  const timestamp = input.nowIso ?? DEFAULT_TIMESTAMP;
  const traceId = input.traceId ?? DEFAULT_TRACE_ID;

  // 1. Profile.
  const { profile } = profileTask(input.profilerInput);

  // 2. Structural retrieval.
  const structural = retrieveCandidates(
    {
      requiredCapabilities: Array.from(profile.requiredCapabilities),
      desiredCapabilities: Array.from(profile.desiredCapabilities),
      minContextWindow: profile.contextRequirementTokens,
      privacyMode: profile.privacyMode,
      costSensitivity: profile.costSensitivity,
      latencySensitivity: deriveLatencySensitivity(profile),
      explicitModelPin: pin,
    },
    { registry: input.registry },
  );

  // 3. Contribution-aware re-scoring.
  const contribution = rescoreCandidates(
    {
      structuralCandidates: structural.candidates,
      taskProfile: profile,
      historicalContributionResult: input.historicalContributionResult,
      policy: input.policy,
    },
    { registry: input.registry },
  );

  // 4. Pareto ensemble optimisation.
  const taskModality = pickTaskModality(profile);
  const paretoPlan = optimizeParetoEnsemble({
    candidates: contribution.contributionScores,
    taskType: profile.taskType,
    taskModality,
    baseline: input.baseline,
    policy: input.policy,
  });

  // 5. Original strategy plan (for side-by-side comparison).
  const plannerCtx = profileToPlannerContext(profile, pin);
  const routesInfo = buildRoutesInfo(
    input.registry,
    contribution.contributionScores.map((c) => c.routeId),
  );
  const plannerInput: StrategyPlannerInput = {
    candidates: contribution.contributionScores.map((s) =>
      contributionScoreAsModelScoreLike(s),
    ),
    context: plannerCtx,
    routesInfo,
  };
  const originalStrategy = planStrategy(plannerInput);

  // 6. Adapter decides which plan wins.
  const adapter = adaptStrategyPlan({
    originalStrategyResult: originalStrategy,
    contributionResult: contribution,
    paretoPlan,
    taskProfile: profile,
    explicitModelPin: pin,
    policy: input.policy,
  });

  // 7. Build trace.
  const summary: ParetoTraceSummary = buildParetoTraceSummary({
    paretoPlan,
    contributionResult: contribution,
    originalStrategy,
    adapter,
  });
  const rawTrace: RoutingDecisionTrace = {
    traceId,
    requestId: input.requestId,
    timestamp,
    routingMode: 'shadow_structural_full',
    taskProfile: {
      taskType: profile.taskType,
      complexity: profile.complexity,
      modalities: Array.from(profile.modalities),
      riskLevel: profile.riskLevel,
      privacyMode: profile.privacyMode,
    },
    semanticIndexBackend: 'none',
    candidatesEvaluated: contribution.contributionScores.length,
    candidatesByStage: { ...structural.countsByStage },
    rejectedByStage: structural.rejectedByStage.map((r) => ({
      routeId: r.routeId,
      stage: r.stage,
      reason: r.reason,
    })),
    selectedCanonicalModelId: null,
    selectedOfferingId: null,
    selectedRouteId:
      adapter.finalOfflinePlan.selectedRouteIds.length > 0
        ? adapter.finalOfflinePlan.selectedRouteIds[0]
        : null,
    scoreBreakdown: {},
    strategyPlan: {
      strategy: adapter.finalOfflinePlan.strategy,
      routes: Array.from(adapter.finalOfflinePlan.selectedRouteIds),
    },
    explicitModelPin: pin,
    pinSubstitution: null,
    latencyByPhase: {},
    paretoSummary: summary,
  };
  // Redaction strips PII anywhere and validates paretoSummary fields.
  const trace = redactRoutingTrace(rawTrace);

  return Object.freeze({
    taskProfile: profile,
    structuralRetrievalResult: structural,
    contributionResult: contribution,
    paretoPlan,
    strategyAdapterResult: adapter,
    trace,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

function deriveLatencySensitivity(profile: TaskProfile): Sensitivity {
  if (typeof profile.latencyBudgetMs === 'number') {
    if (profile.latencyBudgetMs < 2_000) return 'high';
    if (profile.latencyBudgetMs < 10_000) return 'medium';
  }
  return 'low';
}

function pickTaskModality(
  profile: TaskProfile,
): 'text' | 'image' | 'audio' | 'video' | 'mixed' {
  const ms = profile.modalities;
  if (ms.indexOf('image') !== -1) return 'image';
  if (ms.indexOf('audio') !== -1) return 'audio';
  if (ms.indexOf('video') !== -1) return 'video';
  return 'text';
}

function complexityToStrategy(c: TaskProfile['complexity']): StrategyComplexity {
  return c;
}
function riskToStrategy(r: TaskProfile['riskLevel']): StrategyRiskLevel {
  return r;
}
function sensitivityToStrategy(
  s: TaskProfile['costSensitivity'],
): StrategySensitivity {
  return s;
}

function profileToPlannerContext(
  profile: TaskProfile,
  pin: ExplicitPinInfo | null,
): StrategyPlanningContext {
  return {
    taskType: profile.taskType,
    complexity: complexityToStrategy(profile.complexity),
    riskLevel: riskToStrategy(profile.riskLevel),
    privacyMode: profile.privacyMode as PrivacyMode,
    costSensitivity: sensitivityToStrategy(profile.costSensitivity),
    latencySensitivity: deriveLatencySensitivity(profile),
    confidenceNeeded: profile.confidenceNeeded,
    explicitModelPin: pin,
  };
}

function buildRoutesInfo(
  registry: RuntimeModelRegistry,
  routeIds: readonly string[],
): ReadonlyMap<string, PlannerRouteMetadata> {
  const out = new Map<string, PlannerRouteMetadata>();
  for (const id of routeIds) {
    const r = registry.lookupRoute(id);
    if (r) out.set(id, { routeId: r.routeId, routeKind: r.routeKind as RouteKind });
  }
  return out;
}

/**
 * Adapts a `ContributionAwareScore` to the shape `planStrategy` expects.
 * The original `ModelScoreResult` shape requires a `breakdown` and
 * `freshnessStatus`. We reuse the contribution breakdown and a sentinel
 * freshness status because the planner uses only `totalScore`, breakdown
 * subfields and (optionally) routesInfo for its decisions.
 */
function contributionScoreAsModelScoreLike(s: {
  readonly routeId: string;
  readonly modelId: string;
  readonly totalScore: number;
  readonly breakdown: import('../contribution/contribution-aware-candidate-scorer').ContributionAwareBreakdown;
  readonly rejected: boolean;
  readonly rejectionReasons: readonly string[];
  readonly estimatedCostUsd: number;
}): import('../scoring/model-scorer').ModelScoreResult {
  return {
    routeId: s.routeId,
    canonicalModelId: s.modelId,
    offeringId: s.routeId,
    totalScore: s.totalScore,
    breakdown: {
      capabilityFit: s.breakdown.taskTypeFit,
      freshness: 0.8,
      routeReliability: 0.8,
      latencyScore: 0.7,
      costEfficiency: s.breakdown.qualityPerDollarScore,
      contextFit: 1,
      localPreference: 0,
      riskPenalty: 0,
    },
    rejected: s.rejected,
    rejectionReasons: s.rejectionReasons,
    freshnessStatus: 'current_and_routable',
  };
}

// ─── Pareto trace summary ───────────────────────────────────────────────

interface BuildSummaryArgs {
  readonly paretoPlan: EnsemblePlan;
  readonly contributionResult: ContributionAwareRetrieverResult;
  readonly originalStrategy: import('../strategy/strategy-types').StrategyPlannerResult;
  readonly adapter: ParetoStrategyPlannerResult;
}

function buildParetoTraceSummary(args: BuildSummaryArgs): ParetoTraceSummary {
  const p = args.paretoPlan;
  return Object.freeze({
    paretoStatus: p.paretoStatus,
    baselineSingleJudge: p.baselineJudge,
    baselineSingleCostUsd: p.baselineCostUsd,
    expectedEnsembleJudge: p.expectedJudge,
    expectedEnsembleCostUsd: p.expectedCostUsd,
    expectedQualityPerDollar: p.expectedQualityPerDollar,
    selectedModelIds: Array.from(p.selectedModelIds),
    selectedRouteIds: Array.from(p.selectedRouteIds),
    ensembleExplanation: p.explanation,
    marginalContributions: p.marginalContributions.map((m) => ({
      modelId: m.modelId,
      marginalQualityGain: m.marginalQualityGain,
      marginalCostUsd: m.marginalCostUsd,
      accepted: m.accepted,
      reason: m.reason,
    })),
    rejectedCandidates: p.rejectedCandidates.map((r) => ({
      modelId: r.modelId,
      reason: r.reason,
    })),
    structuralPlanSummary: {
      strategy: args.originalStrategy.plan.strategy,
      routes: Array.from(args.originalStrategy.plan.selectedRouteIds),
    },
    paretoPlanSummary: {
      strategy: p.strategyId,
      routes: Array.from(p.selectedRouteIds),
    },
    finalPlanSource: args.adapter.finalOfflinePlan.source,
  });
}
