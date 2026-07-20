// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MockStrategyOutputEvaluator
 *
 * Test-only. Returns deterministic results from a per-model-id score
 * map plus a synthesis override. Used by ConsensusStrategy unit tests
 * to exercise the orchestration pipeline without invoking a real
 * evaluator.
 *
 * When this evaluator is active the consensus artifact records
 * `validationStatus = 'fully_validated'` — the test is asserting the
 * strategy's reaction to the injected scores, so they ARE the source
 * of truth for that test.
 */
import type {
  EvaluationResult,
  EvaluationVerdict,
  EvaluatorInput,
  StrategyOutputEvaluator,
} from './strategy-output-evaluator';

export interface MockEvaluatorOptions {
  /** Per-voter scores keyed by `modelId`. Synthesis is identified
   *  by `role === 'synthesis'` or absence of `modelId`. */
  readonly byModelId?: Record<string, number>;
  readonly synthesis?: number;
  readonly fallback?: number;
  /** Override verdict derivation. Default: score >= 0.20 → 'pass'. */
  readonly verdictByScore?: (score: number) => EvaluationVerdict;
  /** Optional per-call hook so tests can fail synthesis specifically. */
  readonly synthesisVerdict?: EvaluationVerdict;
}

export class MockStrategyOutputEvaluator implements StrategyOutputEvaluator {
  readonly mode = 'mock' as const;
  readonly id = 'mock-evaluator-v1';

  constructor(private readonly opts: MockEvaluatorOptions = {}) {}

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    const isSynthesis = input.role === 'synthesis' || input.modelId === undefined;
    const text = (input.output ?? '').trim();
    const nonEmpty = text.length > 0;
    const executionError = input.executionFailed === true;

    let score: number;
    if (isSynthesis) {
      score = this.opts.synthesis ?? this.opts.fallback ?? 0.5;
    } else if (input.modelId !== undefined && this.opts.byModelId?.[input.modelId] !== undefined) {
      score = this.opts.byModelId[input.modelId]!;
    } else {
      score = this.opts.fallback ?? 0.5;
    }

    let verdict: EvaluationVerdict;
    if (executionError) {
      verdict = 'fail';
    } else if (isSynthesis && this.opts.synthesisVerdict) {
      verdict = this.opts.synthesisVerdict;
    } else if (this.opts.verdictByScore) {
      verdict = this.opts.verdictByScore(score);
    } else {
      verdict = score >= 0.2 ? 'pass' : 'fail';
    }

    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score,
      verdict,
      structural: {
        nonEmpty,
        meetsMinLength: text.length >= 50,
        executionError,
      },
      notes: 'mock evaluator — test-injected scores',
    };
  }
}
