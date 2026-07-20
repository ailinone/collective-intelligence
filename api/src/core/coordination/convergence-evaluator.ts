// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Enhanced Convergence Evaluator
 *
 * Provides real convergence assessment beyond simple thresholds.
 * Detects false convergence, stagnation, herding, and sensitivity poisoning.
 *
 * Used by SensitivityConsensusStrategy to decide whether to continue
 * coordination rounds or stop.
 */

import type {
  CoordinationState,
  CoordinationStopReason,
} from './coordination-types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'convergence-evaluator' });

export interface ConvergenceEvaluation {
  shouldStop: boolean;
  stopReason?: CoordinationStopReason;
  convergenceScore: number;
  falseConvergenceRisk: boolean;
  herdingDetected: boolean;
  sensitivityPoisoningDetected: boolean;
  stagnationDetected: boolean;
  details: {
    agreementScore: number;
    variableStability: number;
    confidenceTrend: 'increasing' | 'decreasing' | 'stable';
    dominantModelInfluence: number;
    variableDrift: number;
    uniqueDecisionTypes: number;
    avgConfidenceDelta: number;
  };
}

export function evaluateConvergence(state: CoordinationState): ConvergenceEvaluation {
  // `history` and `risks` were destructured here for parity with the
  // CoordinationState shape, but every helper below receives `state` and
  // re-destructures what it needs. Pulling them at the top level was dead
  // weight that confused intent. Keep only what the function body uses.
  const { convergence, round } = state;
  const details = computeDetailedMetrics(state);
  const herding = detectHerding(state);
  const poisoning = detectSensitivityPoisoning(state);
  const stagnation = detectStagnation(state);
  const falseConvergence = detectFalseConvergence(state, details);

  let shouldStop = false;
  let stopReason: CoordinationStopReason | undefined;

  const stopCheck = checkStopConditions(state);
  if (stopCheck) {
    shouldStop = true;
    stopReason = stopCheck;
  }

  if (herding.detected && !shouldStop) {
    log.warn(
      {
        runId: state.runId,
        round,
        dominantModel: herding.dominantModel,
        influence: herding.influence.toFixed(2),
      },
      'Herding detected in coordination — models converging to single dominant position',
    );

    if (round >= 2) {
      shouldStop = true;
      stopReason = 'stagnation';
    }
  }

  if (poisoning.detected && !shouldStop) {
    log.warn(
      {
        runId: state.runId,
        round,
        flaggedVariables: poisoning.flaggedVariables,
      },
      'Potential sensitivity poisoning detected',
    );
  }

  if (stagnation.detected && !shouldStop) {
    shouldStop = true;
    stopReason = 'stagnation';
  }

  if (falseConvergence && !shouldStop && round >= 2) {
    log.warn(
      {
        runId: state.runId,
        round,
        convergenceScore: convergence.score,
      },
      'False convergence detected — apparent agreement but low genuine confidence',
    );
  }

  return {
    shouldStop,
    stopReason,
    convergenceScore: convergence.score,
    falseConvergenceRisk: falseConvergence,
    herdingDetected: herding.detected,
    sensitivityPoisoningDetected: poisoning.detected,
    stagnationDetected: stagnation.detected,
    details,
  };
}

function computeDetailedMetrics(state: CoordinationState): ConvergenceEvaluation['details'] {
  const { convergence, variables, history } = state;

  const currentRoundSignals = history.filter(s => s.round === state.round);
  const previousRoundSignals = history.filter(s => s.round === state.round - 1);

  const uniqueDecisions = new Set(currentRoundSignals.map(s => s.decision.type)).size;

  const currentConfAvg = currentRoundSignals.length > 0
    ? currentRoundSignals.reduce((s, sig) => s + sig.decision.confidence, 0) / currentRoundSignals.length
    : 0;
  const previousConfAvg = previousRoundSignals.length > 0
    ? previousRoundSignals.reduce((s, sig) => s + sig.decision.confidence, 0) / previousRoundSignals.length
    : 0;

  const avgConfidenceDelta = currentConfAvg - previousConfAvg;

  let confidenceTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
  if (convergence.confidenceTrend.length >= 2) {
    const recent = convergence.confidenceTrend.slice(-2);
    const delta = recent[1] - recent[0];
    if (delta > 0.05) confidenceTrend = 'increasing';
    else if (delta < -0.05) confidenceTrend = 'decreasing';
  }

  const modelSignalCounts: Record<string, number> = {};
  for (const sig of history) {
    modelSignalCounts[sig.modelId] = (modelSignalCounts[sig.modelId] || 0) + 1;
  }
  const totalSignals = history.length || 1;
  const maxModelSignals = Math.max(...Object.values(modelSignalCounts), 0);
  const dominantModelInfluence = maxModelSignals / totalSignals;

  const varValues = Object.values(variables);
  const variableStability = varValues.length > 0
    ? varValues.reduce((s, v) => s + v.stability, 0) / varValues.length
    : 0;

  let variableDrift = 0;
  if (state.round > 1) {
    const unstableCount = convergence.unstableVariables.length;
    const totalCount = Object.keys(variables).length;
    variableDrift = totalCount > 0 ? unstableCount / totalCount : 0;
  }

  const agreementScore = 1 - convergence.dissent;

  return {
    agreementScore,
    variableStability,
    confidenceTrend,
    dominantModelInfluence,
    variableDrift,
    uniqueDecisionTypes: uniqueDecisions,
    avgConfidenceDelta,
  };
}

