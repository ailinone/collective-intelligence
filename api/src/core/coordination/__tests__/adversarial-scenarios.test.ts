// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration tests — Adversarial scenario robustness (F2.4)
 *
 * Drives each adversarial signal generator through the full
 * `aggregateSignals` + `evaluateConvergence` pipeline and asserts
 * the corresponding detector flags the attack pattern.
 *
 * These tests are the executable spec for the adversarial layer:
 * a regression that silently weakens any detector (poisoning,
 * herding, outlier handling) will surface here.
 */

import { describe, it, expect } from 'vitest';
import { aggregateSignals, createInitialState } from '../sensitivity-aggregator';
import { evaluateConvergence } from '../convergence-evaluator';
import {
  buildPoisoningScenario,
  buildHerdingScenario,
  buildConfidenceSpamScenario,
  buildOutlierScenario,
  buildHostileMinorityScenario,
  ADVERSARIAL_SCENARIO_NAMES,
} from '../adversarial-scenarios';
import type { CoordinationLimits } from '../coordination-types';

function defaultLimits(): CoordinationLimits {
  return {
    maxRounds: 3,
    minConvergenceScore: 0.82,
    maxDecisionFlipRate: 0.15,
    maxDissent: 0.35,
    stopOnCriticalRisk: true,
    minValidSignalsPerRound: 2,
    detectStagnation: true,
  };
}

// ─── Sensitivity poisoning ─────────────────────────────────────────────

describe('Sensitivity poisoning scenario', () => {
  it('pure-adversary cohort triggers detectSensitivityPoisoning (identical triggers)', () => {
    let state = createInitialState('adv-poisoning', 'sensitivity-consensus', defaultLimits());
    const rounds = buildPoisoningScenario({ agentCount: 4, adversaryCount: 4, rounds: 1 });

    for (const roundSignals of rounds) {
      state = aggregateSignals(roundSignals, state).nextState;
    }

    const evaluation = evaluateConvergence(state);
    expect(evaluation.sensitivityPoisoningDetected).toBe(true);
  });

  it('mixed cohort with even one honest signal does NOT trigger (conservative detector)', () => {
    // Documents the detector's intentionally conservative posture: any
    // honest signal on the same variable defeats the "all identical
    // triggers" structural test. This is desired — false positives on
    // partially-poisoned variables would be noisier than the value the
    // detector adds.
    let state = createInitialState('adv-poisoning-mixed', 'sensitivity-consensus', defaultLimits());
    const rounds = buildPoisoningScenario({ agentCount: 6, adversaryCount: 3 });

    for (const roundSignals of rounds) {
      state = aggregateSignals(roundSignals, state).nextState;
    }

    const evaluation = evaluateConvergence(state);
    expect(evaluation.sensitivityPoisoningDetected).toBe(false);
  });

  it('produces a critical risk when adversaries declare risk=critical', () => {
    let state = createInitialState('adv-poisoning-2', 'sensitivity-consensus', defaultLimits());
    const rounds = buildPoisoningScenario({ adversaryCount: 3, agentCount: 5 });
    for (const roundSignals of rounds) {
      state = aggregateSignals(roundSignals, state).nextState;
    }
    expect(state.risks.some((r) => r.severity === 'critical')).toBe(true);
  });
});

// ─── Herding cascade ───────────────────────────────────────────────────

describe('Herding cascade scenario', () => {
  it('triggers detectHerding via the rising-confidence branch', () => {
    let state = createInitialState('adv-herd', 'sensitivity-consensus', defaultLimits());
    const rounds = buildHerdingScenario({ agentCount: 14, flipCount: 2 });

    for (const roundSignals of rounds) {
      state = aggregateSignals(roundSignals, state).nextState;
    }

    expect(state.convergence.decisionFlipRate).toBeGreaterThan(0);
    expect(state.convergence.decisionFlipRate).toBeLessThan(0.15);
    expect(evaluateConvergence(state).herdingDetected).toBe(true);
  });
});

// ─── Confidence spamming ───────────────────────────────────────────────

