// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CompositeEvaluator
 *
 * Combines `structural` + `task_specific` + `llm_judge` evaluators with
 * explicit precedence rules. Never invents a score: if no sub-evaluator
 * emits a numeric score, the composite's score is `undefined` too.
 *
 * Rules (in order):
 *   1. structural fail → bubble up immediately as `fail`, score=0
 *      (NOTE: structural fail short-circuits — there's no point asking
 *      the judge to evaluate something with no output / exec error).
 *   2. task_specific score wins when present (it's the most objective).
 *   3. llm_judge contributes only when its result is `fully_validated`.
 *      A blend uses `weights.taskSpecific` / `weights.llmJudge`.
 *   4. when neither task_specific nor llm_judge produces a comparable
 *      numeric score, composite emits `score: undefined` and
 *      `validationStatus = 'structurally_validated_only'` (or
 *      `'unavailable'` if structural didn't run either).
 *
 * Composite NEVER claims `fully_validated` purely from structural
 * evidence — the spec is explicit: structural can only block, not
 * promote.
 */
import type {
  EvaluationResult,
  EvaluatorInput,
  StrategyOutputEvaluator,
  ValidationStatus,
} from './strategy-output-evaluator';

export interface CompositeEvaluatorOptions {
  readonly structural?: StrategyOutputEvaluator;
  readonly taskSpecific?: StrategyOutputEvaluator;
  readonly llmJudge?: StrategyOutputEvaluator;
  readonly weights?: {
    readonly taskSpecific: number;
    readonly llmJudge: number;
  };
}

export class CompositeEvaluator implements StrategyOutputEvaluator {
  readonly mode = 'composite' as const;
  readonly id = 'composite-v1';

  constructor(private readonly opts: CompositeEvaluatorOptions = {}) {}

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    const subResults: Array<{ name: string; result: EvaluationResult }> = [];

    // ─── 1. structural gate ────────────────────────────────────────
    if (this.opts.structural) {
      const r = await this.opts.structural.evaluate(input);
      subResults.push({ name: 'structural', result: r });
      if (r.verdict === 'fail') {
        return {
          scoringMode: this.mode,
          evaluatorId: this.id,
          score: 0,
          verdict: 'fail',
          structural: r.structural,
          notes: 'composite: structural fail short-circuit',
          validationStatus: 'fully_validated',
          subResults,
          selectedScoreSource: 'structural',
        };
      }
    }

    // ─── 2. task_specific ──────────────────────────────────────────
    let taskScore: number | undefined;
    let taskValidation: ValidationStatus | undefined;
    let taskResult: EvaluationResult | undefined;
    if (this.opts.taskSpecific) {
      const r = await this.opts.taskSpecific.evaluate(input);
      subResults.push({ name: 'task_specific', result: r });
      taskResult = r;
      taskScore = r.score;
      taskValidation = r.validationStatus;
      if (r.verdict === 'fail') {
        return {
          scoringMode: this.mode,
          evaluatorId: this.id,
          score: r.score ?? 0,
          verdict: 'fail',
          structural: r.structural,
          notes: 'composite: task_specific fail',
          validationStatus: 'fully_validated',
          subResults,
          selectedScoreSource: 'task_specific',
        };
      }
    }

    // ─── 3. llm_judge ──────────────────────────────────────────────
    let judgeScore: number | undefined;
    let judgeFullyValidated = false;
    let judgeResult: EvaluationResult | undefined;
    if (this.opts.llmJudge) {
      const r = await this.opts.llmJudge.evaluate(input);
      subResults.push({ name: 'llm_judge', result: r });
      judgeResult = r;
      if (r.validationStatus === 'fully_validated' && typeof r.score === 'number') {
        judgeScore = r.score;
        judgeFullyValidated = true;
      }
    }

    // ─── 4. combine ────────────────────────────────────────────────
    const weights = this.opts.weights ?? { taskSpecific: 0.6, llmJudge: 0.4 };
    let score: number | undefined;
    let selectedScoreSource: string;
    let verdict: 'pass' | 'fail' | 'uncertain';
    let validationStatus: ValidationStatus;

    const taskFullyValidated = taskValidation === 'fully_validated' && typeof taskScore === 'number';

    if (taskFullyValidated && judgeFullyValidated) {
      score = clamp01(taskScore! * weights.taskSpecific + judgeScore! * weights.llmJudge);
      selectedScoreSource = 'weighted_task_judge';
      verdict = score >= 0.5 ? 'pass' : score >= 0.2 ? 'uncertain' : 'fail';
      validationStatus = 'fully_validated';
    } else if (taskFullyValidated) {
      score = taskScore;
      selectedScoreSource = 'task_specific';
      verdict = taskResult!.verdict;
      validationStatus = 'fully_validated';
    } else if (judgeFullyValidated) {
      score = judgeScore;
      selectedScoreSource = 'llm_judge';
      verdict = judgeResult!.verdict;
      validationStatus = 'fully_validated';
    } else {
      // No comparable numeric score from any axis. Composite stays
      // structural-only. NEVER promotes structural to fully_validated.
      score = undefined;
      selectedScoreSource = 'none';
      verdict = taskResult?.verdict ?? 'uncertain';
      validationStatus = this.opts.structural || this.opts.taskSpecific
        ? 'structurally_validated_only'
        : 'unavailable';
    }

    // Aggregate structural facts from the strongest signal we have.
    const baseStructural = taskResult?.structural
      ?? judgeResult?.structural
      ?? subResults[0]?.result.structural
      ?? { nonEmpty: true, meetsMinLength: true, executionError: false };

    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score,
      verdict,
      structural: baseStructural,
      notes: `composite: ${selectedScoreSource}`,
      validationStatus,
      subResults,
      selectedScoreSource,
    };
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
