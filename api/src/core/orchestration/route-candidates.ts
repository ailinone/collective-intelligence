// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-H §8 — Multi-Route Candidate Types.
 *
 * Types for the multi-route plan model. Every role in a consensus plan
 * carries:
 *   - `logicalModelId` (the abstract model selected by role resolver)
 *   - `routeCandidates[]` (ordered list of concrete routes that can
 *     reach the logical model)
 *   - `routeSelectionPolicy` (deterministic policy that orders + bounds
 *     the cascade)
 *
 * The triple `{ providerId, apiModelId, adapterKind }` constitutes a
 * concrete ROUTE. Two routes for the same logical model may use the
 * SAME apiModelId on different providers (router peerings) OR a
 * DIFFERENT apiModelId on the same provider's namespace style
 * (e.g., `gpt-4o` direct vs. `openai/gpt-4o` via OpenRouter).
 *
 * Sanitization invariants:
 *   - `authRef` is a HANDLE to the loader (e.g., `gcp:openai-key`), NOT
 *     a secret value. Never include real API keys here.
 *   - All cost/health/latency ranks are integers in `[0..100]` (lower
 *     is better when used as `costRank`, higher when used as `healthRank`).
 *     The builder normalizes to this scale.
 *   - `lastFailureKind` is one of the `ProviderErrorKind` enum strings.
 */

import type { ProviderErrorKind } from './failures/provider-error-classifier';

/**
 * Capability category a route can serve. Consensus participants /
 * synthesizer / judge / fallback ALL require `endpointKind='chat'`.
 */
export type RouteEndpointKind =
  | 'chat'
  | 'embeddings'
  | 'rerank'
  | 'image'
  | 'audio'
  | 'video'
  | 'unknown';

/**
 * How a route is equivalent to the LOGICAL model the role resolver
 * picked. Strict consensus only permits the top 2 categories; the third
 * is permitted in DIAGNOSTIC dry-run but blockers escalate if executable
 * is requested without exact-equivalence proof.
 */
export type RouteEquivalenceKind =
  | 'exact_same_model'                  // identical apiModelId on native + same training
  | 'same_provider_model_via_router'    // same native model accessed via router peering
  | 'router_alias_probable'             // router lists a same-name model but no canonical proof
  | 'family_equivalent'                 // sibling within same model family
  | 'not_equivalent';                   // different model entirely

/**
 * Source of evidence for this route. Higher-priority sources are listed
 * first; the builder uses this to break ties when ordering routes.
 */
export type RouteCandidateSource =
  | 'last_success'           // recently chat-succeeded — strongest live signal
  | 'native_provider'        // direct provider catalog entry
  | 'provider_discovery'     // discovered via provider's /v1/models endpoint
  | 'router_taxonomy'        // derived from provider-routing-taxonomy peering
  | 'catalog_binding'        // catalog row points at this route
  | 'manual_probe_spec';     // caller passed it explicitly

