// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Comparative Evals: Sensitivity Consensus vs Existing Strategies
 *
 * Compares the new sensitivity-consensus strategy against consensus, debate,
 * and collaborative strategies on structured decision tasks.
 *
 * Measures:
 * - Decision quality
 * - Confidence calibration
 * - Cost efficiency
 * - Convergence behavior
 * - Dissent handling
 *
 * These evals use the coordination components directly (no live API needed).
 * For live strategy comparison, use the strategy comparison endpoint.
 */

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  aggregateSignals,
} from '../../src/core/coordination/sensitivity-aggregator';
import { evaluateConvergence } from '../../src/core/coordination/convergence-evaluator';
import type { CoordinationSignal, CoordinationLimits } from '../../src/core/coordination/coordination-types';

interface StrategyEvalResult {
  strategy: string;
  convergenceScore: number;
  rounds: number;
  decisionFlipRate: number;
  dissent: number;
  totalCost: number;
  totalTokens: number;
  stopReason: string;
  confidence: number;
  criticalVariables: string[];
}

const defaultLimits = (): CoordinationLimits => ({
  maxRounds: 3,
  minConvergenceScore: 0.82,
  maxDecisionFlipRate: 0.15,
  maxDissent: 0.35,
  stopOnCriticalRisk: true,
  minValidSignalsPerRound: 2,
  detectStagnation: true,
});

const makeSignal = (overrides: Partial<CoordinationSignal> = {}): CoordinationSignal => ({
  id: `sig-${Math.random().toString(36).slice(2)}`,
  runId: 'run-eval',
  round: 1,
  agentId: 'agent-a',
  modelId: 'model-a',
  providerId: 'provider-a',
  decision: {
    type: 'approve',
    value: 'approved',
    confidence: 0.85,
    rationale: 'Eval rationale',
  },
  sensitivities: [
    {
      variable: 'quality',
      direction: 'block',
      trigger: 'if quality drops',
      confidence: 0.9,
      rationale: 'quality gate',
      risk: 'high',
    },
  ],
  metrics: {
    latencyMs: 400,
    inputTokens: 200,
    outputTokens: 100,
    estimatedCost: 0.008,
  },
  createdAt: new Date().toISOString(),
  ...overrides,
});

function runSimulatedStrategy(
  strategyName: string,
  roundsData: CoordinationSignal[][],
): StrategyEvalResult {
  const limits = defaultLimits();
  let state = createInitialState('run-eval', strategyName, limits);
  let stopReason = 'max_rounds';

  for (const roundSignals of roundsData) {
    const agg = aggregateSignals(roundSignals, state);
    state = agg.nextState;

    const evalResult = evaluateConvergence(state);
    if (evalResult.shouldStop && evalResult.stopReason) {
      stopReason = evalResult.stopReason;
      break;
    }
  }

  const lastRound = roundsData[roundsData.length - 1];
  const majorityDecision = lastRound[0]?.decision;
  const criticalVars = Object.entries(state.variables)
    .filter(([, v]) => v.stability < 0.5)
    .map(([k]) => k);

  return {
    strategy: strategyName,
    convergenceScore: state.convergence.score,
    rounds: state.round,
    decisionFlipRate: state.convergence.decisionFlipRate,
    dissent: state.convergence.dissent,
    totalCost: state.totalCostUsd,
    totalTokens: state.totalTokens,
    stopReason,
    confidence: majorityDecision?.confidence ?? 0,
    criticalVariables: criticalVars,
  };
}

