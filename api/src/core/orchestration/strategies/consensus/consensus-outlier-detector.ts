// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * consensus-outlier-detector — pure function.
 *
 * Given a per-voter EvaluationResult plus the execution success flag,
 * decide whether the voter should be excluded from BOTH synthesis input
 * AND the best-individual comparison.
 *
 * The detector is structural-first: it never relies on a quality score
 * alone. A voter that fails the executor, returns empty, or fails
 * an explicit structural check is an outlier regardless of evaluator
 * mode. The score-threshold gate fires ONLY when the evaluator emits
 * a numeric score (i.e., `mock`, `task_specific`, `llm_judge`,
 * `composite`, or `heuristic_test_only`).
 *
 * This keeps the strategy correct under `unavailable` and `structural`
 * evaluators: outlier filtering still works on objective signals; the
 * score-threshold simply doesn't apply.
 */
import type { EvaluationResult } from '../evaluation/strategy-output-evaluator';

export const SCORE_OUTLIER_THRESHOLD = 0.2;

export interface OutlierDetectionInput {
  readonly executionFailed: boolean;
  readonly evaluation: EvaluationResult;
  readonly modelId: string;
}

export interface OutlierDetectionResult {
  readonly outlier: boolean;
  readonly outlierReason?: string;
}

export function detectOutlier(input: OutlierDetectionInput): OutlierDetectionResult {
  if (input.executionFailed) {
    return { outlier: true, outlierReason: 'execution_failed' };
  }
  const s = input.evaluation.structural;
  if (s.executionError) {
    return { outlier: true, outlierReason: 'execution_error_flagged' };
  }
  if (!s.nonEmpty) {
    return { outlier: true, outlierReason: 'empty_output' };
  }
  if (!s.meetsMinLength) {
    return { outlier: true, outlierReason: 'output_too_short' };
  }
  if (s.jsonValid === false) {
    return { outlier: true, outlierReason: 'invalid_json' };
  }
  if (s.codeBlockPresent === false) {
    return { outlier: true, outlierReason: 'missing_code_block' };
  }
  if (input.evaluation.verdict === 'fail') {
    return { outlier: true, outlierReason: 'evaluator_fail_verdict' };
  }
  if (
    input.evaluation.score !== undefined &&
    input.evaluation.score < SCORE_OUTLIER_THRESHOLD
  ) {
    return { outlier: true, outlierReason: 'score_below_threshold' };
  }
  return { outlier: false };
}
