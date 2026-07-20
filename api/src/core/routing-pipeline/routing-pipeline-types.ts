// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-pipeline-types.ts — MVP 7A
 *
 * Pure types for the RoutingPipelineComposer. The composer is offline:
 * it does not call providers, DB, Redis, TEI or HNSW.
 */

import type { ExplicitPinInfo } from '../registry/types';
import type { RuntimeModelRegistry } from '../registry/runtime-model-registry';
import type { CandidateRetrievalResult } from '../retrieval/candidate-retrieval-types';
import type { RoutingDecisionTrace } from '../routing/routing-decision-trace';
import type {
  RoutingMode,
  RuntimeRoutingConfigProvider,
} from '../routing-config/runtime-routing-config-types';
import type { ScoringPolicy } from '../scoring/scoring-policy';
import type { StrategyPlannerResult } from '../strategy/strategy-types';
import type { StrategyPolicy } from '../strategy/strategy-policy';
import type { TaskProfile, TaskProfilerInput } from '../task-profile/task-profile-types';

// ─── Composer input ─────────────────────────────────────────────────────

export interface RoutingPipelineInput {
  readonly requestId: string;
  readonly profilerInput: TaskProfilerInput;
  readonly registry: RuntimeModelRegistry;
  readonly configProvider: RuntimeRoutingConfigProvider;
  /**
   * Optional explicit pin propagated to retriever AND planner. The
   * pipeline NEVER substitutes a pinned route — when the pin is not
   * viable, the planner returns no_viable_strategy.
   */
  readonly explicitModelPin?: ExplicitPinInfo | null;
  /**
   * Optional override for retriever scoring policy. Tests use this to
   * exercise margin / readiness paths; production keeps defaults.
   */
  readonly scoringPolicy?: ScoringPolicy;
  /**
   * Optional override for the strategy planner policy.
   */
  readonly strategyPolicy?: Partial<StrategyPolicy>;
  /**
   * Optional cap on retrieved candidates. Defaults to retriever's own
   * default (entire scored set).
   */
  readonly maxCandidates?: number;
  /**
   * Caller-supplied timestamp for the trace. The composer never reads
   * the wall clock so determinism remains intact.
   */
  readonly nowIso?: string;
  /**
   * Caller-supplied traceId. The composer never invents one.
   */
  readonly traceId?: string;
}

// ─── Composer result ────────────────────────────────────────────────────

/**
 * Composer output. Always carries a redacted `trace`; mode-specific
 * stages populate the remaining optional fields:
 *
 *   legacy                    → trace only
 *   registry_cache            → trace only (with registry counts)
 *   shadow_trace_only         → trace only
 *   shadow_registry_only      → trace + countsByStage.initial
 *   shadow_structural_full    → trace + taskProfile + retrievalResult + strategyResult
 *   shadow_semantic_full      → trace (blocked) + blockedReason
 *   semantic_primary          → trace (blocked) + blockedReason
 */
export interface RoutingPipelineResult {
  readonly mode: RoutingMode;
  readonly taskProfile?: TaskProfile;
  readonly retrievalResult?: CandidateRetrievalResult;
  readonly strategyResult?: StrategyPlannerResult;
  readonly trace: RoutingDecisionTrace;
  readonly blockedReason?: string;
}
