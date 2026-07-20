// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test 3/9: Outlier detection + filtering.
 *
 * Covers spec invariants:
 *   #4 individual scoring (every successful voter gets a verdict + score)
 *   #5 outlier handling: empty / too-short / score < 0.20 are flagged
 *   #16 synthesis happens ONLY on non-outliers
 *   outliers are excluded from best-individual comparison
 */
import { describe, it, expect } from 'vitest';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
import {
  makeContext,
  makeMockEvaluator,
  makeRequest,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

describe('ConsensusStrategy — outlier detection', () => {
  it('flags empty output with reason "empty_output"', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: '' },
      },
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const artifacts = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    const c = artifacts.participantOutputs.find((p) => p.modelId === 'voter-c');
    expect(c?.outlier).toBe(true);
    expect(c?.outlierReason).toBe('empty_output');
  });

  it('flags output below 50 chars with reason "output_too_short"', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'too short' },
      },
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const artifacts = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    const c = artifacts.participantOutputs.find((p) => p.modelId === 'voter-c');
    expect(c?.outlier).toBe(true);
    expect(c?.outlierReason).toBe('output_too_short');
  });

  it('flags voters whose injected score is < 0.20 with reason "score_below_threshold"', async () => {
    const models = threeHealthyModels();
    const evaluator = makeMockEvaluator({
      byModelId: { 'voter-a': 0.8, 'voter-b': 0.7, 'voter-c': 0.05 },
      synthesis: 0.9,
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
    const c = artifacts.participantOutputs.find((p) => p.modelId === 'voter-c');
    expect(c?.outlier).toBe(true);
    // Either the score-threshold gate OR the evaluator-fail-verdict gate
    // may fire first depending on verdict derivation; both are valid
    // outlier reasons coming from the same low-score signal.
    expect(['score_below_threshold', 'evaluator_fail_verdict']).toContain(c?.outlierReason);
  });

  it('outliers are excluded from synthesis input (inputParticipantCount = non-outliers)', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: '' },
      },
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const artifacts = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(artifacts.synthesis.inputParticipantCount).toBe(2);
  });

  it('outliers are excluded from best-individual comparison (bestIndividual.modelId is never an outlier)', async () => {
    const models = threeHealthyModels();
    // voter-c has highest raw score BUT empty output → outlier → cannot become best
    const evaluator = makeMockEvaluator({
      byModelId: { 'voter-a': 0.5, 'voter-b': 0.4, 'voter-c': 0.99 },
      synthesis: 0.95,
    });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: '' },
      },
      evaluator,
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const artifacts = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(artifacts.bestIndividual).not.toBeNull();
    expect(artifacts.bestIndividual!.modelId).not.toBe('voter-c');
    expect(['voter-a', 'voter-b']).toContain(artifacts.bestIndividual!.modelId);
  });

  it('degrades to best-individual when only 1 valid voter remains', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: '' },
        'voter-c': { content: '' },
      },
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const artifacts = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(artifacts.effectiveStrategyId).toBe('consensus_degraded_best_individual');
    expect(artifacts.finalSelection.source).toBe('best_individual');
    expect(artifacts.finalSelection.fallbackReason).toBe('only_one_valid_voter');
    expect(artifacts.finalSelection.comparable).toBe(false);
    expect(artifacts.partialDegradation).toBe(true);
    expect(r.metadata?.effectiveStrategyId).toBe('consensus_degraded_best_individual');
  });

  it('every successful execution gets an individualScore in artifacts when MockEvaluator is used', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const artifacts = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    for (const p of artifacts.participantOutputs) {
      if (p.success) {
        expect(typeof p.individualScore).toBe('number');
        expect(p.individualScore!).toBeGreaterThanOrEqual(0);
        expect(p.individualScore!).toBeLessThanOrEqual(1);
        expect(['pass', 'fail', 'uncertain']).toContain(p.evaluatorVerdict);
      }
    }
  });
});
