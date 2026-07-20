// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * consensus-final-selector — pure function.
 *
 * Given the synthesis evaluation, the best individual's (modelId, score),
 * and whether synthesis is available, decide:
 *   - source: 'synthesis' | 'best_individual'
 *   - fallbackTriggered: boolean
 *   - fallbackReason: textual
 *   - finalScore (when scores exist)
 *   - deltaVsBestIndividual (when scores exist)
 *   - comparable: were both sides scored on the same numeric basis?
 *
 * Decision rules (in order):
 *   1. synthesis unavailable (no run / threw) → fallback, comparable=false
 *      reason='synthesis_not_available'
 *   2. synthesis verdict === 'fail' → fallback, comparable=false
 *      reason='synthesis_failed_evaluator'
 *   3. either synthesisScore or bestIndividualScore is undefined →
 *      KEEP synthesis (structural pass), comparable=false
 *      reason='non_comparable_scores'
 *   4. synthesisScore < bestIndividualScore → fallback, comparable=true
 *      reason='synthesis_underperformed_best_individual'
 *   5. otherwise → synthesis, comparable=true
 *
 * Note rule #3: when the evaluator is `unavailable` or `structural`,
 * neither side has a quality score. We default to synthesis because
 * that is what the legacy strategy did and refusing to produce a
 * response is worse than producing an un-comparable one. The artifact
 * makes the lack of comparison explicit via `comparable: false`.
 */
import type { EvaluationResult } from '../evaluation/strategy-output-evaluator';

/**
 * Tolerance for keeping the synthesis over the best individual (2026-06-30).
 * The judge is noisy and the synthesized answer IS the collective's product —
 * falling back whenever synthesis is even 0.001 below the best individual discards
 * the collective on a statistical TIE and structurally caps the system at the best
 * individual's ceiling. Keep the synthesis unless it is worse by MORE than this
 * margin. Read once at module load so `selectFinal` stays a pure function.
 */
const SYNTHESIS_FALLBACK_MARGIN =
  Number(process.env.CONSENSUS_SYNTHESIS_FALLBACK_MARGIN) || 0.05;

export interface FinalSelectionInput {
  readonly synthesisAvailable: boolean;
  readonly synthesisEvaluation?: EvaluationResult;
  readonly bestIndividualScore: number | undefined;
  readonly bestIndividualModelId: string;
}

export interface FinalSelectionResult {
  /** `selectFinal` itself only ever returns 'synthesis' | 'best_individual';
   *  'verified_individual' and 'agreement_individual' are constructed by the
   *  consensus strategy when an objective `answerVerifier` or the pre-synthesis
   *  agreement gate overrides this judge-driven decision
   *  (see ../../verification/verified-selection.ts). */
  readonly source: 'synthesis' | 'best_individual' | 'verified_individual' | 'agreement_individual';
  readonly fallbackTriggered: boolean;
  readonly fallbackReason?: string;
  readonly finalScore?: number;
  readonly deltaVsBestIndividual?: number;
  readonly comparable: boolean;
}

export function selectFinal(input: FinalSelectionInput): FinalSelectionResult {
  if (!input.synthesisAvailable || !input.synthesisEvaluation) {
    return {
      source: 'best_individual',
      fallbackTriggered: true,
      fallbackReason: 'synthesis_not_available',
      finalScore: input.bestIndividualScore,
      comparable: false,
    };
  }

  if (input.synthesisEvaluation.verdict === 'fail') {
    return {
      source: 'best_individual',
      fallbackTriggered: true,
      fallbackReason: 'synthesis_failed_evaluator',
      finalScore: input.bestIndividualScore,
      comparable: false,
    };
  }

  const synthScore = input.synthesisEvaluation.score;
  const bestScore = input.bestIndividualScore;

  if (synthScore === undefined || bestScore === undefined) {
    // No comparable numbers. Keep synthesis (passed structural) but
    // record that the decision is not score-justified.
    return {
      source: 'synthesis',
      fallbackTriggered: false,
      fallbackReason: 'non_comparable_scores',
      finalScore: synthScore,
      comparable: false,
    };
  }

  const delta = synthScore - bestScore;
  if (delta < -SYNTHESIS_FALLBACK_MARGIN) {
    return {
      source: 'best_individual',
      fallbackTriggered: true,
      fallbackReason: 'synthesis_underperformed_best_individual',
      finalScore: bestScore,
      deltaVsBestIndividual: delta,
      comparable: true,
    };
  }

  return {
    source: 'synthesis',
    fallbackTriggered: false,
    finalScore: synthScore,
    deltaVsBestIndividual: delta,
    comparable: true,
  };
}
