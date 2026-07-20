// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — CollectiveTopology (F2.2)
 *
 * Validates the structural invariants of each topology + the
 * shared helpers (filterSignalsForViewer, describeTopology, factory).
 */

import { describe, it, expect } from 'vitest';
import {
  createFullyConnectedTopology,
  createRingTopology,
  createSmallWorldTopology,
  createSparseRandomTopology,
  createTopology,
  describeTopology,
  filterSignalsForViewer,
  TOPOLOGY_KINDS,
  type CollectiveTopology,
} from '../collective-topology';
import type { CoordinationSignal } from '../coordination-types';

const AGENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function expectSymmetric(topology: CollectiveTopology): void {
  if (!topology.symmetric) return;
  for (const a of topology.agents) {
    for (const b of topology.getNeighbors(a)) {
      expect(topology.getNeighbors(b)).toContain(a);
    }
  }
}

function expectNoSelfLoops(topology: CollectiveTopology): void {
  for (const a of topology.agents) {
    expect(topology.getNeighbors(a)).not.toContain(a);
  }
}

// ─── FullyConnected ────────────────────────────────────────────────────

describe('createFullyConnectedTopology', () => {
  it('connects every agent to every other', () => {
    const t = createFullyConnectedTopology(AGENTS);
    for (const a of AGENTS) {
      const neighbors = t.getNeighbors(a);
      expect(neighbors).toHaveLength(AGENTS.length - 1);
      for (const b of AGENTS) {
        if (a !== b) expect(neighbors).toContain(b);
      }
    }
  });

  it('is symmetric and self-loop free', () => {
    const t = createFullyConnectedTopology(AGENTS);
    expectSymmetric(t);
    expectNoSelfLoops(t);
  });

  it('handles a single-agent run', () => {
    const t = createFullyConnectedTopology(['only']);
    expect(t.getNeighbors('only')).toEqual([]);
  });

  it('deduplicates input agents while preserving order', () => {
    const t = createFullyConnectedTopology(['a', 'b', 'a', 'c', 'b']);
    expect(t.agents).toEqual(['a', 'b', 'c']);
  });
});

// ─── Ring ──────────────────────────────────────────────────────────────

describe('createRingTopology', () => {
  it('produces a degree-2 ring with wrap-around', () => {
    const t = createRingTopology(['a', 'b', 'c', 'd']);
    expect(new Set(t.getNeighbors('a'))).toEqual(new Set(['d', 'b']));
    expect(new Set(t.getNeighbors('b'))).toEqual(new Set(['a', 'c']));
    expect(new Set(t.getNeighbors('c'))).toEqual(new Set(['b', 'd']));
    expect(new Set(t.getNeighbors('d'))).toEqual(new Set(['c', 'a']));
  });

  it('degenerates correctly at n=2 (degree-1 chain)', () => {
    const t = createRingTopology(['x', 'y']);
    expect(t.getNeighbors('x')).toEqual(['y']);
    expect(t.getNeighbors('y')).toEqual(['x']);
  });

  it('handles single-agent run', () => {
    const t = createRingTopology(['solo']);
    expect(t.getNeighbors('solo')).toEqual([]);
  });

  it('is symmetric and self-loop free', () => {
    const t = createRingTopology(AGENTS);
    expectSymmetric(t);
    expectNoSelfLoops(t);
  });
});

// ─── SmallWorld ────────────────────────────────────────────────────────

