// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Sensitivity Aggregator
 *
 * Aggregates CoordinationSignals from multiple agents into a unified
 * CoordinationState. This is a separate responsibility from ResponseAggregator:
 *
 *   ResponseAggregator: aggregates final outputs.
 *   SensitivityAggregator: aggregates conditional signals and updates collective state.
 *
 * Supports multiple aggregation methods:
 *   - weighted_confidence: weight by agent confidence × model reputation
 *   - median: robust to outliers
 *   - trimmed_mean: drop extreme 20%, average rest
 *   - llm_synthesis: use an LLM to resolve conflicts (1 extra call)
 *   - hybrid: weighted_confidence + fallback to median on conflict
 */

import type {
  CoordinationSignal,
  CoordinationState,
  CoordinationLimits,
  Sensitivity,
  SensitivityAggregationResult,
  VariableState,
  ConvergenceMetrics,
  CoordinationRisk,
  CoordinationStopReason,
  AggregationMethod,
} from './coordination-types';
import { DEFAULT_COORDINATION_CONFIG } from './coordination-types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'sensitivity-aggregator' });

// ============================================
// Initialization
// ============================================

/**
 * Create a fresh CoordinationState for a new run.
 */
export function createInitialState(
  runId: string,
  strategy: string,
  limits: CoordinationLimits,
): CoordinationState {
  return {
    runId,
    strategy,
    round: 0,
    variables: {},
    convergence: {
      score: 0,
      decisionFlipRate: 1,
      dissent: 1,
      confidenceTrend: [],
      stableVariables: [],
      unstableVariables: [],
    },
    risks: [],
    history: [],
    limits,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    totalTokens: 0,
  };
}

// ============================================
// Aggregation logic
// ============================================

/**
 * Group sensitivities by variable name.
 */
function groupSensitivitiesByVariable(
  signals: CoordinationSignal[],
): Map<string, Array<{ signal: CoordinationSignal; sensitivity: Sensitivity }>> {
  const grouped = new Map<string, Array<{ signal: CoordinationSignal; sensitivity: Sensitivity }>>();

  for (const signal of signals) {
    for (const sens of signal.sensitivities) {
      const key = sens.variable;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push({ signal, sensitivity: sens });
    }
  }

  return grouped;
}

/**
 * Detect conflicts among sensitivities for the same variable.
 * A conflict exists when agents disagree on direction for the same variable.
 */
function detectConflicts(
  entries: Array<{ signal: CoordinationSignal; sensitivity: Sensitivity }>,
): boolean {
  if (entries.length < 2) return false;

  const directions = new Set(entries.map(e => e.sensitivity.direction));

  // If we have both 'increase' and 'decrease' for the same variable, that's a conflict
  if (directions.has('increase') && directions.has('decrease')) return true;
  if (directions.has('block') && directions.has('unlock')) return true;

  // If all agents have completely different directions, that's a conflict
  if (directions.size === entries.length && entries.length > 2) return true;

  return false;
}

/**
 * Aggregate numeric sensitivities using weighted confidence.
 */
function weightedConfidenceAggregate(
  entries: Array<{ signal: CoordinationSignal; sensitivity: Sensitivity }>,
  previousValue?: VariableState,
): VariableState {
  const totalWeight = entries.reduce(
    (sum, e) => sum + e.sensitivity.confidence,
    0,
  );

  if (totalWeight === 0) {
    return previousValue ?? {
      value: 'indeterminate',
      confidence: 0,
      updatedBy: entries.map(e => e.signal.agentId),
      rationale: 'All sensitivities had zero confidence',
      stability: 0,
    };
  }

  // For numeric values with expectedDelta, compute weighted average
  const numericEntries = entries.filter(e => e.sensitivity.expectedDelta !== undefined);
  let value: number | string;
  let confidence: number;

  if (numericEntries.length > 0) {
    value = numericEntries.reduce(
      (sum, e) => sum + (e.sensitivity.expectedDelta! * e.sensitivity.confidence),
      0,
    ) / totalWeight;
    confidence = entries.reduce(
      (sum, e) => sum + e.sensitivity.confidence,
      0,
    ) / entries.length;
  } else {
    // Non-numeric: use majority direction as value
    const directionCounts: Record<string, number> = {};
    for (const e of entries) {
      const dir = e.sensitivity.direction;
      directionCounts[dir] = (directionCounts[dir] || 0) + e.sensitivity.confidence;
    }
    const dominant = Object.entries(directionCounts).sort((a, b) => b[1] - a[1])[0];
    value = dominant?.[0] ?? 'indeterminate';
    confidence = (dominant?.[1] ?? 0) / totalWeight;
  }

  // Compute stability compared to previous
  let stability = 1;
  if (previousValue) {
    const prevConf = previousValue.confidence;
    stability = 1 - Math.abs(confidence - prevConf);
  }

  const rationale = entries
    .slice(0, 3)
    .map(e => `[${e.signal.modelId}] ${e.sensitivity.rationale}`)
    .join('; ');

  return {
    value,
    confidence: Math.min(1, confidence),
    updatedBy: entries.map(e => e.signal.agentId),
    rationale,
    stability,
  };
}

