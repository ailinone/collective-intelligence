// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Coordinate-wise Median Consensus (F2.3)
 *
 * Implements the optional global consensus step that reduces the
 * per-agent state map produced by F2.3 into a single shared answer:
 *
 *     θ̄ᵗ⁺¹ = Median({θᵗ⁺¹ᵢ : i ∈ V})
 *
 * Given the per-agent local states produced by
 * `per-agent-state.aggregatePerAgent`, computes a single shared
 * coordination state by taking, for each variable, the median (for
 * numeric values) or the mode (for categorical / boolean values)
 * across the agents.
 *
 * Why median (not mean):
 *   The Ailin¹ Collective consensus rule picks median for two
 *   structural reasons:
 *     1. Robustness to outliers — one or two agents reporting
 *        extreme values cannot drag the consensus.
 *     2. Equivariance under monotonic re-scaling — the consensus is
 *        unchanged if every agent reports values on the same shifted
 *        scale.
 *   For non-numeric values we fall back to the mode (most-frequent),
 *   weighted by per-agent confidence.
 *
 * This module is pure and side-effect free.
 */

import type { VariableState } from './coordination-types';
import type { PerAgentStateMap } from './per-agent-state';

// ─── Types ──────────────────────────────────────────────────────────────

export interface CoordinateMedianResult {
  /** The consensus value per variable. */
  variables: Record<string, VariableState>;
  /**
   * Fraction of agents whose local value matched the consensus
   * (per variable). 1.0 = unanimous; 0 = no agent agreed (degenerate).
   * For numeric medians, "matched" means within the agreementTolerance
   * (default 5% of the median absolute deviation).
   */
  agreementByVariable: Record<string, number>;
  /**
   * Variables that appeared in some but not all agents — the local
   * topology produced asymmetric coverage. Useful for diagnostics.
   */
  partialCoverageVariables: string[];
}

export interface CoordinateMedianOptions {
  /**
   * Tolerance for numeric agreement, expressed as a fraction of the
   * median absolute deviation (MAD). Agents within this band of the
   * median count as "matching" the consensus. Default 1.0 (within
   * one MAD). Lower values = stricter agreement counting.
   */
  agreementTolerance?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function numericMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function medianAbsoluteDeviation(values: number[], median: number): number {
  if (values.length === 0) return 0;
  const deviations = values.map((v) => Math.abs(v - median));
  return numericMedian(deviations);
}

/**
 * Categorical mode weighted by VariableState.confidence. Returns the
 * key whose total weight is highest. Ties broken by first-seen order.
 */
function weightedMode(entries: Array<{ key: string; weight: number }>): string | undefined {
  if (entries.length === 0) return undefined;
  const totals = new Map<string, number>();
  for (const e of entries) {
    totals.set(e.key, (totals.get(e.key) ?? 0) + e.weight);
  }
  let bestKey: string | undefined;
  let bestTotal = -Infinity;
  for (const [key, total] of totals) {
    if (total > bestTotal) {
      bestKey = key;
      bestTotal = total;
    }
  }
  return bestKey;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function asCategoryKey(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'boolean') return `b:${value}`;
  if (typeof value === 'number') return `n:${value}`;
  // Stable JSON for object/array
  try {
    return `j:${JSON.stringify(value)}`;
  } catch {
    return 'unknown';
  }
}

// ─── Main consensus ─────────────────────────────────────────────────────

interface PerVariableSample {
  agentId: string;
  state: VariableState;
}

function collectSamplesByVariable(
  perAgentStates: PerAgentStateMap,
): Map<string, PerVariableSample[]> {
  const map = new Map<string, PerVariableSample[]>();
  for (const [agentId, state] of perAgentStates) {
    for (const [variable, varState] of Object.entries(state.variables)) {
      if (!map.has(variable)) map.set(variable, []);
      map.get(variable)!.push({ agentId, state: varState });
    }
  }
  return map;
}

/**
 * Compute the coordinate-wise median across per-agent states.
 *
 * For each variable:
 *   - If all sampled values are finite numbers → coordinate median.
 *     Confidence = mean of per-agent confidences. updatedBy =
 *     deduplicated list of agentIds. Agreement counted via MAD.
 *   - Otherwise → confidence-weighted mode. Agreement counted as the
 *     fraction of agents whose value matched the mode.
 */
export function coordinateMedianConsensus(
  perAgentStates: PerAgentStateMap,
  options: CoordinateMedianOptions = {},
): CoordinateMedianResult {
  const tolerance = Math.max(0, options.agreementTolerance ?? 1.0);
  const samples = collectSamplesByVariable(perAgentStates);

  const variables: Record<string, VariableState> = {};
  const agreementByVariable: Record<string, number> = {};
  const partialCoverageVariables: string[] = [];

  const totalAgentCount = perAgentStates.size;

  for (const [variable, perAgentSamples] of samples) {
    if (perAgentSamples.length === 0) continue;
    if (perAgentSamples.length < totalAgentCount) {
      partialCoverageVariables.push(variable);
    }

    const allNumeric = perAgentSamples.every((s) => isFiniteNumber(s.state.value));

    if (allNumeric) {
      const numericValues = perAgentSamples.map((s) => s.state.value as number);
      const median = numericMedian(numericValues);
      const mad = medianAbsoluteDeviation(numericValues, median);
      // When MAD is zero (all values identical) every value matches by
      // construction; otherwise count how many fall within `tolerance * mad`.
      const band = mad === 0 ? 0 : mad * tolerance;
      const matching = numericValues.filter((v) => Math.abs(v - median) <= band).length;
      const agreement = perAgentSamples.length > 0 ? matching / perAgentSamples.length : 0;

      const confidence =
        perAgentSamples.reduce((acc, s) => acc + s.state.confidence, 0) / perAgentSamples.length;
      const updatedBy = Array.from(new Set(perAgentSamples.map((s) => s.agentId)));

      variables[variable] = {
        value: median,
        confidence: clamp01(confidence),
        updatedBy,
        rationale: `coordinate median across ${perAgentSamples.length} agent(s)`,
        stability: 1 - clamp01(mad),
      };
      agreementByVariable[variable] = agreement;
      continue;
    }

    // Categorical / mixed path — weighted mode by confidence.
    const entries = perAgentSamples.map((s) => ({
      key: asCategoryKey(s.state.value),
      weight: s.state.confidence,
      original: s.state.value,
    }));
    const modeKey = weightedMode(entries);
    if (modeKey === undefined) continue;

    const matching = entries.filter((e) => e.key === modeKey);
    const agreement = perAgentSamples.length > 0 ? matching.length / perAgentSamples.length : 0;
    const confidence =
      matching.length > 0
        ? matching.reduce((acc, m) => acc + m.weight, 0) / matching.length
        : 0;
    const updatedBy = Array.from(new Set(perAgentSamples.map((s) => s.agentId)));
    const value = matching.length > 0 ? matching[0].original : perAgentSamples[0].state.value;

    variables[variable] = {
      value: value as VariableState['value'],
      confidence: clamp01(confidence),
      updatedBy,
      rationale: `weighted mode across ${perAgentSamples.length} agent(s)`,
      stability: agreement,
    };
    agreementByVariable[variable] = agreement;
  }

  return {
    variables,
    agreementByVariable,
    partialCoverageVariables,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