describe('createSmallWorldTopology', () => {
  it('with rewireProbability=0 reduces to a regular ring of degree 2k', () => {
    const t = createSmallWorldTopology(AGENTS, { k: 2, rewireProbability: 0, seed: 1 });
    expect(t.kind).toBe('small_world');
    for (const a of AGENTS) {
      // Degree should be 2k = 4 (2 left + 2 right) on a ring of 8.
      expect(t.getNeighbors(a).length).toBe(4);
    }
    expectSymmetric(t);
    expectNoSelfLoops(t);
  });

  it('produces deterministic output for the same seed', () => {
    const t1 = createSmallWorldTopology(AGENTS, { k: 2, rewireProbability: 0.3, seed: 42 });
    const t2 = createSmallWorldTopology(AGENTS, { k: 2, rewireProbability: 0.3, seed: 42 });
    for (const a of AGENTS) {
      expect(new Set(t1.getNeighbors(a))).toEqual(new Set(t2.getNeighbors(a)));
    }
  });

  it('different seeds produce different topologies (probabilistic check)', () => {
    const t1 = createSmallWorldTopology(AGENTS, { k: 2, rewireProbability: 0.5, seed: 1 });
    const t2 = createSmallWorldTopology(AGENTS, { k: 2, rewireProbability: 0.5, seed: 2 });
    let differs = false;
    for (const a of AGENTS) {
      const a1 = new Set(t1.getNeighbors(a));
      const a2 = new Set(t2.getNeighbors(a));
      if (a1.size !== a2.size || ![...a1].every((n) => a2.has(n))) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  it('preserves symmetry after rewiring', () => {
    const t = createSmallWorldTopology(AGENTS, { rewireProbability: 0.4, seed: 99 });
    expectSymmetric(t);
    expectNoSelfLoops(t);
  });

  it('caps k at floor((n-1)/2) to avoid edges back to self', () => {
    const t = createSmallWorldTopology(['a', 'b', 'c'], { k: 100, rewireProbability: 0, seed: 0 });
    for (const a of t.agents) {
      expect(t.getNeighbors(a)).not.toContain(a);
    }
  });
});

// ─── SparseRandom ──────────────────────────────────────────────────────

describe('createSparseRandomTopology', () => {
  it('with edgeProbability=0 + ensureConnected=true falls back to a ring', () => {
    const t = createSparseRandomTopology(AGENTS, { edgeProbability: 0, ensureConnected: true, seed: 0 });
    for (const a of AGENTS) {
      // With ring overlay, every agent has exactly 2 neighbors.
      expect(t.getNeighbors(a).length).toBe(2);
    }
  });

  it('with edgeProbability=0 + ensureConnected=false leaves agents isolated', () => {
    const t = createSparseRandomTopology(AGENTS, { edgeProbability: 0, ensureConnected: false, seed: 0 });
    for (const a of AGENTS) {
      expect(t.getNeighbors(a)).toEqual([]);
    }
  });

  it('with edgeProbability=1 connects every pair (regardless of ensureConnected)', () => {
    const t = createSparseRandomTopology(AGENTS, { edgeProbability: 1, ensureConnected: false, seed: 0 });
    for (const a of AGENTS) {
      expect(t.getNeighbors(a).length).toBe(AGENTS.length - 1);
    }
  });

  it('is deterministic for the same seed', () => {
    const t1 = createSparseRandomTopology(AGENTS, { edgeProbability: 0.3, seed: 7 });
    const t2 = createSparseRandomTopology(AGENTS, { edgeProbability: 0.3, seed: 7 });
    for (const a of AGENTS) {
      expect(new Set(t1.getNeighbors(a))).toEqual(new Set(t2.getNeighbors(a)));
    }
  });

  it('is symmetric and self-loop free', () => {
    const t = createSparseRandomTopology(AGENTS, { edgeProbability: 0.4, seed: 11 });
    expectSymmetric(t);
    expectNoSelfLoops(t);
  });
});

// ─── Factory ───────────────────────────────────────────────────────────

describe('createTopology factory', () => {
  it('dispatches to the correct concrete factory by kind', () => {
    for (const kind of TOPOLOGY_KINDS) {
      const t = createTopology({ kind, agents: AGENTS });
      expect(t.kind).toBe(kind);
      expect(t.agents).toEqual(AGENTS);
    }
  });

  it('forwards SmallWorld options', () => {
    const t = createTopology({
      kind: 'small_world',
      agents: AGENTS,
      smallWorld: { k: 2, rewireProbability: 0, seed: 1 },
    });
    for (const a of AGENTS) expect(t.getNeighbors(a).length).toBe(4);
  });

  it('forwards SparseRandom options', () => {
    const t = createTopology({
      kind: 'sparse_random',
      agents: AGENTS,
      sparseRandom: { edgeProbability: 1, ensureConnected: false, seed: 0 },
    });
    for (const a of AGENTS) expect(t.getNeighbors(a).length).toBe(AGENTS.length - 1);
  });
});

// ─── filterSignalsForViewer ────────────────────────────────────────────

function makeSignal(agentId: string, round = 1): CoordinationSignal {
  return {
    id: `sig-${agentId}-${round}`,
    runId: 'run-test',
    round,
    agentId,
    modelId: `model-${agentId}`,
    providerId: 'p',
    decision: { type: 'approve', value: 'y', confidence: 0.8 },
    sensitivities: [
      { variable: 'risk', direction: 'decrease', trigger: 't', confidence: 0.7, rationale: 'r' },
    ],
    createdAt: new Date().toISOString(),
  };
}

describe('filterSignalsForViewer', () => {
  it('returns the full set unchanged for fully_connected', () => {
    const t = createFullyConnectedTopology(AGENTS);
    const signals = AGENTS.map((a) => makeSignal(a));
    const filtered = filterSignalsForViewer(signals, 'a', t);
    expect(filtered).toEqual(signals);
  });

  it('returns only neighbors + self under a ring topology', () => {
    const t = createRingTopology(['a', 'b', 'c', 'd']);
    const signals = ['a', 'b', 'c', 'd'].map((a) => makeSignal(a));
    const filtered = filterSignalsForViewer(signals, 'a', t);
    const ids = filtered.map((s) => s.agentId).sort();
    // 'a' sees neighbors d and b, plus its own signal.
    expect(ids).toEqual(['a', 'b', 'd']);
  });

  it('always includes the viewer\'s own signals', () => {
    const t = createSparseRandomTopology(['a', 'b', 'c'], { edgeProbability: 0, ensureConnected: false, seed: 0 });
    const signals = ['a', 'b', 'c'].map((a) => makeSignal(a));
    const filtered = filterSignalsForViewer(signals, 'a', t);
    expect(filtered.some((s) => s.agentId === 'a')).toBe(true);
  });
});

// ─── describeTopology ─────────────────────────────────────────────────

describe('describeTopology', () => {
  it('reports correct stats for a fully-connected topology', () => {
    const t = createFullyConnectedTopology(AGENTS);
    const stats = describeTopology(t);
    expect(stats.agentCount).toBe(8);
    expect(stats.edgeCount).toBe((8 * 7) / 2); // n*(n-1)/2
    expect(stats.minDegree).toBe(7);
    expect(stats.maxDegree).toBe(7);
    expect(stats.isConnected).toBe(true);
    expect(stats.isolatedAgents).toEqual([]);
  });

  it('reports degree 2 for a ring', () => {
    const t = createRingTopology(AGENTS);
    const stats = describeTopology(t);
    expect(stats.minDegree).toBe(2);
    expect(stats.maxDegree).toBe(2);
    expect(stats.edgeCount).toBe(8); // ring of n nodes has n edges
    expect(stats.isConnected).toBe(true);
  });

  it('reports isolated agents when present', () => {
    const t = createSparseRandomTopology(AGENTS, { edgeProbability: 0, ensureConnected: false, seed: 0 });
    const stats = describeTopology(t);
    expect(stats.isolatedAgents.length).toBe(8);
    expect(stats.isConnected).toBe(false);
  });

  it('handles empty agent list', () => {
    const t = createFullyConnectedTopology([]);
    const stats = describeTopology(t);
    expect(stats.agentCount).toBe(0);
    expect(stats.edgeCount).toBe(0);
    expect(stats.isConnected).toBe(true);
  });
});