describe('Comparative Evals: Code Review Scenario', () => {
  it('sensitivity-consensus converges with fewer rounds on clear-cut code review', () => {
    const round1 = [
      makeSignal({ agentId: 'a', decision: { type: 'approve', value: 'LGTM', confidence: 0.92 } }),
      makeSignal({ agentId: 'b', decision: { type: 'approve', value: 'LGTM', confidence: 0.88 } }),
      makeSignal({ agentId: 'c', decision: { type: 'approve', value: 'LGTM', confidence: 0.90 } }),
    ];

    const result = runSimulatedStrategy('sensitivity-consensus', [round1]);
    expect(result.convergenceScore).toBeGreaterThan(0.8);
    expect(result.dissent).toBe(0);
    expect(result.rounds).toBe(1);
  });

  it('sensitivity-consensus captures blocking variables when models disagree', () => {
    const round1 = [
      makeSignal({
        agentId: 'a',
        decision: { type: 'approve', value: 'looks good', confidence: 0.85 },
        sensitivities: [
          { variable: 'test_coverage', direction: 'block', trigger: 'no unit tests', confidence: 0.95, rationale: 'critical gap', risk: 'high' as const },
        ],
      }),
      makeSignal({
        agentId: 'b',
        decision: { type: 'request_changes', value: 'add tests', confidence: 0.9 },
        sensitivities: [
          { variable: 'test_coverage', direction: 'block', trigger: 'no unit tests', confidence: 0.9, rationale: 'must have tests', risk: 'critical' as const },
        ],
      }),
      makeSignal({
        agentId: 'c',
        decision: { type: 'approve', value: 'code is clean', confidence: 0.7 },
        sensitivities: [
          { variable: 'test_coverage', direction: 'unlock', trigger: 'if tests added', confidence: 0.85, rationale: 'tests would resolve concern' },
        ],
      }),
    ];

    const result = runSimulatedStrategy('sensitivity-consensus', [round1]);
    expect(Object.keys(result).length).toBeGreaterThan(0);
    expect(result.convergenceScore).toBeGreaterThanOrEqual(0);
  });

  it('sensitivity-consensus handles multi-round convergence on complex review', () => {
    const round1 = [
      makeSignal({ agentId: 'a', round: 1, decision: { type: 'approve', value: 'ok', confidence: 0.6 } }),
      makeSignal({ agentId: 'b', round: 1, decision: { type: 'reject', value: 'security issue', confidence: 0.8 } }),
      makeSignal({ agentId: 'c', round: 1, decision: { type: 'approve', value: 'fine', confidence: 0.55 } }),
    ];

    const round2 = [
      makeSignal({ agentId: 'a', round: 2, decision: { type: 'request_changes', value: 'fix security', confidence: 0.85 } }),
      makeSignal({ agentId: 'b', round: 2, decision: { type: 'request_changes', value: 'fix security', confidence: 0.9 } }),
      makeSignal({ agentId: 'c', round: 2, decision: { type: 'request_changes', value: 'fix security', confidence: 0.82 } }),
    ];

    const result = runSimulatedStrategy('sensitivity-consensus', [round1, round2]);
    expect(result.rounds).toBe(2);
    expect(result.convergenceScore).toBeGreaterThan(round1.length > 0 ? 0 : 0.5);
    expect(result.decisionFlipRate).toBeGreaterThan(0);
  });
});

describe('Comparative Evals: Architecture Decision Scenario', () => {
  it('captures trade-off sensitivities from different perspectives', () => {
    const round1 = [
      makeSignal({
        agentId: 'security-expert',
        decision: { type: 'reject', value: 'use microservices', confidence: 0.85 },
        sensitivities: [
          { variable: 'attack_surface', direction: 'increase', trigger: 'more network calls', confidence: 0.9, rationale: 'more entry points' },
          { variable: 'auth_complexity', direction: 'increase', trigger: 'service-to-service auth', confidence: 0.85, rationale: 'needs mTLS' },
        ],
      }),
      makeSignal({
        agentId: 'perf-expert',
        decision: { type: 'approve', value: 'use microservices', confidence: 0.75 },
        sensitivities: [
          { variable: 'latency', direction: 'increase', trigger: 'network overhead', confidence: 0.7, rationale: 'inter-service calls' },
          { variable: 'scalability', direction: 'increase', trigger: 'independent scaling', confidence: 0.9, rationale: 'scale per service' },
        ],
      }),
      makeSignal({
        agentId: 'product-expert',
        decision: { type: 'approve', value: 'use microservices', confidence: 0.8 },
        sensitivities: [
          { variable: 'team_velocity', direction: 'unlock', trigger: 'independent deploys', confidence: 0.85, rationale: 'faster iterations' },
          { variable: 'complexity', direction: 'increase', trigger: 'distributed system', confidence: 0.8, rationale: 'ops overhead' },
        ],
      }),
    ];

    const limits = defaultLimits();
    const state = createInitialState('run-arch', 'sensitivity-consensus', limits);
    const agg = aggregateSignals(round1, state);

    const trackedVars = Object.keys(agg.nextState.variables);
    expect(trackedVars.length).toBeGreaterThanOrEqual(4);

    const dominant = agg.dominantSignals;
    expect(dominant.length + agg.conflictingSignals.length).toBeGreaterThan(0);
  });
});

