// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Adversarial Scenarios (F2.4)
 *
 * Synthetic adversarial signal generators for stress-testing the
 * coordination layer's detectors:
 *
 *   • Sensitivity poisoning  — agents emit suspiciously identical or
 *                              extreme-confidence sensitivities (caught
 *                              by `convergence-evaluator.detectSensitivityPoisoning`).
 *   • Herding cascade        — divergent round 1 collapses to unanimous
 *                              high-confidence in round 2 (caught by
 *                              `detectHerding`).
 *   • Confidence spamming    — every agent reports confidence 0.99
 *                              regardless of evidence.
 *   • Outlier amplification  — one agent reports an extreme value while
 *                              others stay close to the truth.
 *   • Hostile minority       — K agents collude on a misleading
 *                              direction; the rest are honest.
 *
 * Why this lives in production code:
 *   The C3 benchmark suite plugs these scenarios into the experiment
 *   runner to measure detection accuracy across deployments. Putting
 *   them in `__tests__/` would keep them invisible to production
 *   benchmarking. They are pure data generators with zero side
 *   effects, so they ship cleanly.
 */

import type { CoordinationSignal, Sensitivity, RiskSeverity } from './coordination-types';

// ─── Common helpers ────────────────────────────────────────────────────

export interface AdversarialAgent {
  agentId: string;
  modelId: string;
  providerId: string;
}

const DEFAULT_PROVIDER = 'adversarial-fixture';

function makeAgent(idx: number): AdversarialAgent {
  return {
    agentId: `agent-${idx}`,
    modelId: `model-${idx}`,
    providerId: DEFAULT_PROVIDER,
  };
}

function makeAgents(count: number): AdversarialAgent[] {
  return Array.from({ length: count }, (_, i) => makeAgent(i));
}

interface SignalFactoryOptions {
  agentIdx: number;
  round: number;
  decisionType: string;
  decisionValue: unknown;
  decisionConfidence: number;
  rationale: string;
  sensitivities: Sensitivity[];
}

function makeSignal(opts: SignalFactoryOptions): CoordinationSignal {
  return {
    id: `adv-${opts.agentIdx}-r${opts.round}-${Math.random().toString(36).slice(2, 8)}`,
    runId: 'adversarial-scenario',
    round: opts.round,
    agentId: `agent-${opts.agentIdx}`,
    modelId: `model-${opts.agentIdx}`,
    providerId: DEFAULT_PROVIDER,
    decision: {
      type: opts.decisionType,
      value: opts.decisionValue,
      confidence: opts.decisionConfidence,
      rationale: opts.rationale,
    },
    sensitivities: opts.sensitivities,
    metrics: {
      latencyMs: 200 + (opts.agentIdx * 10),
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.001,
    },
    createdAt: new Date(0).toISOString(),
  };
}

function honestSensitivity(variable: string, idx: number): Sensitivity {
  // Honest agents have varied rationales and moderate confidence.
  const directions = ['decrease', 'hold', 'increase'] as const;
  return {
    variable,
    direction: directions[idx % directions.length],
    trigger: `if downstream metric on ${variable} drifts (agent ${idx})`,
    confidence: 0.65 + ((idx % 3) * 0.05),
    rationale: `agent ${idx} sees the ${variable} signal as moderate-strength`,
    expectedDelta: 0.5 + ((idx % 4) * 0.05),
  };
}

// ─── Scenario 1 — Sensitivity poisoning ────────────────────────────────

export interface PoisoningScenarioOptions {
  /** Total agent count (>= 3). Default 6. */
  agentCount?: number;
  /** Variable name(s) the adversaries target. Default ['target_var']. */
  variables?: string[];
  /**
   * Adversary count. The remaining agents emit honest signals. Default
   * is 3, so 6 agents → 3 colluders + 3 honest.
   */
  adversaryCount?: number;
  /**
   * Confidence the adversaries report — set very close to 1.0 to
   * trigger `detectSensitivityPoisoning`'s extreme-confidence branch.
   * Default 0.995.
   */
  adversaryConfidence?: number;
  /** Number of rounds to generate. Default 2. */
  rounds?: number;
}

/**
 * Adversaries emit IDENTICAL trigger strings AND extreme confidence
 * (≥ 0.99) on the same variable, across multiple agents. The
 * convergence-evaluator's `detectSensitivityPoisoning` should flag
 * this pattern after at least one round.
 */
