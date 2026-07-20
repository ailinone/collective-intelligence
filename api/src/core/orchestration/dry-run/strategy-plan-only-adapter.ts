// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-plan-only-adapter.ts — SM-R2-CORRECTIVE §8
 *
 * Plan-only adapter for non-consensus strategies in dry-run mode.
 *
 * Problem addressed:
 *   ConsensusPlanDryRunService only handles strategy='consensus'.
 *   When auto-routing resolves to a non-consensus strategy (single, cost-cascade,
 *   debate, quality-multipass, etc.) and the caller requests dryRun=true, there
 *   was no mechanism to return a structured plan without executing.
 *
 * This adapter:
 *   - Takes the resolved strategy + request/context metadata
 *   - Builds a synthetic OrchestrationResult with:
 *       • finalResponse: valid ChatResponse format (no provider content)
 *       • totalCost: 0
 *       • modelsUsed: []
 *       • metadata: plan_only=true, provider_call_executed=false, resolved traces
 *   - Never makes provider calls (pure computation)
 *
 * Injection point:
 *   orchestration-engine.ts — after isDryRunRequested() check returns true,
 *   before feedbackLoop.executeWithFeedback() is called.
 *
 * Trace fields included (for §11 cost-quality trace):
 *   - strategyResolutionTrace: why this strategy was selected
 *   - triageTrace: triage result (including discarded recommendations)
 *   - costQualityTrace: estimated plan cost, expected quality, route readiness
 *   - routeTrace: selectionSource chain
 */

import type { ChatRequest, OrchestrationContext, OrchestrationResult } from '@/types';
import type { DryRunDetectionPath } from './dry-run-execution-guard';

/** Trace data collected during strategy resolution. */
export interface StrategyResolutionTrace {
  /** Strategy name that was resolved (would have been executed). */
  resolvedStrategy: string;
  /** Source that selected the strategy. */
  selectionSource: string;
  /** Number of available models at selection time. */
  modelsAvailable: number;
  /** Task type used for selection. */
  taskType: string;
  /** Quality target used for selection (0-1). */
  qualityTarget?: number;
  /** Was cold-start policy applied? */
  coldStartPolicyApplied: boolean;
}

/** Triage trace included even when recommendation was discarded. */
export interface PlanOnlyTriageTrace {
  invoked: boolean;
  intent?: string | null;
  complexity?: string | null;
  confidence?: number | null;
  recommendedStrategy?: string | null;
  discarded: boolean;
  discardReason?: 'TRIAGE_CONFIDENCE_BELOW_THRESHOLD' | 'STRATEGY_NOT_AVAILABLE' | 'AUTO_STRATEGY_NOT_REQUESTED';
}

/** Cost-quality estimation trace for the plan. */
export interface CostQualityTrace {
  estimatedPlanCostUsd: 0;
  expectedQualityScore: number;
  qualityTarget: number;
  routeReadinessScore: number;
  estimatedLatencyMs?: number;
  providerCallExecuted: false;
  planExecutable: boolean;
  planExecutableBlockers: string[];
}

/** Model ranking trace — which models were considered for the plan. */
export interface ModelRankingTrace {
  candidateModels: Array<{ id: string; qualityScore?: number; estimatedCostUsd?: number }>;
  selectionPolicy: string;
  finalSelectionScore?: number;
  modelCount: number;
}

/** Route candidates for the plan (structural, no provider calls). */
export interface RouteCandidates {
  routeSelectionPolicy: string;
  candidates: Array<{ provider?: string; model?: string; estimatedCostUsd?: number; available: boolean }>;
  selectedRoute: string | null;
}

