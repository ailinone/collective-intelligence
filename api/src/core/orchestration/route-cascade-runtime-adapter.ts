// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-I3B — RouteCascade Runtime Adapter (glue layer).
 *
 * Encapsulates the runtime wiring between the consensus strategy's
 * execution loop and the pure `RouteCascadeExecutor`. Purpose:
 *
 *   - When `eval.useRouteCascade=true`, instead of a single
 *     `executeModel(adapter, model, request, role)` call, the role
 *     iterates through `buildRouteCandidatesForModel(...)` outputs via
 *     `runRouteCascade(...)`.
 *   - On each attempt, the adapter for the route's providerId is
 *     resolved and the request is invoked with the route's apiModelId.
 *   - Per-attempt records flow into a caller-provided sink.
 *   - LiveChatOperabilityStore is updated by the caller's callRoute
 *     wrapper (kept here as an abstraction so tests can inject pure mocks).
 *
 * Strict invariants:
 *   - NEVER calls a route outside `approvedRoutes`.
 *   - NEVER changes the logical model during cascade.
 *   - NEVER retries the same route.
 *   - When `approvedRoutes` is empty: throws structured error
 *     `no_approved_route_candidates` before any provider call.
 *
 * This module ONLY exists when `useRouteCascade=true` is on the eval
 * bag. The legacy path in `consensus-strategy.ts` is untouched.
 */
import type { ChatRequest, Model, ModelExecution } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
// Local alias so the public type name stays readable.
type ChatAdapter = ProviderAdapter;
import { classifyProviderError, type ProviderErrorKind } from './failures/provider-error-classifier';
import {
  runRouteCascade,
  type ProviderRouteAttempt,
  type RouteCallResult,
} from './route-cascade-executor';
import {
  buildRouteCandidatesForModel,
  type ApiModelIdResolver,
  type LiveOperabilityLookup,
  type RouteEconomicsLookup,
} from './build-route-candidates';
import {
  STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
  type ApprovedRouteCandidate,
  type RouteSelectionPolicy,
} from './route-candidates';

/** Caller-supplied function to resolve the chat adapter for a given
 *  (providerId, apiModelId) pair. The strategy already has
 *  `getAdapterForModel(model, context)`; this adapter shim builds a
 *  synthetic `Model` with the route's `providerId` + `apiModelId` and
 *  delegates. */
export type RouteAdapterResolver = (input: {
  readonly providerId: string;
  readonly apiModelId: string;
  readonly logicalModel: Model;
}) => Promise<ChatAdapter | null>;

/** Caller-supplied function that runs the actual provider call (wraps
 *  `BaseStrategy.executeModel(adapter, model, request, role)` or
 *  equivalent). The wrapper accepts a per-route model + adapter so the
 *  call dispatches to the right provider. */
export type RouteChatExecutor = (input: {
  readonly adapter: ChatAdapter;
  readonly model: Model;
  readonly request: ChatRequest;
  readonly role: string;
}) => Promise<ModelExecution>;

/** Caller-supplied function to update the LiveChatOperabilityStore for
 *  a single (providerId, routeId, apiModelId) triple. The adapter shim
 *  invokes this after each cascade attempt. */
export type OperabilitySink = (input: {
  readonly route: ApprovedRouteCandidate;
  readonly ok: boolean;
  readonly errorKind?: ProviderErrorKind;
  readonly httpStatus?: number;
  readonly sanitizedMessage?: string;
}) => void;

export interface RunRoleViaRouteCascadeInput {
  readonly role: string;
  readonly logicalModel: Model;
  readonly request: ChatRequest;
  /** Pre-resolved approved routes (when caller already built them).
   *  When omitted, the adapter builds them on-demand using the routing
   *  taxonomy + live operability lookup. */
  readonly approvedRoutes?: readonly ApprovedRouteCandidate[];
  readonly policy?: RouteSelectionPolicy;
  readonly resolveAdapter: RouteAdapterResolver;
  readonly executeChat: RouteChatExecutor;
  readonly recordAttempt?: (a: ProviderRouteAttempt) => void;
  readonly operabilitySink?: OperabilitySink;
  /** When `approvedRoutes` is omitted, these injected lookups are used
   *  to build them on-demand. Caller is responsible for wrapping
   *  LiveChatOperabilityStore + model catalog. */
  readonly builderInjections?: {
    readonly resolveApiModelId: ApiModelIdResolver;
    readonly lookupLiveOperability: LiveOperabilityLookup;
    readonly lookupEconomics: RouteEconomicsLookup;
    readonly maxCostUsd?: number;
  };
}

export interface RunRoleViaRouteCascadeResult {
  readonly success: boolean;
  readonly execution: ModelExecution | null;
  readonly attempts: readonly ProviderRouteAttempt[];
  readonly winningRoute: ApprovedRouteCandidate | null;
  readonly aggregateFailure?: 'no_approved_route_candidates' | 'no_live_ready_routes' |
                              'all_routes_failed' | 'attempt_cap_exhausted';
  readonly rejections?: readonly unknown[];
}

/**
 * Run a single role's execution via the RouteCascade.
 *
 * Pure-ish: `executeChat` + `resolveAdapter` are caller-injected so unit
 * tests can mock them. The function itself contains no provider calls,
 * no DB calls, no globals.
 */
