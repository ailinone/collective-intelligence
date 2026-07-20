// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Per-Agent State (F2.3)
 *
 * Neighborhood-scoped primitive: each agent maintains a LOCAL
 * coordination state θᵢ that is updated using ONLY the signals of its
 * topology neighbors, instead of the single shared state used by the
 * default aggregation path.
 *
 * Why this matters:
 *   The current `sensitivity-aggregator.aggregateSignals(signals,
 *   state, method)` produces ONE updated state from ALL signals — i.e.
 *   it implicitly assumes a fully-connected topology. The
 *   neighborhood-scoped formulation
 *
 *       θᵗ⁺¹ᵢ = θᵗᵢ + Aggⱼ∈Nᵢ(sᵗⱼ)
 *
 *   keeps a separate θᵢ per agent and only sums its NEIGHBORS' signals.
 *   When agents disagree on neighborhoods (sparse / small-world /
 *   random graphs), the per-agent path produces meaningfully different
 *   trajectories. After the run, an OPTIONAL coordinate-wise median
 *   produces the single shared answer (see
 *   `coordinate-median-consensus.ts`).
 *
 * Scope of this module:
 *   F2.3 ships the primitives and an opt-in config flag. The
 *   `SensitivityConsensusStrategy.runCoordinationLoop` is NOT
 *   refactored yet — branching the loop on the new flag is a
 *   sensitive change that will land in a focused follow-up PR once
 *   the primitive has stabilized in real benchmarks.
 *
 *   Use sites today:
 *     - F2.4 adversarial benchmark may exercise per-agent vs shared.
 *     - C3 ablation arms may flip the flag to compare modes.
 */

import type {
  AggregationMethod,
  ConvergenceMetrics,
  CoordinationRisk,
  CoordinationSignal,
  CoordinationState,
  CoordinationLimits,
  SensitivityAggregationResult,
  VariableState,
} from './coordination-types';
import { aggregateSignals } from './sensitivity-aggregator';
import { filterSignalsForViewer } from './collective-topology';
import type { CollectiveTopology } from './collective-topology';
import { coordinateMedianConsensus } from './coordinate-median-consensus';

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Per-agent local state. Mirrors the relevant subset of
 * `CoordinationState` but scoped to one agent's view of the world.
 *
 * `variables` are the agent's local θᵢ. `history` accumulates only the
 * signals THIS agent has observed (own emissions + neighborhood-
 * filtered peer signals).
 */
export interface PerAgentState {
  agentId: string;
  round: number;
  variables: Record<string, VariableState>;
  history: CoordinationSignal[];
  totalCostUsd: number;
  totalLatencyMs: number;
  totalTokens: number;
}

/**
 * Map from agentId → its local state. Built once at run start, then
 * updated at the end of each round by `aggregatePerAgent`.
 */
export type PerAgentStateMap = Map<string, PerAgentState>;

// ─── Initialization ─────────────────────────────────────────────────────

/**
 * Build a fresh `PerAgentStateMap` for the given agents.
 *
 * Pure function — order-deterministic on the input. The map is keyed
 * by agentId so consumers can `.get(agentId)` without scanning.
 */
export function createInitialPerAgentStates(
  agentIds: ReadonlyArray<string>,
): PerAgentStateMap {
  const map: PerAgentStateMap = new Map();
  const seen = new Set<string>();
  for (const agentId of agentIds) {
    if (typeof agentId !== 'string' || agentId.length === 0) continue;
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    map.set(agentId, {
      agentId,
      round: 0,
      variables: {},
      history: [],
      totalCostUsd: 0,
      totalLatencyMs: 0,
      totalTokens: 0,
    });
  }
  return map;
}

// ─── Aggregation ────────────────────────────────────────────────────────

/**
 * Build a `CoordinationState` view scoped to a single agent. The view
 * is what the existing `aggregateSignals` consumes — by passing per-
 * agent state in, we get the same numeric / textual aggregation
 * machinery but applied only to neighbor signals.
 */
