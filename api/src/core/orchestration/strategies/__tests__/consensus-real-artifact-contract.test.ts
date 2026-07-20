// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Real-artifact contract — offline regression.
 *
 * Pins the SHAPE the live probe expects to find in
 * `ailin_metadata.consensusArtifacts`. The test uses synthetic data that
 * mirrors what `processChatRequest()` will produce when consensus runs
 * with a real evaluator. NO provider call. NO DB write.
 *
 * If a future refactor changes the artifact shape, this test breaks
 * before the live probe does.
 */
import { describe, it, expect } from 'vitest';
import type {
  ConsensusStrategyArtifacts,
  ConsensusParticipantArtifact,
} from '../consensus/consensus-artifacts';

function sampleSyntheticArtifacts(): ConsensusStrategyArtifacts {
  const participants: ConsensusParticipantArtifact[] = [
    {
      modelId: 'voter-a',
      modelName: 'Voter A',
      success: true,
      latencyMs: 1100,
      costUsd: 0.0021,
      individualScore: 0.74,
      evaluatorVerdict: 'pass',
      outlier: undefined,
      outlierReason: undefined,
      outputLength: 1840,
    },
    {
      modelId: 'voter-b',
      modelName: 'Voter B',
      success: true,
      latencyMs: 1240,
      costUsd: 0.0019,
      individualScore: 0.68,
      evaluatorVerdict: 'pass',
      outputLength: 2010,
    },
    {
      modelId: 'voter-c',
      modelName: 'Voter C',
      success: true,
      latencyMs: 970,
      costUsd: 0.0017,
      individualScore: 0.61,
      evaluatorVerdict: 'pass',
      outputLength: 1620,
    },
  ];

  return {
    strategyName: 'consensus',
    effectiveStrategyId: 'consensus',
    scoringMode: 'composite',
    evaluatorId: 'composite-v1',
    validationStatus: 'fully_validated',
    participantOutputs: participants,
    synthesis: {
      inputParticipantCount: 3,
      score: 0.81,
      verdict: 'pass',
      confidence: 0.86,
      outputLength: 2140,
    },
    bestIndividual: {
      modelId: 'voter-a',
      score: 0.74,
      outputLength: 1840,
    },
    finalSelection: {
      source: 'synthesis',
      fallbackTriggered: false,
      finalScore: 0.81,
      deltaVsBestIndividual: 0.07,
      comparable: true,
    },
  };
}

describe('consensus real-artifact contract (offline regression)', () => {
  it('artifact has every field the probe script reads', () => {
    const a = sampleSyntheticArtifacts();

    // Top-level
    expect(a.strategyName).toBe('consensus');
    expect(['consensus', 'consensus_fallback_best_individual', 'consensus_degraded_best_individual']).toContain(a.effectiveStrategyId);
    expect(typeof a.scoringMode).toBe('string');
    expect(typeof a.evaluatorId).toBe('string');
    expect(['fully_validated', 'structurally_validated_only', 'unavailable']).toContain(a.validationStatus);

    // Participants
    expect(a.participantOutputs.length).toBeGreaterThanOrEqual(2);
    for (const p of a.participantOutputs) {
      expect(typeof p.modelId).toBe('string');
      expect(typeof p.success).toBe('boolean');
      if (p.success) {
        expect(p.individualScore === undefined || typeof p.individualScore === 'number').toBe(true);
        expect(['pass', 'fail', 'uncertain', undefined]).toContain(p.evaluatorVerdict);
      }
    }

    // Synthesis
    expect(typeof a.synthesis.inputParticipantCount).toBe('number');

    // Best individual
    expect(a.bestIndividual).not.toBeNull();
    if (a.bestIndividual) {
      expect(typeof a.bestIndividual.modelId).toBe('string');
    }

    // Final selection
    expect(['synthesis', 'best_individual']).toContain(a.finalSelection.source);
    expect(typeof a.finalSelection.fallbackTriggered).toBe('boolean');
    expect(typeof a.finalSelection.comparable).toBe('boolean');
  });

  it('synthesis-wins branch sets comparable=true when scores are present', () => {
    const a = sampleSyntheticArtifacts();
    expect(a.finalSelection.source).toBe('synthesis');
    expect(a.finalSelection.comparable).toBe(true);
    expect(a.finalSelection.deltaVsBestIndividual).toBeGreaterThanOrEqual(0);
  });

  it('fallback branch carries fallbackReason and negative delta', () => {
    const fallback: ConsensusStrategyArtifacts = {
      ...sampleSyntheticArtifacts(),
      effectiveStrategyId: 'consensus_fallback_best_individual',
      synthesis: {
        inputParticipantCount: 3,
        score: 0.45,
        verdict: 'pass',
        confidence: 0.6,
        outputLength: 1500,
      },
      finalSelection: {
        source: 'best_individual',
        fallbackTriggered: true,
        fallbackReason: 'synthesis_underperformed_best_individual',
        finalScore: 0.74,
        deltaVsBestIndividual: -0.29,
        comparable: true,
      },
    };
    expect(fallback.finalSelection.source).toBe('best_individual');
    expect(fallback.finalSelection.fallbackTriggered).toBe(true);
    expect(fallback.finalSelection.deltaVsBestIndividual).toBeLessThan(0);
    expect(fallback.finalSelection.fallbackReason).toBe('synthesis_underperformed_best_individual');
  });

  it('unavailable evaluator → no scores + comparable=false', () => {
    const unavailable: ConsensusStrategyArtifacts = {
      strategyName: 'consensus',
      effectiveStrategyId: 'consensus',
      scoringMode: 'unavailable',
      evaluatorId: 'unavailable-default-v1',
      validationStatus: 'unavailable',
      participantOutputs: [
        { modelId: 'voter-a', success: true, outputLength: 100 },
        { modelId: 'voter-b', success: true, outputLength: 110 },
        { modelId: 'voter-c', success: true, outputLength: 120 },
      ],
      synthesis: {
        inputParticipantCount: 3,
        outputLength: 130,
      },
      bestIndividual: { modelId: 'voter-a', score: undefined, outputLength: 100 },
      finalSelection: {
        source: 'synthesis',
        fallbackTriggered: false,
        fallbackReason: 'non_comparable_scores',
        comparable: false,
      },
    };
    expect(unavailable.validationStatus).toBe('unavailable');
    expect(unavailable.finalSelection.comparable).toBe(false);
    expect(unavailable.participantOutputs.every((p) => p.individualScore === undefined)).toBe(true);
  });

  it('participantOutputs never embed raw output text (only outputLength)', () => {
    const a = sampleSyntheticArtifacts();
    for (const p of a.participantOutputs) {
      // The contract surface should NOT include any raw output field.
      const keys = Object.keys(p);
      const forbidden = ['output', 'content', 'text', 'message', 'rawOutput', 'prompt'];
      for (const f of forbidden) {
        expect(keys).not.toContain(f);
      }
    }
  });
});