/**
 * Aggregate using median (robust to outliers).
 */
function medianAggregate(
  entries: Array<{ signal: CoordinationSignal; sensitivity: Sensitivity }>,
  previousValue?: VariableState,
): VariableState {
  const numericEntries = entries.filter(e => e.sensitivity.expectedDelta !== undefined);

  if (numericEntries.length === 0) {
    // Fall back to weighted for non-numeric
    return weightedConfidenceAggregate(entries, previousValue);
  }

  const sorted = [...numericEntries].sort(
    (a, b) => a.sensitivity.expectedDelta! - b.sensitivity.expectedDelta!,
  );
  const mid = Math.floor(sorted.length / 2);
  const medianValue =
    sorted.length % 2 === 0
      ? (sorted[mid - 1].sensitivity.expectedDelta! + sorted[mid].sensitivity.expectedDelta!) / 2
      : sorted[mid].sensitivity.expectedDelta!;

  const confidences = entries.map(e => e.sensitivity.confidence).sort((a, b) => a - b);
  const medianConf =
    confidences.length % 2 === 0
      ? (confidences[confidences.length / 2 - 1] + confidences[confidences.length / 2]) / 2
      : confidences[Math.floor(confidences.length / 2)];

  return {
    value: medianValue,
    confidence: medianConf,
    updatedBy: entries.map(e => e.signal.agentId),
    rationale: `Median of ${entries.length} signals`,
    stability: previousValue ? 1 - Math.abs(medianConf - previousValue.confidence) : 1,
  };
}

/**
 * Aggregate using trimmed mean (drop top/bottom 20%).
 */
function trimmedMeanAggregate(
  entries: Array<{ signal: CoordinationSignal; sensitivity: Sensitivity }>,
  previousValue?: VariableState,
): VariableState {
  const numericEntries = entries.filter(e => e.sensitivity.expectedDelta !== undefined);

  if (numericEntries.length < 3) {
    return weightedConfidenceAggregate(entries, previousValue);
  }

  const sorted = [...numericEntries].sort(
    (a, b) => a.sensitivity.expectedDelta! - b.sensitivity.expectedDelta!,
  );
  const trim = Math.max(1, Math.floor(sorted.length * 0.2));
  const trimmed = sorted.slice(trim, sorted.length - trim);

  if (trimmed.length === 0) {
    return weightedConfidenceAggregate(entries, previousValue);
  }

  const avgValue =
    trimmed.reduce((sum, e) => sum + e.sensitivity.expectedDelta!, 0) / trimmed.length;
  const avgConf =
    trimmed.reduce((sum, e) => sum + e.sensitivity.confidence, 0) / trimmed.length;

  return {
    value: avgValue,
    confidence: avgConf,
    updatedBy: entries.map(e => e.signal.agentId),
    rationale: `Trimmed mean of ${trimmed.length}/${entries.length} signals`,
    stability: previousValue ? 1 - Math.abs(avgConf - previousValue.confidence) : 1,
  };
}

// ============================================
// Main aggregator
// ============================================

/**
 * Aggregate a set of validated CoordinationSignals into an updated CoordinationState.
 *
 * This is the core function of the coordination layer.
 */
