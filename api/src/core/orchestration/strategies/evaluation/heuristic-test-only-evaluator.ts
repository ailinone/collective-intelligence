// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HeuristicTestOnlyEvaluator
 *
 * EXPLICITLY test-only. Length-bracket + format-marker arithmetic
 * — measures shape, NOT quality. Never use as a production default.
 *
 * Kept available so tests that need a "produces-a-number" evaluator
 * without an explicit mock can still operate, AND so the legacy
 * scoring math has a typed home. When this evaluator is active the
 * consensus artifact records `validationStatus = 'structurally_validated_only'`.
 *
 * If you find yourself reaching for this in production code: stop.
 * Inject a real LLM-judge / task-specific evaluator instead.
 */
import type {
  EvaluationResult,
  EvaluatorInput,
  StrategyOutputEvaluator,
} from './strategy-output-evaluator';

export class HeuristicTestOnlyEvaluator implements StrategyOutputEvaluator {
  readonly mode = 'heuristic_test_only' as const;
  readonly id = 'heuristic-test-only-v1';

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    const executionError = input.executionFailed === true;
    const out = input.output ?? '';
    const trimmed = out.trim();
    const len = trimmed.length;

    if (len === 0) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: 0,
        verdict: 'fail',
        structural: { nonEmpty: false, meetsMinLength: false, executionError },
        notes: 'heuristic-test-only — NOT real quality scoring',
      };
    }
    if (len < 50) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: 0.1,
        verdict: 'fail',
        structural: { nonEmpty: true, meetsMinLength: false, executionError },
        notes: 'heuristic-test-only — NOT real quality scoring',
      };
    }

    let score = 0.3;
    if (len >= 50) score += 0.1;
    if (len >= 200) score += 0.1;
    if (len >= 500) score += 0.1;
    if (len >= 1000) score += 0.05;

    const taskType = (input.task.taskType ?? '').toLowerCase();
    if (taskType.indexOf('code') !== -1 && trimmed.indexOf('```') !== -1) score += 0.1;
    if (taskType.indexOf('json') !== -1 && trimmed.charAt(0) === '{') score += 0.1;
    if (taskType.indexOf('reasoning') !== -1 && len >= 300) score += 0.05;
    if (score > 1) score = 1;
    if (score < 0) score = 0;

    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score,
      verdict: score >= 0.2 ? 'pass' : 'fail',
      structural: {
        nonEmpty: true,
        meetsMinLength: true,
        executionError,
      },
      notes: 'heuristic-test-only — NOT real quality scoring',
    };
  }
}
