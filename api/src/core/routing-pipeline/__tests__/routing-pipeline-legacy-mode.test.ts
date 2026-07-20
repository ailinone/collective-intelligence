// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-pipeline-legacy-mode.test.ts — MVP 7A
 *
 * In legacy mode the composer does NO routing work. TaskProfiler is not
 * invoked, no candidates retrieved, no plan produced. Only a minimal,
 * redacted trace.
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

describe('routing-pipeline — legacy mode', () => {
  it('does NOT invoke TaskProfiler', () => {
    const profilerSpy = vi.spyOn(taskProfilerModule, 'profileTask');
    const result = composeRoutingPipeline({
      requestId: 'r-legacy-1',
      profilerInput: { requestId: 'r-legacy-1', text: 'hello' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({ mode: 'legacy' }),
      nowIso: '2026-05-12T13:00:00.000Z',
      traceId: 'trace-legacy-1',
    });
    expect(profilerSpy).not.toHaveBeenCalled();
    expect(result.mode).toBe('legacy');
  });

  it('does NOT invoke CandidateRetriever', () => {
    const retrieverSpy = vi.spyOn(retrieverModule, 'retrieveCandidates');
    composeRoutingPipeline({
      requestId: 'r-legacy-2',
      profilerInput: { requestId: 'r-legacy-2', text: 'analyze' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({ mode: 'legacy' }),
      nowIso: '2026-05-12T13:00:00.000Z',
      traceId: 'trace-legacy-2',
    });
    expect(retrieverSpy).not.toHaveBeenCalled();
  });

  it('does NOT invoke StrategyPlanner', () => {
    const plannerSpy = vi.spyOn(plannerModule, 'planStrategy');
    composeRoutingPipeline({
      requestId: 'r-legacy-3',
      profilerInput: { requestId: 'r-legacy-3' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({ mode: 'legacy' }),
      nowIso: '2026-05-12T13:00:00.000Z',
      traceId: 'trace-legacy-3',
    });
    expect(plannerSpy).not.toHaveBeenCalled();
  });

  it('produces a minimal trace with unknown-shaped task profile summary', () => {
    const result = composeRoutingPipeline({
      requestId: 'r-legacy-4',
      profilerInput: { requestId: 'r-legacy-4' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({ mode: 'legacy' }),
      nowIso: '2026-05-12T13:00:00.000Z',
      traceId: 'trace-legacy-4',
    });
    expect(result.trace.routingMode).toBe('legacy');
    expect(result.trace.requestId).toBe('r-legacy-4');
    expect(result.trace.traceId).toBe('trace-legacy-4');
    expect(result.trace.taskProfile.taskType).toBe('unknown');
    expect(result.trace.candidatesEvaluated).toBe(0);
    expect(result.trace.selectedRouteId).toBeNull();
    expect(result.trace.strategyPlan.routes).toEqual([]);
  });

  it('result has no selected model, no plan, no retrieval', () => {
    const result = composeRoutingPipeline({
      requestId: 'r-legacy-5',
      profilerInput: { requestId: 'r-legacy-5' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({ mode: 'legacy' }),
      nowIso: '2026-05-12T13:00:00.000Z',
      traceId: 'trace-legacy-5',
    });
    expect(result.taskProfile).toBeUndefined();
    expect(result.retrievalResult).toBeUndefined();
    expect(result.strategyResult).toBeUndefined();
    expect(result.blockedReason).toBeUndefined();
  });
});