describe('Confidence spamming scenario', () => {
  it('pure-spammer cohort triggers detectSensitivityPoisoning (uniform-extreme-confidence)', () => {
    let state = createInitialState('adv-spam', 'sensitivity-consensus', defaultLimits());
    const rounds = buildConfidenceSpamScenario({ agentCount: 4, spammerCount: 4 });

    for (const roundSignals of rounds) {
      state = aggregateSignals(roundSignals, state).nextState;
    }

    // The detector requires every sensitivity on the variable to have
    // confidence ≥ 0.99 AND total ≥ 3. Pure-spammer cohort meets both.
    expect(evaluateConvergence(state).sensitivityPoisoningDetected).toBe(true);
  });

  it('mixed cohort (one honest agent) does NOT trigger (conservative)', () => {
    let state = createInitialState('adv-spam-mixed', 'sensitivity-consensus', defaultLimits());
    const rounds = buildConfidenceSpamScenario({ agentCount: 5, spammerCount: 4 });

    for (const roundSignals of rounds) {
      state = aggregateSignals(roundSignals, state).nextState;
    }
    expect(evaluateConvergence(state).sensitivityPoisoningDetected).toBe(false);
  });
});

// ─── Outlier amplification ─────────────────────────────────────────────

describe('Outlier amplification scenario', () => {
  it('weighted_confidence aggregator is influenced by the outlier', () => {
    let state = createInitialState('adv-outlier-w', 'sensitivity-consensus', defaultLimits());
    const rounds = buildOutlierScenario({ agentCount: 5, outlierExpectedDelta: 100 });
    state = aggregateSignals(rounds[0], state, 'weighted_confidence').nextState;

    const v = state.variables.cost_estimate;
    expect(v).toBeDefined();
    // With weighted confidence and a 100-delta outlier, the resulting
    // value will be substantially above the honest agents' typical
    // delta (~1.0).
    if (typeof v.value === 'number') {
      expect(v.value).toBeGreaterThan(2);
    }
  });

  it('median aggregator damps the outlier', () => {
    let state = createInitialState('adv-outlier-m', 'sensitivity-consensus', defaultLimits());
    const rounds = buildOutlierScenario({ agentCount: 5, outlierExpectedDelta: 100 });
    state = aggregateSignals(rounds[0], state, 'median').nextState;

    const v = state.variables.cost_estimate;
    expect(v).toBeDefined();
    if (typeof v.value === 'number') {
      // Median of {100, 1.0, 1.1, 1.2, 1.3} is 1.2 — outlier damped.
      expect(v.value).toBeLessThan(2);
    }
  });

  it('trimmed_mean aggregator also damps the outlier', () => {
    let state = createInitialState('adv-outlier-t', 'sensitivity-consensus', defaultLimits());
    const rounds = buildOutlierScenario({ agentCount: 5, outlierExpectedDelta: 100 });
    state = aggregateSignals(rounds[0], state, 'trimmed_mean').nextState;

    const v = state.variables.cost_estimate;
    expect(v).toBeDefined();
    if (typeof v.value === 'number') {
      expect(v.value).toBeLessThan(2);
    }
  });
});

// ─── Hostile minority ──────────────────────────────────────────────────

describe('Hostile minority scenario', () => {
  it('honest majority decision survives K < N/2 hostile agents', () => {
    let state = createInitialState('adv-minority', 'sensitivity-consensus', defaultLimits());
    const rounds = buildHostileMinorityScenario({ honestCount: 5, hostileCount: 2 });
    state = aggregateSignals(rounds[0], state).nextState;

    // The hostile agents emit reject; the 5 honest emit approve. The
    // dissent metric should reflect that the minority is dissenting,
    // which means dissent < 0.5.
    expect(state.convergence.dissent).toBeLessThan(0.5);
  });

  it('honest direction wins on the collective_decision variable', () => {
    let state = createInitialState('adv-minority-2', 'sensitivity-consensus', defaultLimits());
    const rounds = buildHostileMinorityScenario({ honestCount: 5, hostileCount: 2 });
    state = aggregateSignals(rounds[0], state).nextState;

    const v = state.variables.collective_decision;
    expect(v).toBeDefined();
    // Majority (5/7) is 'unlock'; aggregator should converge to it.
    expect(v.value).toBe('unlock');
  });
});

// ─── Catalogue completeness ────────────────────────────────────────────

describe('Adversarial scenario catalogue', () => {
  it('exposes 5 named scenarios', () => {
    expect(ADVERSARIAL_SCENARIO_NAMES.length).toBe(5);
    expect(ADVERSARIAL_SCENARIO_NAMES).toContain('sensitivity_poisoning');
    expect(ADVERSARIAL_SCENARIO_NAMES).toContain('herding_cascade');
    expect(ADVERSARIAL_SCENARIO_NAMES).toContain('confidence_spamming');
    expect(ADVERSARIAL_SCENARIO_NAMES).toContain('outlier_amplification');
    expect(ADVERSARIAL_SCENARIO_NAMES).toContain('hostile_minority');
  });
});
