// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment — Adversarial Scenario Runner (F3.2)
 *
 * Synthesizes a deterministic adversarial signal stream and drives it
 * through the coordination layer's aggregator + detector pipeline,
 * producing a measurable detection outcome WITHOUT consuming any
 * real-model API budget.
 *
 * This is the wiring that makes the C3 Adversarial Robustness arm
 * (F2.8 + F2.9) actionable in the experiment-runner: when a
 * CollectiveConfig carries `adversarialScenario`, the runner
 * dispatches here instead of calling /v1/chat/completions.
 *
 * Output contract:
 *   - `qualityScore = 1.0` when the run produced the EXPECTED
 *     detector outcome for the scenario (e.g., poisoning detected
 *     for `sensitivity_poisoning`, no detection for the mixed-
 *     cohort variants).
 *   - `qualityScore = 0.0` otherwise.
 *   - `responseSummary` describes what was detected vs. expected so
 *     the report generator can group failures.
 *   - `costUsd = 0` and `totalTokens = 0` — the synthetic run does
 *     not invoke any model.
 *
 * This module is dependency-light: it imports the coordination layer
 * directly (not via HTTP) so it stays viable even when the API is
 * not running (e.g., during offline benchmark replay).
 */

import {
  buildPoisoningScenario,
  buildHerdingScenario,
  buildConfidenceSpamScenario,
  buildOutlierScenario,
  buildHostileMinorityScenario,
} from '@/core/coordination/adversarial-scenarios';
import { aggregateSignals, createInitialState } from '@/core/coordination/sensitivity-aggregator';
import { evaluateConvergence } from '@/core/coordination/convergence-evaluator';
import type {
  CoordinationLimits,
  CoordinationSignal,
  CoordinationState,
} from '@/core/coordination/coordination-types';
import { logger } from '@/utils/logger';
import type {
  AdversarialScenarioName,
  ExperimentExecutionResult,
  ExperimentPhase,
  ExperimentTask,
  ModeConfig,
} from './experiment-types';
import { nanoid } from 'nanoid';

const log = logger.child({ component: 'adversarial-scenario-runner' });

// ─── Expected outcomes per scenario ────────────────────────────────────

/**
 * What we expect the convergence-evaluator to flag for each scenario.
 * Missing from the map = no specific expectation; the run still
 * records the outcome but doesn't gate qualityScore on detection.
 */
interface ExpectedOutcome {
  /** True if the scenario should trip detectSensitivityPoisoning. */
  expectsPoisoning: boolean;
  /** True if the scenario should trip detectHerding. */
  expectsHerding: boolean;
  /** True if the scenario should produce a critical risk in state.risks. */
  expectsCriticalRisk: boolean;
  /** Free-form note shown in responseSummary on mismatch. */
  rationale: string;
}

const EXPECTED_OUTCOMES: Record<AdversarialScenarioName, ExpectedOutcome> = {
  sensitivity_poisoning: {
    expectsPoisoning: true,
    expectsHerding: false,
    expectsCriticalRisk: true,
    rationale: 'Pure-adversary cohort with identical triggers + critical risk',
  },
  herding_cascade: {
    expectsPoisoning: false,
    expectsHerding: true,
    expectsCriticalRisk: false,
    rationale: 'Divergent round 1 → unanimous high-confidence round 2 (flipRate < 0.15)',
  },
  confidence_spamming: {
    expectsPoisoning: true,
    expectsHerding: false,
    expectsCriticalRisk: false,
    rationale: 'Pure-spammer cohort with confidence ≥ 0.99 across the board',
  },
  outlier_amplification: {
    expectsPoisoning: false,
    expectsHerding: false,
    expectsCriticalRisk: false,
    rationale: 'Outlier expectedDelta should be damped by median/trimmed_mean aggregators',
  },
  hostile_minority: {
    expectsPoisoning: false,
    expectsHerding: false,
    expectsCriticalRisk: false,
    rationale: 'Honest majority should win on collective_decision; dissent stays low',
  },
};

// ─── Scenario dispatch ──────────────────────────────────────────────────

