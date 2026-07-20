// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test 4/9: Best-individual fallback when synthesis underperforms.
 *
 * Covers spec invariants:
 *   #6 final comparison (synthesisScore vs bestIndividualScore)
 *   #7 best-individual fallback (when synthesis < best)
 *   #10 effectiveStrategyId reflects the actual decision
 *   modelsUsed is preserved across both branches
 *   finalSelection.comparable=true under MockEvaluator (numeric scores)
 */
import { describe, it, expect } from 'vitest';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
import {
  makeContext,
  makeMockEvaluator,
  makeRequest,
  setAggregatorOverride,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

describe('ConsensusStrategy — best-individual fallback', () => {
  it('falls back when synthesisScore < bestIndividualScore (synth still passes verdict, just lower)', async () => {
    setAggregatorOverride({
      content: 'A'.repeat(120),  // long enough that structural is fine
      confidence: 0.6,
    });
    const models = threeHealthyModels();
    const evaluator = makeMockEvaluator({
      byModelId: { 'voter-a': 0.85, 'voter-b': 0.7, 'voter-c': 0.6 },
      synthesis: 0.3, // passes verdict (>=0.2) but below voter-a's 0.85
      fallback: 0.5,
    });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator,
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const artifacts = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(artifacts.effectiveStrategyId).toBe('consensus_fallback_best_individual');
    expect(artifacts.finalSelection.source).toBe('best_individual');
    expect(artifacts.finalSelection.fallbackTriggered).toBe(true);
    expect(artifacts.finalSelection.fallbackReason).toBe(
      'synthesis_underperformed_best_individual',
    );
    expect(artifacts.finalSelection.comparable).toBe(true);
    expect(artifacts.finalSelection.deltaVsBestIndividual).toBeLessThan(0);
    const finalContent = r.finalResponse.choices[0].message.content as string;
    expect(finalContent).toBe('A'.repeat(120));
    expect(r.metadata?.effectiveStrategyId).toBe('consensus_fallback_best_individual');
    expect(r.metadata?.aggregationMethod).toBe('best_individual_fallback');
  });

  it('keeps synthesis when synthesisScore >= bestIndividualScore', async () => {
    const models = threeHealthyModels();
    const evaluator = makeMockEvaluator({
      byModelId: { 'voter-a': 0.6, 'voter-b': 0.5, 'voter-c': 0.55 },
      synthesis: 0.85,
      fallback: 0.5,
    });
    setAggregatorOverride({
      content:
        'Synthesis answer combining all three voter perspectives into a single high-quality response that is well above the 50-char outlier floor.',
      confidence: 0.9,
    });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator,
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const artifacts = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(artifacts.effectiveStrategyId).toBe('consensus');
    expect(artifacts.finalSelection.source).toBe('synthesis');
    expect(artifacts.finalSelection.fallbackTriggered).toBe(false);
    expect(artifacts.finalSelection.comparable).toBe(true);
    expect(artifacts.finalSelection.deltaVsBestIndividual).toBeGreaterThanOrEqual(0);
    expect(r.metadata?.aggregationMethod).toBe('synthesis');
  });

  it('keeps modelsUsed shape (all 3) across both fallback and non-fallback branches', async () => {
    const models = threeHealthyModels();

    const evaluatorLow = makeMockEvaluator({
      byModelId: { 'voter-a': 0.9, 'voter-b': 0.6, 'voter-c': 0.5 },
      synthesis: 0.1,
    });
    const { strategy: s1 } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: evaluatorLow,
      eligibleModels: models,
    });
    const r1 = await s1.execute(makeRequest(), makeContext(models));
    expect(r1.modelsUsed.length).toBe(3);

    const evaluatorHigh = makeMockEvaluator({
      byModelId: { 'voter-a': 0.5, 'voter-b': 0.5, 'voter-c': 0.5 },
      synthesis: 0.9,
    });
    const { strategy: s2 } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: evaluatorHigh,
      eligibleModels: models,
    });
    const r2 = await s2.execute(makeRequest(), makeContext(models));
    expect(r2.modelsUsed.length).toBe(3);
  });

  it('qualityScore mirrors finalSelection (best-individual.score on fallback)', async () => {
    const models = threeHealthyModels();
    const evaluator = makeMockEvaluator({
      byModelId: { 'voter-a': 0.77, 'voter-b': 0.6, 'voter-c': 0.5 },
      synthesis: 0.05,
    });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator,
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    expect(r.qualityScore).toBe(0.77);
  });

  it('fallback also triggers when synthesis verdict is fail (independent of score delta)', async () => {
    const models = threeHealthyModels();
    const evaluator = makeMockEvaluator({
      byModelId: { 'voter-a': 0.4, 'voter-b': 0.4, 'voter-c': 0.4 },
      synthesis: 0.95, // high score but...
      synthesisVerdict: 'fail', // ...verdict forces fallback
    });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator,
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const artifacts = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(artifacts.finalSelection.source).toBe('best_individual');
    expect(artifacts.finalSelection.fallbackReason).toBe('synthesis_failed_evaluator');
    expect(artifacts.finalSelection.comparable).toBe(false);
  });
});
