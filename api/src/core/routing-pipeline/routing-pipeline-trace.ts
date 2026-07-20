// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-pipeline-trace.ts — MVP 7A
 *
 * Pure trace builder for the composer. Produces a `RoutingDecisionTrace`
 * shaped object from the categorical projections; the redaction layer
 * (`redactRoutingTrace` from MVP 3) is the enforcement boundary. We
 * apply it at the end so the trace cannot leak prompts, messages or
 * raw attachments even if a caller fed them in.
 */

import type { CandidateRetrievalResult } from '../retrieval/candidate-retrieval-types';
import type { ExplicitPinInfo } from '../registry/types';
import type { RoutingDecisionTrace } from '../routing/routing-decision-trace';
import { redactRoutingTrace } from '../routing/routing-redaction';
import type { RoutingMode } from '../routing-config/runtime-routing-config-types';
import type { StrategyPlannerResult } from '../strategy/strategy-types';
import type { TaskProfile } from '../task-profile/task-profile-types';

// ─── Args ───────────────────────────────────────────────────────────────

export interface BuildPipelineTraceArgs {
  readonly traceId: string;
  readonly requestId: string;
  readonly timestamp: string;
  readonly mode: RoutingMode;
  readonly taskProfile?: TaskProfile;
  readonly retrievalResult?: CandidateRetrievalResult;
  readonly strategyResult?: StrategyPlannerResult;
  readonly explicitModelPin?: ExplicitPinInfo | null;
  readonly initialRegistryRoutes?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function profileSummary(p: TaskProfile | undefined): RoutingDecisionTrace['taskProfile'] {
  if (!p) {
    return {
      taskType: 'unknown',
      complexity: 'unknown',
      modalities: [],
      riskLevel: 'unknown',
      privacyMode: 'unknown',
    };
  }
  return {
    taskType: p.taskType,
    complexity: p.complexity,
    modalities: Array.from(p.modalities),
    riskLevel: p.riskLevel,
    privacyMode: p.privacyMode,
  };
}

function selectedRouteId(s: StrategyPlannerResult | undefined): string | null {
  if (!s) return null;
  const ids = s.plan.selectedRouteIds;
  return ids.length > 0 ? ids[0] : null;
}

function selectedFromRetrieval(
  s: StrategyPlannerResult | undefined,
  r: CandidateRetrievalResult | undefined,
): {
  readonly canonicalModelId: string | null;
  readonly offeringId: string | null;
  readonly routeId: string | null;
  readonly scoreBreakdown: Readonly<Record<string, number>>;
} {
  const routeId = selectedRouteId(s);
  if (!routeId || !r) {
    return {
      canonicalModelId: null,
      offeringId: null,
      routeId: null,
      scoreBreakdown: {},
    };
  }
  const hit = r.candidates.find((c) => c.routeId === routeId);
  if (!hit) {
    return {
      canonicalModelId: null,
      offeringId: null,
      routeId,
      scoreBreakdown: {},
    };
  }
  return {
    canonicalModelId: hit.canonicalModelId,
    offeringId: hit.offeringId,
    routeId: hit.routeId,
    scoreBreakdown: { ...hit.breakdown },
  };
}

// ─── Public builder ─────────────────────────────────────────────────────

/**
 * Builds the composer's trace and returns it AFTER redaction. The
 * redaction step strips any unexpected key and scrubs email/phone
 * patterns from string fields. Trace timestamps are taken from `args`
 * so the composer remains deterministic.
 */
export function buildPipelineTrace(args: BuildPipelineTraceArgs): RoutingDecisionTrace {
  const sel = selectedFromRetrieval(args.strategyResult, args.retrievalResult);
  const candidatesByStage: Record<string, number> = args.retrievalResult
    ? { ...args.retrievalResult.countsByStage }
    : typeof args.initialRegistryRoutes === 'number'
    ? { initial: args.initialRegistryRoutes }
    : {};

  const raw: RoutingDecisionTrace = {
    traceId: args.traceId,
    requestId: args.requestId,
    timestamp: args.timestamp,
    routingMode: args.mode,
    taskProfile: profileSummary(args.taskProfile),
    semanticIndexBackend: 'none',
    candidatesEvaluated: args.retrievalResult?.candidates.length ?? 0,
    candidatesByStage,
    rejectedByStage: args.retrievalResult
      ? args.retrievalResult.rejectedByStage.map((r) => ({
          routeId: r.routeId,
          stage: r.stage,
          reason: r.reason,
        }))
      : [],
    selectedCanonicalModelId: sel.canonicalModelId,
    selectedOfferingId: sel.offeringId,
    selectedRouteId: sel.routeId,
    scoreBreakdown: sel.scoreBreakdown,
    strategyPlan: args.strategyResult
      ? {
          strategy: args.strategyResult.plan.strategy,
          routes: Array.from(args.strategyResult.plan.selectedRouteIds),
        }
      : { strategy: 'no_viable_strategy', routes: [] },
    explicitModelPin: args.explicitModelPin ?? null,
    pinSubstitution: null,
    latencyByPhase: {},
  };

  // Redaction is mandatory — it strips any forbidden key the caller
  // may have accidentally injected.
  return redactRoutingTrace(raw);
}
