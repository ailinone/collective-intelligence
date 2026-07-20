// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-strategy-planner-adapter.test.ts — MVP 8B
 *
 * Validates the adapter's decision precedence:
 *   - explicit pin preserved
 *   - Pareto beats_baseline wins
 *   - Pareto single_fallback adopted
 *   - Pareto cost_tradeoff requires explicit policy permission
 *   - default falls back to original
 *
 * Adapter is pure: no fetch, no DB, deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adaptStrategyPlan } from '../pareto-strategy-planner-adapter';
import type { EnsemblePlan } from '../../pareto/ensemble-plan-types';
import type { ContributionAwareRetrieverResult } from '../../retrieval/contribution-aware-retriever';
import type { StrategyPlannerResult, StrategyPlan } from '../strategy-types';
import type { ContributionAwareScore } from '../../contribution/contribution-aware-candidate-scorer';
import type { TaskProfile } from '../../task-profile/task-profile-types';

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('fetch_must_not_be_called_in_adapter');
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── Fixtures ───────────────────────────────────────────────────────────

function buildPlan(strategy: StrategyPlan['strategy']): StrategyPlan {
  return Object.freeze({
    strategy,
    selectedRouteIds: ['r-original-1'],
    fallbackRouteIds: Object.freeze([]),
    maxParallelism: 1,
    estimatedCostClass: 'low',
    estimatedLatencyClass: 'low',
    confidence: 0.7,
    reasons: Object.freeze(['test_reason']),
    constraintsApplied: Object.freeze([]),
  });
}

function buildOriginal(): StrategyPlannerResult {
  return Object.freeze({
    plan: buildPlan('single_best'),
    rejectedStrategies: Object.freeze([]),
  });
}

function buildPareto(
  status: EnsemblePlan['paretoStatus'],
  strategyId: EnsemblePlan['strategyId'] = 'parallel',
  routes: readonly string[] = ['r-pareto-1', 'r-pareto-2'],
  models: readonly string[] = ['m-pareto-1', 'm-pareto-2'],
): EnsemblePlan {
  return Object.freeze({
    strategyId,
    selectedRouteIds: Object.freeze(routes.slice()),
    selectedModelIds: Object.freeze(models.slice()),
    expectedJudge: 0.82,
    expectedCostUsd: 0.0028,
    expectedQualityPerDollar: 290,
    baselineJudge: 0.6,
    baselineCostUsd: 0.022,
    paretoStatus: status,
    marginalContributions: Object.freeze([
      {
        modelId: models[0],
        marginalQualityGain: 0.78,
        marginalCostUsd: 0.0014,
        accepted: true,
        reason: 'seed_anchor',
      },
    ]),
    rejectedCandidates: Object.freeze([]),
    explanation: 'test_explanation',
  });
}

function buildContribution(routeToModel: Record<string, string>): ContributionAwareRetrieverResult {
  const scores: ContributionAwareScore[] = [];
  for (const [routeId, modelId] of Object.entries(routeToModel)) {
    scores.push(
      Object.freeze({
        routeId,
        modelId,
        totalScore: 0.7,
        breakdown: Object.freeze({
          structuralScore: 0.7,
          contributionScore: 0.6,
          qualityPerDollarScore: 0.5,
          taskTypeFit: 1,
          modalityFit: 1,
          harmPenalty: -0.05,
          costPenalty: -0.1,
          confidencePenalty: -0.05,
        }),
        recommendedRole: 'anchor',
        rejected: false,
        rejectionReasons: Object.freeze([]),
        explanation: 'accepted',
        estimatedCostUsd: 0.02,
        expectedJudge: 0.7,
      }),
    );
  }
  return Object.freeze({
    contributionScores: Object.freeze(scores),
    rejectedByContribution: Object.freeze([]),
  });
}

function buildProfile(): TaskProfile {
  return Object.freeze({
    taskType: 'code',
    complexity: 'medium',
    requiredCapabilities: Object.freeze(['chat']),
    desiredCapabilities: Object.freeze([]),
    modalities: Object.freeze(['text']),
    riskLevel: 'low',
    costSensitivity: 'low',
    privacyMode: 'standard',
    confidenceNeeded: 0.7,
    strategyHints: Object.freeze([]),
  });
}

// ─── Decision precedence ────────────────────────────────────────────────

describe('adaptStrategyPlan — explicit pin', () => {
  it('preserves the original plan when explicitModelPin is set', () => {
    const r = adaptStrategyPlan({
      originalStrategyResult: buildOriginal(),
      contributionResult: buildContribution({ 'r-original-1': 'm-pinned' }),
      paretoPlan: buildPareto('beats_baseline'),
      taskProfile: buildProfile(),
      explicitModelPin: {
        source: 'request_modelPin',
        routeId: 'r-original-1',
        allowSubstitution: false,
      },
    });
    expect(r.finalOfflinePlan.source).toBe('original_strategy');
    expect(r.finalOfflinePlan.reason).toBe('explicit_pin_preserved');
    expect(r.finalOfflinePlan.selectedRouteIds).toEqual(['r-original-1']);
  });
});

describe('adaptStrategyPlan — pareto wins', () => {
  it('Pareto beats_baseline ⇒ source=pareto, strategy from Pareto', () => {
    const r = adaptStrategyPlan({
      originalStrategyResult: buildOriginal(),
      contributionResult: buildContribution({}),
      paretoPlan: buildPareto('beats_baseline'),
      taskProfile: buildProfile(),
    });
    expect(r.finalOfflinePlan.source).toBe('pareto');
    expect(r.finalOfflinePlan.strategy).toBe('parallel');
    expect(r.finalOfflinePlan.selectedRouteIds).toEqual([
      'r-pareto-1',
      'r-pareto-2',
    ]);
    expect(r.finalOfflinePlan.reason).toBe('pareto_beats_baseline');
  });

  it('parallel preferred when pareto vence a tese', () => {
    const r = adaptStrategyPlan({
      originalStrategyResult: buildOriginal(),
      contributionResult: buildContribution({}),
      paretoPlan: buildPareto('beats_baseline', 'parallel'),
      taskProfile: buildProfile(),
    });
    expect(r.finalOfflinePlan.strategy).toBe('parallel');
  });
});

