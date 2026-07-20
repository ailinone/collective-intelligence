// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-pipeline-composer.ts — MVP 7A
 *
 * Pure, offline pipeline orchestrator. Reads the mode from the config
 * provider, then dispatches:
 *
 *   legacy                 → no-op trace
 *   registry_cache         → registry-count trace
 *   shadow_trace_only      → minimal trace
 *   shadow_registry_only   → registry-count trace
 *   shadow_structural_full → TaskProfiler → CandidateRetriever
 *                            → ModelScorer (via retriever)
 *                            → StrategyPlanner → trace
 *   shadow_semantic_full   → BLOCKED
 *   semantic_primary       → BLOCKED
 *
 * Invariants:
 *   - No provider call. No DB. No Redis. No TEI. No HNSW.
 *   - No clock reads. No randomness. The composer accepts `nowIso` and
 *     `traceId` from the caller and never invents them.
 *   - Input is never mutated.
 *   - Output `trace` is ALWAYS passed through `redactRoutingTrace` so
 *     forbidden keys (prompt, messages, rawContext, …) cannot leak.
 *   - The explicit pin is propagated to retriever and planner but
 *     never substituted.
 */

import type {
  ExplicitPinInfo,
  PrivacyMode,
  RouteKind,
} from '../registry/types';
import type { CandidateRetrievalRequest } from '../retrieval/candidate-retrieval-types';
import { retrieveCandidates } from '../retrieval/candidate-retriever';
import {
  BLOCKED_MODES,
  BLOCKED_REASON,
  type RoutingMode,
} from '../routing-config/runtime-routing-config-types';
import { planStrategy } from '../strategy/strategy-planner';
import type {
  StrategyComplexity,
  StrategyPlannerInput,
  StrategyPlanningContext,
  StrategyRiskLevel,
  StrategySensitivity,
} from '../strategy/strategy-types';
import type { Sensitivity } from '../scoring/scoring-policy';
import { profileTask } from '../task-profile/task-profiler';
import type {
  TaskProfile,
} from '../task-profile/task-profile-types';
import { buildPipelineTrace } from './routing-pipeline-trace';
import type {
  RoutingPipelineInput,
  RoutingPipelineResult,
} from './routing-pipeline-types';

// ─── Constants (data, not logic) ────────────────────────────────────────

const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const DEFAULT_TRACE_ID = 'trace-pipeline-mvp7a';

// ─── Mappers ────────────────────────────────────────────────────────────

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

function deriveLatencySensitivity(profile: TaskProfile): Sensitivity {
  if (typeof profile.latencyBudgetMs === 'number') {
    if (profile.latencyBudgetMs < 2_000) return 'high';
    if (profile.latencyBudgetMs < 10_000) return 'medium';
  }
  return 'low';
}

function profileToRetrievalRequest(
  profile: TaskProfile,
  pin: ExplicitPinInfo | null | undefined,
  input: RoutingPipelineInput,
): CandidateRetrievalRequest {
  const required = Array.from(profile.requiredCapabilities);
  const desired = Array.from(profile.desiredCapabilities);
  const costSensitivity: Sensitivity = profile.costSensitivity;
  const privacyMode: PrivacyMode = profile.privacyMode;
  return {
    requiredCapabilities: required,
    desiredCapabilities: desired,
    minContextWindow: profile.contextRequirementTokens,
    privacyMode,
    costSensitivity,
    latencySensitivity: deriveLatencySensitivity(profile),
    explicitModelPin: pin ?? null,
    maxCandidates: input.maxCandidates,
    scoringPolicy: input.scoringPolicy,
  };
}

function profileToPlannerContext(
  profile: TaskProfile,
  pin: ExplicitPinInfo | null | undefined,
): StrategyPlanningContext {
  return {
    taskType: profile.taskType,
    complexity: complexityToStrategy(profile.complexity),
    riskLevel: riskToStrategy(profile.riskLevel),
    privacyMode: profile.privacyMode,
    costSensitivity: sensitivityToStrategy(profile.costSensitivity),
    latencySensitivity: deriveLatencySensitivity(profile),
    confidenceNeeded: profile.confidenceNeeded,
    explicitModelPin: pin ?? null,
  };
}

// ─── Composer ───────────────────────────────────────────────────────────

/**
 * Runs the offline routing pipeline. Always returns a result with a
 * (redacted) trace — never throws on user-shaped errors.
 */
