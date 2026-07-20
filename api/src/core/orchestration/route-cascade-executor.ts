// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-H §12 — Route Cascade Executor.
 *
 * Pure executor for the multi-route cascade. Given an ordered list of
 * approved `ApprovedRouteCandidate` entries (from the dry-run plan) and
 * a route-call function (injected by the caller), it:
 *
 *   1. Tries each route in order until one succeeds.
 *   2. Records a `ProviderRouteAttempt` per try (success or failure).
 *   3. Honors `RouteSelectionPolicy.maxRouteAttempts` as the hard cap.
 *   4. NEVER consults a route outside the approved list (the strict
 *      `allowOutOfPlanRoutes=false` invariant).
 *   5. Updates `wasRouteFallback` after the first attempt, never claims
 *      `wasModelFallback` (those are decided at a layer above the route
 *      cascade).
 *   6. Surfaces a final `RoleExecutionOutcome` with:
 *        - success route (if any)
 *        - all attempts
 *        - aggregate failure kind when every route failed
 *
 * Pure means:
 *   - No network calls. Caller injects `callRoute()` which encapsulates
 *     the real adapter invocation.
 *   - No DB calls. Caller's `recordAttempt()` callback persists state.
 *   - No clocks. Caller injects `now()` for testable timestamps.
 *
 * The executor is consumed by `consensus-strategy.ts` (or whatever
 * orchestration layer runs the role). Wiring into that strategy is OUT
 * of scope for this module — the executor stays adapter-agnostic.
 */
import type { ProviderErrorKind } from './failures/provider-error-classifier';
import type {
  ProviderRouteAttemptArtifact,
  ProviderRouteAttemptRole,
} from './provider-route-attempt-artifact';
import type {
  ApprovedRouteCandidate,
  RouteSelectionPolicy,
} from './route-candidates';

/**
 * Per-attempt artifact recorded by the cascade. One entry per route the
 * executor actually tried (skipped routes do not get an attempt entry).
 *
 * 01C.1B-I §6 reuse audit (decision `extend_existing`): this type now
 * STRICTLY EXTENDS the shared `ProviderRouteAttemptArtifact` so the
 * dry-run planner + runtime executor agree on the base 11 fields. The
 * extension adds runtime-only fields (timing, error kind, cost, route
 * provenance). When the runtime emits a record, callers consuming the
 * dry-run shape see a structural superset.
 *
 * The shared base is in `./provider-route-attempt-artifact.ts`.
 */
export interface ProviderRouteAttempt extends ProviderRouteAttemptArtifact {
  // role / providerId / routeId / modelId / attempt / maxAttempts / ok /
  // startedAt / wasRetried / wasRouteFallback / wasModelFallback inherited.
  // Runtime-only extensions:
  readonly logicalModelId: string;
  readonly routerId?: string;
  readonly upstreamProviderId?: string;
  /** Wire-level api model id used in the actual call.
   *  Equals `modelId` when no router alias is in play. */
  readonly apiModelId: string;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly httpStatus?: number;
  readonly errorKind?: ProviderErrorKind;
  readonly retryable: boolean;
  /** Cascade never retries the same route — overridden to false literal. */
  readonly wasRetried: false;
  /** Cascade never swaps model — overridden to false literal. */
  readonly wasModelFallback: false;
  readonly costUsd: number;
}

// Re-export the shared role type so callers don't need to know about
// the separate file.
export type { ProviderRouteAttemptRole };

/**
 * Result of a single route call provided by the caller.
 */
export interface RouteCallResult<TResp> {
  readonly ok: boolean;
  readonly response?: TResp;
  readonly httpStatus?: number;
  readonly errorKind?: ProviderErrorKind;
  readonly sanitizedMessage?: string;
  readonly costUsd: number;
}

/**
 * Caller-injected function that ACTUALLY invokes the route. Pure
 * interface — the executor doesn't know about adapters, HTTP, etc.
 */
export type RouteCallFn<TResp> = (
  candidate: ApprovedRouteCandidate,
  attempt: number,
) => Promise<RouteCallResult<TResp>>;

/**
 * Caller-injected sink for per-attempt records. The executor records
 * every attempt EVEN ON SUCCESS so the audit trail is complete. The
 * sink decides where the record goes (memory, DB, OTEL span, etc.).
 */
export type AttemptSink = (attempt: ProviderRouteAttempt) => void;

export interface RoleExecutionOutcome<TResp> {
  readonly success: boolean;
  /** When `success=true`: the route that produced the response. */
  readonly winningRoute?: ApprovedRouteCandidate;
  /** When `success=true`: the response payload (caller's TResp shape). */
  readonly response?: TResp;
  /** ALL attempts recorded in this cascade, in attempt order. */
  readonly attempts: readonly ProviderRouteAttempt[];
  /** When `success=false`: the error kind of the FIRST attempt for ops
   *  telemetry. The aggregate failure kind is `'all_routes_failed'`. */
  readonly firstErrorKind?: ProviderErrorKind;
  /** When `success=false`: aggregate label. */
  readonly aggregateFailure?: 'all_routes_failed' | 'no_approved_routes' | 'attempt_cap_exhausted';
}

export interface CascadeRunInput<TResp> {
  readonly role: string;
  readonly logicalModelId: string;
  readonly approvedRoutes: readonly ApprovedRouteCandidate[];
  readonly policy: RouteSelectionPolicy;
  readonly callRoute: RouteCallFn<TResp>;
  readonly recordAttempt?: AttemptSink;
  readonly now?: () => number;
}

