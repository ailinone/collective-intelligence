// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LLMJudgeEvaluator
 *
 * Safe adapter for a rubric-based LLM judge. By default, this evaluator
 * REFUSES to call any provider — every safety gate must pass before a
 * real client can be invoked. Tests inject a mock client; production
 * wiring must:
 *   - set `enabled: true`
 *   - set a non-empty `judgeModelId`
 *   - set `maxCostUsd > 0`
 *   - inject a concrete `LLMJudgeClient` that itself respects budget +
 *     timeout
 *
 * If any gate fails, the evaluator returns `mode='llm_judge'`,
 * `validationStatus='unavailable'`, and `score=undefined` so callers
 * know the judge did NOT run.
 */
import type {
  EvaluationResult,
  EvaluatorInput,
  StrategyOutputEvaluator,
} from './strategy-output-evaluator';
import type {
  LLMJudgeClient,
  LLMJudgeEvaluatorConfig,
  LLMJudgeInput,
  LLMJudgeRawResult,
} from './llm-judge-evaluator.types';

export class LLMJudgeEvaluator implements StrategyOutputEvaluator {
  readonly mode = 'llm_judge' as const;
  readonly id: string;

  constructor(
    private readonly config: LLMJudgeEvaluatorConfig,
    private readonly client?: LLMJudgeClient,
  ) {
    this.id = `llm-judge-${config.rubricVersion}`;
  }

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    // Strategy 01C.0.1 — per-call judge override takes precedence over
    // the static config.judgeModelId. The plan-driven path passes the
    // model id selected by ModelRoleResolver here; legacy callers omit
    // it and fall back to env config.
    const effectiveJudgeModelId =
      input.judgeModelOverride && input.judgeModelOverride.trim().length > 0
        ? input.judgeModelOverride.trim()
        : this.config.judgeModelId;

    // ─── Safety gates (in order) ────────────────────────────────────
    if (!this.config.enabled) {
      return this.unavailable('llm_judge_disabled');
    }
    if (!effectiveJudgeModelId || effectiveJudgeModelId.trim().length === 0) {
      return this.unavailable('judge_model_id_missing');
    }
    if (!Number.isFinite(this.config.maxCostUsd) || this.config.maxCostUsd <= 0) {
      return this.unavailable('budget_zero_or_invalid');
    }
    if (!this.client) {
      return this.unavailable('judge_client_unavailable');
    }

    const executionError = input.executionFailed === true;
    const text = (input.output ?? '').trim();
    const nonEmpty = text.length > 0;

    if (executionError || !nonEmpty) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: 0,
        verdict: 'fail',
        structural: {
          nonEmpty,
          meetsMinLength: false,
          executionError,
        },
        notes: executionError ? 'execution failed before judge' : 'empty output',
        validationStatus: 'fully_validated',
      };
    }

    const judgeInput: LLMJudgeInput = {
      judgeModelId: effectiveJudgeModelId,
      rubricVersion: this.config.rubricVersion,
      task: {
        taskType: input.task.taskType,
        userMessageExcerpt: input.task.userMessageExcerpt,
        expectedFormat: input.task.expectedFormat,
      },
      output: text,
      role: input.role,
      maxCostUsd: this.config.maxCostUsd,
      timeoutMs: this.config.timeoutMs,
    };

    let raw: LLMJudgeRawResult;
    try {
      raw = await withTimeout(this.client.judge(judgeInput), this.config.timeoutMs);
    } catch (err) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: undefined,
        verdict: 'uncertain',
        structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
        notes: `judge call failed: ${errorMessage(err)}`,
        validationStatus: 'unavailable',
      };
    }

    if (!isValidRaw(raw)) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: undefined,
        verdict: 'uncertain',
        structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
        notes: 'judge returned malformed result',
        validationStatus: 'unavailable',
      };
    }

    const judgeSource =
      input.judgeModelOverride && input.judgeModelOverride.trim().length > 0
        ? 'dynamic_role_resolver'
        : 'env_fallback';
    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score: clamp01(raw.score),
      verdict: raw.verdict,
      structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
      confidence: raw.confidence,
      // Cost-accounting integrity: carry the judge's billable cost forward so
      // consumers can fold it into the request total instead of dropping it.
      judgeCostUsd: raw.costUsd ?? 0,
      notes: `${raw.shortRationale ?? ''} (rubric=${this.config.rubricVersion}, judgeModel=${effectiveJudgeModelId}, judgeSource=${judgeSource})`.trim(),
      validationStatus: 'fully_validated',
      subScores: raw.subScores
        ? {
            taskCorrectness: raw.subScores.correctness,
            rubricJudge: raw.subScores.reasoningQuality,
            safetyFormat: raw.subScores.safety,
          }
        : undefined,
    };
  }

  private unavailable(reason: string): EvaluationResult {
    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score: undefined,
      verdict: 'uncertain',
      structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
      notes: `LLM judge unavailable: ${reason}`,
      validationStatus: 'unavailable',
    };
  }
}

// ─── pure helpers ─────────────────────────────────────────────────────

function isValidRaw(r: unknown): r is LLMJudgeRawResult {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as { score?: unknown; verdict?: unknown };
  if (typeof o.score !== 'number' || !Number.isFinite(o.score)) return false;
  if (o.score < 0 || o.score > 1) return false;
  if (o.verdict !== 'pass' && o.verdict !== 'fail' && o.verdict !== 'uncertain') return false;
  return true;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`judge_timeout_after_${ms}ms`)), ms);
  });
  return Promise.race([p.finally(() => { if (timeoutId) clearTimeout(timeoutId); }), timeout]);
}