function generateSignals(scenario: AdversarialScenarioName): CoordinationSignal[][] {
  switch (scenario) {
    case 'sensitivity_poisoning':
      // Pure adversary cohort to exercise the structural detection
      // (identical triggers + critical risk).
      return buildPoisoningScenario({ agentCount: 4, adversaryCount: 4, rounds: 1 });
    case 'herding_cascade':
      return buildHerdingScenario({ agentCount: 14, flipCount: 2 });
    case 'confidence_spamming':
      return buildConfidenceSpamScenario({ agentCount: 4, spammerCount: 4 });
    case 'outlier_amplification':
      return buildOutlierScenario({ agentCount: 5, outlierExpectedDelta: 100 });
    case 'hostile_minority':
      return buildHostileMinorityScenario({ honestCount: 5, hostileCount: 2, rounds: 1 });
  }
}

// ─── Limits ────────────────────────────────────────────────────────────

function buildAdversarialLimits(rounds: number): CoordinationLimits {
  return {
    maxRounds: Math.max(rounds, 3),
    minConvergenceScore: 0.82,
    maxDecisionFlipRate: 0.15,
    maxDissent: 0.35,
    stopOnCriticalRisk: false, // run all rounds for measurement
    minValidSignalsPerRound: 1,
    detectStagnation: false,
  };
}

// ─── Outcome computation ───────────────────────────────────────────────

interface ScenarioOutcome {
  poisoningDetected: boolean;
  herdingDetected: boolean;
  criticalRiskCount: number;
  finalConvergenceScore: number;
  finalDecisionFlipRate: number;
  finalDissent: number;
  variableCount: number;
  /**
   * For outlier scenarios — the aggregated value of the outlier-
   * affected variable. Lets the report compare median (damped) vs.
   * weighted_confidence (exposed) on the same input.
   */
  aggregatedOutlierValue: number | null;
}

function computeOutcome(state: CoordinationState): ScenarioOutcome {
  const evaluation = evaluateConvergence(state);
  const criticalRiskCount = state.risks.filter((r) => r.severity === 'critical').length;
  const outlierValue =
    state.variables.cost_estimate && typeof state.variables.cost_estimate.value === 'number'
      ? state.variables.cost_estimate.value
      : null;

  return {
    poisoningDetected: evaluation.sensitivityPoisoningDetected,
    herdingDetected: evaluation.herdingDetected,
    criticalRiskCount,
    finalConvergenceScore: evaluation.convergenceScore,
    finalDecisionFlipRate: state.convergence.decisionFlipRate,
    finalDissent: state.convergence.dissent,
    variableCount: Object.keys(state.variables).length,
    aggregatedOutlierValue: outlierValue,
  };
}

function judgeOutcome(
  scenario: AdversarialScenarioName,
  outcome: ScenarioOutcome,
): { passed: boolean; mismatchSummary: string } {
  const expected = EXPECTED_OUTCOMES[scenario];
  const failures: string[] = [];

  if (expected.expectsPoisoning !== outcome.poisoningDetected) {
    failures.push(
      `expected poisoningDetected=${expected.expectsPoisoning}, got ${outcome.poisoningDetected}`,
    );
  }
  if (expected.expectsHerding !== outcome.herdingDetected) {
    failures.push(
      `expected herdingDetected=${expected.expectsHerding}, got ${outcome.herdingDetected}`,
    );
  }
  if (expected.expectsCriticalRisk !== outcome.criticalRiskCount > 0) {
    failures.push(
      `expected criticalRisk=${expected.expectsCriticalRisk}, got ${outcome.criticalRiskCount} critical risk(s)`,
    );
  }

  // outlier_amplification has additional expectations on the
  // aggregated value: a damping aggregator (median / trimmed_mean)
  // should keep the value below 5; weighted_confidence does not.
  // The judge does not gate on aggregator type here — the report
  // tooling consumes `aggregatedOutlierValue` directly.

  if (failures.length === 0) {
    return { passed: true, mismatchSummary: '' };
  }
  return {
    passed: false,
    mismatchSummary: failures.join('; '),
  };
}

// ─── Main entry ─────────────────────────────────────────────────────────