describe('adaptStrategyPlan — single_fallback', () => {
  it('Pareto single_fallback ⇒ source=single_fallback with explanation', () => {
    const r = adaptStrategyPlan({
      originalStrategyResult: buildOriginal(),
      contributionResult: buildContribution({}),
      paretoPlan: buildPareto('single_fallback', 'single_fallback', ['r-sf-1'], ['m-sf-1']),
      taskProfile: buildProfile(),
    });
    expect(r.finalOfflinePlan.source).toBe('single_fallback');
    expect(r.finalOfflinePlan.strategy).toBe('single_fallback');
    expect(r.finalOfflinePlan.reason).toBe('collective_not_economically_justified');
    expect(r.finalOfflinePlan.selectedRouteIds).toEqual(['r-sf-1']);
  });
});

describe('adaptStrategyPlan — cost_tradeoff gated by policy', () => {
  it('default policy ⇒ cost_tradeoff is rejected, original kept', () => {
    const r = adaptStrategyPlan({
      originalStrategyResult: buildOriginal(),
      contributionResult: buildContribution({}),
      paretoPlan: buildPareto('cost_tradeoff', 'consensus'),
      taskProfile: buildProfile(),
    });
    expect(r.finalOfflinePlan.source).toBe('original_strategy');
    expect(r.finalOfflinePlan.strategy).toBe('single_best');
  });

  it('allowConsensusWhenCostExceedsBaseline=true ⇒ pareto chosen', () => {
    const r = adaptStrategyPlan({
      originalStrategyResult: buildOriginal(),
      contributionResult: buildContribution({}),
      paretoPlan: buildPareto('cost_tradeoff', 'consensus'),
      taskProfile: buildProfile(),
      policy: { allowConsensusWhenCostExceedsBaseline: true },
    });
    expect(r.finalOfflinePlan.source).toBe('pareto');
    expect(r.finalOfflinePlan.strategy).toBe('consensus');
    expect(r.finalOfflinePlan.reason).toBe('pareto_cost_tradeoff_policy_permits');
  });

  it('allowCritiqueRepairWhenCostExceedsBaseline=true ⇒ pareto chosen', () => {
    const r = adaptStrategyPlan({
      originalStrategyResult: buildOriginal(),
      contributionResult: buildContribution({}),
      paretoPlan: buildPareto('cost_tradeoff', 'critique-repair'),
      taskProfile: buildProfile(),
      policy: { allowCritiqueRepairWhenCostExceedsBaseline: true },
    });
    expect(r.finalOfflinePlan.source).toBe('pareto');
    expect(r.finalOfflinePlan.strategy).toBe('critique-repair');
  });
});

describe('adaptStrategyPlan — dominated keeps original', () => {
  it('paretoStatus=dominated ⇒ original kept, reason explains', () => {
    const r = adaptStrategyPlan({
      originalStrategyResult: buildOriginal(),
      contributionResult: buildContribution({}),
      paretoPlan: buildPareto('dominated'),
      taskProfile: buildProfile(),
    });
    expect(r.finalOfflinePlan.source).toBe('original_strategy');
    expect(r.finalOfflinePlan.reason).toBe('pareto_dominated_kept_original');
  });
});

describe('adaptStrategyPlan — output shape', () => {
  it('result is frozen', () => {
    const r = adaptStrategyPlan({
      originalStrategyResult: buildOriginal(),
      contributionResult: buildContribution({}),
      paretoPlan: buildPareto('beats_baseline'),
      taskProfile: buildProfile(),
    });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.finalOfflinePlan)).toBe(true);
  });

  it('preserves originalStrategyPlan and paretoEnsemblePlan unchanged', () => {
    const orig = buildOriginal();
    const pareto = buildPareto('beats_baseline');
    const r = adaptStrategyPlan({
      originalStrategyResult: orig,
      contributionResult: buildContribution({}),
      paretoPlan: pareto,
      taskProfile: buildProfile(),
    });
    expect(r.originalStrategyPlan).toBe(orig);
    expect(r.paretoEnsemblePlan).toBe(pareto);
  });
});

describe('adaptStrategyPlan — determinism + side-effect freedom', () => {
  it('1000 iterations produce byte-identical output', () => {
    const args = {
      originalStrategyResult: buildOriginal(),
      contributionResult: buildContribution({}),
      paretoPlan: buildPareto('beats_baseline'),
      taskProfile: buildProfile(),
    };
    const first = JSON.stringify(adaptStrategyPlan(args));
    for (let i = 0; i < 1000; i += 1) {
      expect(JSON.stringify(adaptStrategyPlan(args))).toBe(first);
    }
  });

  it('does not call Date.now / Math.random', () => {
    const dateSpy = vi.spyOn(Date, 'now');
    const randSpy = vi.spyOn(Math, 'random');
    adaptStrategyPlan({
      originalStrategyResult: buildOriginal(),
      contributionResult: buildContribution({}),
      paretoPlan: buildPareto('beats_baseline'),
      taskProfile: buildProfile(),
    });
    expect(dateSpy).not.toHaveBeenCalled();
    expect(randSpy).not.toHaveBeenCalled();
  });
});
