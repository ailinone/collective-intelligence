// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-pipeline-explicit-pin.test.ts — MVP 7A
 *
 * The composer must preserve the Explicit Model Pin Invariant:
 *   - Pin is propagated to the retriever and planner.
 *   - The composer NEVER substitutes a pinned route — when the pin
 *     resolves to no viable candidate, no_viable_strategy is returned.
 *   - allowSubstitution has no effect in MVP 7A.
 */

import { describe, expect, it } from 'vitest';
import { composeRoutingPipeline } from '../routing-pipeline-composer';
import { createStaticRoutingConfigProvider } from '../../routing-config/runtime-routing-config-provider';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import type { ExplicitPinInfo } from '../../registry/types';

function firstChatRouteId(): string {
  const registry = buildFixtureRegistry();
  for (const snap of registry.getModelSnapshots()) {
    if (!snap.id || !snap.providerId) continue;
    const cid = `${snap.providerId}:${snap.id}`;
    const routes = registry.routesForCanonical(cid);
    for (const r of routes) {
      if (r.supportsStreaming || r.supportsTools || r.contextWindow) {
        return r.routeId;
      }
    }
  }
  throw new Error('fixture has no usable route');
}

describe('routing-pipeline — explicit pin propagation', () => {
  it('valid pin → planner returns single_best with pinned route', () => {
    const registry = buildFixtureRegistry();
    const routeId = firstChatRouteId();
    const route = registry.lookupRoute(routeId)!;
    const pin: ExplicitPinInfo = {
      source: 'request_model_field',
      canonicalModelId: route.canonicalModelId,
      offeringId: route.offeringId,
      routeId,
      allowSubstitution: false,
    };
    const result = composeRoutingPipeline({
      requestId: 'r-pin-1',
      profilerInput: { requestId: 'r-pin-1', text: 'hello' },
      registry,
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
      explicitModelPin: pin,
      nowIso: '2026-05-12T13:04:00.000Z',
      traceId: 'trace-pin-1',
    });
    expect(result.strategyResult).toBeDefined();
    expect(result.strategyResult?.plan.strategy).toBe('single_best');
    expect(result.strategyResult?.plan.selectedRouteIds).toEqual([routeId]);
    expect(result.trace.explicitModelPin).toEqual(pin);
    expect(result.trace.selectedRouteId).toBe(routeId);
  });

  it('pin propagates into the retrieval context (only pin route survives)', () => {
    const registry = buildFixtureRegistry();
    const routeId = firstChatRouteId();
    const pin: ExplicitPinInfo = {
      source: 'request_modelPin',
      routeId,
      allowSubstitution: false,
    };
    const result = composeRoutingPipeline({
      requestId: 'r-pin-2',
      profilerInput: { requestId: 'r-pin-2', text: 'help' },
      registry,
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
      explicitModelPin: pin,
    });
    expect(result.retrievalResult).toBeDefined();
    // When pinned, only the pin candidate is retained.
    for (const c of result.retrievalResult!.candidates) {
      expect(c.routeId).toBe(routeId);
    }
  });

  it('non-existent pin → no_viable_strategy, NO substitution', () => {
    const pin: ExplicitPinInfo = {
      source: 'internal_pin',
      routeId: 'route-does-not-exist::nowhere',
      allowSubstitution: false,
    };
    const result = composeRoutingPipeline({
      requestId: 'r-pin-3',
      profilerInput: { requestId: 'r-pin-3', text: 'hello' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
      explicitModelPin: pin,
    });
    expect(result.strategyResult?.plan.strategy).toBe('no_viable_strategy');
    expect(result.strategyResult?.plan.selectedRouteIds).toEqual([]);
    expect(result.trace.selectedRouteId).toBeNull();
    expect(result.trace.pinSubstitution).toBeNull();
  });

  it('pin with allowSubstitution=true does NOT trigger substitution in MVP 7A', () => {
    const pin: ExplicitPinInfo = {
      source: 'internal_pin',
      routeId: 'route-not-here',
      allowSubstitution: true,
      authorizingPolicy: 'fallback_when_blocked',
    };
    const result = composeRoutingPipeline({
      requestId: 'r-pin-4',
      profilerInput: { requestId: 'r-pin-4', text: 'hi' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
      explicitModelPin: pin,
    });
    // Even with allowSubstitution=true, MVP 7A does not substitute.
    expect(result.strategyResult?.plan.strategy).toBe('no_viable_strategy');
    expect(result.trace.pinSubstitution).toBeNull();
  });

  it('absence of pin is fine — pipeline still produces a plan', () => {
    const result = composeRoutingPipeline({
      requestId: 'r-pin-5',
      profilerInput: { requestId: 'r-pin-5', text: 'hello' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    expect(result.strategyResult).toBeDefined();
    expect(result.trace.explicitModelPin).toBeNull();
  });
});