export function aggregateSignals(
  signals: CoordinationSignal[],
  currentState: CoordinationState,
  method: AggregationMethod = DEFAULT_COORDINATION_CONFIG.aggregationMethod,
): SensitivityAggregationResult {
  if (signals.length === 0) {
    return {
      nextState: currentState,
      dominantSignals: [],
      conflictingSignals: [],
      updatedVariables: [],
      recommendedNextRound: false,
      stopReason: 'insufficient_valid_signals',
      risks: [{
        type: 'no_signals',
        severity: 'critical',
        description: 'No valid signals received in this round',
        sourceSignalIds: [],
      }],
    };
  }

  // Group sensitivities by variable
  const grouped = groupSensitivitiesByVariable(signals);

  // Track conflicts and updates
  const dominantSignals: string[] = [];
  const conflictingSignals: string[] = [];
  const updatedVariables: string[] = [];
  const newRisks: CoordinationRisk[] = [];

  // Aggregate each variable
  const newVariables: Record<string, VariableState> = { ...currentState.variables };

  for (const [variable, entries] of grouped) {
    const isConflict = detectConflicts(entries);
    const previousValue = currentState.variables[variable];

    let aggregated: VariableState;

    let effectiveMethod = method;
    if (isConflict && method === 'weighted_confidence') {
      effectiveMethod = 'median';
    }

    if (effectiveMethod === 'llm_synthesis') {
      log.warn(
        { variable, method, round: currentState.round + 1 },
        'llm_synthesis aggregation is not yet implemented — falling back to hybrid. ' +
        'Remove llm_synthesis from config or implement the aggregation method.',
      );
      effectiveMethod = 'hybrid';
    }

    switch (effectiveMethod) {
      case 'median':
        aggregated = medianAggregate(entries, previousValue);
        break;
      case 'trimmed_mean':
        aggregated = trimmedMeanAggregate(entries, previousValue);
        break;
      case 'weighted_confidence':
      case 'hybrid':
      default:
        aggregated = weightedConfidenceAggregate(entries, previousValue);
        break;
    }

    newVariables[variable] = aggregated;
    updatedVariables.push(variable);

    if (isConflict) {
      conflictingSignals.push(variable);
    } else {
      dominantSignals.push(variable);
    }

    // Detect critical risks from sensitivities
    for (const entry of entries) {
      if (entry.sensitivity.risk === 'critical') {
        newRisks.push({
          type: `critical_sensitivity_${variable}`,
          severity: 'critical',
          description: entry.sensitivity.rationale,
          sourceSignalIds: [entry.signal.id],
        });
      }
    }
  }

  // Compute convergence metrics
  const convergence = computeConvergence(signals, currentState, newVariables, grouped);

  // Update state
  const nextState: CoordinationState = {
    ...currentState,
    round: currentState.round + 1,
    variables: newVariables,
    convergence,
    risks: [...currentState.risks, ...newRisks],
    history: [...currentState.history, ...signals],
    totalCostUsd: currentState.totalCostUsd + signals.reduce((s, sig) => s + (sig.metrics?.estimatedCost ?? 0), 0),
    totalLatencyMs: currentState.totalLatencyMs + Math.max(...signals.map(s => s.metrics?.latencyMs ?? 0)),
    totalTokens: currentState.totalTokens + signals.reduce((s, sig) => s + (sig.metrics?.inputTokens ?? 0) + (sig.metrics?.outputTokens ?? 0), 0),
  };

  // Determine stop conditions
  const stopReason = evaluateStopConditions(nextState);

  log.debug(
    {
      round: nextState.round,
      variableCount: Object.keys(newVariables).length,
      dominant: dominantSignals.length,
      conflicting: conflictingSignals.length,
      convergence: convergence.score,
      stopReason,
    },
    'Sensitivity aggregation completed',
  );

  return {
    nextState,
    dominantSignals,
    conflictingSignals,
    updatedVariables,
    recommendedNextRound: stopReason === undefined,
    stopReason,
    risks: newRisks,
  };
}

// ============================================
// Convergence computation
// ============================================

/**
 * Compute convergence metrics by comparing current signals to previous round.
 */
