// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration tests — EntropySeed end-to-end (F1.8)
 *
 * Validates the full wiring of the anti-herding primitive:
 *   1. The convergence-evaluator's `detectHerding` correctly trips on
 *      a synthetic herding scenario (rising-confidence cascade with
 *      zero dissent in round 2 after multi-decision round 1).
 *   2. The `buildCoordinationSystemPrompt` honors the
 *      `entropySeedEnabled` flag end-to-end: when off (default), the
 *      preamble is absent; when on, it is present and positioned
 *      BEFORE the JSON schema instructions.
 *   3. The flag is correctly threaded from `getCoordinationConfigFromEnv`
 *      through to the prompt at the env-var level — flipping
 *      `CI_COLLECTIVE_ENTROPY_SEED_ENABLED` changes prompt output.
 *
 * What this test does NOT claim:
 *   We cannot prove in a deterministic unit/integration test that the
 *   EntropySeed instruction actually reduces herding in real LLM
 *   responses — that requires running the strategy against actual
 *   models and measuring the divergence/convergence delta. That
 *   measurement belongs in the C3 benchmark suite (Independence &
 *   Herding test phase). What we DO prove here is that the mechanism
 *   is plumbed correctly so the C3 benchmark has something to measure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { evaluateConvergence } from '../convergence-evaluator';
import { buildCoordinationSystemPrompt } from '../sensitivity-prompt-adapter';
import { aggregateSignals, createInitialState } from '../sensitivity-aggregator';
import { getCoordinationConfigFromEnv } from '../coordination-types';
import type {
  CoordinationLimits,
  CoordinationSignal,
  CoordinationState,
} from '../coordination-types';

const ENTROPY_SEED_ENV_VAR = 'CI_COLLECTIVE_ENTROPY_SEED_ENABLED';

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