export interface ApprovedRouteCandidate {
  /** Stable id for this exact route. Recommended formula:
   *  `<providerId>::<apiModelId>::<adapterKind>` */
  readonly routeId: string;
  /** Abstract model identity the role resolver picked. */
  readonly logicalModelId: string;
  /** Model id string accepted by THIS route's endpoint. May differ from
   *  `logicalModelId` (router-rewritten alias). */
  readonly apiModelId: string;
  /** Provider id that will receive the chat completion call. When this
   *  is a router (e.g., `huggingface`), `upstreamProviderId` is set. */
  readonly providerId: string;
  /** When `providerId` is a router serving a specific upstream backend:
   *  the upstream's id (e.g., `togetherai` when `providerId=huggingface`). */
  readonly routerId?: string;
  /** When `providerId` is a router and `upstreamProviderId` is set: the
   *  slug the router uses internally (e.g., `together` for togetherai
   *  via HF router). */
  readonly upstreamProviderId?: string;
  /** The native provider this route represents end-to-end. Equal to
   *  `providerId` for direct routes; equal to `upstreamProviderId` for
   *  router routes. */
  readonly nativeProviderId?: string;
  /** Adapter format identifier (e.g., `openai-compatible-chat`,
   *  `anthropic-messages`, `google-generative-content`). */
  readonly adapterKind: string;
  /** Endpoint capability this route serves. Consensus roles require chat. */
  readonly endpointKind: RouteEndpointKind;
  /** Equivalence guarantee versus the logical model. */
  readonly equivalenceKind: RouteEquivalenceKind;
  /** Sanitized handle to the credential loader. Never contains a real key. */
  readonly authRef?: string;
  /** Cost rank (lower is cheaper). Range `[0..100]`. */
  readonly costRank?: number;
  /** Health rank (higher is healthier). Range `[0..100]`. */
  readonly healthRank?: number;
  /** Latency rank (lower is faster). Range `[0..100]`. */
  readonly latencyRank?: number;
  /** Whether the live-operability store flags this exact `(providerId, routeId, apiModelId)`
   *  as chat-ready RECENTLY. */
  readonly liveReady: boolean;
  /** ISO timestamp of the last recorded chat success for this route. */
  readonly lastSuccessAt?: string;
  /** Most recent failure kind, if any. */
  readonly lastFailureKind?: ProviderErrorKind;
  /** ISO timestamp of the last recorded failure. */
  readonly lastFailureAt?: string;
  /** Effective input context window for this route. */
  readonly maxContextTokens?: number;
  /** Sanitized cost per million input tokens (lookup, not billing). */
  readonly inputCostPerMTok?: number;
  /** Sanitized cost per million output tokens. */
  readonly outputCostPerMTok?: number;
  /** Source of evidence for this route. */
  readonly source: RouteCandidateSource;
}

/**
 * Deterministic policy for ordering + bounding the route cascade.
 * Included in the plan fingerprint so the executor cannot relax limits
 * after approval.
 *
 * - `orderBy`: ordered list of ranking criteria. Order matters: ties on
 *   the first criterion are broken by the second, etc.
 * - `maxRouteAttempts`: hard ceiling on the number of routes tried.
 *   Strict mode default: 3 (native + 2 router fallbacks).
 * - `allowOutOfPlanRoutes`: ALWAYS false in strict mode. Runtime cannot
 *   manufacture a route that wasn't in the approved plan.
 * - `allowModelFallback`: whether the executor can swap the logical
 *   model when all routes for the current model fail. Strict consensus:
 *   false (a failed model is a role failure, not a model swap event).
 * - `allowRouterFallback`: whether cascade can move from native →
 *   router routes. Strict consensus: true (the whole point).
 * - `requireLiveReadyForCriticalRoles`: when true, a route must have
 *   `liveReady=true` to be in the approved list for participant /
 *   synthesizer / judge / fallback.
 *
 * 01C.1B-J1R2 — Two-stage capping:
 *
 * - `discoveryMaxRouteCandidates`: ceiling on routes the **discovery /
 *   preprobe / dry-run** view exposes to operators. Defaults very high
 *   (200) so the dry-run shows the full multi-provider fanout. Routes
 *   beyond this cap are tagged `over_attempt_cap` rejections.
 * - `runtimeMaxRouteAttempts`: ceiling on routes the **executor** will
 *   actually try at request time. Strict default: 3. The fingerprint
 *   carries `runtimeMaxRouteAttempts` — not `discoveryMaxRouteCandidates` —
 *   because only the runtime cap influences execution semantics.
 * - `maxRouteAttempts`: legacy alias kept for backward compatibility.
 *   The builder uses `runtimeMaxRouteAttempts ?? maxRouteAttempts` for
 *   the runtime cap and `discoveryMaxRouteCandidates ?? max(200,
 *   maxRouteAttempts)` for the discovery cap.
 */
export interface RouteSelectionPolicy {
  readonly orderBy: readonly RouteOrderCriterion[];
  readonly maxRouteAttempts: number;
  readonly discoveryMaxRouteCandidates?: number;
  readonly runtimeMaxRouteAttempts?: number;
  readonly allowOutOfPlanRoutes: false;
  readonly allowModelFallback: boolean;
  readonly allowRouterFallback: boolean;
  readonly requireLiveReadyForCriticalRoles: boolean;
}

export type RouteOrderCriterion =
  | 'liveReady'
  | 'recentSuccess'
  | 'cost'
  | 'latency'
  | 'context'
  | 'nativeFirst';

