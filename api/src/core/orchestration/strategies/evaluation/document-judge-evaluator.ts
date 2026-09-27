// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DocumentJudgeEvaluator
 *
 * The document-critic sibling of `LLMJudgeEvaluator`. Text-only — no vision
 * dispatch, unlike `MediaJudgeEvaluator` — because a document critic judges
 * the PDF's extracted TEXT (with `[page N]` markers), never frames/images.
 * Same safety-gate order and timeout contract as `LLMJudgeEvaluator`; the
 * one addition is `issues`, a page-anchored list the judge is asked to
 * return alongside its score/verdict.
 *
 * If any gate fails, the evaluator returns `mode='llm_judge'`,
 * `validationStatus='unavailable'`, `score=undefined`, `issues=[]` — never
 * fabricated.
 */
import type {
  EvaluationResult,
  EvaluatorInput,
  StrategyOutputEvaluator,
} from './strategy-output-evaluator';
import type {
  DocumentCriticRole,
  DocumentJudgeClient,
  DocumentJudgeEvaluatorConfig,
  DocumentJudgeInput,
  DocumentJudgeRawResult,
} from './document-judge-evaluator.types';

export class DocumentJudgeEvaluator implements StrategyOutputEvaluator {
  readonly mode = 'llm_judge' as const;
  readonly id: string;
  private readonly criticRole: DocumentCriticRole;

  constructor(
    private readonly config: DocumentJudgeEvaluatorConfig,
    private readonly client?: DocumentJudgeClient
  ) {
    this.criticRole = config.criticRole;
    this.id = `document-judge-${this.criticRole}-${config.rubricVersion}`;
  }

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    // ─── Safety gates (same order as LLMJudgeEvaluator) ──────────────────
    if (!this.config.enabled) {
      return this.unavailable('document_judge_disabled');
    }
    const effectiveJudgeModelId =
      input.judgeModelOverride && input.judgeModelOverride.trim().length > 0
        ? input.judgeModelOverride.trim()
        : this.config.judgeModelId;
    if (!effectiveJudgeModelId || effectiveJudgeModelId.trim().length === 0) {
      return this.unavailable('judge_model_id_missing');
    }
    if (!Number.isFinite(this.config.maxCostUsd) || this.config.maxCostUsd <= 0) {
      return this.unavailable('budget_zero_or_invalid');
    }
    if (!this.client) {
      return this.unavailable('document_judge_client_unavailable');
    }

    const text = (input.output ?? '').trim();
    if (!text) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: 0,
        verdict: 'fail',
        structural: { nonEmpty: false, meetsMinLength: false, executionError: false },
        issues: [],
        notes: 'empty document text',
        validationStatus: 'fully_validated',
      };
    }

    const judgeInput: DocumentJudgeInput = {
      judgeModelId: effectiveJudgeModelId,
      rubricVersion: this.config.rubricVersion,
      criticRole: this.criticRole,
      task: {
        taskType: input.task.taskType,
        userMessageExcerpt: input.task.userMessageExcerpt,
        expectedFormat: input.task.expectedFormat,
      },
      documentText: text,
      role: input.role,
      maxCostUsd: this.config.maxCostUsd,
      timeoutMs: this.config.timeoutMs,
    };

    let raw: DocumentJudgeRawResult;
    try {
      raw = await withTimeout(this.client.judgeDocument(judgeInput), this.config.timeoutMs);
    } catch (err) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: undefined,
        verdict: 'uncertain',
        structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
        issues: [],
        notes: `document judge call failed: ${errorMessage(err)}`,
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
        issues: [],
        notes: 'document judge returned malformed result',
        validationStatus: 'unavailable',
      };
    }

    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score: clamp01(raw.score),
      verdict: raw.verdict,
      structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
      confidence: raw.confidence,
      judgeCostUsd: raw.costUsd ?? 0,
      issues: raw.issues,
      notes:
        `${raw.shortRationale ?? ''} (critic=${this.criticRole}, rubric=${this.config.rubricVersion}, judgeModel=${effectiveJudgeModelId})`.trim(),
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
      issues: [],
      notes: `Document judge unavailable: ${reason}`,
      validationStatus: 'unavailable',
    };
  }
}

function isValidRaw(r: unknown): r is DocumentJudgeRawResult {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as { score?: unknown; verdict?: unknown; issues?: unknown };
  if (typeof o.score !== 'number' || !Number.isFinite(o.score)) return false;
  if (o.score < 0 || o.score > 1) return false;
  if (o.verdict !== 'pass' && o.verdict !== 'fail' && o.verdict !== 'uncertain') return false;
  if (!Array.isArray(o.issues)) return false;
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
    timeoutId = setTimeout(() => reject(new Error(`document_judge_timeout_after_${ms}ms`)), ms);
  });
  return Promise.race([
    p.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeout,
  ]);
}