/** Execution plan step — what would have been executed. */
export interface ExecutionPlanStep {
  stepId: string;
  /** Semantic role this step plays in the strategy pipeline (SM-R5 FIX-001). */
  role?: string;
  /**
   * Semantic phase label for this step (SM-R6 FIX-002/003/004).
   * Populated for strategies with deep step templates (cost-cascade,
   * critique-repair, quality-multipass, single).
   * Undefined for strategies still using the 2-tier execute/synthesize pattern.
   */
  phase?: string;
  action: string;
  modelId?: string;
  providerId?: string;
  providerCallPlanned: boolean;
  providerCallExecuted: false;
}

/**
 * Strategy-level semantic metadata added in SM-R6.
 * Describes the pipeline structure for consumers that need richer context
 * than step count alone (e.g., C3 scope design, audit tooling).
 */
export interface StrategySemantics {
  /** Artifact version for plan semantic content. */
  semanticPlanVersion: string;
  /** Strategy ID this plan was built for. */
  strategyId: string;
  /** Total number of planned phases. */
  phaseCount: number;
  /** Ordered phase labels. */
  phases: string[];
  /** All roles across steps (may have duplicates for multi-model strategies). */
  roles: string[];
  /** Per-strategy policy overlay — only present when applicable. */
  cascadePolicy?: {
    tiers: string[];
    escalationThreshold: string;
    budgetCapPolicy: string;
    stopCondition: string;
  };
  iterationPolicy?: {
    minPasses: number;
    maxPasses: number;
    qualityGate: string;
  };
  repairPolicy?: {
    critiqueRequired: boolean;
    repairRequired: boolean;
    finalValidationRequired: boolean;
  };
  latencyPolicy?: {
    latencyOptimized: boolean;
    latencyCapMs?: number;
  };
}

/** Full plan-only result payload. */
export interface PlanOnlyResultPayload {
  plan_only: true;
  provider_call_executed: false;
  dry_run_interception_path: DryRunDetectionPath;
  strategy_resolution_trace: StrategyResolutionTrace;
  triage_trace: PlanOnlyTriageTrace;
  cost_quality_trace: CostQualityTrace;
  model_ranking_trace: ModelRankingTrace;
  route_candidates: RouteCandidates;
  route_trace: string[];
  models_considered: string[];
  executionPlan: {
    steps: ExecutionPlanStep[];
    planNote: string;
    /** SM-R6: present for strategies with deep step templates. */
    strategySemantics?: StrategySemantics;
  };
  planFingerprint: string;
  executable: boolean;
  dryRun: true;
  planOnly: true;
  blockers: string[];
  missingCapabilities: string[];
}

/**
 * Options for buildPlanOnlyResult.
 * All fields are optional for backward compatibility.
 */
export interface PlanOnlyResultOptions {
  /** Whether this strategy is registered in the engine. Default: true. */
  registered?: boolean;
  /** Explicit blockers for missing/unsupported strategies. */
  blockers?: string[];
  /** Missing capabilities for blocked strategies. */
  missingCapabilities?: string[];
}

/**
 * Build a synthetic OrchestrationResult for a dry-run scenario.
 *
 * All values are computed from available metadata — no provider calls are made.
 *
 * @param strategyName    — The strategy that was selected (not executed).
 * @param selectionSource — How the strategy was chosen.
 * @param detectionPath   — Where the dryRun signal was detected.
 * @param request         — The original request (for metadata extraction).
 * @param context         — The orchestration context (for models/quality target).
 * @param triageDecision  — Triage result (may be null if triage was not run or discarded).
 * @param qualityTarget   — The resolved adaptive quality target.
 * @param options         — Optional flags for registration status and blockers.
 */