export function composeRoutingPipeline(
  input: RoutingPipelineInput,
): RoutingPipelineResult {
  const mode = input.configProvider.getMode();
  const timestamp = input.nowIso ?? DEFAULT_TIMESTAMP;
  const traceId = input.traceId ?? DEFAULT_TRACE_ID;
  const pin: ExplicitPinInfo | null = input.explicitModelPin ?? null;

  // ─── BLOCKED modes — return early without touching anything ──────────
  if (BLOCKED_MODES.has(mode)) {
    const trace = buildPipelineTrace({
      traceId,
      requestId: input.requestId,
      timestamp,
      mode,
      explicitModelPin: pin,
    });
    return Object.freeze({
      mode,
      trace,
      blockedReason: BLOCKED_REASON,
    });
  }

  // ─── legacy — no work, minimal trace ─────────────────────────────────
  if (mode === 'legacy') {
    const trace = buildPipelineTrace({
      traceId,
      requestId: input.requestId,
      timestamp,
      mode,
      explicitModelPin: pin,
    });
    return Object.freeze({ mode, trace });
  }

  // ─── shadow_trace_only — minimal trace ───────────────────────────────
  if (mode === 'shadow_trace_only') {
    const trace = buildPipelineTrace({
      traceId,
      requestId: input.requestId,
      timestamp,
      mode,
      explicitModelPin: pin,
    });
    return Object.freeze({ mode, trace });
  }

  // ─── registry_cache / shadow_registry_only — registry read only ──────
  if (mode === 'registry_cache' || mode === 'shadow_registry_only') {
    const size = input.registry.size();
    const trace = buildPipelineTrace({
      traceId,
      requestId: input.requestId,
      timestamp,
      mode,
      explicitModelPin: pin,
      initialRegistryRoutes: size.routes,
    });
    return Object.freeze({ mode, trace });
  }

  // ─── shadow_structural_full — full offline pipeline ──────────────────
  return runStructuralFull(input, timestamp, traceId, pin);
}

// ─── Structural full pipeline ───────────────────────────────────────────

function runStructuralFull(
  input: RoutingPipelineInput,
  timestamp: string,
  traceId: string,
  pin: ExplicitPinInfo | null,
): RoutingPipelineResult {
  // 1. Profile the request — heuristic, deterministic, offline.
  const { profile } = profileTask(input.profilerInput);

  // 2. Retrieve structural candidates.
  const retrievalRequest = profileToRetrievalRequest(profile, pin, input);
  const retrievalResult = retrieveCandidates(retrievalRequest, {
    registry: input.registry,
  });

  // 3. Plan strategy over the scored set.
  const plannerContext = profileToPlannerContext(profile, pin);
  const plannerInput: StrategyPlannerInput = {
    candidates: retrievalResult.candidates,
    context: plannerContext,
    policy: input.strategyPolicy,
    routesInfo: buildRoutesInfo(input, retrievalResult.candidates.map((c) => c.routeId)),
  };
  const strategyResult = planStrategy(plannerInput);

  // 4. Build redacted trace.
  const trace = buildPipelineTrace({
    traceId,
    requestId: input.requestId,
    timestamp,
    mode: 'shadow_structural_full',
    taskProfile: profile,
    retrievalResult,
    strategyResult,
    explicitModelPin: pin,
  });

  return Object.freeze({
    mode: 'shadow_structural_full' as RoutingMode,
    taskProfile: profile,
    retrievalResult,
    strategyResult,
    trace,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Builds the planner's routesInfo Map from the registry. The composer
 * looks each routeId up and pulls its routeKind from the registry — no
 * external state involved.
 */
function buildRoutesInfo(
  input: RoutingPipelineInput,
  routeIds: readonly string[],
): ReadonlyMap<string, { routeId: string; routeKind: RouteKind }> {
  const out = new Map<string, { routeId: string; routeKind: RouteKind }>();
  for (const id of routeIds) {
    const r = input.registry.lookupRoute(id);
    if (r) {
      out.set(id, { routeId: r.routeId, routeKind: r.routeKind });
    }
  }
  return out;
}

// Helper inference — used by composer when a caller wants to inspect
// what the composer would emit without running it.
export function isBlocked(mode: RoutingMode): boolean {
  return BLOCKED_MODES.has(mode);
}
