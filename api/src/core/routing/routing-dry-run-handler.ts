// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-dry-run-handler.ts — pure routing dry-run.
 *
 * MVP 3 invariants:
 *   - Pure function. Dependencies injected.
 *   - DOES NOT call any provider, DB, Redis, TEI, or HNSW.
 *   - DOES NOT call `fetch`.
 *   - DOES NOT import orchestration engine, chat route, experiment runner.
 *   - Operates entirely on the registry passed in (fixture-driven in tests).
 *   - Produces a `RoutingDecisionTrace` describing the (lack of) decision.
 *   - When a `traceCollector` is supplied, enqueues the trace fire-and-forget.
 *
 * MVP 3 deliberately keeps the result MINIMAL — registry size, candidate
 * count, optionally `selectedRouteId` only if the caller explicitly hints
 * a route. Real candidate retrieval / scoring lands in MVP 5+.
 */

import type { RuntimeModelRegistry } from '../registry/runtime-model-registry';
import type {
  RoutingDecisionTrace,
  RoutingTraceMetrics,
  TaskProfileSummary,
} from './routing-decision-trace';
import { noopRoutingTraceMetrics } from './routing-decision-trace';
import type { RoutingTraceCollector } from './routing-trace-collector';
import { redactRoutingTrace } from './routing-redaction';
import type { ExplicitPinInfo } from '../registry/types';

// ─── Input / output / deps ──────────────────────────────────────────────

export interface RoutingDryRunInput {
  readonly requestId: string;
  /** Optional model string. NOT used for execution — only for `selectedRouteId` hint. */
  readonly model?: string;
  /**
   * Free-form messages. Accepted to mirror the chat-request shape, but
   * the handler discards them through redaction — see invariants.
   */
  readonly messages?: unknown;
  /** Optional categorical task profile. Defaults to a `general` profile. */
  readonly taskProfile?: TaskProfileSummary;
  /** Optional explicit pin info passed through to the trace. */
  readonly explicitModelPin?: ExplicitPinInfo;
}

export interface RoutingDryRunDeps {
  readonly registry: RuntimeModelRegistry;
  readonly traceCollector?: RoutingTraceCollector;
  readonly metrics?: RoutingTraceMetrics;
  /** Source of "now" — defaults to `Date.now()`. Injectable for determinism. */
  readonly now: () => string;
  /** Source of trace ids — defaults to a counter. Injectable for determinism. */
  readonly traceIdProvider?: () => string;
}

export interface RoutingDryRunResult {
  readonly traceId: string;
  readonly trace: RoutingDecisionTrace;
  readonly registrySize: {
    readonly canonical: number;
    readonly offerings: number;
    readonly routes: number;
  };
  /** Number of candidates considered. In MVP 3, equals registry route count. */
  readonly candidateCount: number;
  /**
   * If the caller passed `model` AND a route with `requestModelId === model`
   * exists, this is its routeId. Otherwise `null`. NOT a real selection —
   * just a structural hint surfaced for the operator.
   */
  readonly selectedRouteIdHint: string | null;
  readonly note: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

let _counter = 0;
function defaultTraceIdProvider(): string {
  _counter += 1;
  return `trace-${_counter.toString(36)}-${Date.now().toString(36)}`;
}

function defaultProfile(): TaskProfileSummary {
  return {
    taskType: 'general',
    complexity: 'medium',
    modalities: ['text'],
    riskLevel: 'low',
    privacyMode: 'standard',
  };
}

// ─── Handler ────────────────────────────────────────────────────────────

/**
 * Returns the dry-run result. Synchronous in spirit — the only async
 * effect is the trace collector enqueue, which is itself sync but lives
 * behind the optional dependency.
 */
export async function dryRunRouting(
  input: RoutingDryRunInput,
  deps: RoutingDryRunDeps,
): Promise<RoutingDryRunResult> {
  const traceIdProvider = deps.traceIdProvider ?? defaultTraceIdProvider;
  const metrics = deps.metrics ?? noopRoutingTraceMetrics;
  const taskProfile = input.taskProfile ?? defaultProfile();
  const traceId = traceIdProvider();
  const timestamp = deps.now();

  const size = deps.registry.size();

  // Look up the routeId hint structurally — NO provider call, NO scoring.
  let selectedRouteIdHint: string | null = null;
  if (typeof input.model === 'string' && input.model.length > 0) {
    // Search across canonical models for an exact requestModelId match.
    // Tests rely on this being deterministic and read-only.
    for (const route of iterateAllRoutes(deps.registry)) {
      if (route.requestModelId === input.model) {
        selectedRouteIdHint = route.routeId;
        break;
      }
    }
  }

  // Build the trace. Redaction is applied at enqueue time AND at output.
  const rawTrace: RoutingDecisionTrace = {
    traceId,
    requestId: input.requestId,
    timestamp,
    routingMode: 'legacy', // MVP 3 is observation-only — mode is never primary
    taskProfile,
    semanticIndexBackend: 'none', // MVP 3: no semantic backend wired
    candidatesEvaluated: size.routes,
    candidatesByStage: { initial: size.routes },
    rejectedByStage: [],
    selectedCanonicalModelId: null,
    selectedOfferingId: null,
    selectedRouteId: selectedRouteIdHint,
    scoreBreakdown: {},
    strategyPlan: { strategy: 'none', routes: [] },
    explicitModelPin: input.explicitModelPin ?? null,
    pinSubstitution: null,
    latencyByPhase: {},
  };

  const trace = redactRoutingTrace(rawTrace);

  // Best-effort enqueue. Per the invariant, enqueue is sync and never throws.
  if (deps.traceCollector) {
    deps.traceCollector.enqueue(trace);
  }
  metrics.increment('routing_admin_endpoint_invocations_total', {
    endpoint: 'dry_run',
    result: 'ok',
  });

  return {
    traceId,
    trace,
    registrySize: size,
    candidateCount: size.routes,
    selectedRouteIdHint,
    note:
      'DRY-RUN MVP 3: this handler does NOT call providers, DB, Redis, TEI, or HNSW. ' +
      'No selection/scoring/strategy logic is applied yet — that lands in MVP 5+.',
  };
}

/**
 * Iterator helper — yields every route in the registry. Uses the
 * canonical→routes index to avoid building a flat array of 70k+
 * entries when not needed.
 */
function* iterateAllRoutes(registry: RuntimeModelRegistry) {
  // Conceptually: for each canonical, get routes. But the registry
  // exposes routesForCanonical and we need ALL routes — easiest is to
  // walk through canonical ids we can discover via the public API.
  // MVP 1's registry only exposes `routesForCanonical` and
  // `routesForOffering`, plus `size`. There's no `entries()` yet.
  //
  // For MVP 3 we add NO new public API. We iterate by looking up by
  // routeId — but we don't know the ids. Workaround: the dry-run
  // handler does NOT iterate in production; it accepts that there's no
  // public iterator and falls back to `routesForCanonical` over every
  // canonical id when needed via getModelSnapshots().
  for (const snapshot of registry.getModelSnapshots()) {
    if (!snapshot.id || !snapshot.providerId) continue;
    const canonicalModelId = `${snapshot.providerId}:${snapshot.id}`;
    const routes = registry.routesForCanonical(canonicalModelId);
    for (const r of routes) yield r;
  }
}
