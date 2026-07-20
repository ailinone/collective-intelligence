// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-explain-handler.ts — pure routing explain.
 *
 * MVP 3 invariants identical to `routing-dry-run-handler.ts`:
 *   - Pure function. Deps injected.
 *   - DOES NOT call any provider, DB, Redis, TEI, HNSW.
 *   - DOES NOT call `fetch`.
 *   - Operates entirely on the injected registry.
 *
 * Purpose: given an id (canonicalModelId OR offeringId OR routeId),
 * return the corresponding entity plus structural neighbours (routes
 * of the canonical, offerings of the canonical, canonical of the
 * route). No scoring, no semantic similarity in MVP 3.
 */

import type { RuntimeModelRegistry } from '../registry/runtime-model-registry';
import type { CanonicalModel } from '../registry/canonical-model';
import type { ModelProviderOffering } from '../registry/model-offering';
import type { ProviderModelRoute } from '../registry/model-route';
import type { RoutingTraceMetrics } from './routing-decision-trace';
import { noopRoutingTraceMetrics } from './routing-decision-trace';

// ─── Input / output / deps ──────────────────────────────────────────────

export interface RoutingExplainInput {
  readonly canonicalModelId?: string;
  readonly offeringId?: string;
  readonly routeId?: string;
}

export interface RoutingExplainDeps {
  readonly registry: RuntimeModelRegistry;
  readonly metrics?: RoutingTraceMetrics;
}

export interface RoutingExplainResult {
  readonly resolvedKind: 'canonical' | 'offering' | 'route' | 'not_found';
  readonly canonical: CanonicalModel | null;
  readonly offerings: ReadonlyArray<ModelProviderOffering>;
  readonly routes: ReadonlyArray<ProviderModelRoute>;
  readonly note: string;
}

// ─── Handler ────────────────────────────────────────────────────────────

/**
 * Looks up the requested entity and returns structural neighbours.
 * The input is checked in priority order: routeId → offeringId →
 * canonicalModelId. Exactly one identifier resolves a single entity;
 * the rest of the return packs related siblings.
 */
export async function explainRouting(
  input: RoutingExplainInput,
  deps: RoutingExplainDeps,
): Promise<RoutingExplainResult> {
  const metrics = deps.metrics ?? noopRoutingTraceMetrics;
  let result: RoutingExplainResult;

  if (input.routeId) {
    const route = deps.registry.lookupRoute(input.routeId);
    if (!route) {
      result = notFound('route', input.routeId);
    } else {
      const canonical = deps.registry.lookupCanonicalModel(route.canonicalModelId) ?? null;
      const offerings = deps.registry.offeringsForCanonical(route.canonicalModelId);
      const routes = deps.registry.routesForCanonical(route.canonicalModelId);
      result = {
        resolvedKind: 'route',
        canonical,
        offerings,
        routes,
        note: 'EXPLAIN MVP 3: structural lookup only. No semantic similarity, no scoring.',
      };
    }
  } else if (input.offeringId) {
    const offering = deps.registry.lookupOffering(input.offeringId);
    if (!offering) {
      result = notFound('offering', input.offeringId);
    } else {
      const canonical = deps.registry.lookupCanonicalModel(offering.canonicalModelId) ?? null;
      const offerings = deps.registry.offeringsForCanonical(offering.canonicalModelId);
      const routes = deps.registry.routesForOffering(offering.offeringId);
      result = {
        resolvedKind: 'offering',
        canonical,
        offerings,
        routes,
        note: 'EXPLAIN MVP 3: structural lookup only. No semantic similarity, no scoring.',
      };
    }
  } else if (input.canonicalModelId) {
    const canonical = deps.registry.lookupCanonicalModel(input.canonicalModelId);
    if (!canonical) {
      result = notFound('canonical', input.canonicalModelId);
    } else {
      const offerings = deps.registry.offeringsForCanonical(canonical.canonicalModelId);
      const routes = deps.registry.routesForCanonical(canonical.canonicalModelId);
      result = {
        resolvedKind: 'canonical',
        canonical,
        offerings,
        routes,
        note: 'EXPLAIN MVP 3: structural lookup only. No semantic similarity, no scoring.',
      };
    }
  } else {
    result = notFound('canonical', '<no-id-provided>');
  }

  metrics.increment('routing_admin_endpoint_invocations_total', {
    endpoint: 'explain',
    result: result.resolvedKind === 'not_found' ? 'not_found' : 'ok',
  });

  return result;
}

function notFound(
  kind: 'canonical' | 'offering' | 'route',
  id: string,
): RoutingExplainResult {
  return {
    resolvedKind: 'not_found',
    canonical: null,
    offerings: [],
    routes: [],
    note: `EXPLAIN MVP 3: ${kind} id '${id}' not found in registry.`,
  };
}