export function buildPoisoningScenario(
  options: PoisoningScenarioOptions = {},
): CoordinationSignal[][] {
  const agentCount = Math.max(3, options.agentCount ?? 6);
  // Allow adversaryCount up to agentCount so callers can construct
  // pure-adversary scenarios that fully exercise the detector. The
  // previous `agentCount - 1` cap silently produced mixed scenarios
  // where honest signals diluted the structural anomaly below the
  // detector's threshold.
  const adversaryCount = Math.max(2, Math.min(agentCount, options.adversaryCount ?? 3));
  const variables = options.variables && options.variables.length > 0 ? options.variables : ['target_var'];
  const advConfidence = Math.max(0.5, Math.min(0.999, options.adversaryConfidence ?? 0.995));
  const rounds = Math.max(1, options.rounds ?? 2);

  const allRounds: CoordinationSignal[][] = [];
  for (let round = 1; round <= rounds; round++) {
    const signals: CoordinationSignal[] = [];
    for (let agentIdx = 0; agentIdx < agentCount; agentIdx++) {
      const isAdversary = agentIdx < adversaryCount;

      const sensitivities: Sensitivity[] = isAdversary
        ? variables.map((v) => ({
            variable: v,
            direction: 'block',
            // Identical trigger across all adversaries — the structural
            // smoking gun the poisoning detector keys on.
            trigger: 'identical-poisoning-trigger',
            confidence: advConfidence,
            rationale: 'adversary forces this variable',
            risk: 'critical' as RiskSeverity,
            expectedDelta: 1.0,
          }))
        : variables.map((v, i) => honestSensitivity(v, agentIdx + i));

      signals.push(
        makeSignal({
          agentIdx,
          round,
          decisionType: isAdversary ? 'block' : 'approve',
          decisionValue: isAdversary ? 'block' : 'ok',
          decisionConfidence: isAdversary ? advConfidence : 0.7,
          rationale: isAdversary ? 'adversarial' : 'honest evaluation',
          sensitivities,
        }),
      );
    }
    allRounds.push(signals);
  }
  return allRounds;
}

// ─── Scenario 2 — Herding cascade ──────────────────────────────────────

export interface HerdingScenarioOptions {
  /** Total agent count (≥ 7 required for flipRate < 0.15 with one flip). Default 14. */
  agentCount?: number;
  /** Number of dissenters in round 1 who flip in round 2. Default 2. */
  flipCount?: number;
}

/**
 * Round 1 has divergent decisions; round 2 collapses to a single
 * decision at uniformly high confidence — the classic herding
 * signature `detectHerding` keys on. Returns the two-round signal
 * sequence.
 */
export function buildHerdingScenario(
  options: HerdingScenarioOptions = {},
): CoordinationSignal[][] {
  const agentCount = Math.max(7, options.agentCount ?? 14);
  const flipCount = Math.max(1, Math.min(Math.floor(agentCount * 0.14), options.flipCount ?? 2));

  const round1: CoordinationSignal[] = [];
  const round2: CoordinationSignal[] = [];

  for (let agentIdx = 0; agentIdx < agentCount; agentIdx++) {
    const isDissenter = agentIdx < flipCount;
    round1.push(
      makeSignal({
        agentIdx,
        round: 1,
        decisionType: isDissenter ? 'reject' : 'approve',
        decisionValue: isDissenter ? 'n' : 'y',
        decisionConfidence: 0.6 + ((agentIdx % 3) * 0.02), // <0.7 average so trend rises
        rationale: 'round-1 reasoning',
        sensitivities: [honestSensitivity('risk', agentIdx)],
      }),
    );
    round2.push(
      makeSignal({
        agentIdx,
        round: 2,
        // Everyone now agrees on approve — the dissenters flipped.
        decisionType: 'approve',
        decisionValue: 'y',
        decisionConfidence: 0.95,
        rationale: 'round-2 reasoning',
        sensitivities: [honestSensitivity('risk', agentIdx)],
      }),
    );
  }
  return [round1, round2];
}

// ─── Scenario 3 — Confidence spamming ──────────────────────────────────

export interface ConfidenceSpamScenarioOptions {
  agentCount?: number;
  spammerCount?: number;
}

/**
 * Spammers report confidence 0.99 on every signal regardless of
 * actual support. The poisoning detector should flag uniform extreme
 * confidence as a structural anomaly.
 */
export function buildConfidenceSpamScenario(
  options: ConfidenceSpamScenarioOptions = {},
): CoordinationSignal[][] {
  const agentCount = Math.max(3, options.agentCount ?? 5);
  // Allow all-spammer scenarios so the detector's
  // uniform-extreme-confidence branch can be exercised in isolation.
  const spammerCount = Math.max(2, Math.min(agentCount, options.spammerCount ?? 3));

  const round1: CoordinationSignal[] = [];
  for (let agentIdx = 0; agentIdx < agentCount; agentIdx++) {
    const isSpammer = agentIdx < spammerCount;
    round1.push(
      makeSignal({
        agentIdx,
        round: 1,
        decisionType: 'approve',
        decisionValue: 'y',
        decisionConfidence: isSpammer ? 0.99 : 0.7,
        rationale: isSpammer ? 'always confident' : 'honest assessment',
        sensitivities: [
          {
            variable: 'risk',
            direction: 'decrease',
            trigger: isSpammer ? `spam-trigger-${agentIdx}` : `legit-${agentIdx}`,
            confidence: isSpammer ? 0.999 : 0.7,
            rationale: 'r',
          },
        ],
      }),
    );
  }
  return [round1];
}

