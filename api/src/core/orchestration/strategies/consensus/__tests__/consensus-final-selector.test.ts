// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the consensus final-selection contract after the 2026-06-30 change that
 * REDUCED the fallback-to-best-individual: the synthesis (the collective's actual
 * product) is now kept unless it is worse than the best individual by MORE than
 * SYNTHESIS_FALLBACK_MARGIN (~0.05). The old `delta < 0` rule discarded the
 * collective on a statistical tie and capped the system at the best individual.
 */
import { describe, it, expect } from 'vitest';
import { selectFinal } from '../consensus-final-selector';
import type { EvaluationResult } from '../../evaluation/strategy-output-evaluator';

const evalOf = (score: number): EvaluationResult =>
  ({ verdict: 'pass', score } as unknown as EvaluationResult);

describe('consensus-final-selector — reduced fallback (2026-06-30)', () => {
  it('KEEPS synthesis when it slightly underperforms within the margin (near-tie)', () => {
    // synthesis 0.85 vs best individual 0.88 → delta -0.03, within 0.05 margin.
    const r = selectFinal({
      synthesisAvailable: true,
      synthesisEvaluation: evalOf(0.85),
      bestIndividualScore: 0.88,
      bestIndividualModelId: 'm1',
    });
    expect(r.source).toBe('synthesis');
    expect(r.fallbackTriggered).toBe(false);
  });

  it('FALLS BACK when synthesis is clearly worse (beyond the margin)', () => {
    // synthesis 0.70 vs best 0.88 → delta -0.18, well past the margin.
    const r = selectFinal({
      synthesisAvailable: true,
      synthesisEvaluation: evalOf(0.70),
      bestIndividualScore: 0.88,
      bestIndividualModelId: 'm1',
    });
    expect(r.source).toBe('best_individual');
    expect(r.fallbackTriggered).toBe(true);
    expect(r.fallbackReason).toBe('synthesis_underperformed_best_individual');
  });

  it('KEEPS synthesis when it wins outright', () => {
    const r = selectFinal({
      synthesisAvailable: true,
      synthesisEvaluation: evalOf(0.93),
      bestIndividualScore: 0.85,
      bestIndividualModelId: 'm1',
    });
    expect(r.source).toBe('synthesis');
    expect(r.fallbackTriggered).toBe(false);
    expect(r.deltaVsBestIndividual).toBeCloseTo(0.08, 5);
  });

  it('still falls back when synthesis is unavailable / failed', () => {
    expect(selectFinal({ synthesisAvailable: false, bestIndividualScore: 0.8, bestIndividualModelId: 'm1' }).source).toBe('best_individual');
    expect(selectFinal({
      synthesisAvailable: true,
      synthesisEvaluation: { verdict: 'fail' } as unknown as EvaluationResult,
      bestIndividualScore: 0.8,
      bestIndividualModelId: 'm1',
    }).source).toBe('best_individual');
  });
});
