// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Topology (F2.2)
 *
 * Defines `G = (V, E)` — the network of who-sees-whose-signal during a
 * coordination run. Each agent in the run is a vertex; an edge between
 * agent A and agent B means A's signal is visible in B's prompt
 * context (and vice-versa for symmetric topologies).
 *
 * Until this module landed, the coordination layer was implicitly
 * fully-connected: every agent saw every other signal via the shared
 * `CoordinationState`. That is the default Ailin¹ Collective setting
 * but is the WORST case for sparse-network benchmarks where the
 * realistic comparison requires neighborhood-limited information
 * flow (preference aggregation in social graphs, multi-hop influence,
 * etc.).
 *
 * Four implementations:
 *   • FullyConnected — every agent neighbors every other (default).
 *   • Ring           — each agent neighbors the previous and next on a
 *                      circle.
 *   • SmallWorld     — small-world: a ring with random rewires; high
 *                      clustering + short average path length.
 *   • SparseRandom   — random-edge: each potential edge present with a
 *                      configured probability.
 *
 * Determinism: SmallWorld and SparseRandom are randomised. Both accept
 * a `seed` so a topology constructed in tests OR in benchmarks is
 * reproducible across runs. The PRNG is a small LCG — no external
 * dependency required.
 *
 * This module is INTENTIONALLY decoupled from `CoordinationState`. The
 * topology only needs the agent ids; the per-agent state filtering is
 * F2.3's job. F2.2 ships the primitive + helpers; F2.3 wires it into
 * the aggregator.
 */

import type { CoordinationSignal } from './coordination-types';

// ─── Public types ───────────────────────────────────────────────────────

export const TOPOLOGY_KINDS = [
  'fully_connected',
  'ring',
  'small_world',
  'sparse_random',
] as const;
export type TopologyKind = (typeof TOPOLOGY_KINDS)[number];

/**
 * A topology is a pure data structure: given the set of agents in the
 * run, it returns the subset of agents whose signals each agent can
 * observe. Implementations MUST be:
 *   - Deterministic for the same {kind, agents, seed}.
 *   - Symmetric when the network model is undirected (Ring,
 *     FullyConnected, SmallWorld, SparseRandom).
 *   - Self-loop free (`getNeighbors(a)` never contains `a`).
 */
export interface CollectiveTopology {
  readonly kind: TopologyKind;
  /** True when `getNeighbors` is symmetric — i.e. b ∈ N(a) ↔ a ∈ N(b). */
  readonly symmetric: boolean;
  /** Returns the neighbor agent ids of `agentId`. Excludes `agentId` itself. */
  getNeighbors(agentId: string): readonly string[];
  /** All agents the topology was built over, in deterministic order. */
  readonly agents: readonly string[];
}

// ─── Seeded PRNG (small LCG) ────────────────────────────────────────────

/**
 * Linear Congruential Generator — period 2^32, fast, deterministic,
 * sufficient for topology randomisation. We avoid Math.random()
 * because tests and benchmarks need reproducibility for the same seed.
 */
class LCG {
  private state: number;
  constructor(seed: number) {
    // Force into uint32 to keep the recurrence inside a 32-bit ring
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 1; // avoid degenerate fixed point
  }

