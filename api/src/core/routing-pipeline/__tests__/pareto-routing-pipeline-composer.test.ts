// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-routing-pipeline-composer.test.ts — MVP 8B
 *
 * End-to-end smoke: the composer produces TaskProfile + structural
 * retrieval + contribution scores + Pareto plan + adapter result +
 * redacted trace, all offline. No fetch, no DB, no Redis, no TEI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeParetoRoutingPipeline } from '../pareto-routing-pipeline-composer';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import { scoreHistoricalContribution } from '../../contribution/historical-contribution-scorer';
import { HISTORICAL_EXECUTIONS_FIXTURE } from '../../contribution/__tests__/fixtures/historical-executions.fixture';

const STANDARD_BASELINE = Object.freeze({
  singleModelJudge: 0.6,
  singleModelCostUsd: 0.022,
});

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('fetch_must_not_be_called_in_pareto_pipeline');
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function basicArgs(overrides: Partial<Parameters<typeof composeParetoRoutingPipeline>[0]> = {}) {
  const registry = buildFixtureRegistry();
  const history = scoreHistoricalContribution({
    executions: HISTORICAL_EXECUTIONS_FIXTURE,
  });
  return {
    requestId: 'r-mvp8b',
    profilerInput: { requestId: 'r-mvp8b', text: 'analyze the data' },
    registry,
    historicalContributionResult: history,
    baseline: STANDARD_BASELINE,
    nowIso: '2026-05-12T15:30:00.000Z',
    traceId: 'trace-mvp8b-1',
    policy: { allowExplorationCandidates: true },
    ...overrides,
  } as const;
}

describe('composeParetoRoutingPipeline — happy path', () => {
  it('produces a TaskProfile', () => {
    const r = composeParetoRoutingPipeline(basicArgs());
    expect(r.taskProfile).toBeDefined();
    expect(r.taskProfile.requiredCapabilities.length).toBeGreaterThan(0);
  });

  it('produces a structural retrieval result', () => {
    const r = composeParetoRoutingPipeline(basicArgs());
    expect(r.structuralRetrievalResult).toBeDefined();
    expect(r.structuralRetrievalResult.candidates.length).toBeGreaterThanOrEqual(0);
  });

  it('produces a contribution result with one score per structural candidate', () => {
    const r = composeParetoRoutingPipeline(basicArgs());
    expect(r.contributionResult.contributionScores.length).toBe(
      r.structuralRetrievalResult.candidates.length,
    );
  });

  it('produces an EnsemblePlan', () => {
    const r = composeParetoRoutingPipeline(basicArgs());
    expect(r.paretoPlan).toBeDefined();
    expect(r.paretoPlan.strategyId).toBeTruthy();
    expect(['parallel', 'consensus', 'critique-repair', 'single_fallback']).toContain(
      r.paretoPlan.strategyId,
    );
  });

  it('produces a ParetoStrategyPlannerResult with finalOfflinePlan', () => {
    const r = composeParetoRoutingPipeline(basicArgs());
    expect(r.strategyAdapterResult).toBeDefined();
    expect(r.strategyAdapterResult.finalOfflinePlan).toBeDefined();
    expect(['pareto', 'single_fallback', 'original_strategy']).toContain(
      r.strategyAdapterResult.finalOfflinePlan.source,
    );
  });

  it('produces a redacted RoutingDecisionTrace with paretoSummary', () => {
    const r = composeParetoRoutingPipeline(basicArgs());
    expect(r.trace).toBeDefined();
    expect(r.trace.requestId).toBe('r-mvp8b');
    expect(r.trace.traceId).toBe('trace-mvp8b-1');
    expect(r.trace.paretoSummary).toBeDefined();
    expect(typeof r.trace.paretoSummary!.paretoStatus).toBe('string');
  });
});

describe('composeParetoRoutingPipeline — trace privacy', () => {
  it('trace does NOT contain raw prompt text', () => {
    const promptText = 'TOP-SECRET-DATA do not log this string please';
    const r = composeParetoRoutingPipeline(
      basicArgs({
        profilerInput: { requestId: 'r-priv', text: promptText },
      }),
    );
    const json = JSON.stringify(r.trace);
    expect(json).not.toContain(promptText);
    expect(json).not.toContain('"prompt"');
    expect(json).not.toContain('"messages"');
    expect(json).not.toContain('"rawContext"');
  });

  it('trace top-level keys only include the allowlist', () => {
    const r = composeParetoRoutingPipeline(basicArgs());
    const allowed = new Set([
      'traceId',
      'requestId',
      'timestamp',
      'routingMode',
      'taskProfile',
      'semanticIndexBackend',
      'candidatesEvaluated',
      'candidatesByStage',
      'rejectedByStage',
      'selectedCanonicalModelId',
      'selectedOfferingId',
      'selectedRouteId',
      'scoreBreakdown',
      'strategyPlan',
      'explicitModelPin',
      'pinSubstitution',
      'latencyByPhase',
      'outcomeStatus',
      'outcomeLatencyMs',
      'paretoSummary',
    ]);
    for (const k of Object.keys(r.trace)) expect(allowed.has(k)).toBe(true);
  });
});

