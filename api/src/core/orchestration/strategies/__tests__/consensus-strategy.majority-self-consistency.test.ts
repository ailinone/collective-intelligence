// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Majority self-consistency in the consensus collective (Wang et al.).
 *
 * The pre-synthesis agreement gate now short-circuits on a MAJORITY of
 * parseable voters (CONSENSUS_AGREEMENT_EXIT_THRESHOLD default 0.6), not just on
 * unanimity — this is the oracle-free lever of the collective. This suite pins:
 *   (i)   3 voters, 2 agree + 1 differs → the majority answer is served via the
 *         short-circuit at the 0.6 default (no synthesis, no coordinator call);
 *   (ii)  3 voters all differing → no majority → falls through to synthesis;
 *   (iii) a single successful voter NEVER triggers the majority short-circuit —
 *         that is the degraded best_individual path, not self-consistency.
 *
 * Mocking follows the sibling consensus-strategy.short-circuit.test.ts pattern.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
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
// also passes under a bare `vitest run <file>` (default config): without these
// the REAL aggregator runs, LLM synthesis fails, and the fallback concatenation
// breaks the SENTINEL_SYNTHESIS asserts.
vi.mock('@/core/aggregation/response-aggregator', async () =>
  (await import('./consensus-module-mocks')).responseAggregatorModuleMock());
vi.mock('@/core/coordination/ensemble-coordinator-shadow', async () =>
  (await import('./consensus-module-mocks')).ensembleShadowModuleMock());
vi.mock('@/core/coordination/ensemble-coordinator-client', async () =>
  (await import('./consensus-module-mocks')).ensembleClientModuleMock());

// Long enough to clear the outlier length threshold.
const pad = 'Detailed reasoning about the task, long enough to clear the outlier threshold. ';

const artifactsOf = (r: { metadata?: Record<string, unknown> }) =>
  r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
const contentOf = (r: { finalResponse: { choices: Array<{ message: { content: unknown } }> } }) =>
  String(r.finalResponse.choices[0].message.content);

describe('ConsensusStrategy — majority self-consistency', () => {
  beforeEach(() => {
    resetAggregatorOverride();
    delete process.env.CONSENSUS_AGREEMENT_EXIT_THRESHOLD;
    delete process.env.CONSENSUS_AGREEMENT_EXIT_MIN_VOTERS;
    delete process.env.CONSENSUS_STRICT_PLAN_EXECUTION;
  });

  it('(i) 2-of-3 majority is served via the short-circuit at the 0.6 default', async () => {
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

    // The majority answer (42) is served; synthesis is skipped entirely.
    expect(contentOf(r)).toContain('FINAL: 42');
    expect(contentOf(r)).not.toContain('SENTINEL_SYNTHESIS');
    expect(a.effectiveStrategyId).toBe('consensus_agreement_individual');
    expect(a.finalSelection.source).toBe('agreement_individual');
    expect(a.finalSelection.fallbackTriggered).toBe(false);
    // Agreement is the 2/3 majority over the parseable voters.
    expect(a.agreementShortCircuit?.agreement).toBeCloseTo(2 / 3);
    expect(a.agreementShortCircuit?.parseableCount).toBe(3);
    expect(a.agreementShortCircuit?.voterCount).toBe(3);
    // Synthesis genuinely skipped: no score, no coordinator subcall billed.
    expect(a.synthesis.score).toBeUndefined();
    expect(r.modelsUsed.every((m) => m.role !== 'coordinator')).toBe(true);
    expect(r.metadata?.aggregationMethod).toBe('agreement_individual');
    expect(r.metadata?.consensusReached).toBe(true);
  });

  it('(ii) three differing answers do NOT short-circuit — falls through to synthesis', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: `SENTINEL_SYNTHESIS ${pad}`, confidence: 0.9 });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: `${pad}FINAL: 1` },
        'voter-b': { content: `${pad}FINAL: 2` },
        'voter-c': { content: `${pad}FINAL: 3` },
      },
      evaluator: makeMockEvaluator({ fallback: 0.5, synthesis: 0.9 }),
      eligibleModels: models,
    });

    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = artifactsOf(r);

    // 1/3 agreement is below the 0.6 majority threshold → synthesis runs.
    expect(a.effectiveStrategyId).toBe('consensus');
    expect(a.finalSelection.source).toBe('synthesis');
    expect(a.agreementShortCircuit).toBeUndefined();
    expect(contentOf(r)).toContain('SENTINEL_SYNTHESIS');
  });

  it('(iii) a single successful voter never triggers the majority short-circuit', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: `SENTINEL_SYNTHESIS ${pad}`, confidence: 0.9 });
    // Force the min-voters env down to 1 to prove the hard floor + degraded
    // guard both refuse a single-voter "majority".
    process.env.CONSENSUS_AGREEMENT_EXIT_MIN_VOTERS = '1';
    try {
      const { strategy } = wireStrategy({
        responses: {
          'voter-a': { content: `${pad}FINAL: 42` },
          'voter-b': { content: '', success: false, error: 'mock_error' },
          'voter-c': { content: '', success: false, error: 'mock_error' },
        },
        evaluator: makeMockEvaluator({ fallback: 0.5, synthesis: 0.9 }),
        eligibleModels: models,
      });

      const r = await strategy.execute(makeRequest(), makeContext(models));
      const a = artifactsOf(r);

      // One valid voter → degraded best_individual, NOT a majority short-circuit.
      expect(a.effectiveStrategyId).not.toBe('consensus_agreement_individual');
      expect(a.effectiveStrategyId).toBe('consensus_degraded_best_individual');
      expect(a.finalSelection.source).toBe('best_individual');
      expect(a.agreementShortCircuit).toBeUndefined();
      expect(r.metadata?.aggregationMethod).toBe('best_individual_fallback');
    } finally {
      delete process.env.CONSENSUS_AGREEMENT_EXIT_MIN_VOTERS;
    }
  });
});
