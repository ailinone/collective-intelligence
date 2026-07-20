// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-admin-routes.ts — admin route FACTORY (NOT registered in MVP 3).
 *
 * MVP 3 invariants:
 *   - Module-load is side-effect free. Importing this file MUST NOT
 *     register any route, open any connection, create any singleton,
 *     read any env var at the top level, or fire any timer.
 *   - The factory `createRoutingAdminRoutes` is the ONLY runtime export.
 *     It takes injected deps and returns an array of route descriptors
 *     (FRAMEWORK-NEUTRAL — no `Router()` instantiated here; the future
 *     bridge to Fastify lives in a later MVP).
 *   - `api/src/index.ts` is INTENTIONALLY NOT modified — this file is
 *     not imported anywhere in the runtime bootstrap.
 *
 * The "no framework instantiation" choice avoids pulling in Fastify or
 * Express at module load (which would create connection pools, plugin
 * registries, etc.). The result is a plain object the future bridge
 * MVP can adapt into either framework.
 */

import type { RuntimeModelRegistry } from '../../core/registry/runtime-model-registry';
import type { RoutingTraceCollector } from '../../core/routing/routing-trace-collector';
import type { RoutingTraceMetrics } from '../../core/routing/routing-decision-trace';
import {
  dryRunRouting,
  type RoutingDryRunInput,
  type RoutingDryRunResult,
} from '../../core/routing/routing-dry-run-handler';
import {
  explainRouting,
  type RoutingExplainInput,
  type RoutingExplainResult,
} from '../../core/routing/routing-explain-handler';

// ─── Framework-neutral route descriptor ─────────────────────────────────

export interface RoutingAdminRouteDescriptor {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly handler: (body: unknown) => Promise<unknown>;
}

// ─── Factory deps ───────────────────────────────────────────────────────

export interface RoutingAdminRouteDeps {
  readonly registry: RuntimeModelRegistry;
  readonly traceCollector?: RoutingTraceCollector;
  readonly metrics?: RoutingTraceMetrics;
  readonly now: () => string;
  readonly traceIdProvider?: () => string;
}

// ─── Factory ────────────────────────────────────────────────────────────

/**
 * Returns the FRAMEWORK-NEUTRAL descriptor list for admin routing
 * endpoints. The bridge to Fastify lives in a later MVP. This factory
 * is pure: calling it returns descriptors but does NOT bind them to
 * any server.
 *
 * MVP 3 ships TWO endpoints:
 *
 *   POST /v1/admin/routing/dry-run
 *     body: RoutingDryRunInput
 *     resp: RoutingDryRunResult
 *
 *   POST /v1/admin/routing/explain
 *     body: RoutingExplainInput
 *     resp: RoutingExplainResult
 */
export function createRoutingAdminRoutes(
  deps: RoutingAdminRouteDeps,
): ReadonlyArray<RoutingAdminRouteDescriptor> {
  const descriptors: RoutingAdminRouteDescriptor[] = [
    {
      method: 'POST',
      path: '/v1/admin/routing/dry-run',
      handler: async (body: unknown): Promise<RoutingDryRunResult> => {
        return dryRunRouting(coerceDryRunInput(body), {
          registry: deps.registry,
          traceCollector: deps.traceCollector,
          metrics: deps.metrics,
          now: deps.now,
          traceIdProvider: deps.traceIdProvider,
        });
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/routing/explain',
      handler: async (body: unknown): Promise<RoutingExplainResult> => {
        return explainRouting(coerceExplainInput(body), {
          registry: deps.registry,
          metrics: deps.metrics,
        });
      },
    },
  ];
  return Object.freeze(descriptors);
}

// ─── Input coercion (defensive — bodies may be arbitrary JSON) ──────────

function coerceDryRunInput(body: unknown): RoutingDryRunInput {
  if (!body || typeof body !== 'object') {
    return { requestId: '' };
  }
  const raw = body as Record<string, unknown>;
  return {
    requestId: typeof raw.requestId === 'string' ? raw.requestId : '',
    model: typeof raw.model === 'string' ? raw.model : undefined,
    messages: 'messages' in raw ? raw.messages : undefined,
    // taskProfile passes through to redaction in the handler — caller can
    // pass any shape; redactRoutingTrace strips unsafe fields.
    taskProfile: (raw.taskProfile && typeof raw.taskProfile === 'object'
      ? (raw.taskProfile as RoutingDryRunInput['taskProfile'])
      : undefined),
  };
}

function coerceExplainInput(body: unknown): RoutingExplainInput {
  if (!body || typeof body !== 'object') return {};
  const raw = body as Record<string, unknown>;
  return {
    canonicalModelId:
      typeof raw.canonicalModelId === 'string' ? raw.canonicalModelId : undefined,
    offeringId: typeof raw.offeringId === 'string' ? raw.offeringId : undefined,
    routeId: typeof raw.routeId === 'string' ? raw.routeId : undefined,
  };
}