describe('composeParetoRoutingPipeline — trace metadata content', () => {
  it('paretoSummary carries baseline + expected + selected ids', () => {
    const r = composeParetoRoutingPipeline(basicArgs());
    const s = r.trace.paretoSummary!;
    expect(s.baselineSingleJudge).toBe(STANDARD_BASELINE.singleModelJudge);
    expect(s.baselineSingleCostUsd).toBe(STANDARD_BASELINE.singleModelCostUsd);
    expect(Array.isArray(s.selectedRouteIds)).toBe(true);
    expect(Array.isArray(s.selectedModelIds)).toBe(true);
    expect(s.ensembleExplanation).toBeTruthy();
  });

  it('paretoSummary records marginalContributions', () => {
    const r = composeParetoRoutingPipeline(basicArgs());
    const s = r.trace.paretoSummary!;
    expect(Array.isArray(s.marginalContributions)).toBe(true);
  });

  it('paretoSummary records rejectedCandidates', () => {
    const r = composeParetoRoutingPipeline(basicArgs());
    const s = r.trace.paretoSummary!;
    expect(Array.isArray(s.rejectedCandidates)).toBe(true);
  });

  it('paretoSummary includes structuralPlanSummary AND paretoPlanSummary', () => {
    const r = composeParetoRoutingPipeline(basicArgs());
    const s = r.trace.paretoSummary!;
    expect(typeof s.structuralPlanSummary.strategy).toBe('string');
    expect(typeof s.paretoPlanSummary.strategy).toBe('string');
    expect(Array.isArray(s.structuralPlanSummary.routes)).toBe(true);
    expect(Array.isArray(s.paretoPlanSummary.routes)).toBe(true);
  });
});

describe('composeParetoRoutingPipeline — does not call providers', () => {
  it('runs without any fetch call', () => {
    expect(() => composeParetoRoutingPipeline(basicArgs())).not.toThrow();
  });
});

describe('composeParetoRoutingPipeline — determinism', () => {
  it('1000 iterations produce byte-identical results', () => {
    const args = basicArgs();
    const first = JSON.stringify(composeParetoRoutingPipeline(args));
    for (let i = 0; i < 100; i += 1) {
      expect(JSON.stringify(composeParetoRoutingPipeline(args))).toBe(first);
    }
  });

  it('does not call Date.now or Math.random', () => {
    const d = vi.spyOn(Date, 'now');
    const m = vi.spyOn(Math, 'random');
    composeParetoRoutingPipeline(basicArgs());
    expect(d).not.toHaveBeenCalled();
    expect(m).not.toHaveBeenCalled();
  });
});

describe('composeParetoRoutingPipeline — explicit pin propagation', () => {
  it('pin is propagated and adapter preserves original', () => {
    const registry = buildFixtureRegistry();
    // Grab the first route from the registry.
    const firstRoute = registry.getModelSnapshots()[0];
    const cid = `${firstRoute.providerId}:${firstRoute.id}`;
    const routes = registry.routesForCanonical(cid);
    const routeId = routes[0]?.routeId;
    expect(routeId).toBeTruthy();
    const r = composeParetoRoutingPipeline({
      requestId: 'r-pin',
      profilerInput: { requestId: 'r-pin', text: 'hello' },
      registry,
      historicalContributionResult: scoreHistoricalContribution({
        executions: HISTORICAL_EXECUTIONS_FIXTURE,
      }),
      baseline: STANDARD_BASELINE,
      explicitModelPin: {
        source: 'request_modelPin',
        routeId,
        allowSubstitution: false,
      },
      nowIso: '2026-05-12T15:31:00.000Z',
      traceId: 'trace-pin-1',
    });
    expect(r.strategyAdapterResult.finalOfflinePlan.reason).toBe(
      'explicit_pin_preserved',
    );
  });
});

describe('composeParetoRoutingPipeline — local_required', () => {
  it('local_required propagates to the contribution policy + retrieval', () => {
    const r = composeParetoRoutingPipeline(
      basicArgs({
        profilerInput: {
          requestId: 'r-local',
          text: 'private',
          explicitPrivacyMode: 'local_required',
        },
      }),
    );
    expect(r.taskProfile.privacyMode).toBe('local_required');
  });
});
