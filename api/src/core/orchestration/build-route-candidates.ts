// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-H §9 — buildRouteCandidatesForModel().
 *
 * Pure function that, given a logical model + native provider id,
 * produces an ordered list of `ApprovedRouteCandidate` derived from:
 *   1. provider-routing-taxonomy v2 (`listModelRouteCandidates`)
 *   2. live-operability snapshot (per-route chat readiness)
 *   3. budget / capability / equivalence filters
 *
 * The function is COMPLETELY framework-agnostic and dependency-injected
 * — no DB calls, no HTTP, no globals. Caller passes:
 *   - the routing-taxonomy snapshot (or uses default global)
 *   - the live-operability lookup function
 *   - the model catalog lookup function
 *   - the cost / context lookup function
 *
 * The function NEVER throws. Rejections (capability mismatch, over-budget,
 * stale live state) are returned as `RouteCandidateRejection[]`. Caller
 * surfaces the rejections in the plan so operators see WHY a route was
 * excluded.
 */

import { listModelRouteCandidates, type ModelRouteCandidate } from '../operability/provider-routing-taxonomy';
import type { ProviderErrorKind } from './failures/provider-error-classifier';
import {
  buildRouteId,
  resolveRouteCaps,
  type ApprovedRouteCandidate,
  type RouteCandidateCoverage,
  type RouteCandidateRejection,
  type RouteEndpointKind,
  type RouteEquivalenceKind,
  type RouteOrderCriterion,
  type RouteSelectionPolicy,
  STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
} from './route-candidates';
import type { ServingProviderEntry } from './lookup-serving-providers';

// ──────────────────────────────────────────────────────────────────────
// Caller-supplied lookups
// ──────────────────────────────────────────────────────────────────────

/**
 * Returns the apiModelId the given (providerId, logicalModelId) should
 * use. For a native route, this is usually `logicalModelId` verbatim
 * (e.g., `gpt-4o` on openai). For a router route, this may be a
 * router-rewritten form (e.g., `openai/gpt-4o` on openrouter, or
 * `openai/gpt-4o:fastest` on huggingface).
 *
 * Returns `undefined` if the provider does not (yet) accept this model
 * — caller treats that as a rejection (`capability_mismatch`).
 */
export type ApiModelIdResolver = (input: {
  readonly providerId: string;
  readonly logicalModelId: string;
  readonly nativeProviderId: string;
  readonly upstreamProviderId?: string;
}) => string | undefined;

export interface LiveOperabilityLookupInput {
  readonly providerId: string;
  readonly routeId: string;
  readonly apiModelId: string;
}

export interface LiveOperabilityLookupResult {
  readonly chatReady: boolean;
  readonly lastSuccessAt?: string;
  readonly lastFailureKind?: ProviderErrorKind;
  readonly lastFailureAt?: string;
  readonly healthRank?: number;
}

/**
 * Returns the live-operability state for a `(providerId, routeId, apiModelId)`
 * triple. When the route has never been audited, return `{ chatReady: false }`
 * — caller treats it as `unauditied_live_state` rejection in strict mode.
 */
export type LiveOperabilityLookup = (input: LiveOperabilityLookupInput) => LiveOperabilityLookupResult;

export interface RouteEconomicsLookupInput {
  readonly providerId: string;
  readonly apiModelId: string;
}

export interface RouteEconomicsLookupResult {
  readonly inputCostPerMTok?: number;
  readonly outputCostPerMTok?: number;
  readonly maxContextTokens?: number;
  readonly latencyRank?: number;
  readonly costRank?: number;
}

export type RouteEconomicsLookup = (input: RouteEconomicsLookupInput) => RouteEconomicsLookupResult;

/**
 * Returns the adapter kind for a (providerId, apiModelId). Default
 * implementations return `'openai-compatible-chat'` for routers, native
 * adapter kind for direct providers.
 */
export type AdapterKindLookup = (input: { providerId: string }) => string;

/**
 * Returns the auth credential HANDLE (NOT the value) the executor would
 * use to authenticate to this route. Returning `undefined` means no
 * credential is loaded — caller treats as `auth_handle_missing`.
 *
 * Example return values:
 *   - `gcp:openai-key`
 *   - `env:OPENROUTER_API_KEY`
 *   - `aws:bedrock-iam-role:arn:aws:...:role/...`
 */
