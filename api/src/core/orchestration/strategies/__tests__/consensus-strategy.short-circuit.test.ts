// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the consensus latency levers (2026-07-03):
 *   1. voter evaluation runs CONCURRENTLY (was N sequential judge calls);
 *   2. pre-synthesis short-circuit via objective checker (answerVerifier) —
 *      a verified voter is served without paying synthesis + its evaluation;
 *   3. pre-synthesis short-circuit via voter agreement (default: unanimity);
 *   4. gates stay OFF under CONSENSUS_STRICT_PLAN_EXECUTION and on partial
 *      agreement — the plain synthesis contract is untouched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
import type { StrategyOutputEvaluator } from '../evaluation/strategy-output-evaluator';
import {
  makeContext,
  makeMockEvaluator,
  makeRequest,
  resetAggregatorOverride,
  setAggregatorOverride,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

// File-local copies of the consensus-validation.setup.ts mocks so this file
// also passes under configs that do not load that setup file (a bare
// `vitest run <file>` uses the default config; without these, the REAL
// aggregator runs, LLM synthesis fails, and the simple-concatenation
// fallback ("### From Voter A…") breaks the SENTINEL_SYNTHESIS asserts).
vi.mock('@/core/aggregation/response-aggregator', async () =>
  (await import('./consensus-module-mocks')).responseAggregatorModuleMock());
vi.mock('@/core/coordination/ensemble-coordinator-shadow', async () =>
  (await import('./consensus-module-mocks')).ensembleShadowModuleMock());
vi.mock('@/core/coordination/ensemble-coordinator-client', async () =>
  (await import('./consensus-module-mocks')).ensembleClientModuleMock());

const isEven = (a: string) => Number(a) % 2 === 0;
const pad = 'Detailed reasoning about the task, long enough to clear the outlier threshold. ';

const artifactsOf = (r: { metadata?: Record<string, unknown> }) =>
  r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
const contentOf = (r: { finalResponse: { choices: Array<{ message: { content: unknown } }> } }) =>
  String(r.finalResponse.choices[0].message.content);

describe('ConsensusStrategy — pre-synthesis short-circuits', () => {
  beforeEach(() => {
    resetAggregatorOverride();
    delete process.env.CONSENSUS_AGREEMENT_EXIT_THRESHOLD;
    delete process.env.CONSENSUS_STRICT_PLAN_EXECUTION;
  });

  it('checker-verified voter is served without synthesis (verified_individual)', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: `SENTINEL_SYNTHESIS ${pad}`, confidence: 0.9 });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: `${pad}FINAL: 3` },
        'voter-b': { content: `${pad}FINAL: 4` },
        'voter-c': { content: `${pad}FINAL: 5` },
      },
      evaluator: makeMockEvaluator({ fallback: 0.5, synthesis: 0.9 }),
      eligibleModels: models,
    });

    const r = await strategy.execute(
      makeRequest(),
      makeContext(models, { answerVerifier: isEven }),
    );
    const a = artifactsOf(r);

    expect(contentOf(r)).toContain('FINAL: 4');
    expect(contentOf(r)).not.toContain('SENTINEL_SYNTHESIS');
    expect(a.effectiveStrategyId).toBe('consensus_verified_individual');
    expect(a.finalSelection.source).toBe('verified_individual');
    expect(a.finalSelection.fallbackTriggered).toBe(false);
    expect(a.verification?.decision).toBe('override_to_voter');
    expect(a.verification?.method).toBe('checker');
    expect(a.verification?.verifiedCount).toBe(1);
    expect(a.verification?.verifiedModelId).toBe('voter-b');
    // Synthesis genuinely skipped: no score, no synthesizer subcall billed.
    expect(a.synthesis.score).toBeUndefined();
    expect(r.modelsUsed.every((m) => m.role !== 'coordinator')).toBe(true);
    expect(r.metadata?.aggregationMethod).toBe('verified_individual');
    expect(a.planParity.planExecutionDegraded).toBeFalsy();
  });

  it('checker overrides a WRONG unanimous majority (the thesis-lever case)', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: `${pad}FINAL: 9` },
        'voter-b': { content: `${pad}FINAL: 9` },
        'voter-c': { content: `${pad}FINAL: 2` },
      },
      evaluator: makeMockEvaluator({ fallback: 0.5, synthesis: 0.9 }),
      eligibleModels: models,
    });

    const r = await strategy.execute(
      makeRequest(),
      makeContext(models, { answerVerifier: isEven }),
    );
    const a = artifactsOf(r);

    // Majority says 9 (fails checker); the single verified voter wins —
    // and the agreement gate must NOT fire first on the wrong majority.
    expect(contentOf(r)).toContain('FINAL: 2');
    expect(a.effectiveStrategyId).toBe('consensus_verified_individual');
    expect(a.verification?.confidence).toBeCloseTo(1 / 3);
  });

  it('unanimous voter agreement skips synthesis (agreement_individual)', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: `SENTINEL_SYNTHESIS ${pad}`, confidence: 0.9 });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: `${pad}FINAL: 42` },
        'voter-b': { content: `${pad}FINAL: 42` },
        'voter-c': { content: `${pad}FINAL: 42` },
      },
      evaluator: makeMockEvaluator({ fallback: 0.5, synthesis: 0.9 }),
      eligibleModels: models,
    });

    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = artifactsOf(r);

    expect(contentOf(r)).toContain('FINAL: 42');
    expect(contentOf(r)).not.toContain('SENTINEL_SYNTHESIS');
    expect(a.effectiveStrategyId).toBe('consensus_agreement_individual');
    expect(a.finalSelection.source).toBe('agreement_individual');
    expect(a.agreementShortCircuit?.agreement).toBe(1);
    expect(a.agreementShortCircuit?.parseableCount).toBe(3);
    expect(a.synthesis.score).toBeUndefined();
    expect(r.metadata?.consensusReached).toBe(true);
    expect(r.metadata?.aggregationMethod).toBe('agreement_individual');
  });

  it('partial agreement (2/3) does NOT short-circuit — synthesis contract untouched', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: `SENTINEL_SYNTHESIS ${pad}`, confidence: 0.9 });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: `${pad}FINAL: 42` },
        'voter-b': { content: `${pad}FINAL: 42` },
        'voter-c': { content: `${pad}FINAL: 7` },
      },
      evaluator: makeMockEvaluator({ fallback: 0.5, synthesis: 0.9 }),
      eligibleModels: models,
    });

    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = artifactsOf(r);

    expect(a.effectiveStrategyId).toBe('consensus');
    expect(a.finalSelection.source).toBe('synthesis');
    expect(contentOf(r)).toContain('SENTINEL_SYNTHESIS');
  });

  it('CONSENSUS_STRICT_PLAN_EXECUTION=true disables the gates entirely', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: `SENTINEL_SYNTHESIS ${pad}`, confidence: 0.9 });
    process.env.CONSENSUS_STRICT_PLAN_EXECUTION = 'true';
    try {
      const { strategy } = wireStrategy({
        responses: {
          'voter-a': { content: `${pad}FINAL: 42` },
          'voter-b': { content: `${pad}FINAL: 42` },
          'voter-c': { content: `${pad}FINAL: 42` },
        },
        evaluator: makeMockEvaluator({ fallback: 0.5, synthesis: 0.9 }),
        eligibleModels: models,
      });
      const r = await strategy.execute(makeRequest(), makeContext(models));
      expect(artifactsOf(r).finalSelection.source).toBe('synthesis');
      expect(contentOf(r)).toContain('SENTINEL_SYNTHESIS');
    } finally {
      delete process.env.CONSENSUS_STRICT_PLAN_EXECUTION;
    }
  });

  it('CONSENSUS_AGREEMENT_EXIT_THRESHOLD above 1 disables the agreement gate', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: `SENTINEL_SYNTHESIS ${pad}`, confidence: 0.9 });
    process.env.CONSENSUS_AGREEMENT_EXIT_THRESHOLD = '1.1';
    try {
      const { strategy } = wireStrategy({
        responses: {
          'voter-a': { content: `${pad}FINAL: 42` },
          'voter-b': { content: `${pad}FINAL: 42` },
          'voter-c': { content: `${pad}FINAL: 42` },
        },
        evaluator: makeMockEvaluator({ fallback: 0.5, synthesis: 0.9 }),
        eligibleModels: models,
      });
      const r = await strategy.execute(makeRequest(), makeContext(models));
      expect(artifactsOf(r).finalSelection.source).toBe('synthesis');
    } finally {
      delete process.env.CONSENSUS_AGREEMENT_EXIT_THRESHOLD;
    }
  });
});