export function buildPlanOnlyResult(
  strategyName: string,
  selectionSource: string,
  detectionPath: DryRunDetectionPath,
  request: ChatRequest & { dryRun?: boolean; ailin_metadata?: Record<string, unknown>; eval?: Record<string, unknown> },
  context: OrchestrationContext,
  triageDecision: {
    intent?: string | null;
    complexity?: string | null;
    confidence?: number | null;
    recommendedStrategy?: string | null;
    discarded?: boolean;
    discardReason?: string;
  } | null | undefined,
  qualityTarget: number,
  options: PlanOnlyResultOptions = {},
): OrchestrationResult {
  const requestId = context.requestId ?? `dry-run-${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  const registered = options.registered !== false; // default: true
  const blockers = options.blockers ?? (registered ? [] : ['BLOCKED_BY_MISSING_STRATEGY_REGISTRY']);
  const missingCapabilities = options.missingCapabilities ?? (registered ? [] : [`strategy:${strategyName}`]);

  // ── Triage trace ─────────────────────────────────────────────────────────
  const triageInvoked = triageDecision !== null && triageDecision !== undefined;
  const triageTrace: PlanOnlyTriageTrace = {
    invoked: triageInvoked,
    intent: triageDecision?.intent ?? null,
    complexity: triageDecision?.complexity ?? null,
    confidence: triageDecision?.confidence ?? null,
    recommendedStrategy: triageDecision?.recommendedStrategy ?? null,
    discarded: triageDecision?.discarded === true ||
      (triageInvoked && !triageDecision?.recommendedStrategy),
    discardReason: triageDecision?.discardReason as PlanOnlyTriageTrace['discardReason'] ??
      (triageInvoked && !triageDecision?.recommendedStrategy
        ? 'TRIAGE_CONFIDENCE_BELOW_THRESHOLD'
        : undefined),
  };

  // ── Strategy resolution trace ─────────────────────────────────────────────
  const strategyResolutionTrace: StrategyResolutionTrace = {
    resolvedStrategy: strategyName,
    selectionSource,
    modelsAvailable: context.models?.length ?? 0,
    taskType: context.taskType ?? 'general',
    qualityTarget: typeof context.qualityTarget === 'number' ? context.qualityTarget : undefined,
    coldStartPolicyApplied: selectionSource === 'cold-start-policy',
  };

  // ── Cost-quality trace ────────────────────────────────────────────────────
  // Route readiness: ratio of available models to a reasonable pool (proxy metric).
  const routeReadinessScore = Math.min(1, (context.models?.length ?? 0) / 3);
  // Expected quality: heuristic from strategy characteristics.
  const qualityEstimate = estimateStrategyQuality(strategyName, qualityTarget);
  const costQualityTrace: CostQualityTrace = {
    estimatedPlanCostUsd: 0,
    expectedQualityScore: qualityEstimate,
    qualityTarget,
    routeReadinessScore,
    estimatedLatencyMs: estimateStrategyLatency(strategyName),
    providerCallExecuted: false,
    planExecutable: routeReadinessScore > 0,
    planExecutableBlockers: routeReadinessScore === 0
      ? ['NO_MODELS_AVAILABLE']
      : [],
  };

  // ── Route trace ───────────────────────────────────────────────────────────
  const routeTrace = buildRouteTrace(selectionSource, triageTrace);

  // ── Model ranking trace ───────────────────────────────────────────────────
  const candidateModels = (context.models ?? []).slice(0, 5).map(m => ({
    id: m.id,
    qualityScore: typeof (m as { qualityScore?: number }).qualityScore === 'number'
      ? (m as { qualityScore?: number }).qualityScore
      : undefined,
    estimatedCostUsd: 0,  // dry-run — no real cost
  }));
  const modelRankingTrace: ModelRankingTrace = {
    candidateModels,
    selectionPolicy: selectionSource,
    finalSelectionScore: candidateModels.length > 0 ? estimateStrategyQuality(strategyName, qualityTarget) : 0,
    modelCount: context.models?.length ?? 0,
  };

  // ── Route candidates ─────────────────────────────────────────────────────
  const routeCandidatesObj: RouteCandidates = {
    routeSelectionPolicy: selectionSource,
    candidates: candidateModels.slice(0, 3).map(m => ({
      model: m.id,
      estimatedCostUsd: 0,
      available: registered,
    })),
    selectedRoute: registered && candidateModels.length > 0 ? candidateModels[0]!.id : null,
  };

  // ── Plan fingerprint ──────────────────────────────────────────────────────
  const planFingerprint = computePlanFingerprint(strategyName, context.taskType ?? 'general', qualityTarget, registered);

  // ── Execution plan ────────────────────────────────────────────────────────
  const { steps: _steps, planNote: _planNote, strategySemantics } =
    buildExecutionPlan(strategyName, registered, blockers, candidateModels);
  const executionPlan = { steps: _steps, planNote: _planNote, strategySemantics };

  // ── Payload ───────────────────────────────────────────────────────────────
  const payload: PlanOnlyResultPayload = {
    plan_only: true,
    provider_call_executed: false,
    dry_run_interception_path: detectionPath,
    strategy_resolution_trace: strategyResolutionTrace,
    triage_trace: triageTrace,
    cost_quality_trace: costQualityTrace,
    model_ranking_trace: modelRankingTrace,
    route_candidates: routeCandidatesObj,
    route_trace: routeTrace,
    models_considered: candidateModels.map(m => m.id),
    executionPlan,
    planFingerprint,
    executable: registered && blockers.length === 0,
    dryRun: true,
    planOnly: true,
    blockers,
    missingCapabilities,
  };

  // ── Synthetic ChatResponse ────────────────────────────────────────────────
  const syntheticContent = `[DRY RUN — PLAN ONLY]\n` +
    `Strategy: ${strategyName} (selected via ${selectionSource})\n` +
    `Task type: ${context.taskType ?? 'general'}\n` +
    `Quality target: ${qualityTarget.toFixed(2)}\n` +
    `Models available: ${context.models?.length ?? 0}\n` +
    `Triage: ${triageTrace.invoked ? `invoked (confidence=${triageTrace.confidence?.toFixed(2) ?? '?'}, discarded=${triageTrace.discarded})` : 'not invoked'}\n` +
    `No provider calls were made.`;

  const finalResponse = {
    id: `dry-run-${requestId}`,
    object: 'chat.completion' as const,
    created: now,
    model: strategyName,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant' as const,
          content: syntheticContent,
        },
        finish_reason: 'stop' as const,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  // ── OrchestrationResult ───────────────────────────────────────────────────
  return {
    strategyUsed: strategyName as import('@/types').ExecutionStrategyName,
    modelsUsed: [],
    finalResponse,
    totalCost: 0,
    totalDuration: 0,
    qualityScore: undefined,
    metadata: {
      // Core identification fields (SM-R2 compat)
      resolved_strategy: strategyName,
      decision_source: selectionSource,
      cost_usd: 0,
      model_count: 0,
      // All trace fields spread first
      ...payload,
      // SM-R3: explicit dry-run markers override spread (validator discovery)
      dryRun: true,
      planOnly: true,
      executable: payload.executable,
      planFingerprint,
      blockers,
      missingCapabilities,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Rough quality estimate per strategy (0-1). */
function estimateStrategyQuality(strategyName: string, qualityTarget: number): number {
  const qualityMap: Record<string, number> = {
    'single': 0.70,
    'cost-cascade': 0.65,
    'parallel': 0.75,
    'debate': 0.82,
    'consensus': 0.88,
    'quality-multipass': 0.92,
    'collaborative': 0.80,
    'competitive': 0.83,
    'expert-panel': 0.85,
    'diversity-ensemble': 0.84,
  };
  return qualityMap[strategyName] ?? Math.min(qualityTarget, 0.75);
}

/** Rough latency estimate per strategy (milliseconds). */
function estimateStrategyLatency(strategyName: string): number {
  const latencyMap: Record<string, number> = {
    'single': 3000,
    'cost-cascade': 4000,
    'parallel': 5000,
    'debate': 15000,
    'consensus': 20000,
    'quality-multipass': 25000,
    'collaborative': 12000,
    'competitive': 10000,
  };
  return latencyMap[strategyName] ?? 8000;
}

/**
 * Compute a deterministic plan fingerprint.
 * Changes when strategy, taskType, qualityTarget, registration status,
 * or semantic plan version changes.
 *
 * SM-R6: SEMANTIC_PLAN_VERSION included so that any upgrade to the semantic
 * template system (adding phases, roles, policies) automatically invalidates
 * prior fingerprints. This lets consumers detect plan content changes.
 */
function computePlanFingerprint(
  strategyName: string,
  taskType: string,
  qualityTarget: number,
  registered: boolean,
): string {
  const input = `${strategyName}|${taskType}|${qualityTarget.toFixed(2)}|${String(registered)}|${SEMANTIC_PLAN_VERSION}`;
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul((h << 5) + h, 1) + input.charCodeAt(i) | 0;
  }
  return `pf_${(h >>> 0).toString(16)}`;
}

// ── SM-R6 Semantic Plan Version ──────────────────────────────────────────────
/**
 * Semantic plan version marker, included in plan fingerprints.
 * Bumping this causes all plan fingerprints to change, which signals
 * to consumers that the semantic content of plans has been updated.
 */
const SEMANTIC_PLAN_VERSION = '01c1b-sm-r6-v1';

// ── SM-R6 Step Template System ────────────────────────────────────────────────
/** A single step descriptor in a strategy step template. */
interface StepTemplate {
  suffix: string;
  role?: string;
  action: string;
  phase: string;
  providerCallPlanned: boolean;
  providerCallExecuted: false;
}

/**
 * Semantic step templates for strategies receiving FIX-002/003/004 depth.
 * Each template describes the full pipeline a strategy would execute in
 * live mode — not just execute+synthesize, but phase-by-phase semantics.
 *
 * Strategies NOT listed here fall back to the STEP_ROLES 2-tier system
 * (consensus, debate, expert-panel, sensitivity-consensus).
 *
 * SM-R6 upgrade summary:
 *   single          1 step  → 1 step  (action renamed: direct-answer, role: responder)
 *   cost-cascade    1 step  → 4 steps (FIX-002)
 *   critique-repair 2 steps → 3 steps (FIX-003)
 *   quality-multipass 2 steps → 4 steps (FIX-004)
 */
const STRATEGY_STEP_TEMPLATES: Record<string, StepTemplate[]> = {
  single: [
    {
      suffix: 'direct',
      role: 'responder',
      action: 'single/direct-answer',
      phase: 'direct_answer',
      providerCallPlanned: true,
      providerCallExecuted: false,
    },
  ],

  'cost-cascade': [
    {
      suffix: 'cheap-attempt',
      role: 'cheap_candidate',
      action: 'cost-cascade/cheap-first-attempt',
      phase: 'cheap_first_attempt',
      providerCallPlanned: true,
      providerCallExecuted: false,
    },
    {
      suffix: 'quality-gate',
      role: 'quality_gate',
      action: 'cost-cascade/quality-gate',
      phase: 'quality_gate',
      providerCallPlanned: false, // gate: evaluate result, no new provider call
      providerCallExecuted: false,
    },
    {
      suffix: 'escalation',
      role: 'escalator',
      action: 'cost-cascade/escalate-if-needed',
      phase: 'escalation',
      providerCallPlanned: true,
      providerCallExecuted: false,
    },
    {
      suffix: 'finalize',
      role: 'synthesizer',
      action: 'cost-cascade/finalize-with-budget-cap',
      phase: 'finalization',
      providerCallPlanned: false, // budget-cap decision: no extra call
      providerCallExecuted: false,
    },
  ],

  'critique-repair': [
    {
      suffix: 'critique',
      role: 'critic',
      action: 'critique-repair/critique',
      phase: 'critique',
      providerCallPlanned: true,
      providerCallExecuted: false,
    },
    {
      suffix: 'repair',
      role: 'repairer',
      action: 'critique-repair/repair-rewrite',
      phase: 'repair',
      providerCallPlanned: true,
      providerCallExecuted: false,
    },
    {
      suffix: 'validate',
      role: 'validator',
      action: 'critique-repair/final-validation',
      phase: 'validation',
      providerCallPlanned: false, // structural validation: no extra call
      providerCallExecuted: false,
    },
  ],

  'quality-multipass': [
    {
      suffix: 'draft',
      role: 'drafter',
      action: 'quality-multipass/draft',
      phase: 'draft',
      providerCallPlanned: true,
      providerCallExecuted: false,
    },
    {
      suffix: 'review',
      role: 'reviewer',
      action: 'quality-multipass/critique-review',
      phase: 'review',
      providerCallPlanned: true,
      providerCallExecuted: false,
    },
    {
      suffix: 'refine',
      role: 'refiner',
      action: 'quality-multipass/refine',
      phase: 'refine',
      providerCallPlanned: true,
      providerCallExecuted: false,
    },
    {
      suffix: 'final',
      role: 'synthesizer',
      action: 'quality-multipass/final-selection',
      phase: 'final',
      providerCallPlanned: false, // selection decision: no extra call
      providerCallExecuted: false,
    },
  ],
};

/** Build strategy semantics metadata for strategies with deep templates. */
function buildStrategySemantics(
  strategyId: string,
  templates: StepTemplate[],
): StrategySemantics {
  const phases = templates.map(t => t.phase);
  const roles = templates.map(t => t.role).filter((r): r is string => r !== undefined);
  const base: StrategySemantics = {
    semanticPlanVersion: SEMANTIC_PLAN_VERSION,
    strategyId,
    phaseCount: phases.length,
    phases,
    roles,
  };

  // Add per-strategy policy metadata
  if (strategyId === 'cost-cascade') {
    base.cascadePolicy = {
      tiers: ['cheap_first_attempt', 'escalation'],
      escalationThreshold: 'quality_gate_fail',
      budgetCapPolicy: 'finalize_with_budget_cap',
      stopCondition: 'quality_gate_pass_or_budget_exhausted',
    };
  }
  if (strategyId === 'quality-multipass') {
    base.iterationPolicy = {
      minPasses: 2,
      maxPasses: 4,
      qualityGate: 'review_score_threshold',
    };
  }
  if (strategyId === 'critique-repair') {
    base.repairPolicy = {
      critiqueRequired: true,
      repairRequired: true,
      finalValidationRequired: true,
    };
  }
  return base;
}

/**
 * Role assignment table — per-strategy semantic roles for each execution step.
 * Multi-agent strategies assign distinct roles so consumers can distinguish
 * which model(s) serve which function in the pipeline.
 *
 * step-0 (execute) role  | step-1 (synthesize) role
 * ---------------------- | ------------------------
 * consensus              | voter               | synthesizer
 * debate                 | proposer            | judge
 * expert-panel           | expert              | judge
 * critique-repair        | critic              | repairer
 * quality-multipass      | executor            | reviewer
 *
 * Single-step strategies (single, cost-cascade, sensitivity-consensus, etc.)
 * leave role undefined — they have no inter-step role differentiation.
 */
const STEP_ROLES: Record<string, { execute: string; synthesize: string }> = {
  'consensus': { execute: 'voter',    synthesize: 'synthesizer' },
  'debate': { execute: 'proposer', synthesize: 'judge'       },
  'expert-panel': { execute: 'expert',   synthesize: 'judge'       },
  'critique-repair': { execute: 'critic',   synthesize: 'repairer'    },
  'quality-multipass': { execute: 'executor', synthesize: 'reviewer'    },
};

/**
 * Build a synthetic execution plan for the given strategy.
 * Registered strategies get a planned step; unregistered get a blocked step.
 *
 * SM-R5 FIX-001: role fields are populated for multi-agent strategies.
 * SM-R6 FIX-002/003/004: deep step templates for cost-cascade, critique-repair,
 *   quality-multipass, and single replace the 2-tier execute/synthesize skeleton.
 *   Templates include per-step phases, roles, and policy metadata via
 *   strategySemantics. Strategies not in STRATEGY_STEP_TEMPLATES fall back
 *   to the STEP_ROLES 2-tier system (consensus, debate, expert-panel).
 */
function buildExecutionPlan(
  strategyName: string,
  registered: boolean,
  blockers: string[],
  candidateModels: Array<{ id: string }>,
): { steps: ExecutionPlanStep[]; planNote: string; strategySemantics?: StrategySemantics } {
  if (!registered || blockers.length > 0) {
    return {
      steps: [{
        stepId: 'step-0-blocked',
        action: 'blocked',
        providerCallPlanned: false,
        providerCallExecuted: false,
      }],
      planNote: `Dry-run plan blocked: ${blockers.join(', ')}`,
    };
  }

  // ── SM-R6 template system (FIX-002/003/004 + single enrichment) ────────────
  const templates = STRATEGY_STEP_TEMPLATES[strategyName];
  if (templates) {
    const steps: ExecutionPlanStep[] = templates.map((t, i) => ({
      stepId: `step-${i}-${t.suffix}`,
      role: t.role,
      phase: t.phase,
      action: t.action,
      modelId: candidateModels[i % Math.max(1, candidateModels.length)]?.id,
      providerCallPlanned: t.providerCallPlanned,
      providerCallExecuted: false as const,
    }));
    const strategySemantics = buildStrategySemantics(strategyName, templates);
    return {
      steps,
      planNote: `Dry-run plan for ${strategyName}: ${steps.length} step(s) planned via semantic template, 0 executed.`,
      strategySemantics,
    };
  }

  // ── SM-R5 STEP_ROLES fallback (consensus, debate, expert-panel, etc.) ──────
  const roles = STEP_ROLES[strategyName];
  const steps: ExecutionPlanStep[] = [{
    stepId: 'step-0-plan',
    action: `${strategyName}/execute`,
    role: roles?.execute,
    modelId: candidateModels[0]?.id,
    providerCallPlanned: true,   // would be called in live mode
    providerCallExecuted: false, // never executed in dry-run
  }];
  if (['consensus', 'debate', 'expert-panel'].includes(strategyName)) {
    steps.push({
      stepId: 'step-1-synthesis',
      action: `${strategyName}/synthesize`,
      role: roles?.synthesize,
      modelId: candidateModels[1]?.id ?? candidateModels[0]?.id,
      providerCallPlanned: true,
      providerCallExecuted: false,
    });
  }
  return {
    steps,
    planNote: `Dry-run plan for ${strategyName}: ${steps.length} step(s) planned, 0 executed.`,
  };
}

/** Build the route trace chain for the given selection. */
function buildRouteTrace(selectionSource: string, triageTrace: PlanOnlyTriageTrace): string[] {
  const trace: string[] = [];

  // Triage
  if (triageTrace.invoked) {
    const triageOutcome = triageTrace.discarded
      ? `triage→discarded(confidence=${triageTrace.confidence?.toFixed(2) ?? '?'}<0.4)`
      : `triage→accepted(strategy=${triageTrace.recommendedStrategy})`;
    trace.push(triageOutcome);
  } else {
    trace.push('triage→skipped(not_auto_or_prefer_speed)');
  }

  // Archive / Pareto / Bandit (all cold in cold-start)
  trace.push('archive→cold_start(no_data)');
  trace.push('pareto→cold_start(no_data)');
  trace.push('bandit→cold_start(no_confidence)');

  // Final resolution
  trace.push(`${selectionSource}→resolved(${selectionSource.includes('cold-start') ? 'deterministic_policy' : 'heuristic_score'})`);

  return trace;
}