export type AuthHandleLookup = (input: { providerId: string }) => string | undefined;

// ──────────────────────────────────────────────────────────────────────
// Input / output shapes
// ──────────────────────────────────────────────────────────────────────

export interface BuildRouteCandidatesInput {
  readonly role: string;
  readonly logicalModelId: string;
  readonly nativeProviderId: string;
  readonly taskCapability: RouteEndpointKind;
  readonly policy?: RouteSelectionPolicy;
  /** Maximum input+output cost per call, in USD. Routes that exceed
   *  this are rejected with `over_budget`. */
  readonly maxCostUsd?: number;
  readonly resolveApiModelId: ApiModelIdResolver;
  readonly lookupLiveOperability: LiveOperabilityLookup;
  readonly lookupEconomics: RouteEconomicsLookup;
  readonly lookupAdapterKind?: AdapterKindLookup;
  readonly lookupAuthHandle?: AuthHandleLookup;
  /** Optional override: caller can pass a custom multi-route list (used
   *  by tests + by callers that augment the taxonomy with discovery). */
  readonly routeCandidatesOverride?: readonly ModelRouteCandidate[];
  /**
   * 01C.1B-J1R2 — Catalog-side fanout. When provided, returns every
   * (providerId, apiModelId) tuple in the local model catalog whose
   * normalized name matches this logical model — across providers.
   * The builder unions these with the taxonomy routes and dedupes by
   * `routeId` (providerId + apiModelId + adapterKind).
   */
  readonly servingProviders?: readonly ServingProviderEntry[];
}

export interface BuildRouteCandidatesResult {
  /**
   * Routes the discovery/preprobe view exposes. Up to
   * `policy.discoveryMaxRouteCandidates`. Operators see this list in
   * dry-run smoke responses.
   */
  readonly approved: readonly ApprovedRouteCandidate[];
  /**
   * 01C.1B-J1R2 — Subset of `approved` the executor will actually try
   * at request time. Capped by `policy.runtimeMaxRouteAttempts`. This
   * is the slice that goes into the plan fingerprint.
   */
  readonly approvedForExecution: readonly ApprovedRouteCandidate[];
  readonly rejections: readonly RouteCandidateRejection[];
  readonly coverage: RouteCandidateCoverage;
}

// ──────────────────────────────────────────────────────────────────────
// Equivalence classification
// ──────────────────────────────────────────────────────────────────────

/**
 * Decide the equivalence guarantee between a route's apiModelId and the
 * logical model.
 *
 * Strict consensus accepts:
 *   - `exact_same_model`: direct route where `apiModelId === logicalModelId`.
 *   - `same_provider_model_via_router`: router serves the same native
 *     provider model under an aliased id (e.g., `openai/gpt-4o` on
 *     openrouter for native `gpt-4o`).
 *
 * Diagnostic-only:
 *   - `router_alias_probable`: router lists a same-name model but we
 *     cannot prove cross-platform equivalence.
 *
 * Hard-rejected for strict consensus:
 *   - `family_equivalent`: e.g., gpt-4o-mini vs gpt-4o (different models).
 *   - `not_equivalent`: different model entirely.
 */