function detectHerding(state: CoordinationState): {
  detected: boolean;
  dominantModel?: string;
  influence: number;
} {
  const { history, convergence, round } = state;

  if (round < 2 || history.length < 4) {
    return { detected: false, influence: 0 };
  }

  const currentRound = history.filter(s => s.round === round);
  if (currentRound.length < 2) return { detected: false, influence: 0 };

  const decisions = currentRound.map(s => s.decision.type);
  const unique = new Set(decisions);
  if (unique.size === 1 && convergence.decisionFlipRate === 0 && convergence.dissent === 0) {
    const prevRound = history.filter(s => s.round === round - 1);
    if (prevRound.length >= 2) {
      const prevDecisions = new Set(prevRound.map(s => s.decision.type));
      if (prevDecisions.size > 1) {
        const modelCounts: Record<string, number> = {};
        for (const s of currentRound) {
          modelCounts[s.modelId] = (modelCounts[s.modelId] || 0) + 1;
        }
        const dominant = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0];
        return {
          detected: true,
          dominantModel: dominant?.[0],
          influence: (dominant?.[1] ?? 0) / currentRound.length,
        };
      }
    }
  }

  if (convergence.decisionFlipRate > 0 && convergence.decisionFlipRate < 0.15) {
    const allDecisionsSame = unique.size <= 1;
    const allConfHigh = currentRound.every(s => s.decision.confidence >= 0.9);
    if (allDecisionsSame && allConfHigh && convergence.confidenceTrend.length >= 2) {
      const trend = convergence.confidenceTrend;
      const risingFast = trend[0] < 0.7 && trend[trend.length - 1] >= 0.9;
      if (risingFast) {
        return {
          detected: true,
          influence: convergence.score,
        };
      }
    }
  }

  return { detected: false, influence: 0 };
}

function detectSensitivityPoisoning(state: CoordinationState): {
  detected: boolean;
  flaggedVariables: string[];
} {
  const { history, variables, round } = state;
  const flaggedVariables: string[] = [];

  if (round < 1 || history.length < 3) {
    return { detected: false, flaggedVariables: [] };
  }

  for (const [varName, varState] of Object.entries(variables)) {
    if (varState.updatedBy.length <= 1) continue;

    const allSensitivities = history.flatMap(s =>
      s.sensitivities.filter(sens => sens.variable === varName)
    );

    if (allSensitivities.length < 2) continue;

    const identicalTriggers = allSensitivities.filter(
      s => s.trigger === allSensitivities[0].trigger
    );
    if (identicalTriggers.length === allSensitivities.length && allSensitivities.length >= 3) {
      flaggedVariables.push(varName);
      continue;
    }

    const extremeConfidence = allSensitivities.filter(s => s.confidence >= 0.99);
    if (extremeConfidence.length === allSensitivities.length && allSensitivities.length >= 3) {
      flaggedVariables.push(varName);
    }
  }

  return {
    detected: flaggedVariables.length > 0,
    flaggedVariables,
  };
}

function detectStagnation(state: CoordinationState): {
  detected: boolean;
} {
  const { convergence, round, limits } = state;

  if (!limits.detectStagnation || round < 2) {
    return { detected: false };
  }

  const trend = convergence.confidenceTrend;
  if (trend.length >= 3) {
    const last3 = trend.slice(-3);
    const maxDelta = Math.max(
      Math.abs(last3[1] - last3[0]),
      Math.abs(last3[2] - last3[1])
    );
    if (maxDelta < 0.01 && convergence.decisionFlipRate === 0) {
      return { detected: true };
    }
  }

  return { detected: false };
}

function detectFalseConvergence(
  state: CoordinationState,
  details: ConvergenceEvaluation['details'],
): boolean {
  if (state.convergence.score >= state.limits.minConvergenceScore) {
    if (details.avgConfidenceDelta < -0.1) {
      return true;
    }

    if (details.uniqueDecisionTypes <= 1 && details.variableDrift > 0.5) {
      return true;
    }

    if (state.convergence.dissent === 0 && details.dominantModelInfluence > 0.6) {
      return true;
    }
  }

  return false;
}

function checkStopConditions(state: CoordinationState): CoordinationStopReason | undefined {
  const { convergence, limits, risks, round, totalCostUsd, totalLatencyMs } = state;

  if (round >= limits.maxRounds) {
    return 'max_rounds';
  }

  if (limits.maxCostUsd !== undefined && totalCostUsd >= limits.maxCostUsd) {
    return 'max_cost';
  }

  if (limits.maxLatencyMs !== undefined && totalLatencyMs >= limits.maxLatencyMs) {
    return 'max_latency';
  }

  if (limits.stopOnCriticalRisk) {
    if (risks.some(r => r.severity === 'critical')) {
      return 'critical_risk';
    }
  }

  if (
    convergence.score >= limits.minConvergenceScore &&
    convergence.decisionFlipRate <= limits.maxDecisionFlipRate &&
    convergence.dissent <= limits.maxDissent
  ) {
    return 'converged';
  }

  if (round >= 3 && convergence.dissent > limits.maxDissent && convergence.decisionFlipRate > limits.maxDecisionFlipRate) {
    return 'persistent_divergence';
  }

  const currentRoundValid = state.history.filter(s => s.round === round);
  if (currentRoundValid.length < limits.minValidSignalsPerRound) {
    return 'insufficient_valid_signals';
  }

  return undefined;
}
