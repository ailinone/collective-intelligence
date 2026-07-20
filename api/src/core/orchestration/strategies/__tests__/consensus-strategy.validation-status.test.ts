// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test 9/9: validationStatus propagation.
 *
 * The most important new contract: when NO evaluator is injected,
 * ConsensusStrategy MUST fall back to `UnavailableStrategyOutputEvaluator`
 * and record `validationStatus = 'unavailable'` in the artifact. This
 * keeps callers from accidentally trusting a length-based heuristic as
 * a quality signal.
 *
 * Also pins: scoringMode + validationStatus propagation for the
 * Structural and HeuristicTestOnly evaluators.
 */
import { describe, it, expect } from 'vitest';
import { StructuralOutputEvaluator } from '../evaluation/structural-evaluator';
import { HeuristicTestOnlyEvaluator } from '../evaluation/heuristic-test-only-evaluator';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
import {
  makeContext,
  makeRequest,
  threeHealthyModels,
  wireStrategy,
  setAggregatorOverride,
} from './consensus-strategy.fixtures';

describe('ConsensusStrategy — validationStatus', () => {
  it('defaults to UnavailableEvaluator when no evaluator is injected (validationStatus="unavailable")', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: null, // critical: leave unset → production default
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.scoringMode).toBe('unavailable');
    expect(a.validationStatus).toBe('unavailable');
    expect(a.evaluatorId).toBe('unavailable-default-v1');
  });

  it('unavailable evaluator → no quality scores on participants, no comparable synthesis-vs-best', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: null,
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    for (const p of a.participantOutputs) {
      expect(p.individualScore).toBeUndefined();
    }
    expect(a.synthesis.score).toBeUndefined();
    expect(a.bestIndividual?.score).toBeUndefined();
    expect(a.finalSelection.comparable).toBe(false);
    // Decision-rule under unavailable: synthesis is kept (structural pass)
    // and the artifact records the lack of comparison.
    expect(a.finalSelection.source).toBe('synthesis');
    expect(a.finalSelection.fallbackReason).toBe('non_comparable_scores');
  });

  it('unavailable evaluator still filters outliers on structural facts (empty / failed)', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: '' },               // empty → outlier
        'voter-c': { content: '', success: false, error: 'mock_err' }, // exec_failed → outlier
      },
      evaluator: null,
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    const b = a.participantOutputs.find((p) => p.modelId === 'voter-b');
    const c = a.participantOutputs.find((p) => p.modelId === 'voter-c');
    expect(b?.outlier).toBe(true);
    expect(b?.outlierReason).toBe('empty_output');
    expect(c?.outlier).toBe(true);
    expect(c?.outlierReason).toBe('execution_failed');
    expect(a.effectiveStrategyId).toBe('consensus_degraded_best_individual');
  });

  it('StructuralEvaluator records validationStatus="structurally_validated_only"', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: new StructuralOutputEvaluator(),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.scoringMode).toBe('structural');
    expect(a.validationStatus).toBe('structurally_validated_only');
    expect(a.evaluatorId).toBe('structural-default-v1');
    // No numeric scores under structural evaluator
    for (const p of a.participantOutputs) {
      expect(p.individualScore).toBeUndefined();
    }
    expect(a.finalSelection.comparable).toBe(false);
  });

  it('HeuristicTestOnlyEvaluator records validationStatus="structurally_validated_only" and notes the warning', async () => {
    const models = threeHealthyModels();
    setAggregatorOverride({ content: 'X'.repeat(120), confidence: 0.8 });
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: new HeuristicTestOnlyEvaluator(),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.scoringMode).toBe('heuristic_test_only');
    expect(a.validationStatus).toBe('structurally_validated_only');
    // Heuristic evaluator DOES emit a numeric score (length-based) — the
    // comparison IS made, but the artifact's validationStatus warns that
    // this is not real quality scoring.
    expect(typeof a.synthesis.score).toBe('number');
    expect(typeof a.bestIndividual?.score).toBe('number');
    expect(a.finalSelection.comparable).toBe(true);
  });

  it('scoringMode + evaluatorId propagate from injected evaluator to metadata + artifacts', async () => {
    const models = threeHealthyModels();
    const evaluator = new StructuralOutputEvaluator();
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
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.scoringMode).toBe(evaluator.mode);
    expect(a.evaluatorId).toBe(evaluator.id);
  });
});
