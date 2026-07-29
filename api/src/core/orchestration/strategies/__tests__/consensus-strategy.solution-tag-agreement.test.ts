// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Majority self-consistency on `<solution>...</solution>`-tagged answers
 * (the format LiveBench-style reasoning benchmarks instruct models to answer
 * in — reasoning prose first, then a tagged final answer). Before this fix,
 * extractAgreementAnswer only recognized a `FINAL:` line or a reply that is
 * ENTIRELY one fenced code block, so a prose-then-`<solution>` reply always
 * returned null and the 0.6 majority short-circuit (see
 * consensus-strategy.majority-self-consistency.test.ts) never fired for this
 * task class — it silently fell through to full synthesis every time.
 *
 * Mocking follows the sibling consensus-strategy.majority-self-consistency
 * test's pattern.
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

vi.mock('@/core/aggregation/response-aggregator', async () =>
  (await import('./consensus-module-mocks')).responseAggregatorModuleMock()
);
vi.mock('@/core/coordination/ensemble-coordinator-shadow', async () =>
  (await import('./consensus-module-mocks')).ensembleShadowModuleMock()
);
vi.mock('@/core/coordination/ensemble-coordinator-client', async () =>
  (await import('./consensus-module-mocks')).ensembleClientModuleMock()
);

// Long enough to clear the outlier length threshold.
const reasoning =
  'Working through the constraints step by step: the person who watches adventure ' +
  'is to the left of the journalist, and the police officer does not like filmmaking. ' +
  'Combining these clues in order lets us place each attribute uniquely. ';

const artifactsOf = (r: { metadata?: Record<string, unknown> }) =>
  r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
const contentOf = (r: { finalResponse: { choices: Array<{ message: { content: unknown } }> } }) =>
  String(r.finalResponse.choices[0].message.content);

describe('ConsensusStrategy — <solution> tag majority agreement', () => {
  beforeEach(() => {
    resetAggregatorOverride();
    delete process.env.CONSENSUS_AGREEMENT_EXIT_THRESHOLD;
    delete process.env.CONSENSUS_AGREEMENT_EXIT_MIN_VOTERS;
  });

  it('(i) 2-of-3 voters agree on a <solution> tag, despite prose before it, despite it not being a fenced code block', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: `SENTINEL_SYNTHESIS ${reasoning}`, confidence: 0.9 });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': {
          content: `${reasoning}<solution>1, filmmaking, police-officer, journalist</solution>`,
        },
        'voter-b': {
          content: `${reasoning}<solution>1, filmmaking, police-officer, journalist</solution>`,
        },
        'voter-c': {
          content: `${reasoning}<solution>2, collecting, journalist, police-officer</solution>`,
        },
      },
      evaluator: makeMockEvaluator({ fallback: 0.5, synthesis: 0.9 }),
      eligibleModels: models,
    });

    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = artifactsOf(r);

    expect(contentOf(r)).toContain(
      '<solution>1, filmmaking, police-officer, journalist</solution>'
    );
    expect(contentOf(r)).not.toContain('SENTINEL_SYNTHESIS');
    expect(a.effectiveStrategyId).toBe('consensus_agreement_individual');
    expect(a.finalSelection.source).toBe('agreement_individual');
    expect(a.agreementShortCircuit?.agreement).toBeCloseTo(2 / 3);
    expect(a.agreementShortCircuit?.parseableCount).toBe(3);
    expect(a.synthesis.score).toBeUndefined();
    expect(r.metadata?.aggregationMethod).toBe('agreement_individual');
  });

  it('(ii) <solution> tags matching only after lexical normalization (whitespace/case/comma-spacing) still form a majority', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: `SENTINEL_SYNTHESIS ${reasoning}`, confidence: 0.9 });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': {
          content: `${reasoning}<solution>1, filmmaking, police-officer, journalist</solution>`,
        },
        'voter-b': {
          content: `${reasoning}<solution>1,Filmmaking,Police-Officer, journalist</solution>`,
        },
        'voter-c': {
          content: `${reasoning}<solution>2, collecting, journalist, police-officer</solution>`,
        },
      },
      evaluator: makeMockEvaluator({ fallback: 0.5, synthesis: 0.9 }),
      eligibleModels: models,
    });

    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = artifactsOf(r);

    expect(a.effectiveStrategyId).toBe('consensus_agreement_individual');
    expect(a.agreementShortCircuit?.agreement).toBeCloseTo(2 / 3);
  });

  it('(iii) three genuinely differing <solution> answers do NOT short-circuit — falls through to synthesis', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: `SENTINEL_SYNTHESIS ${reasoning}`, confidence: 0.9 });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': {
          content: `${reasoning}<solution>1, filmmaking, police-officer, journalist</solution>`,
        },
        'voter-b': {
          content: `${reasoning}<solution>2, collecting, journalist, police-officer</solution>`,
        },
        'voter-c': {
          content: `${reasoning}<solution>1, collecting, police-officer, journalist</solution>`,
        },
      },
      evaluator: makeMockEvaluator({ fallback: 0.5, synthesis: 0.9 }),
      eligibleModels: models,
    });

    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = artifactsOf(r);

    expect(a.effectiveStrategyId).toBe('consensus');
    expect(a.finalSelection.source).toBe('synthesis');
    expect(a.agreementShortCircuit).toBeUndefined();
    expect(contentOf(r)).toContain('SENTINEL_SYNTHESIS');
  });

  it('(iv) a later <solution> tag wins over an earlier one in the same reply (last-wins, mirrors FINAL: precedence)', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: `SENTINEL_SYNTHESIS ${reasoning}`, confidence: 0.9 });
    const { strategy } = wireStrategy({
      responses: {
        // A voter that second-guesses itself mid-reply: only the LAST tag counts.
        'voter-a': {
          content: `${reasoning}<solution>2, collecting, journalist, police-officer</solution> Wait, let me recheck. ${reasoning}<solution>1, filmmaking, police-officer, journalist</solution>`,
        },
        'voter-b': {
          content: `${reasoning}<solution>1, filmmaking, police-officer, journalist</solution>`,
        },
        'voter-c': {
          content: `${reasoning}<solution>2, collecting, journalist, police-officer</solution>`,
        },
      },
      evaluator: makeMockEvaluator({ fallback: 0.5, synthesis: 0.9 }),
      eligibleModels: models,
    });

    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = artifactsOf(r);

    // voter-a's LAST tag agrees with voter-b → 2/3 majority.
    expect(a.effectiveStrategyId).toBe('consensus_agreement_individual');
    expect(a.agreementShortCircuit?.agreement).toBeCloseTo(2 / 3);
  });
});