/**
 * Run the cascade. Pure, deterministic given fixed `callRoute` + `now`.
 *
 * Error policy (from §12.3):
 *   - insufficient_credits → next route
 *   - invalid_auth         → next route
 *   - rate_limited         → next route
 *   - model_not_supported  → next route
 *   - timeout              → next route (caller's deadline policy enforced
 *                            outside this module)
 *   - server_error         → next route
 *   - network_error        → next route
 *   - any unknown          → next route (conservative — let the next route
 *                            try; if it also fails, role surfaces failure)
 *
 * The cascade does NOT retry the same route. Per the route-selection
 * policy, every attempt is on a DIFFERENT route. The legacy retry
 * (`maxRetriesPerProvider`) is enforced inside the adapter — not here.
 */
export async function runRouteCascade<TResp>(
  input: CascadeRunInput<TResp>,
): Promise<RoleExecutionOutcome<TResp>> {
  const attempts: ProviderRouteAttempt[] = [];

  if (input.approvedRoutes.length === 0) {
    return {
      success: false,
      attempts: [],
      aggregateFailure: 'no_approved_routes',
    };
  }

  const cap = Math.min(input.policy.maxRouteAttempts, input.approvedRoutes.length);
  const now = input.now ?? (() => Date.now());

  let firstErrorKind: ProviderErrorKind | undefined;

  for (let i = 0; i < cap; i++) {
    const candidate = input.approvedRoutes[i];
    const attempt = i + 1;
    const startedMs = now();
    const startedAt = new Date(startedMs).toISOString();

    let result: RouteCallResult<TResp>;
    try {
      result = await input.callRoute(candidate, attempt);
    } catch (err) {
      // The callRoute contract says it should NEVER throw — it should
      // catch internally and return `{ ok: false, ... }`. If a throw
      // happens, we treat it as an unknown failure but DON'T let it
      // crash the cascade.
      result = {
        ok: false,
        errorKind: 'unknown',
        sanitizedMessage: err instanceof Error ? err.message.slice(0, 200) : 'unknown_throw',
        costUsd: 0,
      };
    }

    const completedMs = now();
    const completedAt = new Date(completedMs).toISOString();
    const latencyMs = Math.max(0, completedMs - startedMs);

    const record: ProviderRouteAttempt = {
      // Inherited from ProviderRouteAttemptArtifact:
      role: input.role as ProviderRouteAttemptRole,
      routeId: candidate.routeId,
      providerId: candidate.providerId,
      modelId: candidate.apiModelId,  // shared artifact uses `modelId` for the wire-level id
      attempt,
      maxAttempts: cap,
      ok: result.ok,
      startedAt,
      wasRetried: false,
      wasRouteFallback: i > 0,
      wasModelFallback: false,
      // Runtime-only extensions:
      logicalModelId: input.logicalModelId,
      routerId: candidate.routerId,
      upstreamProviderId: candidate.upstreamProviderId,
      apiModelId: candidate.apiModelId,
      completedAt,
      latencyMs,
      httpStatus: result.httpStatus,
      errorKind: result.errorKind,
      retryable: false,
      costUsd: result.costUsd,
    };
    attempts.push(record);
    input.recordAttempt?.(record);

    if (result.ok) {
      return {
        success: true,
        winningRoute: candidate,
        response: result.response,
        attempts,
      };
    }

    if (firstErrorKind === undefined) {
      firstErrorKind = result.errorKind;
    }

    // Continue to next route per the error policy. The cascade is
    // intentionally permissive (any failure → next route) — the
    // route-selection policy already filtered out non-eligible routes
    // upstream in the builder.
  }

  return {
    success: false,
    attempts,
    firstErrorKind,
    aggregateFailure: attempts.length < input.approvedRoutes.length
      ? 'attempt_cap_exhausted'
      : 'all_routes_failed',
  };
}

/**
 * Summarize a list of role outcomes for the plan's metadata surface.
 * Pure projection used by the audit script + dry-run service.
 */
export interface CascadeRunSummary {
  readonly totalRoles: number;
  readonly succeededRoles: number;
  readonly totalAttempts: number;
  readonly fallbackUsedCount: number;  // attempts where wasRouteFallback=true
  readonly totalCostUsd: number;
  readonly perRole: ReadonlyArray<{
    readonly role: string;
    readonly success: boolean;
    readonly winningRouteId?: string;
    readonly attemptsCount: number;
    readonly aggregateFailure?: string;
  }>;
}

export function summarizeCascadeRuns<TResp>(
  outcomes: readonly (RoleExecutionOutcome<TResp> & { role: string })[],
): CascadeRunSummary {
  let totalAttempts = 0;
  let fallbackUsedCount = 0;
  let totalCostUsd = 0;
  const perRole: CascadeRunSummary['perRole'] = outcomes.map((o) => {
    for (const a of o.attempts) {
      totalAttempts++;
      if (a.wasRouteFallback) fallbackUsedCount++;
      totalCostUsd += a.costUsd;
    }
    return {
      role: o.role,
      success: o.success,
      winningRouteId: o.winningRoute?.routeId,
      attemptsCount: o.attempts.length,
      aggregateFailure: o.aggregateFailure,
    };
  });
  return {
    totalRoles: outcomes.length,
    succeededRoles: outcomes.filter((o) => o.success).length,
    totalAttempts,
    fallbackUsedCount,
    totalCostUsd,
    perRole,
  };
}
