// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Comparable-gate: best-vs-synthesis fallback is ONLY a real signal
 * when both scores are numeric and produced by the same evaluator.
 * Under unavailable / structural evaluators, the comparison is
 * impossible — the artifact must record `comparable: false` and the
 * strategy must NOT fabricate a fallback decision from undefined.
 */
import { describe, it, expect } from 'vitest';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
import { StructuralOutputEvaluator } from '../evaluation/structural-evaluator';
import {
  makeContext,
  makeMockEvaluator,
  makeRequest,
  setAggregatorOverride,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

describe('Consensus — comparable gate', () => {
  it('unavailable evaluator → comparable=false, source=synthesis, fallbackReason="non_comparable_scores"', async () => {
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
    expect(a.finalSelection.comparable).toBe(false);
    expect(a.finalSelection.source).toBe('synthesis');
    expect(a.finalSelection.fallbackReason).toBe('non_comparable_scores');
  });

  it('structural evaluator → comparable=false', async () => {
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
    expect(a.finalSelection.comparable).toBe(false);
  });

  it('mock evaluator (real numeric scores) → comparable=true', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: makeMockEvaluator({
        byModelId: { 'voter-a': 0.6, 'voter-b': 0.5, 'voter-c': 0.55 },
        synthesis: 0.8,
      }),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.finalSelection.comparable).toBe(true);
  });

  it('mock evaluator with synth losing on score → comparable=true + fallback to best individual', async () => {
    setAggregatorOverride({ content: 'S'.repeat(120), confidence: 0.5 });
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: makeMockEvaluator({
        byModelId: { 'voter-a': 0.9, 'voter-b': 0.7, 'voter-c': 0.6 },
        synthesis: 0.4,
      }),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.finalSelection.comparable).toBe(true);
    expect(a.finalSelection.source).toBe('best_individual');
    expect(a.finalSelection.deltaVsBestIndividual).toBeLessThan(0);
  });

  it('synthesis verdict=fail still bypasses comparison (regardless of scores)', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: makeMockEvaluator({
        byModelId: { 'voter-a': 0.4, 'voter-b': 0.4, 'voter-c': 0.4 },
        synthesis: 0.9,
        synthesisVerdict: 'fail',
      }),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.finalSelection.source).toBe('best_individual');
    expect(a.finalSelection.comparable).toBe(false);
    expect(a.finalSelection.fallbackReason).toBe('synthesis_failed_evaluator');
  });
});
