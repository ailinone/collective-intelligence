// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-pipeline-local-required.test.ts — MVP 7A
 *
 * With `privacyMode = 'local_required'` the composer's plan must only
 * contain local / self_hosted routes. When no such route exists, the
 * plan is no_viable_strategy.
 */

import { describe, expect, it } from 'vitest';
import { composeRoutingPipeline } from '../routing-pipeline-composer';
import { createStaticRoutingConfigProvider } from '../../routing-config/runtime-routing-config-provider';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import { buildRuntimeModelRegistry } from '../../registry/registry-builder';
import { FIXTURE_ROUTE_KIND_BY_PROVIDER } from '../../registry/__tests__/fixtures/legacy-models.fixture';

const SELF_HOSTED_KINDS = new Set(['local', 'self_hosted']);

describe('routing-pipeline — local_required', () => {
  it('only local/self_hosted routes appear in selected', () => {
    const registry = buildFixtureRegistry();
    const result = composeRoutingPipeline({
      requestId: 'r-lr-1',
      profilerInput: {
        requestId: 'r-lr-1',
        text: 'sensitive content',
        explicitPrivacyMode: 'local_required',
      },
      registry,
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
      nowIso: '2026-05-12T13:05:00.000Z',
      traceId: 'trace-lr-1',
    });

    // If the plan is non-empty, all routes must be local-ish.
    for (const routeId of result.strategyResult!.plan.selectedRouteIds) {
      const r = registry.lookupRoute(routeId);
      expect(r).toBeDefined();
      expect(SELF_HOSTED_KINDS.has(r!.routeKind)).toBe(true);
    }
  });

  it('cloud routes do NOT appear in the trace.strategyPlan.routes', () => {
    const registry = buildFixtureRegistry();
    const result = composeRoutingPipeline({
      requestId: 'r-lr-2',
      profilerInput: {
        requestId: 'r-lr-2',
        text: 'private',
        explicitPrivacyMode: 'local_required',
      },
      registry,
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    for (const routeId of result.trace.strategyPlan.routes) {
      const r = registry.lookupRoute(routeId);
      expect(r).toBeDefined();
      expect(SELF_HOSTED_KINDS.has(r!.routeKind)).toBe(true);
    }
  });

  it('when registry has NO local routes ⇒ no_viable_strategy', () => {
    // Build a registry from the cloud-only subset of the fixture.
    const cloudOnly = buildRuntimeModelRegistry({
      models: [
        {
          id: 'm-cloud-1',
          providerId: 'anthropic',
          status: 'active',
          capabilityUris: ['chat'],
          contextWindow: 100_000,
          inputCostPer1k: 0.001,
          outputCostPer1k: 0.002,
          lifecycleStatus: 'current',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
        },
        {
          id: 'm-cloud-2',
          providerId: 'openai',
          status: 'active',
          capabilityUris: ['chat'],
          contextWindow: 100_000,
          inputCostPer1k: 0.001,
          outputCostPer1k: 0.002,
          lifecycleStatus: 'current',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
        },
      ],
      routeKindByProvider: FIXTURE_ROUTE_KIND_BY_PROVIDER,
      source: 'fixture',
      now: '2026-05-12T12:00:00.000Z',
    }).registry;

    const result = composeRoutingPipeline({
      requestId: 'r-lr-3',
      profilerInput: {
        requestId: 'r-lr-3',
        text: 'private',
        explicitPrivacyMode: 'local_required',
      },
      registry: cloudOnly,
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    expect(result.strategyResult?.plan.strategy).toBe('no_viable_strategy');
    expect(result.strategyResult?.plan.selectedRouteIds).toEqual([]);
  });

  it('local_preferred (not _required) still allows cloud in selected', () => {
    const registry = buildFixtureRegistry();
    const result = composeRoutingPipeline({
      requestId: 'r-lr-4',
      profilerInput: {
        requestId: 'r-lr-4',
        text: 'analyze data',
        explicitPrivacyMode: 'local_preferred',
      },
      registry,
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    // With local_preferred we don't enforce. Just verify the pipeline ran.
    expect(result.taskProfile?.privacyMode).toBe('local_preferred');
    expect(result.retrievalResult?.candidates.length).toBeGreaterThan(0);
  });

  it('local_required mode is mapped into the planner context', () => {
    const result = composeRoutingPipeline({
      requestId: 'r-lr-5',
      profilerInput: {
        requestId: 'r-lr-5',
        text: 'data',
        explicitPrivacyMode: 'local_required',
      },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    expect(result.taskProfile?.privacyMode).toBe('local_required');
  });
});