function buildAgentScopedState(
  agentState: PerAgentState,
  limits: CoordinationLimits,
  strategy: string,
  runId: string,
): CoordinationState {
  return {
    runId,
    strategy,
    round: agentState.round,
    variables: { ...agentState.variables },
    convergence: {
      score: 0,
      decisionFlipRate: 1,
      dissent: 1,
      confidenceTrend: [],
      stableVariables: [],
      unstableVariables: [],
    },
    risks: [],
    history: [...agentState.history],
    limits,
    totalCostUsd: agentState.totalCostUsd,
    totalLatencyMs: agentState.totalLatencyMs,
    totalTokens: agentState.totalTokens,
  };
}

/**
 * Run one round of per-agent aggregation. For each agent in
 * `perAgentStates`:
 *   1. Filter the round's signals to those visible to this agent
 *      under the topology (neighbors + self).
 *   2. Call `aggregateSignals` against the agent's scoped state.
 *   3. Replace the agent's state with the next-state from the
 *      aggregation.
 *
 * Returns a new map (does not mutate the input). The map ordering
 * matches the input ordering so downstream consensus is reproducible.
 */
export function aggregatePerAgent(
  perAgentStates: PerAgentStateMap,
  signals: ReadonlyArray<CoordinationSignal>,
  topology: CollectiveTopology,
  method: AggregationMethod,
  limits: CoordinationLimits,
  strategy: string,
  runId: string,
): { nextStates: PerAgentStateMap; perAgentResults: Map<string, SensitivityAggregationResult> } {
  const nextStates: PerAgentStateMap = new Map();
  const perAgentResults = new Map<string, SensitivityAggregationResult>();

  for (const [agentId, agentState] of perAgentStates) {
    const visibleSignals = filterSignalsForViewer([...signals], agentId, topology);
    const scopedState = buildAgentScopedState(agentState, limits, strategy, runId);

    // `llm_synthesis` requires async; per-agent aggregation falls back
    // to `weighted_confidence` when the operator selected the LLM path
    // because invoking N coordinator calls (one per agent) would
    // multiply cost N-fold. Operators that want LLM-mediated synthesis
    // SHOULD keep the shared-state mode.
    const effectiveMethod: AggregationMethod = method === 'llm_synthesis' ? 'weighted_confidence' : method;
    const result = aggregateSignals(visibleSignals, scopedState, effectiveMethod);

    perAgentResults.set(agentId, result);

    nextStates.set(agentId, {
      agentId,
      round: result.nextState.round,
      variables: { ...result.nextState.variables },
      history: [...result.nextState.history],
      totalCostUsd: result.nextState.totalCostUsd,
      totalLatencyMs: result.nextState.totalLatencyMs,
      totalTokens: result.nextState.totalTokens,
    });
  }

  return { nextStates, perAgentResults };
}

// ─── Diagnostics ────────────────────────────────────────────────────────

export interface PerAgentStateSnapshot {
  agentId: string;
  round: number;
  variableCount: number;
  totalCostUsd: number;
}

/**
 * F2.6 — Bridge between the per-agent path and the existing
 * shared-state machinery (`evaluateConvergence`,
 * `buildCoordinationResult`). Synthesizes a single
 * `CoordinationState` from the per-agent map by:
 *
 *   1. Running coordinate-wise median consensus to reduce {θᵢ} → θ̄.
 *   2. Computing run-level convergence metrics from the round's
 *      signals (decisionFlipRate, dissent, confidenceTrend) — these
 *      are the same metrics the shared-state path computes.
 *   3. Inheriting cumulative totals (cost/latency/tokens) from
 *      explicit run-level counters so we do NOT double-count signals
 *      that were visible to multiple agents under sparse topologies.
 *
 * Pure function — exported so the strategy can call it once per round
 * for stop-condition evaluation and once at run end for the final
 * result.
 */
export interface SharedStateSynthesisInput {
  runId: string;
  strategy: string;
  perAgentStates: PerAgentStateMap;
  /** Signals emitted in the round that just ended. */
  currentRoundSignals: ReadonlyArray<CoordinationSignal>;
  /** Cumulative history across all rounds (for trend metrics). */
  fullHistory: ReadonlyArray<CoordinationSignal>;
  /** Run-level cost ledger (summed once per signal across rounds). */
  runTotalCostUsd: number;
  runTotalLatencyMs: number;
  runTotalTokens: number;
  limits: CoordinationLimits;
  /** Round number that just completed (1-based). */
  round: number;
  /** Existing critical-risk events accumulated so far. */
  cumulativeRisks: ReadonlyArray<CoordinationRisk>;
  /** Confidence trend up to (but not including) the current round. */
  priorConfidenceTrend: ReadonlyArray<number>;
}