  /** Returns a uniform float in [0, 1). */
  next(): number {
    // Standard LCG constants (multiplier 1664525, increment 1013904223).
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  /** Returns a uniform integer in [0, n). */
  nextInt(n: number): number {
    return Math.floor(this.next() * n);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function uniqueAgents(agents: ReadonlyArray<string>): string[] {
  // Preserve order while deduping — Set iteration order is insertion.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of agents) {
    if (typeof a === 'string' && a.length > 0 && !seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

function buildAdjacencyMap(
  agents: ReadonlyArray<string>,
  edges: Iterable<readonly [string, string]>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const a of agents) map.set(a, []);
  for (const [a, b] of edges) {
    if (a === b) continue;
    if (!map.has(a) || !map.has(b)) continue;
    const aList = map.get(a)!;
    const bList = map.get(b)!;
    if (!aList.includes(b)) aList.push(b);
    if (!bList.includes(a)) bList.push(a);
  }
  return map;
}

function fromAdjacency(
  kind: TopologyKind,
  symmetric: boolean,
  agents: ReadonlyArray<string>,
  adjacency: Map<string, string[]>,
): CollectiveTopology {
  const stableAgents = [...agents];
  const frozen = new Map<string, readonly string[]>();
  for (const [a, ns] of adjacency) frozen.set(a, [...ns]);

  return {
    kind,
    symmetric,
    agents: stableAgents,
    getNeighbors(agentId: string): readonly string[] {
      return frozen.get(agentId) ?? [];
    },
  };
}

// ─── FullyConnected ─────────────────────────────────────────────────────

/**
 * Every agent neighbors every other. This is the default behavior of
 * the coordination layer prior to F2.2.
 */
export function createFullyConnectedTopology(
  agents: ReadonlyArray<string>,
): CollectiveTopology {
  const stable = uniqueAgents(agents);
  const adjacency = new Map<string, string[]>();
  for (const a of stable) {
    adjacency.set(a, stable.filter((b) => b !== a));
  }
  return fromAdjacency('fully_connected', true, stable, adjacency);
}

// ─── Ring ───────────────────────────────────────────────────────────────

/**
 * Each agent neighbors the previous and next agent in the input order
 * with wrap-around. Topology of degree 2 (3 with k=2 mode, but we keep
 * the canonical k=2 / wrap form here — see SmallWorld for k>2 rings).
 */
export function createRingTopology(
  agents: ReadonlyArray<string>,
): CollectiveTopology {
  const stable = uniqueAgents(agents);
  const n = stable.length;
  const adjacency = new Map<string, string[]>();
  for (let i = 0; i < n; i++) {
    const a = stable[i];
    if (n <= 1) {
      adjacency.set(a, []);
      continue;
    }
    if (n === 2) {
      adjacency.set(a, [stable[(i + 1) % n]]);
      continue;
    }
    const left = stable[(i - 1 + n) % n];
    const right = stable[(i + 1) % n];
    adjacency.set(a, [left, right]);
  }
  return fromAdjacency('ring', true, stable, adjacency);
}

// ─── SmallWorld (small-world) ────────────────────────────────────────

export interface SmallWorldOptions {
  /**
   * Number of nearest-neighbor connections per agent on each side.
   * The base ring before rewiring has degree 2k. Default 2 (so
   * degree 4 — 2 left + 2 right). Bounded by the input size.
   */
  k?: number;
  /**
   * Probability of rewiring each edge. 0 = pure ring. 1 = fully
   * random. small-world "small world" regime is around 0.05–0.2.
   * Default 0.10.
   */
  rewireProbability?: number;
  /** PRNG seed for reproducibility. Default 0. */
  seed?: number;
}

/**
 * small-world small-world: start with a regular ring of degree 2k,
 * then for each edge rewire one endpoint to a random target with
 * probability `rewireProbability`. Produces graphs with high
 * clustering and short average path length — the canonical model for
 * sparse coordination networks.
 */
export function createSmallWorldTopology(
  agents: ReadonlyArray<string>,
  options: SmallWorldOptions = {},
): CollectiveTopology {
  const stable = uniqueAgents(agents);
  const n = stable.length;
  const k = Math.max(1, Math.min(Math.floor((n - 1) / 2), options.k ?? 2));
  const rewireProbability = Math.max(0, Math.min(1, options.rewireProbability ?? 0.10));
  const rng = new LCG(options.seed ?? 0);

  if (n <= 2) {
    // Degenerate case: fall back to ring (which handles n=1/2 correctly)
    return { ...createRingTopology(stable), kind: 'small_world' };
  }

  // Build the regular ring: each node connects to k nearest neighbors
  // on each side (canonical small-world starting ring).
  const edges = new Set<string>();
  function edgeKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  for (let i = 0; i < n; i++) {
    for (let j = 1; j <= k; j++) {
      const a = stable[i];
      const b = stable[(i + j) % n];
      edges.add(edgeKey(a, b));
    }
  }

  // Rewire pass: for each edge, with probability `rewireProbability`,
  // replace the edge with (a, c) for a random c not equal to a and not
  // already adjacent to a.
  const rewired = new Set<string>();
  for (const key of edges) {
    if (rng.next() >= rewireProbability) {
      rewired.add(key);
      continue;
    }
    const [aRaw, bRaw] = key.split('|');
    const a = aRaw;
    const b = bRaw;
    // Pick a fresh target c
    let attempts = 0;
    let placed = false;
    while (attempts < n * 2) {
      const cIdx = rng.nextInt(n);
      const c = stable[cIdx];
      if (c === a || c === b) {
        attempts++;
        continue;
      }
      const newKey = edgeKey(a, c);
      if (rewired.has(newKey)) {
        attempts++;
        continue;
      }
      rewired.add(newKey);
      placed = true;
      break;
    }
    // If we couldn't find a fresh target (highly connected graph),
    // keep the original edge so we don't lose coverage.
    if (!placed) rewired.add(key);
  }

  const edgePairs: Array<[string, string]> = [];
  for (const key of rewired) {
    const [a, b] = key.split('|') as [string, string];
    edgePairs.push([a, b]);
  }

  const adjacency = buildAdjacencyMap(stable, edgePairs);
  return fromAdjacency('small_world', true, stable, adjacency);
}

// ─── SparseRandom (random-edge) ─────────────────────────────────────────

export interface SparseRandomOptions {
  /**
   * Probability of each potential edge being present. 0 = no edges.
   * 1 = fully connected. Default 0.30 — produces a sparse but
   * reasonably connected graph.
   */
  edgeProbability?: number;
  /** PRNG seed for reproducibility. Default 0. */
  seed?: number;
  /**
   * When true, ensures the resulting graph is connected by adding a
   * spanning ring after the random pass. Default true so a degenerate
   * low-probability draw cannot strand an agent with no neighbors.
   */
  ensureConnected?: boolean;
}

/**
 * random-edge G(n, p): each potential undirected edge included
 * independently with probability `edgeProbability`. When
 * `ensureConnected` is true (default), a spanning ring is overlaid
 * to guarantee every agent has at least 2 neighbors.
 */
export function createSparseRandomTopology(
  agents: ReadonlyArray<string>,
  options: SparseRandomOptions = {},
): CollectiveTopology {
  const stable = uniqueAgents(agents);
  const n = stable.length;
  const p = Math.max(0, Math.min(1, options.edgeProbability ?? 0.30));
  const rng = new LCG(options.seed ?? 0);
  const ensureConnected = options.ensureConnected !== false;

  if (n <= 1) {
    return fromAdjacency('sparse_random', true, stable, new Map([[stable[0] ?? '', []]]));
  }

  const edges: Array<[string, string]> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rng.next() < p) {
        edges.push([stable[i], stable[j]]);
      }
    }
  }

  if (ensureConnected) {
    // Overlay a ring so every node has at least 2 neighbors.
    for (let i = 0; i < n; i++) {
      const a = stable[i];
      const b = stable[(i + 1) % n];
      if (a !== b) edges.push([a, b]);
    }
  }

  const adjacency = buildAdjacencyMap(stable, edges);
  return fromAdjacency('sparse_random', true, stable, adjacency);
}

// ─── Factory ────────────────────────────────────────────────────────────

export interface TopologyFactoryOptions {
  kind: TopologyKind;
  agents: ReadonlyArray<string>;
  /** Forwarded to SmallWorld when kind === 'small_world'. */
  smallWorld?: SmallWorldOptions;
  /** Forwarded to SparseRandom when kind === 'sparse_random'. */
  sparseRandom?: SparseRandomOptions;
}

/**
 * Build a topology by kind. Centralized so callers do not have to
 * import every concrete factory. Validates `kind` against the
 * registered enum and returns FullyConnected for unknown values
 * (defensive — never crashes).
 */
export function createTopology(opts: TopologyFactoryOptions): CollectiveTopology {
  switch (opts.kind) {
    case 'fully_connected':
      return createFullyConnectedTopology(opts.agents);
    case 'ring':
      return createRingTopology(opts.agents);
    case 'small_world':
      return createSmallWorldTopology(opts.agents, opts.smallWorld);
    case 'sparse_random':
      return createSparseRandomTopology(opts.agents, opts.sparseRandom);
    default: {
      // Exhaustiveness guard — `kind` is the union of TOPOLOGY_KINDS,
      // so this branch is only reached by runtime callers passing an
      // out-of-band string. Fall back to fully-connected.
      return createFullyConnectedTopology(opts.agents);
    }
  }
}

// ─── Signal filtering helpers ───────────────────────────────────────────

/**
 * Filter a list of signals to those visible to a specific agent
 * under the given topology. The viewer's own signals are always
 * included so the viewer sees its own previous emissions.
 *
 * Pure helper used by F2.3 when the per-agent state mode is on. When
 * the topology is fully-connected this returns the input unchanged.
 */
export function filterSignalsForViewer(
  signals: ReadonlyArray<CoordinationSignal>,
  viewerAgentId: string,
  topology: CollectiveTopology,
): CoordinationSignal[] {
  if (topology.kind === 'fully_connected') return [...signals];
  const neighbors = new Set(topology.getNeighbors(viewerAgentId));
  // Always include the viewer's own signals.
  neighbors.add(viewerAgentId);
  return signals.filter((s) => neighbors.has(s.agentId));
}

// ─── Diagnostics ────────────────────────────────────────────────────────

export interface TopologyStats {
  agentCount: number;
  edgeCount: number;
  averageDegree: number;
  minDegree: number;
  maxDegree: number;
  isConnected: boolean;
  isolatedAgents: string[];
}

/**
 * Compute structural statistics. Useful for benchmarks and for the
 * /v1/collective/runs endpoint metadata. Edge count is undirected
 * (each pair counted once); average degree is `2 * edgeCount /
 * agentCount` to mirror the textbook formulation.
 */
export function describeTopology(topology: CollectiveTopology): TopologyStats {
  const agents = topology.agents;
  const n = agents.length;
  if (n === 0) {
    return {
      agentCount: 0,
      edgeCount: 0,
      averageDegree: 0,
      minDegree: 0,
      maxDegree: 0,
      isConnected: true,
      isolatedAgents: [],
    };
  }

  const undirectedEdges = new Set<string>();
  let minDegree = Number.POSITIVE_INFINITY;
  let maxDegree = 0;
  const isolated: string[] = [];

  for (const a of agents) {
    const neighbors = topology.getNeighbors(a);
    if (neighbors.length === 0) isolated.push(a);
    if (neighbors.length < minDegree) minDegree = neighbors.length;
    if (neighbors.length > maxDegree) maxDegree = neighbors.length;
    for (const b of neighbors) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      undirectedEdges.add(key);
    }
  }

  if (minDegree === Number.POSITIVE_INFINITY) minDegree = 0;

  // BFS connectivity check
  const adjacency = new Map<string, ReadonlyArray<string>>();
  for (const a of agents) adjacency.set(a, topology.getNeighbors(a));
  const visited = new Set<string>();
  const queue: string[] = [agents[0]];
  visited.add(agents[0]);
  while (queue.length > 0) {
    const a = queue.shift()!;
    for (const b of adjacency.get(a) ?? []) {
      if (!visited.has(b)) {
        visited.add(b);
        queue.push(b);
      }
    }
  }

  const edgeCount = undirectedEdges.size;
  return {
    agentCount: n,
    edgeCount,
    averageDegree: n > 0 ? (2 * edgeCount) / n : 0,
    minDegree,
    maxDegree,
    isConnected: visited.size === n,
    isolatedAgents: isolated,
  };
}
