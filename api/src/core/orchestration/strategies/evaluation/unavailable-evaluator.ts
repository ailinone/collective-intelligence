// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * UnavailableStrategyOutputEvaluator
 *
 * The production default when no real judge is configured. It deliberately
 * REFUSES to assign a quality score so consensus decisions cannot silently
 * be justified by a length-based heuristic. The strategy still gets a
 * structural verdict (empty / exec_failed) so failed voters can be
 * filtered out, but quality scoring is suppressed and the consensus
 * artifact records `validationStatus = 'unavailable'`.
 *
 * Operator contract:
 *   - When this evaluator is in play, the synthesis-vs-best-individual
 *     comparison cannot be made on numeric scores. The final selector
 *     keeps synthesis (assuming it passed structural checks) and the
 *     artifact's `finalSelection.comparable` is `false`.
 *   - Outlier detection is still useful: empty / failed executions are
 *     flagged as outliers and excluded from synthesis input.
 */
import type {
  EvaluationResult,
  EvaluatorInput,
  StrategyOutputEvaluator,
} from './strategy-output-evaluator';

export class UnavailableStrategyOutputEvaluator implements StrategyOutputEvaluator {
  readonly mode = 'unavailable' as const;
  readonly id = 'unavailable-default-v1';

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    const executionError = input.executionFailed === true;
    const text = input.output ?? '';
    const trimmed = text.trim();
    const nonEmpty = trimmed.length > 0;

    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score: undefined,
      verdict: executionError || !nonEmpty ? 'fail' : 'uncertain',
      structural: {
        nonEmpty,
        meetsMinLength: nonEmpty,
        executionError,
      },
      notes:
        'No real quality evaluator configured; structural verdict only. ' +
        'Strategy artifacts will record validationStatus = "unavailable".',
    };
  }
}
