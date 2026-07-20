// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test 5/9: Complete artifact contract verification.
 *
 * Covers spec invariant #8 — artifacts completos. Every required field
 * on ConsensusStrategyArtifacts must be populated correctly across all
 * three branches (synthesis-wins, fallback, degraded), including the
 * new fields `scoringMode`, `evaluatorId`, `validationStatus`,
 * `evaluatorVerdict` on participants, and `comparable` on finalSelection.
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

describe('ConsensusStrategy — artifacts', () => {
  it('synthesis-wins branch populates every required artifact field', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(130) },
        'voter-c': { content: 'C'.repeat(140) },
      },
      evaluator: makeMockEvaluator({
        byModelId: { 'voter-a': 0.5, 'voter-b': 0.45, 'voter-c': 0.55 },
        synthesis: 0.8,
      }),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;

    expect(a.strategyName).toBe('consensus');
    expect(a.effectiveStrategyId).toBe('consensus');
    expect(a.scoringMode).toBe('mock');
    expect(a.validationStatus).toBe('fully_validated');
    expect(typeof a.evaluatorId).toBe('string');

    expect(a.participantOutputs.length).toBe(3);
    for (const p of a.participantOutputs) {
      expect(typeof p.modelId).toBe('string');
      expect(typeof p.success).toBe('boolean');
      expect(p.success).toBe(true);
      expect(typeof p.individualScore).toBe('number');
      expect(typeof p.outputLength).toBe('number');
      expect(p.outputLength).toBeGreaterThan(0);
      expect(['pass', 'fail', 'uncertain']).toContain(p.evaluatorVerdict);
    }

    expect(a.synthesis.inputParticipantCount).toBe(3);
    expect(typeof a.synthesis.score).toBe('number');
    expect(typeof a.synthesis.confidence).toBe('number');
    expect(typeof a.synthesis.outputLength).toBe('number');
    expect(['pass', 'fail', 'uncertain']).toContain(a.synthesis.verdict);

    expect(a.bestIndividual).not.toBeNull();
    expect(typeof a.bestIndividual!.modelId).toBe('string');
    expect(typeof a.bestIndividual!.score).toBe('number');
    expect(typeof a.bestIndividual!.outputLength).toBe('number');

    expect(a.finalSelection.source).toBe('synthesis');
    expect(a.finalSelection.fallbackTriggered).toBe(false);
    expect(a.finalSelection.comparable).toBe(true);
    expect(typeof a.finalSelection.finalScore).toBe('number');
    expect(typeof a.finalSelection.deltaVsBestIndividual).toBe('number');

    expect(r.metadata?.effectiveStrategyId).toBe(a.effectiveStrategyId);
    expect(r.metadata?.consensusArtifacts).toBe(a);
  });

  it('fallback branch populates fallbackReason + finalScore + delta < 0', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: 'S'.repeat(120), confidence: 0.5 });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(150) },
        'voter-b': { content: 'B'.repeat(150) },
        'voter-c': { content: 'C'.repeat(150) },
      },
      evaluator: makeMockEvaluator({
        byModelId: { 'voter-a': 0.9, 'voter-b': 0.7, 'voter-c': 0.6 },
        // Synth passes verdict (>=0.2) but loses on score-comparison.
        synthesis: 0.4,
      }),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.effectiveStrategyId).toBe('consensus_fallback_best_individual');
    expect(a.finalSelection.source).toBe('best_individual');
    expect(a.finalSelection.fallbackTriggered).toBe(true);
    expect(a.finalSelection.fallbackReason).toBe(
      'synthesis_underperformed_best_individual',
    );
    expect(a.finalSelection.finalScore).toBe(0.9);
    expect(a.finalSelection.comparable).toBe(true);
    expect(a.finalSelection.deltaVsBestIndividual).toBeLessThan(0);
    expect(a.bestIndividual?.modelId).toBe('voter-a');
  });

  it('degraded branch populates partialDegradation + partialDegradationReason', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(150) },
        'voter-b': { content: '' },
        'voter-c': { content: '' },
      },
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.effectiveStrategyId).toBe('consensus_degraded_best_individual');
    expect(a.partialDegradation).toBe(true);
    expect(a.partialDegradationReason).toBe('only_one_valid_voter');
    expect(a.finalSelection.fallbackReason).toBe('only_one_valid_voter');
    expect(a.finalSelection.comparable).toBe(false);
    expect(a.synthesis.inputParticipantCount).toBe(1);
    expect(a.synthesis.score).toBeUndefined();
    expect(a.synthesis.confidence).toBeUndefined();
    expect(a.synthesis.outputLength).toBeUndefined();
  });

  it('participantOutputs preserves entries for failed executions (success=false)', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': {
          content: '',
          success: false,
          error: 'auth_failed',
        },
      },
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    const failure = a.participantOutputs.find((p) => p.modelId === 'voter-c');
    expect(failure).toBeDefined();
    expect(failure!.success).toBe(false);
    expect(failure!.error).toBe('auth_failed');
    expect(failure!.outlier).toBe(true);
    expect(failure!.outlierReason).toBe('execution_failed');
    expect(failure!.individualScore).toBeUndefined();
  });

  it('finalResponse on synthesis branch is the aggregated response (not a voter)', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({
      content:
        'COORDINATOR_OUTPUT — synthesis of all voters into a single coherent response well above the 50-char outlier threshold.',
      confidence: 0.9,
    });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: makeMockEvaluator({
        byModelId: { 'voter-a': 0.5, 'voter-b': 0.5, 'voter-c': 0.5 },
        synthesis: 0.9,
      }),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const text = r.finalResponse.choices[0].message.content as string;
    expect(text.startsWith('COORDINATOR_OUTPUT')).toBe(true);
  });
});