export function classifyRouteEquivalence(input: {
  readonly route: ModelRouteCandidate;
  readonly logicalModelId: string;
  readonly apiModelId: string;
  readonly nativeProviderId: string;
}): RouteEquivalenceKind {
  const { route, logicalModelId, apiModelId, nativeProviderId } = input;

  // Native route: apiModelId === logicalModelId → exact.
  if (route.kind === 'native') {
    if (apiModelId === logicalModelId) return 'exact_same_model';
    // Native but id changed — could still be same model with namespace.
    if (apiModelId.endsWith(`/${logicalModelId}`) || apiModelId.endsWith(`-${logicalModelId}`)) {
      return 'exact_same_model';
    }
    return 'router_alias_probable';
  }

  // 01C.1B-J1R §11.3 — Router-as-native case. When the chosen logical model's
  // native provider is ITSELF a router (e.g., vercel-ai-gateway, routeway,
  // openrouter), `listModelRouteCandidates(router)` returns a single
  // self-referential route. The route's `providerId` equals the input
  // `nativeProviderId`, and there's no upstream — it's the same endpoint
  // serving itself. Treat as exact equivalence so the role gets at least
  // one candidate.
  if (route.kind === 'router' && route.providerId === nativeProviderId && !route.nativeProviderId) {
    return apiModelId === logicalModelId ? 'exact_same_model' : 'same_provider_model_via_router';
  }

  // Router route: check if it's serving the SAME native model.
  if (route.kind === 'router' && route.nativeProviderId === nativeProviderId) {
    // The router peering exists for this exact native, so the same model
    // accessed via the router is a same-provider-via-router case.
    // Strong signal: apiModelId contains the native id or matches it.
    if (
      apiModelId === logicalModelId ||
      apiModelId.includes(`/${logicalModelId}`) ||
      apiModelId.includes(`-${logicalModelId}`) ||
      apiModelId.toLowerCase() === logicalModelId.toLowerCase()
    ) {
      return 'same_provider_model_via_router';
    }
    // Otherwise it's an alias on the same provider — still likely the same
    // model but not provable without discovery cross-check.
    return 'router_alias_probable';
  }

  // Router route serving a DIFFERENT native: this is family at best.
  return 'family_equivalent';
}

// ──────────────────────────────────────────────────────────────────────
// Ordering
// ──────────────────────────────────────────────────────────────────────

function compareRoutes(
  a: ApprovedRouteCandidate,
  b: ApprovedRouteCandidate,
  orderBy: readonly RouteOrderCriterion[],
): number {
  for (const c of orderBy) {
    let cmp = 0;
    switch (c) {
      case 'liveReady':
        cmp = Number(b.liveReady) - Number(a.liveReady);
        break;
      case 'recentSuccess': {
        const ta = a.lastSuccessAt ? Date.parse(a.lastSuccessAt) : 0;
        const tb = b.lastSuccessAt ? Date.parse(b.lastSuccessAt) : 0;
        cmp = tb - ta;
        break;
      }
      case 'cost':
        cmp = (a.costRank ?? 100) - (b.costRank ?? 100);
        break;
      case 'latency':
        cmp = (a.latencyRank ?? 100) - (b.latencyRank ?? 100);
        break;
      case 'context':
        cmp = (b.maxContextTokens ?? 0) - (a.maxContextTokens ?? 0);
        break;
      case 'nativeFirst':
        cmp = (a.routerId ? 1 : 0) - (b.routerId ? 1 : 0);
        break;
    }
    if (cmp !== 0) return cmp;
  }
  return 0;
}

// ──────────────────────────────────────────────────────────────────────
// Main builder
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the approved route candidates list for a single role/logical model.
 *
 * Pipeline:
 *   1. Pull raw routes from the taxonomy (or `routeCandidatesOverride`).
 *   2. Resolve `apiModelId` per route.
 *   3. Classify equivalence.
 *   4. Apply capability filter (only `taskCapability` matches).
 *   5. Apply auth-handle filter (skip if no credential loaded).
 *   6. Apply live-readiness filter (strict mode requires `liveReady=true`).
 *   7. Apply equivalence filter (strict mode rejects family_equivalent / not_equivalent).
 *   8. Apply budget filter.
 *   9. Sort by `policy.orderBy`.
 *  10. Cap at `policy.maxRouteAttempts`.
 *  11. Compute coverage summary.
 */