export function synthesizeSharedStateFromPerAgent(
  input: SharedStateSynthesisInput,
): CoordinationState {
  const median = coordinateMedianConsensus(input.perAgentStates);
  const variables: Record<string, VariableState> = { ...median.variables };

  const decisionTypes = input.currentRoundSignals.map((s) => s.decision.type);
  const majority = getMajorityDecision(decisionTypes);
  const dissent = majority
    ? 1 - decisionTypes.filter((d) => d === majority).length / Math.max(1, decisionTypes.length)
    : 1;

  const decisionFlipRate = computeDecisionFlipRate(input.currentRoundSignals, input.fullHistory, input.round);

  const confidenceAvg = input.currentRoundSignals.length > 0
    ? input.currentRoundSignals.reduce((acc, s) => acc + s.decision.confidence, 0) /
      input.currentRoundSignals.length
    : 0;

  // Pull "stable" / "unstable" labels from the median agreement scores.
  const stableVariables: string[] = [];
  const unstableVariables: string[] = [];
  for (const [variable, agreement] of Object.entries(median.agreementByVariable)) {
    if (agreement >= 0.85) stableVariables.push(variable);
    else unstableVariables.push(variable);
  }

  const variableStability = stableVariables.length + unstableVariables.length > 0
    ? stableVariables.length / (stableVariables.length + unstableVariables.length)
    : 0;

  const convergence: ConvergenceMetrics = {
    score: 0.4 * (1 - dissent) + 0.3 * variableStability + 0.3 * confidenceAvg,
    decisionFlipRate,
    dissent,
    confidenceTrend: [...input.priorConfidenceTrend, confidenceAvg],
    stableVariables,
    unstableVariables,
  };

  return {
    runId: input.runId,
    strategy: input.strategy,
    round: input.round,
    variables,
    convergence,
    risks: [...input.cumulativeRisks],
    history: [...input.fullHistory],
    limits: input.limits,
    totalCostUsd: input.runTotalCostUsd,
    totalLatencyMs: input.runTotalLatencyMs,
    totalTokens: input.runTotalTokens,
  };
}

function getMajorityDecision(types: string[]): string | undefined {
  if (types.length === 0) return undefined;
  const counts: Record<string, number> = {};
  for (const t of types) counts[t] = (counts[t] ?? 0) + 1;
  let bestType: string | undefined;
  let bestCount = -Infinity;
  for (const [t, c] of Object.entries(counts)) {
    if (c > bestCount) {
      bestType = t;
      bestCount = c;
    }
  }
  return bestType;
}

function computeDecisionFlipRate(
  currentRoundSignals: ReadonlyArray<CoordinationSignal>,
  fullHistory: ReadonlyArray<CoordinationSignal>,
  currentRound: number,
): number {
  if (currentRound <= 1) return 0;
  const previousRound = currentRound - 1;
  const previousSignals = fullHistory.filter((s) => s.round === previousRound);
  if (previousSignals.length === 0 || currentRoundSignals.length === 0) return 0;

  let flips = 0;
  for (const sig of currentRoundSignals) {
    const prior = previousSignals.find((p) => p.agentId === sig.agentId);
    if (prior && prior.decision.type !== sig.decision.type) flips++;
  }
  return flips / currentRoundSignals.length;
}

/**
 * Compact summary suitable for logs / metadata. Doesn't materialise
 * full variable state — useful for run reports that need to show
 * each agent's coverage at a glance.
 */
export function summarizePerAgentStates(
  perAgentStates: PerAgentStateMap,
): PerAgentStateSnapshot[] {
  const out: PerAgentStateSnapshot[] = [];
  for (const [agentId, state] of perAgentStates) {
    out.push({
      agentId,
      round: state.round,
      variableCount: Object.keys(state.variables).length,
      totalCostUsd: state.totalCostUsd,
    });
  }
  return out;
}