function computeConvergence(
  signals: CoordinationSignal[],
  previousState: CoordinationState,
  newVariables: Record<string, VariableState>,
  // `_grouped` is intentionally unused for now — the caller already passes
  // the per-variable grouping it built, but convergence currently scores
  // on the raw signal list. Kept in the signature so future variable-level
  // convergence logic can adopt it without a caller refactor; prefixed with
  // `_` to mark "intentionally unused, not dead".
  _grouped: Map<string, Array<{ signal: CoordinationSignal; sensitivity: Sensitivity }>>,
): ConvergenceMetrics {
  // Decision agreement
  const decisionTypes = signals.map(s => s.decision.type);
  const majorityDecision = getMajority(decisionTypes);
  const dissent = majorityDecision
    ? 1 - (decisionTypes.filter(d => d === majorityDecision).length / decisionTypes.length)
    : 1;

  // Decision flip rate vs previous round
  let decisionFlipRate = 0;
  if (previousState.round > 0) {
    const previousSignals = previousState.history.filter(s => s.round === previousState.round);
    if (previousSignals.length > 0) {
      let flips = 0;
      for (const signal of signals) {
        const prev = previousSignals.find(s => s.agentId === signal.agentId);
        if (prev && prev.decision.type !== signal.decision.type) {
          flips++;
        }
      }
      decisionFlipRate = signals.length > 0 ? flips / signals.length : 0;
    }
  }

  // Variable stability
  const stableVariables: string[] = [];
  const unstableVariables: string[] = [];
  for (const [variable, state] of Object.entries(newVariables)) {
    if (state.stability >= 0.85) {
      stableVariables.push(variable);
    } else {
      unstableVariables.push(variable);
    }
  }

  // Overall convergence score: weighted combination
  const variableStability = Object.keys(newVariables).length > 0
    ? stableVariables.length / Object.keys(newVariables).length
    : 0;

  const agreementScore = 1 - dissent;

  const confidenceAvg = signals.length > 0
    ? signals.reduce((s, sig) => s + sig.decision.confidence, 0) / signals.length
    : 0;

  // Weighted convergence: 40% agreement + 30% variable stability + 30% confidence
  const score = (agreementScore * 0.4) + (variableStability * 0.3) + (confidenceAvg * 0.3);

  // Confidence trend
  const confidenceTrend = [...previousState.convergence.confidenceTrend, confidenceAvg];

  return {
    score,
    decisionFlipRate,
    dissent,
    confidenceTrend,
    stableVariables,
    unstableVariables,
  };
}

/**
 * Get the majority element from an array.
 */
function getMajority(arr: string[]): string | undefined {
  if (arr.length === 0) return undefined;
  const counts: Record<string, number> = {};
  for (const item of arr) {
    counts[item] = (counts[item] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
}

// ============================================
// Stop condition evaluation
// ============================================

/**
 * Evaluate whether coordination should stop based on current state.
 * Returns undefined if coordination should continue.
 */
export function evaluateStopConditions(state: CoordinationState): CoordinationStopReason | undefined {
  const { convergence, limits, risks, round } = state;

  // Hard limits
  if (round >= limits.maxRounds) {
    return 'max_rounds';
  }

  if (limits.maxCostUsd !== undefined && state.totalCostUsd >= limits.maxCostUsd) {
    return 'max_cost';
  }

  if (limits.maxLatencyMs !== undefined && state.totalLatencyMs >= limits.maxLatencyMs) {
    return 'max_latency';
  }

  // Critical risk
  if (limits.stopOnCriticalRisk) {
    const hasCritical = risks.some(r => r.severity === 'critical');
    if (hasCritical) {
      return 'critical_risk';
    }
  }

  // Convergence reached
  if (convergence.score >= limits.minConvergenceScore && convergence.decisionFlipRate <= limits.maxDecisionFlipRate) {
    return 'converged';
  }

  // Stagnation: no changes for 2+ rounds
  if (limits.detectStagnation && round >= 2) {
    if (convergence.decisionFlipRate === 0 && convergence.dissent <= limits.maxDissent) {
      return 'stagnation';
    }
  }

  // Persistent divergence
  if (round >= 2 && convergence.dissent > limits.maxDissent && convergence.decisionFlipRate > limits.maxDecisionFlipRate) {
    return 'persistent_divergence';
  }

  // Continue
  return undefined;
}
