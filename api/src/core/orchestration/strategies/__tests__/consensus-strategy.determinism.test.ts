// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test 7/9: Determinism with a fixed evaluator.
 *
 * Covers spec invariant #11 — same inputs + same evaluator produce the
 * same decision artifacts. (Wallclock-derived fields like totalDuration
 * and execution.id are non-deterministic by design and are NOT compared.)
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

function projectStableArtifacts(a: ConsensusStrategyArtifacts): unknown {
  return {
    strategyName: a.strategyName,
    effectiveStrategyId: a.effectiveStrategyId,
    scoringMode: a.scoringMode,
    evaluatorId: a.evaluatorId,
    validationStatus: a.validationStatus,
    participantOutputs: a.participantOutputs.map((p) => ({
      modelId: p.modelId,
      modelName: p.modelName,
      success: p.success,
      individualScore: p.individualScore,
      evaluatorVerdict: p.evaluatorVerdict,
      outlier: p.outlier,
      outlierReason: p.outlierReason,
      outputLength: p.outputLength,
    })),
    synthesis: {
      inputParticipantCount: a.synthesis.inputParticipantCount,
      score: a.synthesis.score,
      verdict: a.synthesis.verdict,
      confidence: a.synthesis.confidence,
      outputLength: a.synthesis.outputLength,
    },
    bestIndividual: a.bestIndividual,
    finalSelection: a.finalSelection,
    partialDegradation: a.partialDegradation,
    partialDegradationReason: a.partialDegradationReason,
  };
}

describe('ConsensusStrategy — determinism', () => {
  it('same inputs → same decision artifacts (modulo wallclock fields)', async () => {
    const models = threeHealthyModels();
    const responses = {
      'voter-a': { content: 'A'.repeat(140) },
      'voter-b': { content: 'B'.repeat(140) },
      'voter-c': { content: 'C'.repeat(140) },
    };
    const evaluator = makeMockEvaluator({
      byModelId: { 'voter-a': 0.7, 'voter-b': 0.6, 'voter-c': 0.5 },
      synthesis: 0.8,
    });

    const w1 = wireStrategy({ responses, evaluator, eligibleModels: models });
    const w2 = wireStrategy({ responses, evaluator, eligibleModels: models });
    const ctx = makeContext(models);

    const r1 = await w1.strategy.execute(makeRequest('fixed prompt'), ctx);
    const r2 = await w2.strategy.execute(makeRequest('fixed prompt'), ctx);

    const a1 = r1.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    const a2 = r2.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;

    expect(projectStableArtifacts(a1)).toEqual(projectStableArtifacts(a2));
    expect(r1.qualityScore).toBe(r2.qualityScore);
    expect(r1.totalCost).toBe(r2.totalCost);
  });

  it('bestIndividual.modelId is deterministic given the evaluator ordering', async () => {
    const models = threeHealthyModels();
    const responses = {
      'voter-a': { content: 'A'.repeat(140) },
      'voter-b': { content: 'B'.repeat(140) },
      'voter-c': { content: 'C'.repeat(140) },
    };
    const evaluator = makeMockEvaluator({
      byModelId: { 'voter-a': 0.5, 'voter-b': 0.9, 'voter-c': 0.4 },
      synthesis: 0.95,
    });

    for (let i = 0; i < 3; i++) {
      const { strategy } = wireStrategy({
        responses,
        evaluator,
        eligibleModels: models,
      });
      const r = await strategy.execute(makeRequest(), makeContext(models));
      const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
      expect(a.bestIndividual?.modelId).toBe('voter-b');
    }
  });

  it('finalSelection.source is deterministic across repeated runs (fallback branch)', async () => {
    const models = threeHealthyModels();
    const responses = {
      'voter-a': { content: 'A'.repeat(140) },
      'voter-b': { content: 'B'.repeat(140) },
      'voter-c': { content: 'C'.repeat(140) },
    };
    const evaluator = makeMockEvaluator({
      byModelId: { 'voter-a': 0.85, 'voter-b': 0.55, 'voter-c': 0.45 },
      synthesis: 0.1,
    });

    for (let i = 0; i < 3; i++) {
      const { strategy } = wireStrategy({
        responses,
        evaluator,
        eligibleModels: models,
      });
      const r = await strategy.execute(makeRequest(), makeContext(models));
      const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
      expect(a.finalSelection.source).toBe('best_individual');
      expect(a.effectiveStrategyId).toBe('consensus_fallback_best_individual');
    }
  });
});
