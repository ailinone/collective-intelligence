// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-pipeline-shadow-registry-only.test.ts — MVP 7A
 *
 * In shadow_registry_only the composer reads the registry's size but
 * performs no scoring, no planning, no semantic work.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { composeRoutingPipeline } from '../routing-pipeline-composer';
import { createStaticRoutingConfigProvider } from '../../routing-config/runtime-routing-config-provider';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import * as taskProfilerModule from '../../task-profile/task-profiler';
import * as retrieverModule from '../../retrieval/candidate-retriever';
import * as plannerModule from '../../strategy/strategy-planner';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('routing-pipeline — shadow_registry_only', () => {
  it('produces a trace with registry routes count', () => {
    const registry = buildFixtureRegistry();
    const expectedRoutes = registry.size().routes;
    const result = composeRoutingPipeline({
      requestId: 'r-sr-1',
      profilerInput: { requestId: 'r-sr-1' },
      registry,
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_registry_only',
      }),
      nowIso: '2026-05-12T13:02:00.000Z',
      traceId: 'trace-sr-1',
    });
    expect(result.mode).toBe('shadow_registry_only');
    expect(result.trace.candidatesByStage.initial).toBe(expectedRoutes);
  });

  it('does NOT invoke TaskProfiler', () => {
    const profilerSpy = vi.spyOn(taskProfilerModule, 'profileTask');
    composeRoutingPipeline({
      requestId: 'r-sr-2',
      profilerInput: { requestId: 'r-sr-2', text: 'analyze' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_registry_only',
      }),
    });
    expect(profilerSpy).not.toHaveBeenCalled();
  });

  it('does NOT invoke CandidateRetriever (scoring)', () => {
    const retrieverSpy = vi.spyOn(retrieverModule, 'retrieveCandidates');
    composeRoutingPipeline({
      requestId: 'r-sr-3',
      profilerInput: { requestId: 'r-sr-3' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_registry_only',
      }),
    });
    expect(retrieverSpy).not.toHaveBeenCalled();
  });

  it('does NOT invoke StrategyPlanner', () => {
    const plannerSpy = vi.spyOn(plannerModule, 'planStrategy');
    composeRoutingPipeline({
      requestId: 'r-sr-4',
      profilerInput: { requestId: 'r-sr-4' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_registry_only',
      }),
    });
    expect(plannerSpy).not.toHaveBeenCalled();
  });

  it('semanticIndexBackend stays "none"', () => {
    const result = composeRoutingPipeline({
      requestId: 'r-sr-5',
      profilerInput: { requestId: 'r-sr-5' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_registry_only',
      }),
    });
    expect(result.trace.semanticIndexBackend).toBe('none');
  });

  it('registry_cache mode also produces registry-count trace', () => {
    const registry = buildFixtureRegistry();
    const expectedRoutes = registry.size().routes;
    const result = composeRoutingPipeline({
      requestId: 'r-sr-6',
      profilerInput: { requestId: 'r-sr-6' },
      registry,
      configProvider: createStaticRoutingConfigProvider({
        mode: 'registry_cache',
      }),
      nowIso: '2026-05-12T13:02:30.000Z',
      traceId: 'trace-sr-6',
    });
    expect(result.mode).toBe('registry_cache');
    expect(result.trace.candidatesByStage.initial).toBe(expectedRoutes);
  });
});