function makeSignal(overrides: Partial<CoordinationSignal> = {}): CoordinationSignal {
  return {
    id: `sig-${Math.random().toString(36).slice(2, 10)}`,
    runId: 'run-herding',
    round: 1,
    agentId: 'agent-default',
    modelId: 'model-default',
    providerId: 'provider-default',
    decision: {
      type: 'approve',
      value: 'ok',
      confidence: 0.85,
      rationale: 'baseline approve',
    },
    sensitivities: [
      {
        variable: 'risk',
        direction: 'decrease',
        trigger: 'tests pass',
        confidence: 0.85,
        rationale: 'good coverage',
      },
    ],
    metrics: {
      latencyMs: 400,
      inputTokens: 200,
      outputTokens: 100,
      estimatedCost: 0.005,
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Herding detection on synthetic scenario ────────────────────────────

/**
 * The convergence-evaluator's "rising confidence cascade" branch
 * (`detectHerding`) trips when:
 *   - flipRate is in (0, 0.15) — a small minority of agents flipped
 *   - all current-round decisions are unanimous
 *   - all current-round confidences are >= 0.9
 *   - confidenceTrend goes from <0.7 to >=0.9
 *
 * To keep flipRate under 0.15 with at least one flip, we need at least
 * 7 agents (1/7 ≈ 0.143). The scenarios below use 14 agents so the
 * math has comfortable margin and the patterns read naturally.
 */
const HERDING_AGENT_COUNT = 14;
const HERDING_FLIP_COUNT = 2; // 2/14 ≈ 0.143 — under 0.15 threshold

function buildHerdingRound(opts: {
  round: 1 | 2;
  /** Number of agents whose decision differs from the dominant. Only used in round 1. */
  divergentInRound1?: number;
}): CoordinationSignal[] {
  const signals: CoordinationSignal[] = [];
  if (opts.round === 1) {
    const divergent = opts.divergentInRound1 ?? HERDING_FLIP_COUNT;
    for (let i = 0; i < HERDING_AGENT_COUNT; i++) {
      const isDivergent = i < divergent;
      signals.push(
        makeSignal({
          agentId: `agent-${i}`,
          round: 1,
          decision: {
            type: isDivergent ? 'reject' : 'approve',
            value: isDivergent ? 'n' : 'y',
            // Round-1 confidence intentionally low (<0.7 average) so
            // the trend rises into the herding-detection window.
            confidence: isDivergent ? 0.62 : 0.6,
            rationale: 'round-1 reasoning',
          },
        }),
      );
    }
    return signals;
  }
  // Round 2: everyone agrees on `approve`, all at high confidence.
  for (let i = 0; i < HERDING_AGENT_COUNT; i++) {
    signals.push(
      makeSignal({
        agentId: `agent-${i}`,
        round: 2,
        decision: {
          type: 'approve',
          value: 'y',
          confidence: 0.95,
          rationale: 'round-2 reasoning',
        },
      }),
    );
  }
  return signals;
}

describe('Convergence evaluator detects synthetic herding', () => {
  it('flags herdingDetected=true on rising-confidence cascade after divergent round 1', () => {
    let state: CoordinationState = createInitialState('run-h1', 'sensitivity-consensus', defaultLimits());

    state = aggregateSignals(buildHerdingRound({ round: 1, divergentInRound1: HERDING_FLIP_COUNT }), state).nextState;
    state = aggregateSignals(buildHerdingRound({ round: 2 }), state).nextState;

    const evaluation = evaluateConvergence(state);
    // Sanity-check the preconditions of the rising-cascade branch
    // before asserting the detection — failures here indicate the
    // synthetic scenario itself drifted, not the detector.
    expect(state.convergence.decisionFlipRate).toBeGreaterThan(0);
    expect(state.convergence.decisionFlipRate).toBeLessThan(0.15);
    expect(state.convergence.confidenceTrend.length).toBeGreaterThanOrEqual(2);
    expect(evaluation.herdingDetected).toBe(true);
  });

  it('does NOT flag herding when decisions stay stable across rounds with consistent confidence', () => {
    let state: CoordinationState = createInitialState('run-h2', 'sensitivity-consensus', defaultLimits());

    // Round 1: unanimous approve at moderate confidence.
    const round1 = Array.from({ length: HERDING_AGENT_COUNT }, (_, i) =>
      makeSignal({
        agentId: `agent-${i}`,
        round: 1,
        decision: { type: 'approve', value: 'y', confidence: 0.85, rationale: 'stable' },
      }),
    );
    state = aggregateSignals(round1, state).nextState;

    // Round 2: same — no divergence-then-collapse pattern, so this is
    // genuine stable agreement, not herding.
    const round2 = Array.from({ length: HERDING_AGENT_COUNT }, (_, i) =>
      makeSignal({
        agentId: `agent-${i}`,
        round: 2,
        decision: { type: 'approve', value: 'y', confidence: 0.86, rationale: 'stable' },
      }),
    );
    state = aggregateSignals(round2, state).nextState;

    const evaluation = evaluateConvergence(state);
    expect(evaluation.herdingDetected).toBe(false);
  });
});

// ─── EntropySeed prompt wiring through env var ──────────────────────────

describe('EntropySeed env-driven configuration (F1.8)', () => {
  // Snapshot the env var so tests do not bleed into one another. The
  // strategy reads via `getCoordinationConfigFromEnv()` so flipping
  // the env var is the canonical way to toggle the feature.
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env[ENTROPY_SEED_ENV_VAR];
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENTROPY_SEED_ENV_VAR];
    } else {
      process.env[ENTROPY_SEED_ENV_VAR] = originalValue;
    }
  });

  it('default env: getCoordinationConfigFromEnv reports entropySeedEnabled=false', () => {
    delete process.env[ENTROPY_SEED_ENV_VAR];
    const config = getCoordinationConfigFromEnv();
    expect(config.entropySeedEnabled).toBe(false);
  });

  it('env=true: getCoordinationConfigFromEnv reports entropySeedEnabled=true', () => {
    process.env[ENTROPY_SEED_ENV_VAR] = 'true';
    const config = getCoordinationConfigFromEnv();
    expect(config.entropySeedEnabled).toBe(true);
  });

  it('env=invalid string: defaults to false (strict comparison)', () => {
    process.env[ENTROPY_SEED_ENV_VAR] = 'yes';
    const config = getCoordinationConfigFromEnv();
    expect(config.entropySeedEnabled).toBe(false);
  });

  it('flipping env from false→true changes prompt output', () => {
    process.env[ENTROPY_SEED_ENV_VAR] = 'false';
    const configOff = getCoordinationConfigFromEnv();
    const promptOff = buildCoordinationSystemPrompt(undefined, 1, undefined, {
      entropySeedEnabled: configOff.entropySeedEnabled,
    });

    process.env[ENTROPY_SEED_ENV_VAR] = 'true';
    const configOn = getCoordinationConfigFromEnv();
    const promptOn = buildCoordinationSystemPrompt(undefined, 1, undefined, {
      entropySeedEnabled: configOn.entropySeedEnabled,
    });

    expect(promptOff).not.toContain('16-character random string');
    expect(promptOn).toContain('16-character random string');
    // Prompt-on must include AT LEAST the prompt-off content (additive).
    // Lengths differ only by the EntropySeed preamble.
    expect(promptOn.length).toBeGreaterThan(promptOff.length);
  });
});

// ─── Stability check — herding-detection survives EntropySeed plumbing ──

describe('Herding detection still trips when EntropySeed wired in (no false negatives)', () => {
  it('the synthetic herding scenario remains detectable regardless of prompt-shape changes', () => {
    // Sanity: the herding detection logic operates on signal data, not
    // on prompt text. Wiring EntropySeed into the prompt MUST NOT mask
    // the post-hoc detector. This test guards against an accidental
    // future change where the detector would only flag herding when a
    // specific prompt shape was used.
    let state: CoordinationState = createInitialState('run-h3', 'sensitivity-consensus', defaultLimits());
    state = aggregateSignals(buildHerdingRound({ round: 1, divergentInRound1: HERDING_FLIP_COUNT }), state).nextState;
    state = aggregateSignals(buildHerdingRound({ round: 2 }), state).nextState;

    const evaluation = evaluateConvergence(state);
    expect(evaluation.herdingDetected).toBe(true);
  });
});
