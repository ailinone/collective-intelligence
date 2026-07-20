// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration tests — Per-agent path + median consensus + topology
 * synthesized state (F2.6).
 *
 * Drives `synthesizeSharedStateFromPerAgent` end-to-end with the
 * per-agent aggregator + topology so the integration contract exposed
 * to `SensitivityConsensusStrategy.runCoordinationLoop` is validated
 * without spinning up the full strategy (which would require adapter
 * resolution + model calls).
 */

import { describe, it, expect } from 'vitest';
import type { CoordinationLimits, CoordinationSignal } from '../coordination-types';
import {
  createInitialPerAgentStates,
  aggregatePerAgent,
  synthesizeSharedStateFromPerAgent,
} from '../per-agent-state';
import {
  createFullyConnectedTopology,
  createRingTopology,
  createSparseRandomTopology,
} from '../collective-topology';

function defaultLimits(): CoordinationLimits {
  return {
    maxRounds: 3,
    minConvergenceScore: 0.82,
    maxDecisionFlipRate: 0.15,
    maxDissent: 0.35,
    stopOnCriticalRisk: true,
    minValidSignalsPerRound: 1,
    detectStagnation: true,
    maxCostUsd: 1.0,
    maxLatencyMs: 60000,
  };
}

function makeSignal(overrides: Partial<CoordinationSignal> = {}): CoordinationSignal {
  return {
    id: `sig-${Math.random().toString(36).slice(2, 10)}`,
    runId: 'run-int',
    round: 1,
    agentId: 'agent-default',
    modelId: 'model-default',
    providerId: 'p',
    decision: { type: 'approve', value: 'y', confidence: 0.8, rationale: 'r' },
    sensitivities: [
      { variable: 'risk', direction: 'decrease', trigger: 't', confidence: 0.8, rationale: 'r', expectedDelta: 0.5 },
    ],
    metrics: { latencyMs: 200, inputTokens: 100, outputTokens: 50, estimatedCost: 0.001 },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Per-agent path → synthesized shared state (F2.6)', () => {
  it('produces a synthesized state whose totals match run-level counters', () => {
    const agentIds = ['agent-a', 'agent-b', 'agent-c'];
    let perAgentStates = createInitialPerAgentStates(agentIds);
    const topology = createFullyConnectedTopology(agentIds);
    const limits = defaultLimits();

    const signals = agentIds.map((id) => makeSignal({ agentId: id }));
    const fullHistory: CoordinationSignal[] = [...signals];

    const result = aggregatePerAgent(
      perAgentStates,
      signals,
      topology,
      'weighted_confidence',
      limits,
      'sensitivity-consensus',
      'run-int',
    );
    perAgentStates = result.nextStates;

    const runCost = signals.reduce((acc, s) => acc + (s.metrics?.estimatedCost ?? 0), 0);
    const runTokens = signals.reduce(
      (acc, s) => acc + (s.metrics?.inputTokens ?? 0) + (s.metrics?.outputTokens ?? 0),
      0,
    );

    const synthesized = synthesizeSharedStateFromPerAgent({
      runId: 'run-int',
      strategy: 'sensitivity-consensus',
      perAgentStates,
      currentRoundSignals: signals,
      fullHistory,
      runTotalCostUsd: runCost,
      runTotalLatencyMs: 200,
      runTotalTokens: runTokens,
      limits,
      round: 1,
      cumulativeRisks: [],
      priorConfidenceTrend: [],
    });

    expect(synthesized.round).toBe(1);
    expect(synthesized.totalCostUsd).toBeCloseTo(runCost, 6);
    expect(synthesized.totalTokens).toBe(runTokens);
    // Even under fully-connected topology, the synthesized state must
    // reflect all 3 agents' contributions to 'risk'.
    expect(Object.keys(synthesized.variables)).toContain('risk');
  });

  it('aligns dissent metric with the round\'s decision distribution', () => {
    const agentIds = ['a', 'b', 'c'];
    let perAgentStates = createInitialPerAgentStates(agentIds);
    const topology = createFullyConnectedTopology(agentIds);

    // 2 approve, 1 reject → dissent = 1/3 ≈ 0.333
    const signals = [
      makeSignal({ agentId: 'a', decision: { type: 'approve', value: 'y', confidence: 0.8, rationale: 'r' } }),
      makeSignal({ agentId: 'b', decision: { type: 'approve', value: 'y', confidence: 0.8, rationale: 'r' } }),
      makeSignal({ agentId: 'c', decision: { type: 'reject', value: 'n', confidence: 0.7, rationale: 'r' } }),
    ];

    const result = aggregatePerAgent(
      perAgentStates,
      signals,
      topology,
      'weighted_confidence',
      defaultLimits(),
      'sensitivity-consensus',
      'run-dissent',
    );
    perAgentStates = result.nextStates;

    const synthesized = synthesizeSharedStateFromPerAgent({
      runId: 'run-dissent',
      strategy: 'sensitivity-consensus',
      perAgentStates,
      currentRoundSignals: signals,
      fullHistory: signals,
      runTotalCostUsd: 0.003,
      runTotalLatencyMs: 200,
      runTotalTokens: 450,
      limits: defaultLimits(),
      round: 1,
      cumulativeRisks: [],
      priorConfidenceTrend: [],
    });

    expect(synthesized.convergence.dissent).toBeCloseTo(1 / 3, 5);
  });

  it('confidence trend grows by exactly one entry per synthesized round', () => {
    const agentIds = ['a', 'b'];
    let perAgentStates = createInitialPerAgentStates(agentIds);
    const topology = createFullyConnectedTopology(agentIds);

    const round1 = [
      makeSignal({ agentId: 'a', round: 1, decision: { type: 'approve', value: 'y', confidence: 0.6, rationale: 'r' } }),
      makeSignal({ agentId: 'b', round: 1, decision: { type: 'approve', value: 'y', confidence: 0.65, rationale: 'r' } }),
    ];
    perAgentStates = aggregatePerAgent(
      perAgentStates,
      round1,
      topology,
      'weighted_confidence',
      defaultLimits(),
      'sensitivity-consensus',
      'run-trend',
    ).nextStates;

    const after1 = synthesizeSharedStateFromPerAgent({
      runId: 'run-trend',
      strategy: 'sensitivity-consensus',
      perAgentStates,
      currentRoundSignals: round1,
      fullHistory: [...round1],
      runTotalCostUsd: 0.002,
      runTotalLatencyMs: 200,
      runTotalTokens: 300,
      limits: defaultLimits(),
      round: 1,
      cumulativeRisks: [],
      priorConfidenceTrend: [],
    });
    expect(after1.convergence.confidenceTrend.length).toBe(1);

    const round2 = [
      makeSignal({ agentId: 'a', round: 2, decision: { type: 'approve', value: 'y', confidence: 0.8, rationale: 'r' } }),
      makeSignal({ agentId: 'b', round: 2, decision: { type: 'approve', value: 'y', confidence: 0.85, rationale: 'r' } }),
    ];
    perAgentStates = aggregatePerAgent(
      perAgentStates,
      round2,
      topology,
      'weighted_confidence',
      defaultLimits(),
      'sensitivity-consensus',
      'run-trend',
    ).nextStates;

    const after2 = synthesizeSharedStateFromPerAgent({
      runId: 'run-trend',
      strategy: 'sensitivity-consensus',
      perAgentStates,
      currentRoundSignals: round2,
      fullHistory: [...round1, ...round2],
      runTotalCostUsd: 0.004,
      runTotalLatencyMs: 400,
      runTotalTokens: 600,
      limits: defaultLimits(),
      round: 2,
      cumulativeRisks: [],
      priorConfidenceTrend: after1.convergence.confidenceTrend,
    });
    expect(after2.convergence.confidenceTrend.length).toBe(2);
    expect(after2.convergence.confidenceTrend[0]).toBeCloseTo(after1.convergence.confidenceTrend[0]);
  });

  it('decisionFlipRate measures cross-round flips deterministically', () => {
    const agentIds = ['a', 'b'];
    let perAgentStates = createInitialPerAgentStates(agentIds);
    const topology = createFullyConnectedTopology(agentIds);

    // Round 1: a/approve b/reject. Round 2: a flips to reject, b stays.
    const round1 = [
      makeSignal({ agentId: 'a', round: 1, decision: { type: 'approve', value: 'y', confidence: 0.7, rationale: 'r' } }),
      makeSignal({ agentId: 'b', round: 1, decision: { type: 'reject', value: 'n', confidence: 0.7, rationale: 'r' } }),
    ];
    perAgentStates = aggregatePerAgent(
      perAgentStates,
      round1,
      topology,
      'weighted_confidence',
      defaultLimits(),
      'sensitivity-consensus',
      'run-flip',
    ).nextStates;

    const round2 = [
      makeSignal({ agentId: 'a', round: 2, decision: { type: 'reject', value: 'n', confidence: 0.8, rationale: 'r' } }),
      makeSignal({ agentId: 'b', round: 2, decision: { type: 'reject', value: 'n', confidence: 0.8, rationale: 'r' } }),
    ];
    perAgentStates = aggregatePerAgent(
      perAgentStates,
      round2,
      topology,
      'weighted_confidence',
      defaultLimits(),
      'sensitivity-consensus',
      'run-flip',
    ).nextStates;

    const synthesized = synthesizeSharedStateFromPerAgent({
      runId: 'run-flip',
      strategy: 'sensitivity-consensus',
      perAgentStates,
      currentRoundSignals: round2,
      fullHistory: [...round1, ...round2],
      runTotalCostUsd: 0.004,
      runTotalLatencyMs: 400,
      runTotalTokens: 600,
      limits: defaultLimits(),
      round: 2,
      cumulativeRisks: [],
      priorConfidenceTrend: [0.7],
    });

    // 1 of 2 agents flipped → 0.5
    expect(synthesized.convergence.decisionFlipRate).toBeCloseTo(0.5);
  });

  it('topology variation produces different per-agent variable coverage', () => {
    const agentIds = ['a', 'b', 'c', 'd'];
    const ringTopology = createRingTopology(agentIds);
    const sparseTopology = createSparseRandomTopology(agentIds, {
      edgeProbability: 0,
      ensureConnected: false,
      seed: 0,
    });

    // Signal exclusive to agent 'c' (only c's neighbors should observe).
    const signals = [
      makeSignal({ agentId: 'a', sensitivities: [
        { variable: 'risk', direction: 'decrease', trigger: 't', confidence: 0.8, rationale: 'r', expectedDelta: 0.5 },
      ] }),
      makeSignal({ agentId: 'b', sensitivities: [
        { variable: 'risk', direction: 'decrease', trigger: 't', confidence: 0.8, rationale: 'r', expectedDelta: 0.4 },
      ] }),
      makeSignal({ agentId: 'c', sensitivities: [
        { variable: 'risk', direction: 'decrease', trigger: 't', confidence: 0.8, rationale: 'r', expectedDelta: 0.6 },
        { variable: 'cost', direction: 'increase', trigger: 't', confidence: 0.7, rationale: 'r', expectedDelta: 0.3 },
      ] }),
      makeSignal({ agentId: 'd', sensitivities: [
        { variable: 'risk', direction: 'decrease', trigger: 't', confidence: 0.8, rationale: 'r', expectedDelta: 0.5 },
      ] }),
    ];

    const ringStates = aggregatePerAgent(
      createInitialPerAgentStates(agentIds),
      signals,
      ringTopology,
      'weighted_confidence',
      defaultLimits(),
      'sensitivity-consensus',
      'run-ring',
    ).nextStates;

    const sparseStates = aggregatePerAgent(
      createInitialPerAgentStates(agentIds),
      signals,
      sparseTopology,
      'weighted_confidence',
      defaultLimits(),
      'sensitivity-consensus',
      'run-sparse',
    ).nextStates;

    // Under ring topology, b and d (neighbors of c) observe 'cost'.
    // Under sparse + ensureConnected=false, only c observes 'cost'
    // (own emission).
    expect(Object.keys(ringStates.get('b')!.variables)).toContain('cost');
    expect(Object.keys(sparseStates.get('a')!.variables)).not.toContain('cost');
    expect(Object.keys(sparseStates.get('c')!.variables)).toContain('cost');
  });
});