/**
 * Strict default policy used when the caller does not override.
 * Bake into the fingerprint via `STRICT_DEFAULT_ROUTE_SELECTION_POLICY`.
 */
export const STRICT_DEFAULT_ROUTE_SELECTION_POLICY: RouteSelectionPolicy = {
  orderBy: ['liveReady', 'recentSuccess', 'nativeFirst', 'cost', 'latency'],
  maxRouteAttempts: 3,
  // J1R2 — discovery exposes up to 200 candidates so operators can see
  // the full multi-provider fanout; runtime cap stays at 3 (strict).
  discoveryMaxRouteCandidates: 200,
  runtimeMaxRouteAttempts: 3,
  allowOutOfPlanRoutes: false,
  allowModelFallback: false,
  allowRouterFallback: true,
  requireLiveReadyForCriticalRoles: true,
};

/**
 * Resolve effective discovery/runtime caps from a policy, honoring the
 * legacy `maxRouteAttempts` alias and reasonable defaults.
 *
 * J1R2 invariant: `discoveryMaxRouteCandidates >= runtimeMaxRouteAttempts`.
 * If a caller pins discovery lower than runtime, the resolver lifts
 * discovery to runtime (operators always see at least what the executor
 * will try).
 */
export function resolveRouteCaps(policy: RouteSelectionPolicy): {
  readonly discoveryCap: number;
  readonly runtimeCap: number;
} {
  const runtimeCap = policy.runtimeMaxRouteAttempts ?? policy.maxRouteAttempts;
  const discoveryCap = Math.max(
    policy.discoveryMaxRouteCandidates ?? Math.max(200, runtimeCap),
    runtimeCap,
  );
  return { discoveryCap, runtimeCap };
}

/**
 * Rejection record: a route that was CONSIDERED but excluded from the
 * approved list. Operators see these in `consensusPlan.routeCandidateRejections`
 * to understand why a particular route didn't make it.
 */
export interface RouteCandidateRejection {
  readonly routeId: string;
  readonly providerId: string;
  readonly logicalModelId: string;
  readonly reason:
    | 'capability_mismatch'
    | 'over_budget'
    | 'unhealthy'
    | 'unauditied_live_state'
    | 'over_attempt_cap'
    | 'equivalence_too_loose'
    | 'auth_handle_missing'
    | 'duplicate_route_id';
  readonly detail?: string;
}

/**
 * Per-role coverage summary surfaced in the plan.
 */
export interface RouteCandidateCoverage {
  readonly role: string;
  readonly logicalModelId: string;
  readonly approvedCount: number;
  readonly liveReadyCount: number;
  readonly rejectedCount: number;
  readonly hasNativeRoute: boolean;
  readonly hasRouterRoute: boolean;
}

/**
 * Helper for building stable, deterministic route ids.
 */
export function buildRouteId(input: {
  readonly providerId: string;
  readonly apiModelId: string;
  readonly adapterKind: string;
}): string {
  return `${input.providerId}::${input.apiModelId}::${input.adapterKind}`;
}

/**
 * Canonical-JSON shape that goes into the plan fingerprint. We project
 * ONLY the fields that influence routing semantics so cosmetic changes
 * (e.g., `lastSuccessAt` drift) don't churn the fingerprint.
 */
export interface RouteCandidateFingerprintShape {
  readonly routeId: string;
  readonly logicalModelId: string;
  readonly apiModelId: string;
  readonly providerId: string;
  readonly routerId?: string;
  readonly upstreamProviderId?: string;
  readonly adapterKind: string;
  readonly endpointKind: RouteEndpointKind;
  readonly equivalenceKind: RouteEquivalenceKind;
}

export function projectRouteForFingerprint(c: ApprovedRouteCandidate): RouteCandidateFingerprintShape {
  const shape: RouteCandidateFingerprintShape = {
    routeId: c.routeId,
    logicalModelId: c.logicalModelId,
    apiModelId: c.apiModelId,
    providerId: c.providerId,
    routerId: c.routerId,
    upstreamProviderId: c.upstreamProviderId,
    adapterKind: c.adapterKind,
    endpointKind: c.endpointKind,
    equivalenceKind: c.equivalenceKind,
  };
  return shape;
}
