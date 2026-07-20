// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-pipeline-shadow-trace-only.test.ts — MVP 7A
 *
 * In shadow_trace_only the composer emits a trace but performs no
 * downstream work. No task profiling, no retrieval, no planning.
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

describe('routing-pipeline — shadow_trace_only', () => {
  it('produces a trace with the correct routingMode', () => {
    const result = composeRoutingPipeline({
      requestId: 'r-st-1',
      profilerInput: { requestId: 'r-st-1', text: 'whatever' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_trace_only',
      }),
      nowIso: '2026-05-12T13:01:00.000Z',
      traceId: 'trace-st-1',
    });
    expect(result.mode).toBe('shadow_trace_only');
    expect(result.trace.routingMode).toBe('shadow_trace_only');
    expect(result.trace.requestId).toBe('r-st-1');
    expect(result.trace.traceId).toBe('trace-st-1');
  });

  it('does NOT invoke TaskProfiler', () => {
    const profilerSpy = vi.spyOn(taskProfilerModule, 'profileTask');
    composeRoutingPipeline({
      requestId: 'r-st-2',
      profilerInput: { requestId: 'r-st-2', text: 'analyze' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_trace_only',
      }),
    });
    expect(profilerSpy).not.toHaveBeenCalled();
  });

  it('does NOT invoke CandidateRetriever', () => {
    const retrieverSpy = vi.spyOn(retrieverModule, 'retrieveCandidates');
    composeRoutingPipeline({
      requestId: 'r-st-3',
      profilerInput: { requestId: 'r-st-3' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_trace_only',
      }),
    });
    expect(retrieverSpy).not.toHaveBeenCalled();
  });

  it('does NOT invoke StrategyPlanner', () => {
    const plannerSpy = vi.spyOn(plannerModule, 'planStrategy');
    composeRoutingPipeline({
      requestId: 'r-st-4',
      profilerInput: { requestId: 'r-st-4' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_trace_only',
      }),
    });
    expect(plannerSpy).not.toHaveBeenCalled();
  });

  it('trace does NOT contain raw prompt fields', () => {
    const promptText =
      'sensitive prompt content that must never appear in the trace';
    const result = composeRoutingPipeline({
      requestId: 'r-st-5',
      profilerInput: { requestId: 'r-st-5', text: promptText },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_trace_only',
      }),
    });
    const traceJson = JSON.stringify(result.trace);
    expect(traceJson).not.toContain(promptText);
    expect(traceJson).not.toContain('prompt');
    expect(traceJson).not.toContain('messages');
    expect(traceJson).not.toContain('rawContext');
  });
});