export function buildRouteCandidatesForModel(
  input: BuildRouteCandidatesInput,
): BuildRouteCandidatesResult {
  const policy = input.policy ?? STRICT_DEFAULT_ROUTE_SELECTION_POLICY;
  const adapterKindLookup = input.lookupAdapterKind ?? (() => 'openai-compatible-chat');
  const authHandleLookup = input.lookupAuthHandle ?? (() => 'unknown');

  const taxonomyRoutes = input.routeCandidatesOverride ?? listModelRouteCandidates(input.nativeProviderId);

  // 01C.1B-J1R2 — Union taxonomy routes with catalog-side serving
  // providers. Taxonomy gives us peerings (router fanout for true natives,
  // adapter kinds). Catalog gives us the actual list of providers that
  // already have the model registered (which is the source of truth for
  // router-as-native cases like vercel-ai-gateway::meta/llama-3.2-11b
  // where the taxonomy can't enumerate alternates on its own).
  //
  // Each serving-provider entry is converted to a `ModelRouteCandidate`
  // shape so the same downstream pipeline (resolveApiModelId, classify,
  // filter, sort) applies uniformly.
  // We tag each rawRoute with its catalog row (if any) so the loop
  // can use the catalog's authoritative `apiModelId` instead of running
  // the resolver — which doesn't know provider-specific naming conventions
  // (e.g., deepinfra serves llama-3.2-11b as `meta-llama/Llama-3.2-11B-Vision-Instruct`).
  type AugmentedRoute = { readonly route: ModelRouteCandidate; readonly catalogEntry?: ServingProviderEntry };
  const augmentedTaxonomy: AugmentedRoute[] = taxonomyRoutes.map((r) => ({ route: r }));
  const augmentedCatalog: AugmentedRoute[] = [];
  if (input.servingProviders && input.servingProviders.length > 0) {
    for (const sp of input.servingProviders) {
      const isNative = sp.providerId.toLowerCase() === input.nativeProviderId.toLowerCase();
      augmentedCatalog.push({
        route: {
          providerId: sp.providerId,
          kind: isNative ? 'native' : 'router',
          upstreamSlug: sp.apiModelId,
          nativeProviderId: isNative ? undefined : input.nativeProviderId,
        },
        catalogEntry: sp,
      });
    }
  }
  const rawRoutes: readonly AugmentedRoute[] = [...augmentedTaxonomy, ...augmentedCatalog];

  const rejections: RouteCandidateRejection[] = [];
  const considered: ApprovedRouteCandidate[] = [];
  const seenRouteIds = new Set<string>();

  for (const aug of rawRoutes) {
    const route = aug.route;
    const providerId = route.providerId;
    // 01C.1B-J1R2 — When the route came from the catalog fanout, use
    // the catalog's authoritative apiModelId. The resolver doesn't know
    // provider-specific naming (e.g., deepinfra ↔ `meta-llama/Llama-3.2-11B-Vision-Instruct`).
    let apiModelId: string | undefined;
    if (aug.catalogEntry) {
      apiModelId = aug.catalogEntry.apiModelId;
    } else {
      apiModelId = input.resolveApiModelId({
        providerId,
        logicalModelId: input.logicalModelId,
        nativeProviderId: input.nativeProviderId,
        upstreamProviderId: route.upstreamSlug,
      });
    }

    if (!apiModelId) {
      rejections.push({
        routeId: `${providerId}::?::?`,
        providerId,
        logicalModelId: input.logicalModelId,
        reason: 'capability_mismatch',
        detail: `apiModelId not resolvable for logical=${input.logicalModelId} via ${providerId}`,
      });
      continue;
    }

    const adapterKind = adapterKindLookup({ providerId });
    const routeId = buildRouteId({ providerId, apiModelId, adapterKind });

    if (seenRouteIds.has(routeId)) {
      rejections.push({
        routeId,
        providerId,
        logicalModelId: input.logicalModelId,
        reason: 'duplicate_route_id',
      });
      continue;
    }
    seenRouteIds.add(routeId);

    const equivalenceKind = classifyRouteEquivalence({
      route,
      logicalModelId: input.logicalModelId,
      apiModelId,
      nativeProviderId: input.nativeProviderId,
    });

    // Strict consensus rejects family/not-equivalent.
    if (equivalenceKind === 'not_equivalent' || equivalenceKind === 'family_equivalent') {
      rejections.push({
        routeId,
        providerId,
        logicalModelId: input.logicalModelId,
        reason: 'equivalence_too_loose',
        detail: `equivalence=${equivalenceKind}`,
      });
      continue;
    }

    // Auth handle filter.
    const authRef = authHandleLookup({ providerId });
    if (!authRef || authRef === 'unknown') {
      rejections.push({
        routeId,
        providerId,
        logicalModelId: input.logicalModelId,
        reason: 'auth_handle_missing',
      });
      continue;
    }

    const live = input.lookupLiveOperability({ providerId, routeId, apiModelId });
    const econ = input.lookupEconomics({ providerId, apiModelId });

    // Budget filter — if both sides of pricing present and exceed cap, reject.
    if (input.maxCostUsd !== undefined && econ.inputCostPerMTok !== undefined && econ.outputCostPerMTok !== undefined) {
      // Rough estimate: assume 200 input tokens + 200 output tokens for the
      // budget check. Caller can override with a custom maxCostUsd. The
      // estimate intentionally errs on the cheap side — real cost is
      // capped by `eval.maxTotalCostUsd` at runtime regardless.
      const estimated =
        (econ.inputCostPerMTok / 1_000_000) * 200 +
        (econ.outputCostPerMTok / 1_000_000) * 200;
      if (estimated > input.maxCostUsd) {
        rejections.push({
          routeId,
          providerId,
          logicalModelId: input.logicalModelId,
          reason: 'over_budget',
          detail: `estimated_cost=${estimated.toFixed(6)} > cap=${input.maxCostUsd}`,
        });
        continue;
      }
    }

    // Live-readiness filter (strict mode for critical roles).
    if (policy.requireLiveReadyForCriticalRoles && !live.chatReady) {
      rejections.push({
        routeId,
        providerId,
        logicalModelId: input.logicalModelId,
        reason: 'unauditied_live_state',
        detail: live.lastFailureKind ? `last_failure=${live.lastFailureKind}` : 'never_audited',
      });
      continue;
    }

    const candidate: ApprovedRouteCandidate = {
      routeId,
      logicalModelId: input.logicalModelId,
      apiModelId,
      providerId,
      routerId: route.kind === 'router' ? providerId : undefined,
      upstreamProviderId: route.upstreamSlug,
      nativeProviderId: route.nativeProviderId ?? input.nativeProviderId,
      adapterKind,
      endpointKind: input.taskCapability,
      equivalenceKind,
      authRef,
      costRank: econ.costRank,
      healthRank: live.healthRank,
      latencyRank: econ.latencyRank,
      liveReady: live.chatReady,
      lastSuccessAt: live.lastSuccessAt,
      lastFailureKind: live.lastFailureKind,
      lastFailureAt: live.lastFailureAt,
      maxContextTokens: econ.maxContextTokens,
      inputCostPerMTok: econ.inputCostPerMTok,
      outputCostPerMTok: econ.outputCostPerMTok,
      // J1R2 — Tag catalog-sourced routes distinctly so operators can
      // distinguish taxonomy peerings from catalog fanout in dry-run.
      source: aug.catalogEntry
        ? 'catalog_binding'
        : route.kind === 'native'
          ? 'native_provider'
          : 'router_taxonomy',
    };
    considered.push(candidate);
  }

  // Sort by policy.orderBy.
  considered.sort((a, b) => compareRoutes(a, b, policy.orderBy));

  // 01C.1B-J1R2 — Two-stage capping:
  //   `approved` (discovery view) — slice to discoveryMaxRouteCandidates.
  //   `approvedForExecution`      — sub-slice to runtimeMaxRouteAttempts.
  //   Rejections with `over_attempt_cap` are emitted ONLY for routes
  //   beyond the discovery cap, so operators see the full multi-provider
  //   fanout in dry-run smoke.
  const { discoveryCap, runtimeCap } = resolveRouteCaps(policy);
  const approved = considered.slice(0, discoveryCap);
  for (const c of considered.slice(discoveryCap)) {
    rejections.push({
      routeId: c.routeId,
      providerId: c.providerId,
      logicalModelId: c.logicalModelId,
      reason: 'over_attempt_cap',
    });
  }
  const approvedForExecution = approved.slice(0, runtimeCap);

  const coverage: RouteCandidateCoverage = {
    role: input.role,
    logicalModelId: input.logicalModelId,
    approvedCount: approved.length,
    liveReadyCount: approved.filter((c) => c.liveReady).length,
    rejectedCount: rejections.length,
    hasNativeRoute: approved.some((c) => !c.routerId),
    hasRouterRoute: approved.some((c) => Boolean(c.routerId)),
  };

  return { approved, approvedForExecution, rejections, coverage };
}
