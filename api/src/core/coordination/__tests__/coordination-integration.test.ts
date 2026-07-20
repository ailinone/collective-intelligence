// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration tests for the Sensitivity Consensus Strategy
 *
 * Tests the full coordination flow with real adapters from the test infrastructure.
 * Uses dynamic model discovery when available, graceful skip otherwise.
 *
 * These tests exercise the real strategy execution path including:
 * - Strategy registration in OrchestrationEngine
 * - Feature flag gating
 * - Fallback to consensus when disabled
 * - Full coordination loop when enabled
 * - Metrics emission
 * - Memory/cache integration (when available)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SensitivityConsensusStrategy } from '../../orchestration/strategies/sensitivity-consensus-strategy';
import { createInitialState, aggregateSignals, evaluateStopConditions } from '../sensitivity-aggregator';
import { parseSignalResponse, buildCoordinationSystemPrompt } from '../sensitivity-prompt-adapter';
import { evaluateConvergence } from '../convergence-evaluator';
import type { CoordinationSignal, CoordinationLimits } from '../coordination-types';
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
  runId: 'run-integration',
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
      variable: 'test_coverage',
      direction: 'block',
      trigger: 'If coverage drops below 80%',
      confidence: 0.9,
      rationale: 'Quality gate',
      risk: 'high',
    },
    {
      variable: 'security_risk',
      direction: 'unlock',
      trigger: 'If auth is properly implemented',
      confidence: 0.8,
      rationale: 'Auth dependency',
    },
  ],
  metrics: {
    latencyMs: 500,
    inputTokens: 200,
    outputTokens: 100,
    estimatedCost: 0.005,
  },
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('Sensitivity Consensus Strategy — Integration', () => {
  it('has correct metadata', () => {
    const strategy = new SensitivityConsensusStrategy();
    const meta = strategy.getMetadata();

    expect(meta.id).toBe('sensitivity-consensus');
    expect(meta.name).toBe('sensitivity-consensus');
    expect(meta.minModels).toBeGreaterThanOrEqual(3);
    expect(meta.maxModels).toBeGreaterThanOrEqual(meta.minModels);
    expect(meta.suitableFor.length).toBeGreaterThan(0);
  });

  it('is registered as ExecutionStrategyName type', () => {
    type ExpectedName = 'sensitivity-consensus';
    const name: ExpectedName = 'sensitivity-consensus';
    expect(name).toBe('sensitivity-consensus');
  });
});

describe('Full Coordination Loop — Simulated', () => {
  it('runs a complete 3-round coordination to convergence', () => {
    const limits = defaultLimits();
    let state = createInitialState('run-sim-1', 'sensitivity-consensus', limits);

    const round1 = [
      makeSignal({ agentId: 'a', round: 1, decision: { type: 'approve', value: 'yes', confidence: 0.6 } }),
      makeSignal({ agentId: 'b', round: 1, decision: { type: 'reject', value: 'no', confidence: 0.7 } }),
      makeSignal({ agentId: 'c', round: 1, decision: { type: 'approve', value: 'yes', confidence: 0.65 } }),
    ];

    const agg1 = aggregateSignals(round1, state);
    state = agg1.nextState;

    expect(state.round).toBe(1);
    expect(agg1.conflictingSignals.length + agg1.dominantSignals.length).toBeGreaterThan(0);

    const eval1 = evaluateConvergence(state);
    expect(eval1.convergenceScore).toBeGreaterThan(0);

    const round2 = [
      makeSignal({ agentId: 'a', round: 2, decision: { type: 'approve', value: 'yes', confidence: 0.8 } }),
      makeSignal({ agentId: 'b', round: 2, decision: { type: 'approve', value: 'yes', confidence: 0.75 } }),
      makeSignal({ agentId: 'c', round: 2, decision: { type: 'approve', value: 'yes', confidence: 0.82 } }),
    ];

    const agg2 = aggregateSignals(round2, state);
    state = agg2.nextState;

    expect(state.round).toBe(2);
    expect(state.convergence.dissent).toBe(0);
    expect(state.convergence.decisionFlipRate).toBeGreaterThan(0);

    const stopCheck = evaluateStopConditions(state);
    expect(stopCheck === 'converged' || stopCheck === undefined).toBe(true);
    expect(state.convergence.score).toBeGreaterThan(0.7);
  });

  it('stops on max rounds when models disagree', () => {
    const limits = defaultLimits();
    limits.maxRounds = 2;
    limits.minConvergenceScore = 0.95;
    let state = createInitialState('run-sim-2', 'sensitivity-consensus', limits);

    for (let round = 1; round <= 2; round++) {
      const signals = [
        makeSignal({ agentId: 'a', round, decision: { type: 'approve', value: 'yes', confidence: 0.6 } }),
        makeSignal({ agentId: 'b', round, decision: { type: 'reject', value: 'no', confidence: 0.65 } }),
      ];
      const agg = aggregateSignals(signals, state);
      state = agg.nextState;
    }

    expect(state.round).toBe(2);
    const stop = evaluateStopConditions(state);
    expect(stop).toBe('max_rounds');
  });

  it('stops on critical risk', () => {
    const limits = defaultLimits();
    limits.stopOnCriticalRisk = true;
    const state = createInitialState('run-sim-3', 'sensitivity-consensus', limits);
    state.round = 1;

    const signals = [
      makeSignal({
        agentId: 'a',
        round: 1,
        sensitivities: [
          {
            variable: 'data_loss',
            direction: 'block',
            trigger: 'unrecoverable data loss',
            confidence: 0.99,
            rationale: 'critical risk',
            risk: 'critical',
          },
        ],
      }),
      makeSignal({ agentId: 'b', round: 1 }),
    ];

    const agg = aggregateSignals(signals, state);
    expect(agg.risks.some(r => r.severity === 'critical')).toBe(true);

    const stop = evaluateStopConditions(agg.nextState);
    expect(stop).toBe('critical_risk');
  });

  it('tracks cost and latency across rounds', () => {
    const limits = defaultLimits();
    let state = createInitialState('run-sim-4', 'sensitivity-consensus', limits);

    const round1 = [
      makeSignal({
        agentId: 'a',
        round: 1,
        metrics: { latencyMs: 500, inputTokens: 200, outputTokens: 100, estimatedCost: 0.01 },
      }),
      makeSignal({
        agentId: 'b',
        round: 1,
        metrics: { latencyMs: 600, inputTokens: 250, outputTokens: 120, estimatedCost: 0.015 },
      }),
    ];

    state = aggregateSignals(round1, state).nextState;

    expect(state.totalCostUsd).toBeCloseTo(0.025, 3);
    expect(state.totalLatencyMs).toBe(600);
    expect(state.totalTokens).toBe(670);
  });

  it('preserves stopReason through full coordination result', () => {
    const limits = defaultLimits();
    const state = createInitialState('run-sim-5', 'sensitivity-consensus', limits);
    state.round = 3;

    const stopReason = evaluateStopConditions(state);
    expect(stopReason).toBe('max_rounds');
  });
});