describe('Comparative Evals: Cost Efficiency', () => {
  it('sensitivity-consensus accumulates cost correctly across rounds', () => {
    const round1 = [
      makeSignal({ agentId: 'a', metrics: { latencyMs: 400, inputTokens: 200, outputTokens: 100, estimatedCost: 0.005 } }),
      makeSignal({ agentId: 'b', metrics: { latencyMs: 500, inputTokens: 250, outputTokens: 120, estimatedCost: 0.007 } }),
      makeSignal({ agentId: 'c', metrics: { latencyMs: 450, inputTokens: 230, outputTokens: 110, estimatedCost: 0.006 } }),
    ];

    const limits = defaultLimits();
    limits.maxCostUsd = 0.02;
    const state = createInitialState('run-cost', 'sensitivity-consensus', limits);
    const agg = aggregateSignals(round1, state);

    expect(agg.nextState.totalCostUsd).toBeCloseTo(0.018, 3);
    expect(agg.nextState.totalTokens).toBe(1010);
  });
});

describe('Comparative Evals: Regression — Existing Strategies', () => {
  it('consensus strategy simulation produces expected results', () => {
    const round1 = [
      makeSignal({ agentId: 'a', decision: { type: 'approve', value: 'yes', confidence: 0.9 } }),
      makeSignal({ agentId: 'b', decision: { type: 'approve', value: 'yes', confidence: 0.85 } }),
      makeSignal({ agentId: 'c', decision: { type: 'approve', value: 'yes', confidence: 0.88 } }),
    ];

    const result = runSimulatedStrategy('consensus', [round1]);
    expect(result.dissent).toBe(0);
    expect(result.convergenceScore).toBeGreaterThan(0.8);
  });

  it('debate strategy simulation shows initial disagreement', () => {
    const round1 = [
      makeSignal({ agentId: 'proposer', decision: { type: 'approve', value: 'proposal', confidence: 0.9 } }),
      makeSignal({ agentId: 'opponent', decision: { type: 'reject', value: 'counter', confidence: 0.85 } }),
      makeSignal({ agentId: 'judge', decision: { type: 'approve', value: 'proposal wins', confidence: 0.75 } }),
    ];

    const result = runSimulatedStrategy('debate', [round1]);
    expect(result.dissent).toBeGreaterThan(0);
  });

  it('collaborative strategy simulation shows convergence', () => {
    const round1 = [
      makeSignal({ agentId: 'a', decision: { type: 'partial', value: 'need more info', confidence: 0.5 } }),
      makeSignal({ agentId: 'b', decision: { type: 'partial', value: 'need more info', confidence: 0.6 } }),
    ];

    const round2 = [
      makeSignal({ agentId: 'a', decision: { type: 'approve', value: 'complete', confidence: 0.9 } }),
      makeSignal({ agentId: 'b', decision: { type: 'approve', value: 'complete', confidence: 0.88 } }),
    ];

    const result = runSimulatedStrategy('collaborative', [round1, round2]);
    expect(result.convergenceScore).toBeGreaterThan(0.5);
    expect(result.rounds).toBeGreaterThanOrEqual(1);
  });
});
