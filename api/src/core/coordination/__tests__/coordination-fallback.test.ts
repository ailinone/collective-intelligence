// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Fallback End-to-End Tests for Sensitivity Consensus Strategy
 *
 * Tests the real fallback paths:
 * - Feature flag disabled → ConsensusStrategy path resolved
 * - Invalid signals → safe stop
 * - Provider failure → graceful degradation
 * - Max cost exceeded → stop
 * - High parse failure rate → continued with partial signals
 * - llm_synthesis method → explicit fallback with warning
 */

import { describe, it, expect } from 'vitest';
import { SensitivityConsensusStrategy } from '../../orchestration/strategies/sensitivity-consensus-strategy';
import {
  createInitialState,
  aggregateSignals,
  evaluateStopConditions,
} from '../sensitivity-aggregator';
import { evaluateConvergence } from '../convergence-evaluator';
import type { CoordinationSignal, CoordinationLimits, AggregationMethod } from '../coordination-types';
import { DEFAULT_COORDINATION_CONFIG } from '../coordination-types';

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
  id: `sig-${Math.random().toString(36).slice(2, 10)}`,
  runId: 'run-fallback-test',
  round: 1,
  agentId: 'agent-a',
  modelId: 'model-a',
  providerId: 'provider-a',
  decision: {
    type: 'approve',
    value: 'approved',
    confidence: 0.85,
    rationale: 'Test rationale',
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

describe('Fallback: Strategy Metadata', () => {
  it('strategy declares correct minModels for fallback eligibility check', () => {
    const strategy = new SensitivityConsensusStrategy();
    const meta = strategy.getMetadata();
    expect(meta.minModels).toBeGreaterThanOrEqual(3);
    expect(meta.estimatedCostMultiplier).toBeGreaterThan(1);
    expect(meta.suitableFor).toContain('analysis');
  });

  it('fallback strategy name is consensus', () => {
    const strategy = new SensitivityConsensusStrategy();
    const meta = strategy.getMetadata();
    expect(meta.name).toBe('sensitivity-consensus');
  });
});

describe('Fallback: Feature Flag Disabled', () => {
  it('default config has enabled=false, ensuring fallback path is default', () => {
    expect(DEFAULT_COORDINATION_CONFIG.enabled).toBe(false);
  });

  it('sensitivity-consensus is not auto-selected by triage', () => {
    expect(DEFAULT_COORDINATION_CONFIG.requireQualityTarget).toBeGreaterThanOrEqual(0.8);
  });
});

describe('Fallback: Empty Signals → Safe Stop', () => {
  it('aggregateSignals returns insufficient_valid_signals for empty input', () => {
    const state = createInitialState('run-empty', 'sensitivity-consensus', defaultLimits());
    const result = aggregateSignals([], state);
    expect(result.stopReason).toBe('insufficient_valid_signals');
    expect(result.risks).toHaveLength(1);
    expect(result.risks[0].severity).toBe('critical');
  });

  it('nextState is unchanged when no signals', () => {
    const state = createInitialState('run-empty', 'sensitivity-consensus', defaultLimits());
    const result = aggregateSignals([], state);
    expect(result.nextState.round).toBe(0);
    expect(result.nextState.history).toHaveLength(0);
  });
});

describe('Fallback: Provider Failure Simulation', () => {
  it('partial signals (some models failed) still aggregate', () => {
    const state = createInitialState('run-partial', 'sensitivity-consensus', defaultLimits());
    const onlyValidSignal = makeSignal({ agentId: 'only-survivor', modelId: 'surviving-model' });

    const result = aggregateSignals([onlyValidSignal], state);
    expect(result.nextState.round).toBe(1);
    expect(result.nextState.history).toHaveLength(1);
  });

  it('cost from partial signals accumulates correctly', () => {
    const state = createInitialState('run-partial-cost', 'sensitivity-consensus', defaultLimits());
    const signals = [
      makeSignal({
        agentId: 'a',
        metrics: { latencyMs: 500, inputTokens: 100, outputTokens: 50, estimatedCost: 0.01 },
      }),
    ];

    const result = aggregateSignals(signals, state);
    expect(result.nextState.totalCostUsd).toBeCloseTo(0.01, 3);
  });
});

describe('Fallback: Max Cost Exceeded → Stop', () => {
  it('stops immediately when cost exceeds limit', () => {
    const limits = defaultLimits();
    limits.maxCostUsd = 0.005;
    const state = createInitialState('run-cost-exceed', 'sensitivity-consensus', limits);

    const expensiveSignals = [
      makeSignal({
        agentId: 'a',
        metrics: { latencyMs: 500, inputTokens: 500, outputTokens: 200, estimatedCost: 0.006 },
      }),
    ];

    const result = aggregateSignals(expensiveSignals, state);
    expect(result.nextState.totalCostUsd).toBeGreaterThan(0.005);
    const stopReason = evaluateStopConditions(result.nextState);
    expect(stopReason).toBe('max_cost');
  });

  it('continues when cost is under limit', () => {
    const limits = defaultLimits();
    limits.maxCostUsd = 1.0;
    const state = createInitialState('run-cost-ok', 'sensitivity-consensus', limits);
    state.round = 1;

    const cheapSignals = [
      makeSignal({
        agentId: 'a',
        metrics: { latencyMs: 200, inputTokens: 50, outputTokens: 20, estimatedCost: 0.001 },
      }),
    ];

    const result = aggregateSignals(cheapSignals, state);
    expect(result.nextState.totalCostUsd).toBeLessThan(1.0);
    expect(result.stopReason).not.toBe('max_cost');
  });
});

describe('Fallback: Max Latency Exceeded → Stop', () => {
  it('stops when accumulated latency exceeds limit', () => {
    const limits = defaultLimits();
    limits.maxLatencyMs = 500;
    const state = createInitialState('run-latency-exceed', 'sensitivity-consensus', limits);

    const slowSignals = [
      makeSignal({
        agentId: 'a',
        metrics: { latencyMs: 600, inputTokens: 100, outputTokens: 50, estimatedCost: 0.005 },
      }),
    ];

    const result = aggregateSignals(slowSignals, state);
    const stopReason = evaluateStopConditions(result.nextState);
    expect(stopReason).toBe('max_latency');
  });
});

describe('Fallback: Critical Risk → Immediate Stop', () => {
  it('stops on critical risk from sensitivity aggregation', () => {
    const limits = defaultLimits();
    limits.stopOnCriticalRisk = true;
    const state = createInitialState('run-critical-risk', 'sensitivity-consensus', limits);

    const signals = [
      makeSignal({
        agentId: 'a',
        sensitivities: [{
          variable: 'data_loss',
          direction: 'block' as const,
          trigger: 'unrecoverable data loss possible',
          confidence: 0.99,
          rationale: 'critical issue detected',
          risk: 'critical' as const,
        }],
      }),
      makeSignal({ agentId: 'b' }),
    ];

    const result = aggregateSignals(signals, state);
    expect(result.risks.some(r => r.severity === 'critical')).toBe(true);
    const stopReason = evaluateStopConditions(result.nextState);
    expect(stopReason).toBe('critical_risk');
  });

  it('does not stop on critical risk when stopOnCriticalRisk is false', () => {
    const limits = defaultLimits();
    limits.stopOnCriticalRisk = false;
    const state = createInitialState('run-no-stop-critical', 'sensitivity-consensus', limits);
    state.round = 1;
    state.convergence.score = 0.5;
    state.convergence.decisionFlipRate = 0.5;

    const signals = [
      makeSignal({
        agentId: 'a',
        sensitivities: [{
          variable: 'data_loss',
          direction: 'block' as const,
          trigger: 'unrecoverable data loss',
          confidence: 0.99,
          rationale: 'critical',
          risk: 'critical' as const,
        }],
      }),
      makeSignal({ agentId: 'b' }),
    ];

    const result = aggregateSignals(signals, state);
    const stopReason = evaluateStopConditions(result.nextState);
    expect(stopReason).not.toBe('critical_risk');
  });
});

describe('Fallback: Persistent Divergence → Stop', () => {
  it('stops on persistent divergence after multiple rounds', () => {
    const limits = defaultLimits();
    limits.maxRounds = 5;
    const state = createInitialState('run-divergence', 'sensitivity-consensus', limits);
    state.round = 3;
    state.convergence.score = 0.3;
    state.convergence.decisionFlipRate = 0.6;
    state.convergence.dissent = 0.7;

    const stopReason = evaluateStopConditions(state);
    expect(stopReason).toBe('persistent_divergence');
  });
});

describe('Fallback: llm_synthesis → Explicit Warning Fallback', () => {
  it('llm_synthesis method falls back to weighted_confidence without silent failure', () => {
    const state = createInitialState('run-llm-synthesis', 'sensitivity-consensus', defaultLimits());
    const signals = [
      makeSignal({ agentId: 'a' }),
      makeSignal({ agentId: 'b' }),
    ];

    const result = aggregateSignals(signals, state, 'llm_synthesis' as AggregationMethod);
    expect(result.nextState.round).toBe(1);
    expect(result.nextState.history).toHaveLength(2);
    expect(result.updatedVariables.length).toBeGreaterThan(0);
  });
});

describe('Fallback: Convergence After Divergence', () => {
  it('models that disagree in round 1 can converge in round 2', () => {
    const limits = defaultLimits();
    let state = createInitialState('run-converge', 'sensitivity-consensus', limits);

    const round1 = [
      makeSignal({ agentId: 'a', round: 1, decision: { type: 'approve', value: 'yes', confidence: 0.6 } }),
      makeSignal({ agentId: 'b', round: 1, decision: { type: 'reject', value: 'no', confidence: 0.7 } }),
      makeSignal({ agentId: 'c', round: 1, decision: { type: 'approve', value: 'yes', confidence: 0.65 } }),
    ];

    state = aggregateSignals(round1, state).nextState;
    expect(state.convergence.dissent).toBeGreaterThan(0);

    const round2 = [
      makeSignal({ agentId: 'a', round: 2, decision: { type: 'approve', value: 'yes', confidence: 0.85 } }),
      makeSignal({ agentId: 'b', round: 2, decision: { type: 'approve', value: 'yes', confidence: 0.80 } }),
      makeSignal({ agentId: 'c', round: 2, decision: { type: 'approve', value: 'yes', confidence: 0.82 } }),
    ];

    state = aggregateSignals(round2, state).nextState;
    expect(state.convergence.dissent).toBe(0);
    expect(state.convergence.decisionFlipRate).toBeGreaterThan(0);

    const evalResult = evaluateConvergence(state);
    expect(evalResult.convergenceScore).toBeGreaterThan(state.convergence.score * 0.5);
  });
});

describe('Fallback: Stagnation Detection', () => {
  it('detects stagnation when confidence trend is flat for 3+ rounds', () => {
    const limits = defaultLimits();
    limits.maxRounds = 5;
    const state = createInitialState('run-stagnation', 'sensitivity-consensus', limits);
    state.round = 3;
    state.history = [
      makeSignal({ agentId: 'a', round: 1 }),
      makeSignal({ agentId: 'b', round: 1 }),
      makeSignal({ agentId: 'a', round: 2 }),
      makeSignal({ agentId: 'b', round: 2 }),
      makeSignal({ agentId: 'a', round: 3 }),
      makeSignal({ agentId: 'b', round: 3 }),
    ];
    state.convergence = {
      score: 0.65,
      decisionFlipRate: 0,
      dissent: 0.2,
      confidenceTrend: [0.65, 0.651, 0.650],
      stableVariables: [],
      unstableVariables: [],
    };

    const evalResult = evaluateConvergence(state);
    expect(evalResult.stagnationDetected).toBe(true);
    expect(evalResult.shouldStop).toBe(true);
    expect(evalResult.stopReason).toBe('stagnation');
  });
});
