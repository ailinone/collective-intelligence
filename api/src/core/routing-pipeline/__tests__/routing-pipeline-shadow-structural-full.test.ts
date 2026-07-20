// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-pipeline-shadow-structural-full.test.ts — MVP 7A
 *
 * In shadow_structural_full the composer runs the full offline pipeline:
 * TaskProfiler → CandidateRetriever (which calls ModelScorer) →
 * StrategyPlanner → RoutingDecisionTrace.
 *
 * No provider, DB, Redis, TEI or HNSW is called.
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

describe('routing-pipeline — shadow_structural_full', () => {
  it('invokes TaskProfiler once', () => {
    const profilerSpy = vi.spyOn(taskProfilerModule, 'profileTask');
    composeRoutingPipeline({
      requestId: 'r-ssf-1',
      profilerInput: { requestId: 'r-ssf-1', text: 'analyze quarterly' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
      nowIso: '2026-05-12T13:03:00.000Z',
      traceId: 'trace-ssf-1',
    });
    expect(profilerSpy).toHaveBeenCalledTimes(1);
  });

  it('invokes CandidateRetriever once', () => {
    const retrieverSpy = vi.spyOn(retrieverModule, 'retrieveCandidates');
    composeRoutingPipeline({
      requestId: 'r-ssf-2',
      profilerInput: { requestId: 'r-ssf-2', text: 'analyze' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    expect(retrieverSpy).toHaveBeenCalledTimes(1);
  });

  it('invokes StrategyPlanner once', () => {
    const plannerSpy = vi.spyOn(plannerModule, 'planStrategy');
    composeRoutingPipeline({
      requestId: 'r-ssf-3',
      profilerInput: { requestId: 'r-ssf-3', text: 'tell me a story' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    expect(plannerSpy).toHaveBeenCalledTimes(1);
  });

  it('result includes taskProfile, retrievalResult and strategyResult', () => {
    const result = composeRoutingPipeline({
      requestId: 'r-ssf-4',
      profilerInput: { requestId: 'r-ssf-4', text: 'help me code' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
      nowIso: '2026-05-12T13:03:30.000Z',
      traceId: 'trace-ssf-4',
    });
    expect(result.taskProfile).toBeDefined();
    expect(result.retrievalResult).toBeDefined();
    expect(result.strategyResult).toBeDefined();
    expect(result.mode).toBe('shadow_structural_full');
  });

  it('result.taskProfile.requiredCapabilities includes "chat"', () => {
    const result = composeRoutingPipeline({
      requestId: 'r-ssf-5',
      profilerInput: { requestId: 'r-ssf-5', text: 'hello' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    expect(result.taskProfile?.requiredCapabilities).toContain('chat');
  });

  it('trace.candidatesEvaluated == number of retained candidates', () => {
    const result = composeRoutingPipeline({
      requestId: 'r-ssf-6',
      profilerInput: { requestId: 'r-ssf-6', text: 'analysis' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    expect(result.trace.candidatesEvaluated).toBe(
      result.retrievalResult?.candidates.length ?? -1,
    );
  });

  it('trace does NOT contain raw prompt text', () => {
    const promptText = 'top-secret prompt content do not log';
    const result = composeRoutingPipeline({
      requestId: 'r-ssf-7',
      profilerInput: { requestId: 'r-ssf-7', text: promptText },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    const json = JSON.stringify(result.trace);
    expect(json).not.toContain(promptText);
    expect(json).not.toContain('prompt');
    expect(json).not.toContain('messages');
    expect(json).not.toContain('rawContext');
  });

  it('when plan is single_best, trace.selectedRouteId is non-null', () => {
    const result = composeRoutingPipeline({
      requestId: 'r-ssf-8',
      profilerInput: { requestId: 'r-ssf-8', text: 'hello' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    if (result.strategyResult?.plan.strategy === 'single_best') {
      expect(result.trace.selectedRouteId).not.toBeNull();
    }
  });

  it('mode-specific stages do not run for shadow_structural_full BLOCKED neighbors', () => {
    const sem = composeRoutingPipeline({
      requestId: 'r-ssf-9',
      profilerInput: { requestId: 'r-ssf-9', text: 'x' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_semantic_full',
      }),
    });
    expect(sem.taskProfile).toBeUndefined();
    expect(sem.retrievalResult).toBeUndefined();
    expect(sem.strategyResult).toBeUndefined();
    expect(sem.blockedReason).toBeDefined();
  });
});
