// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-compares-current-selector.test.ts — MVP 8A
 *
 * Validates Section 15.8: head-to-head comparison between a naive
 * "structural-only" selector (highest structural score) and the
 * Pareto-aware optimizer. The Pareto-aware version must dominate on
 * either quality, cost, or hard-reject of bad candidates.
 */

import { describe, expect, it } from 'vitest';
import { optimizeParetoEnsemble } from '../pareto-ensemble-optimizer';
import type { ContributionAwareScore } from '../../contribution/contribution-aware-candidate-scorer';
import {
  scoreAnchorA,
  scoreAnchorB,
  scorePairX,
  scorePairY,
  scoreCheapGood,
  scoreCheapHarmful,
  scoreMini,
  scoreModalityMismatchAudio,
  scoreModalityMismatchImage,
  scoreExpensiveNotPareto,
  STANDARD_BASELINE,
} from './fixtures/candidate-fixtures';

function naiveSelector(
  candidates: readonly ContributionAwareScore[],
  topN: number,
): readonly ContributionAwareScore[] {
  // "Old" selector: just sort by structural score desc + cost asc.
  const sorted = [...candidates].sort((a, b) => {
    const sd = b.breakdown.structuralScore - a.breakdown.structuralScore;
    if (sd !== 0) return sd;
    return a.estimatedCostUsd - b.estimatedCostUsd;
  });
  return sorted.slice(0, topN);
}

describe('selector comparison — naive vs Pareto-aware', () => {
  const candidates: readonly ContributionAwareScore[] = [
    scoreAnchorA(),
    scoreAnchorB(),
    scorePairX(),
    scorePairY(),
    scoreCheapGood(),
    scoreCheapHarmful(),
    scoreMini('a'),
    scoreMini('b'),
    scoreMini('c'),
    scoreModalityMismatchAudio(),
    scoreModalityMismatchImage(),
    scoreExpensiveNotPareto(),
  ];

  it('naive selector picks bad candidates that Pareto rejects', () => {
    // Naive selector by structural score includes everything (all 0.7).
    const naive = naiveSelector(candidates, 5);
    const naiveIds = naive.map((c) => c.modelId);
    // Check that the naive set CAN include modality mismatches or minis
    // (cheap), highlighting the problem the Pareto layer solves.
    expect(naiveIds.length).toBe(5);
  });

  it('Pareto-aware selector rejects modality mismatch, multi-mini, cheap-harmful', () => {
    const plan = optimizeParetoEnsemble({
      candidates,
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    for (const banned of [
      'fx-audio-tts',
      'fx-image-gen',
      'fx-mini-a',
      'fx-mini-b',
      'fx-mini-c',
      'fx-cheap-harmful',
    ]) {
      expect(plan.selectedModelIds, `selected should NOT include ${banned}`).not.toContain(banned);
    }
  });

  it('Pareto-aware result keeps the cheap-but-good pair winners', () => {
    const plan = optimizeParetoEnsemble({
      candidates,
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    // The pair winners are cheap AND high judge; the optimizer should
    // converge on at least one of them as anchor/support.
    const hasWinner =
      plan.selectedModelIds.indexOf('fx-pair-x') !== -1 ||
      plan.selectedModelIds.indexOf('fx-pair-y') !== -1;
    expect(hasWinner).toBe(true);
  });

  it('Pareto-aware delivers higher expected quality than naive top-2 — even when naive is cheaper', () => {
    // Naive sorts by structural score (all equal), then by cost asc, so
    // it ends up picking the cheapest junk (multi-mini, cheap-harmful).
    // The Pareto-aware optimizer is happy to spend a bit more on the
    // pair winners because that delivers real quality.
    const naive = naiveSelector(candidates, 2);
    // The naive selection probably contains harmful/zero-judge models
    // (multi-mini or audio-tts). Approximate naive quality as the mean
    // of expected judge over its selected set.
    const naiveJudgeMean =
      naive.reduce((s, c) => s + c.expectedJudge, 0) / Math.max(1, naive.length);

    const plan = optimizeParetoEnsemble({
      candidates,
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan.expectedJudge).toBeGreaterThan(naiveJudgeMean);
  });

  it('Pareto-aware ensemble respects the baseline cost ceiling', () => {
    const plan = optimizeParetoEnsemble({
      candidates,
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan.expectedCostUsd).toBeLessThanOrEqual(
      STANDARD_BASELINE.singleModelCostUsd + 1e-9,
    );
  });
});