export async function runRoleViaRouteCascade(
  input: RunRoleViaRouteCascadeInput,
): Promise<RunRoleViaRouteCascadeResult> {
  const policy: RouteSelectionPolicy = input.policy ?? STRICT_DEFAULT_ROUTE_SELECTION_POLICY;

  // Resolve approved routes (caller-supplied OR built on-demand).
  let approvedRoutes: readonly ApprovedRouteCandidate[];
  let rejections: readonly unknown[] = [];
  if (input.approvedRoutes !== undefined) {
    approvedRoutes = input.approvedRoutes;
  } else if (input.builderInjections) {
    const builderResult = buildRouteCandidatesForModel({
      role: input.role,
      logicalModelId: input.logicalModel.id,
      nativeProviderId: (input.logicalModel.provider ?? 'unknown').toLowerCase(),
      taskCapability: 'chat',
      resolveApiModelId: input.builderInjections.resolveApiModelId,
      lookupLiveOperability: input.builderInjections.lookupLiveOperability,
      lookupEconomics: input.builderInjections.lookupEconomics,
      lookupAuthHandle: ({ providerId }) => `loader:${providerId}`,  // presence handle
      maxCostUsd: input.builderInjections.maxCostUsd,
      policy,
    });
    approvedRoutes = builderResult.approved;
    rejections = builderResult.rejections;
  } else {
    throw Object.assign(new Error('no_approved_route_candidates'), {
      code: 'NO_APPROVED_ROUTE_CANDIDATES',
      role: input.role,
      logicalModelId: input.logicalModel.id,
      detail:
        'useRouteCascade=true requires either pre-resolved approvedRoutes OR builderInjections to build them on demand.',
    });
  }

  if (approvedRoutes.length === 0) {
    return {
      success: false,
      execution: null,
      attempts: [],
      winningRoute: null,
      aggregateFailure: 'no_approved_route_candidates',
      rejections,
    };
  }

  // Build the cascade's callRoute wrapper that invokes the caller's
  // executor for each route.
  let lastExecution: ModelExecution | null = null;
  const callRoute = async (
    candidate: ApprovedRouteCandidate,
    _attempt: number,
  ): Promise<RouteCallResult<ModelExecution>> => {
    // Resolve the adapter for this route's providerId.
    let adapter: ChatAdapter | null = null;
    try {
      adapter = await input.resolveAdapter({
        providerId: candidate.providerId,
        apiModelId: candidate.apiModelId,
        logicalModel: input.logicalModel,
      });
    } catch {
      adapter = null;
    }
    if (!adapter) {
      return {
        ok: false,
        errorKind: 'unknown',
        sanitizedMessage: 'adapter_resolution_failed',
        costUsd: 0,
      };
    }
    // Build the per-route model snapshot the executor expects.
    const routeModel: Model = {
      ...input.logicalModel,
      id: candidate.apiModelId,
      provider: candidate.providerId,
    } as Model;
    try {
      const execution = await input.executeChat({
        adapter,
        model: routeModel,
        request: input.request,
        role: input.role,
      });
      lastExecution = execution;
      // Update operability sink with success.
      input.operabilitySink?.({
        route: candidate,
        ok: true,
      });
      return {
        ok: true,
        response: execution,
        httpStatus: 200,
        costUsd: 0,  // cost surfaced via the ModelExecution itself
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Use the existing classifier to bucket the failure.
      const statusMatch = msg.match(/HTTP\s+(\d{3})/) ?? msg.match(/^\s*(4\d{2}|5\d{2})\b/);
      const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
      const cls = classifyProviderError({ status: httpStatus, body: msg });
      input.operabilitySink?.({
        route: candidate,
        ok: false,
        errorKind: cls.kind,
        httpStatus,
        sanitizedMessage: cls.sanitizedMessage,
      });
      return {
        ok: false,
        httpStatus,
        errorKind: cls.kind,
        sanitizedMessage: cls.sanitizedMessage,
        costUsd: 0,
      };
    }
  };

  const cascade = await runRouteCascade<ModelExecution>({
    role: input.role,
    logicalModelId: input.logicalModel.id,
    approvedRoutes,
    policy,
    callRoute,
    recordAttempt: input.recordAttempt,
  });

  // Normalize aggregateFailure to the adapter's union type. The
  // underlying RouteCascadeExecutor uses 'no_approved_routes' but we
  // surface it as 'no_approved_route_candidates' for consistency with
  // the spec's vocabulary at this layer.
  const aggregateFailure: RunRoleViaRouteCascadeResult['aggregateFailure'] =
    cascade.aggregateFailure === 'no_approved_routes'
      ? 'no_approved_route_candidates'
      : cascade.aggregateFailure === 'all_routes_failed'
      ? 'all_routes_failed'
      : cascade.aggregateFailure === 'attempt_cap_exhausted'
      ? 'attempt_cap_exhausted'
      : undefined;

  return {
    success: cascade.success,
    execution: cascade.success ? lastExecution : null,
    attempts: cascade.attempts,
    winningRoute: cascade.winningRoute ?? null,
    aggregateFailure,
    rejections,
  };
}

/**
 * Test helper: validate that a candidate is in the approved list.
 * Used by callers that want to enforce the out-of-plan guard outside
 * the cascade (e.g., when re-validating a stored attempt).
 */
export function isRouteInPlan(
  candidate: { readonly routeId: string; readonly providerId: string; readonly apiModelId: string },
  approvedRoutes: readonly ApprovedRouteCandidate[],
): boolean {
  return approvedRoutes.some(
    (r) =>
      r.routeId === candidate.routeId ||
      (r.providerId === candidate.providerId && r.apiModelId === candidate.apiModelId),
  );
}
