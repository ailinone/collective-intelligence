// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — Per-agent state + coordinate-wise median consensus (F2.3)
 *
 * Two complementary modules:
 *   - per-agent-state.ts:    each agent keeps its own θᵢ; aggregation
 *                            scoped to neighbor signals.
 *   - coordinate-median-consensus.ts: collapses {θᵢ} into a single
 *                                     consensus state via median/mode.
 */

import { describe, it, expect } from 'vitest';
import type { CoordinationLimits, CoordinationSignal } from '../coordination-types';
import {
  createInitialPerAgentStates,
  aggregatePerAgent,
  summarizePerAgentStates,
} from '../per-agent-state';
import {
  coordinateMedianConsensus,
} from '../coordinate-median-consensus';
import {
  createFullyConnectedTopology,
  createRingTopology,
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
  };
}

function makeSignal(overrides: Partial<CoordinationSignal> = {}): CoordinationSignal {
  return {
    id: `sig-${Math.random().toString(36).slice(2, 10)}`,
    runId: 'run-test',
    round: 1,
    agentId: 'agent-default',
    modelId: 'model-default',
    providerId: 'provider-default',
    decision: { type: 'approve', value: 'y', confidence: 0.85, rationale: 'r' },
    sensitivities: [
      {
        variable: 'risk',
        direction: 'decrease',
        trigger: 't',
        confidence: 0.8,
        rationale: 'baseline',
        expectedDelta: 0.5,
      },
    ],
    metrics: { latencyMs: 400, inputTokens: 100, outputTokens: 50, estimatedCost: 0.001 },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── createInitialPerAgentStates ────────────────────────────────────────

describe('createInitialPerAgentStates', () => {
  it('builds one entry per agent in deterministic order', () => {
    const map = createInitialPerAgentStates(['a', 'b', 'c']);
    expect([...map.keys()]).toEqual(['a', 'b', 'c']);
    for (const state of map.values()) {
      expect(state.round).toBe(0);
      expect(state.variables).toEqual({});
      expect(state.history).toEqual([]);
      expect(state.totalCostUsd).toBe(0);
    }
  });

  it('deduplicates input agents', () => {
    const map = createInitialPerAgentStates(['a', 'b', 'a', 'c']);
    expect([...map.keys()]).toEqual(['a', 'b', 'c']);
  });

  it('skips invalid agent ids', () => {
    const map = createInitialPerAgentStates(['a', '', 'b']);
    expect([...map.keys()]).toEqual(['a', 'b']);
  });
});

// ─── aggregatePerAgent ─────────────────────────────────────────────────

describe('aggregatePerAgent', () => {
  it('produces one state per agent under fully-connected topology', () => {
    const agentIds = ['a', 'b', 'c'];
    const states = createInitialPerAgentStates(agentIds);
    const topology = createFullyConnectedTopology(agentIds);
    const signals = agentIds.map((id) => makeSignal({ agentId: id }));

    const { nextStates, perAgentResults } = aggregatePerAgent(
      states,
      signals,
      topology,
      'weighted_confidence',
      defaultLimits(),
      'sensitivity-consensus',
      'run-test',
    );

    expect(nextStates.size).toBe(3);
    expect(perAgentResults.size).toBe(3);
    for (const agentId of agentIds) {
      const next = nextStates.get(agentId);
      expect(next).toBeDefined();
      expect(next!.round).toBe(1);
      // Under fully-connected, every agent saw all 3 signals → 'risk' should be present
      expect(Object.keys(next!.variables)).toContain('risk');
    }
  });

  it('limits each agent\'s view to its neighbors under a ring topology', () => {
    const agentIds = ['a', 'b', 'c', 'd'];
    const states = createInitialPerAgentStates(agentIds);
    const topology = createRingTopology(agentIds);
    // Signal from 'c' has a unique extra sensitivity variable 'cost'.
    const signals = [
      makeSignal({ agentId: 'a', sensitivities: [{ variable: 'risk', direction: 'decrease', trigger: 't', confidence: 0.8, rationale: 'r-a', expectedDelta: 0.5 }] }),
      makeSignal({ agentId: 'b', sensitivities: [{ variable: 'risk', direction: 'decrease', trigger: 't', confidence: 0.8, rationale: 'r-b', expectedDelta: 0.4 }] }),
      makeSignal({
        agentId: 'c',
        sensitivities: [
          { variable: 'risk', direction: 'decrease', trigger: 't', confidence: 0.8, rationale: 'r-c', expectedDelta: 0.6 },
          { variable: 'cost', direction: 'increase', trigger: 't', confidence: 0.7, rationale: 'r-c', expectedDelta: 0.3 },
        ],
      }),
      makeSignal({ agentId: 'd', sensitivities: [{ variable: 'risk', direction: 'decrease', trigger: 't', confidence: 0.8, rationale: 'r-d', expectedDelta: 0.5 }] }),
    ];

    const { nextStates } = aggregatePerAgent(
      states,
      signals,
      topology,
      'weighted_confidence',
      defaultLimits(),
      'sensitivity-consensus',
      'run-test',
    );

    // Ring on 4 nodes: a's neighbors are d,b. So a sees signals from a,b,d
    // — which means it does NOT observe 'cost' from c.
    expect(Object.keys(nextStates.get('a')!.variables)).not.toContain('cost');
    // c IS the source of 'cost' so it observes it (own emission).
    expect(Object.keys(nextStates.get('c')!.variables)).toContain('cost');
    // b's neighbors are a and c, so b also observes 'cost' from c.
    expect(Object.keys(nextStates.get('b')!.variables)).toContain('cost');
  });

  it('falls back from llm_synthesis to weighted_confidence (per-agent path is sync-only)', () => {
    const agentIds = ['a', 'b'];
    const states = createInitialPerAgentStates(agentIds);
    const topology = createFullyConnectedTopology(agentIds);
    const signals = agentIds.map((id) => makeSignal({ agentId: id }));

    // Should not throw and should produce results — the explicit fallback
    // means the caller sees `weighted_confidence` math even when they
    // requested `llm_synthesis`.
    const { nextStates } = aggregatePerAgent(
      states,
      signals,
      topology,
      'llm_synthesis',
      defaultLimits(),
      'sensitivity-consensus',
      'run-test',
    );
    expect(nextStates.size).toBe(2);
  });

  it('does not mutate the input map', () => {
    const agentIds = ['a', 'b'];
    const states = createInitialPerAgentStates(agentIds);
    const before = JSON.stringify({
      a: states.get('a')!.variables,
      b: states.get('b')!.variables,
    });

    const topology = createFullyConnectedTopology(agentIds);
    const signals = agentIds.map((id) => makeSignal({ agentId: id }));
    aggregatePerAgent(states, signals, topology, 'weighted_confidence', defaultLimits(), 'sensitivity-consensus', 'run-test');

    const after = JSON.stringify({
      a: states.get('a')!.variables,
      b: states.get('b')!.variables,
    });
    expect(after).toBe(before);
  });
});

// ─── summarizePerAgentStates ────────────────────────────────────────────

describe('summarizePerAgentStates', () => {
  it('produces a snapshot per agent', () => {
    const map = createInitialPerAgentStates(['a', 'b']);
    const summary = summarizePerAgentStates(map);
    expect(summary).toHaveLength(2);
    expect(summary[0]).toMatchObject({ agentId: 'a', round: 0, variableCount: 0, totalCostUsd: 0 });
  });
});

// ─── coordinateMedianConsensus ──────────────────────────────────────────

describe('coordinateMedianConsensus', () => {
  it('produces a numeric coordinate median', () => {
    const states = createInitialPerAgentStates(['a', 'b', 'c', 'd', 'e']);
    states.get('a')!.variables.risk = { value: 0.1, confidence: 0.8, updatedBy: ['a'], rationale: 'r', stability: 1 };
    states.get('b')!.variables.risk = { value: 0.2, confidence: 0.8, updatedBy: ['b'], rationale: 'r', stability: 1 };
    states.get('c')!.variables.risk = { value: 0.3, confidence: 0.8, updatedBy: ['c'], rationale: 'r', stability: 1 };
    states.get('d')!.variables.risk = { value: 0.4, confidence: 0.8, updatedBy: ['d'], rationale: 'r', stability: 1 };
    states.get('e')!.variables.risk = { value: 0.5, confidence: 0.8, updatedBy: ['e'], rationale: 'r', stability: 1 };

    const result = coordinateMedianConsensus(states);
    expect(result.variables.risk).toBeDefined();
    expect(result.variables.risk.value).toBe(0.3);
  });

  it('is robust to outliers (median, not mean)', () => {
    const states = createInitialPerAgentStates(['a', 'b', 'c']);
    states.get('a')!.variables.x = { value: 10, confidence: 0.9, updatedBy: ['a'], rationale: 'r', stability: 1 };
    states.get('b')!.variables.x = { value: 11, confidence: 0.9, updatedBy: ['b'], rationale: 'r', stability: 1 };
    // outlier
    states.get('c')!.variables.x = { value: 1000, confidence: 0.9, updatedBy: ['c'], rationale: 'r', stability: 1 };

    const result = coordinateMedianConsensus(states);
    // Median of {10, 11, 1000} = 11; mean would be ~340.
    expect(result.variables.x.value).toBe(11);
  });

  it('uses confidence-weighted mode for non-numeric values', () => {
    const states = createInitialPerAgentStates(['a', 'b', 'c']);
    states.get('a')!.variables.decision = { value: 'approve', confidence: 0.9, updatedBy: ['a'], rationale: 'r', stability: 1 };
    states.get('b')!.variables.decision = { value: 'approve', confidence: 0.6, updatedBy: ['b'], rationale: 'r', stability: 1 };
    states.get('c')!.variables.decision = { value: 'reject', confidence: 0.3, updatedBy: ['c'], rationale: 'r', stability: 1 };

    const result = coordinateMedianConsensus(states);
    expect(result.variables.decision.value).toBe('approve');
    // Two of three agreed
    expect(result.agreementByVariable.decision).toBeCloseTo(2 / 3);
  });

  it('reports partial-coverage variables', () => {
    const states = createInitialPerAgentStates(['a', 'b', 'c']);
    states.get('a')!.variables.risk = { value: 0.5, confidence: 0.8, updatedBy: ['a'], rationale: 'r', stability: 1 };
    // 'b' did not observe 'risk' (e.g. topology blocked it)
    states.get('c')!.variables.risk = { value: 0.6, confidence: 0.8, updatedBy: ['c'], rationale: 'r', stability: 1 };

    const result = coordinateMedianConsensus(states);
    expect(result.partialCoverageVariables).toContain('risk');
  });

  it('reports unanimous agreement when all values match', () => {
    const states = createInitialPerAgentStates(['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) {
      states.get(id)!.variables.shared = {
        value: 0.5,
        confidence: 0.9,
        updatedBy: [id],
        rationale: 'r',
        stability: 1,
      };
    }
    const result = coordinateMedianConsensus(states);
    expect(result.agreementByVariable.shared).toBe(1);
  });

  it('handles empty per-agent map gracefully', () => {
    const result = coordinateMedianConsensus(new Map());
    expect(result.variables).toEqual({});
    expect(result.agreementByVariable).toEqual({});
    expect(result.partialCoverageVariables).toEqual([]);
  });

  it('mixes numeric and categorical variables independently per variable', () => {
    const states = createInitialPerAgentStates(['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) {
      states.get(id)!.variables.numeric_var = {
        value: id === 'b' ? 0.5 : id === 'a' ? 0.4 : 0.6,
        confidence: 0.8,
        updatedBy: [id],
        rationale: 'r',
        stability: 1,
      };
      states.get(id)!.variables.cat_var = {
        value: id === 'c' ? 'no' : 'yes',
        confidence: 0.8,
        updatedBy: [id],
        rationale: 'r',
        stability: 1,
      };
    }
    const result = coordinateMedianConsensus(states);
    expect(result.variables.numeric_var.value).toBe(0.5); // median of 0.4/0.5/0.6
    expect(result.variables.cat_var.value).toBe('yes'); // 2 of 3 agents
  });
});