// ─── Scenario 4 — Outlier amplification ────────────────────────────────

export interface OutlierScenarioOptions {
  agentCount?: number;
  outlierExpectedDelta?: number;
}

/**
 * One agent emits an extreme `expectedDelta` while peers stay close
 * to a moderate value. Used to verify that median / trimmed_mean
 * aggregators damp the outlier whereas weighted_confidence is more
 * exposed to it.
 */
export function buildOutlierScenario(
  options: OutlierScenarioOptions = {},
): CoordinationSignal[][] {
  const agentCount = Math.max(4, options.agentCount ?? 5);
  const outlierDelta = options.outlierExpectedDelta ?? 100;

  const round1: CoordinationSignal[] = [];
  for (let agentIdx = 0; agentIdx < agentCount; agentIdx++) {
    const isOutlier = agentIdx === 0;
    round1.push(
      makeSignal({
        agentIdx,
        round: 1,
        decisionType: isOutlier ? 'block' : 'approve',
        decisionValue: isOutlier ? 'extreme' : 'ok',
        decisionConfidence: isOutlier ? 0.95 : 0.7,
        rationale: isOutlier ? 'outlier' : 'normal',
        sensitivities: [
          {
            variable: 'cost_estimate',
            direction: isOutlier ? 'increase' : 'hold',
            // Diversify the honest triggers per agent so the
            // structural poisoning detector does NOT flag the cohort
            // as colluding (false positive). Outlier keeps its own
            // distinct trigger string. With each honest agent
            // emitting a unique trigger, `identicalTriggers.length`
            // never equals total → poisoning correctly NOT flagged.
            trigger: isOutlier ? 'extreme cost projection' : `agent-${agentIdx} cost review`,
            confidence: 0.7,
            rationale: 'cost analysis',
            expectedDelta: isOutlier ? outlierDelta : 1.0 + (agentIdx * 0.1),
          },
        ],
      }),
    );
  }
  return [round1];
}

// ─── Scenario 5 — Hostile minority ─────────────────────────────────────

export interface HostileMinorityScenarioOptions {
  honestCount?: number;
  hostileCount?: number;
  rounds?: number;
}

/**
 * K hostile agents collude on a misleading direction; N - K honest
 * agents report a different direction. With K < N/2 the majority
 * voting in `getMajority` should still pick the honest direction —
 * a baseline robustness test for the aggregator.
 */
export function buildHostileMinorityScenario(
  options: HostileMinorityScenarioOptions = {},
): CoordinationSignal[][] {
  const honestCount = Math.max(3, options.honestCount ?? 5);
  const hostileCount = Math.max(1, options.hostileCount ?? 2);
  const rounds = Math.max(1, options.rounds ?? 1);
  const totalAgents = honestCount + hostileCount;

  const allRounds: CoordinationSignal[][] = [];
  for (let round = 1; round <= rounds; round++) {
    const signals: CoordinationSignal[] = [];
    for (let agentIdx = 0; agentIdx < totalAgents; agentIdx++) {
      const isHostile = agentIdx < hostileCount;
      signals.push(
        makeSignal({
          agentIdx,
          round,
          decisionType: isHostile ? 'reject' : 'approve',
          decisionValue: isHostile ? 'no' : 'yes',
          decisionConfidence: isHostile ? 0.92 : 0.78,
          rationale: isHostile ? 'colluding to reject' : 'honest approve',
          sensitivities: [
            {
              variable: 'collective_decision',
              direction: isHostile ? 'block' : 'unlock',
              // Hostile colluders share an identical trigger (the
              // realistic attack pattern), but honest agents diversify
              // theirs per agent index. This keeps the cohort below
              // the detector's "all identical" threshold so the
              // hostile-minority scenario does NOT false-positive on
              // poisoning detection — the test of value is whether
              // the majority decision survives, not whether the
              // structural detector trips.
              trigger: isHostile ? 'colluding rejection signal' : `agent-${agentIdx} honest review`,
              confidence: isHostile ? 0.92 : 0.75,
              rationale: 'evaluation',
            },
          ],
        }),
      );
    }
    allRounds.push(signals);
  }
  return allRounds;
}

// ─── Scenario index ────────────────────────────────────────────────────

export const ADVERSARIAL_SCENARIO_NAMES = [
  'sensitivity_poisoning',
  'herding_cascade',
  'confidence_spamming',
  'outlier_amplification',
  'hostile_minority',
] as const;

export type AdversarialScenarioName = (typeof ADVERSARIAL_SCENARIO_NAMES)[number];

export function listAdversarialAgents(scenario: CoordinationSignal[][]): AdversarialAgent[] {
  const ids = new Set<string>();
  for (const round of scenario) {
    for (const signal of round) {
      ids.add(signal.agentId);
    }
  }
  // Reconstruct AdversarialAgent shape from the ids.
  return [...ids].map((agentId, i) => ({
    agentId,
    modelId: `model-${i}`,
    providerId: DEFAULT_PROVIDER,
  }));
}

export { makeAgents };