describe('ConsensusStrategy — concurrent voter evaluation', () => {
  beforeEach(() => resetAggregatorOverride());

  it('evaluates voters in parallel (max in-flight >= 2), preserving per-voter scores', async () => {
    const models = threeHealthyModels();
    const inner = makeMockEvaluator({
      byModelId: { 'voter-a': 0.4, 'voter-b': 0.6, 'voter-c': 0.8 },
      synthesis: 0.9,
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const probe: StrategyOutputEvaluator = {
      mode: inner.mode,
      id: inner.id,
      async evaluate(input) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        try {
          return await inner.evaluate(input);
        } finally {
          inFlight -= 1;
        }
      },
    };

    const { strategy } = wireStrategy({
      responses: {
        // No parseable FINAL answers — agreement gate must not fire.
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: probe,
      eligibleModels: models,
    });

    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = artifactsOf(r);

    expect(maxInFlight).toBeGreaterThanOrEqual(2); // was 1 when the loop was sequential
    // Per-voter scores still attributed to the right voter (order preserved).
    const byId = Object.fromEntries(a.participantOutputs.map((p) => [p.modelId, p.individualScore]));
    expect(byId['voter-a']).toBe(0.4);
    expect(byId['voter-b']).toBe(0.6);
    expect(byId['voter-c']).toBe(0.8);
  });
});