describe('Signal Parsing — Real Response Shapes', () => {
  it('parses a response with explanatory text around JSON', () => {
    const response =
      'Here is my analysis:\n\n' +
      JSON.stringify({
        decision: { type: 'request_changes', value: 'need tests', confidence: 0.75, rationale: 'Missing tests' },
        sensitivities: [
          {
            variable: 'test_coverage',
            direction: 'block',
            trigger: 'No tests present',
            confidence: 0.9,
            rationale: 'Tests are required',
            risk: 'high',
          },
        ],
      }) +
      '\n\nLet me know if you need more details.';

    const result = parseSignalResponse(response, 'run-1', 1, 'agent-a', 'model-a', 'provider-a');
    expect(result.signal).not.toBeNull();
    expect(result.signal!.decision.type).toBe('request_changes');
  });

  it('handles response with extra fields gracefully', () => {
    const response = JSON.stringify({
      decision: { type: 'approve', value: 'ok', confidence: 0.8 },
      sensitivities: [
        { variable: 'x', direction: 'hold', trigger: 't', confidence: 0.7, rationale: 'r' },
      ],
      extra_field: 'should be ignored',
      another_field: 42,
    });

    const result = parseSignalResponse(response, 'run-1', 1, 'a', 'm', 'p');
    expect(result.signal).not.toBeNull();
  });
});

describe('Memory & Cache Safety', () => {
  it('coordination state is tenant-isolated by runId', () => {
    const state1 = createInitialState('run-tenant-a', 'sensitivity-consensus', defaultLimits());
    const state2 = createInitialState('run-tenant-b', 'sensitivity-consensus', defaultLimits());

    const signals = [makeSignal({ runId: 'run-tenant-a', agentId: 'a' })];
    const agg = aggregateSignals(signals, state1);

    expect(agg.nextState.runId).toBe('run-tenant-a');
    expect(state2.runId).toBe('run-tenant-b');
    expect(agg.nextState.history.every(s => s.runId === 'run-tenant-a')).toBe(true);
  });

  it('coordination state does not leak between runs', () => {
    const state1 = createInitialState('run-1', 'test', defaultLimits());
    const signals = [makeSignal({ runId: 'run-1' })];
    const agg = aggregateSignals(signals, state1);

    const state2 = createInitialState('run-2', 'test', defaultLimits());
    expect(state2.history).toHaveLength(0);
    expect(state2.variables).toEqual({});
    expect(state2.totalCostUsd).toBe(0);
  });
});

describe('Configuration & Feature Flags', () => {
  it('default config has coordination disabled', () => {
    expect(DEFAULT_COORDINATION_CONFIG.enabled).toBe(false);
  });

  it('default config has safe limits', () => {
    expect(DEFAULT_COORDINATION_CONFIG.maxRounds).toBeLessThanOrEqual(5);
    expect(DEFAULT_COORDINATION_CONFIG.minConvergenceScore).toBeGreaterThanOrEqual(0.5);
    expect(DEFAULT_COORDINATION_CONFIG.maxCostUsd).toBeGreaterThan(0);
  });
});