export interface AdversarialRunOptions {
  experimentId: string;
  task: ExperimentTask;
  mode: ModeConfig;
  repetition: number;
  phase: ExperimentPhase;
  /**
   * The aggregation method to apply per round. Inherited from the
   * mode if specified, otherwise defaults to `weighted_confidence`
   * which is the most common production setting.
   */
  aggregationMethod?: 'weighted_confidence' | 'median' | 'trimmed_mean' | 'hybrid';
  scenario: AdversarialScenarioName;
}

export function runAdversarialScenarioSynthetic(
  options: AdversarialRunOptions,
): ExperimentExecutionResult {
  const startMs = Date.now();
  const aggregationMethod = options.aggregationMethod ?? 'weighted_confidence';
  const runId = `adv-${nanoid(10)}`;
  const rounds = generateSignals(options.scenario);
  const limits = buildAdversarialLimits(rounds.length);

  let state = createInitialState(runId, 'adversarial-scenario', limits);
  for (const roundSignals of rounds) {
    state = aggregateSignals(roundSignals, state, aggregationMethod).nextState;
  }

  const outcome = computeOutcome(state);
  const judgement = judgeOutcome(options.scenario, outcome);
  const latencyMs = Date.now() - startMs;

  log.info(
    {
      experimentId: options.experimentId,
      taskIndex: options.task.index,
      scenario: options.scenario,
      passed: judgement.passed,
      poisoningDetected: outcome.poisoningDetected,
      herdingDetected: outcome.herdingDetected,
      criticalRiskCount: outcome.criticalRiskCount,
      latencyMs,
    },
    'Adversarial scenario synthetic run completed',
  );

  const summaryParts: string[] = [
    `[ADVERSARIAL] scenario=${options.scenario}`,
    `expected: ${EXPECTED_OUTCOMES[options.scenario].rationale}`,
    `outcome: poisoningDetected=${outcome.poisoningDetected}, herdingDetected=${outcome.herdingDetected}, criticalRisks=${outcome.criticalRiskCount}, convergenceScore=${outcome.finalConvergenceScore.toFixed(3)}`,
    `passed=${judgement.passed}`,
  ];
  if (!judgement.passed) {
    summaryParts.push(`mismatch: ${judgement.mismatchSummary}`);
  }

  const strategy =
    options.mode.mode === 'collective' || options.mode.mode === 'forced-pool-collective' || options.mode.mode === 'ablation'
      ? options.mode.strategy
      : 'single';

  return {
    experimentId: options.experimentId,
    taskIndex: options.task.index,
    repetition: options.repetition,
    executionMode: options.mode.mode === 'forced-pool-collective' ? 'collective-tier1' : options.mode.mode,
    strategy,
    model: null,
    taskType: options.task.taskType,
    complexity: options.task.complexity,
    domain: options.task.domain || 'general',
    prompt: options.task.prompt,
    qualityScore: judgement.passed ? 1.0 : 0.0,
    costUsd: 0,
    latencyMs,
    totalTokens: 0,
    success: true,
    modelsUsed: [],
    judgeScore: judgement.passed ? 1.0 : 0.0,
    judgeRubric: 'adversarial detector accuracy',
    faithfulnessScore: null,
    instructionFollowingScore: null,
    failureMode: judgement.passed ? null : 'incomplete',
    phase: options.phase,
    responseSummary: summaryParts.join(' | '),
    ablationDisabled: options.mode.mode === 'ablation' ? options.mode.disableComponents : [],
    ablationCondition: options.mode.mode === 'ablation' ? `-${options.mode.disableComponents.join('-')}` : null,
    scoringPolicy: 'adversarial',
    judgeUsed: false,
    heuristicScoreRaw: null,
  };
}

// ─── Public dispatch helper ────────────────────────────────────────────

/**
 * Returns true when the mode carries an adversarial scenario tag and
 * should be dispatched to the synthetic runner. The experiment-runner
 * checks this at the start of `executeSingleRun` before any HTTP call.
 */
export function isAdversarialScenarioMode(mode: ModeConfig): mode is ModeConfig & { adversarialScenario: AdversarialScenarioName } {
  return mode.mode === 'collective' && typeof mode.adversarialScenario === 'string' && mode.adversarialScenario.length > 0;
}
