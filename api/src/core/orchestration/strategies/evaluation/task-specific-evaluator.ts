// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * TaskSpecificEvaluator
 *
 * Objective evaluator for tasks where pass/fail can be decided structurally
 * or via injectable runners (compile / test / lint / JSON-schema). Never
 * emits a "high score because the output looks like code" — that would
 * replicate the heuristic anti-pattern. If no objective evidence is
 * available, the result is `verdict='uncertain'` and `score=undefined`,
 * with `validationStatus='structurally_validated_only'`.
 *
 * Supported task kinds (inferred from `task.expectedFormat` or `task.taskType`):
 *   - code-generation
 *   - json
 *   - plain_text
 *   - unknown
 *
 * Objective signals (when present in `task`):
 *   - jsonSchema       — for `json`, executes a minimal required-keys check
 *   - codeRunner       — for `code-generation`, evaluator-provided async hook
 *                        that returns objective pass/fail (test/compile/lint)
 *
 * Without an objective signal, the evaluator emits structural verdicts only
 * and `validationStatus = 'structurally_validated_only'`. The strategy will
 * therefore mark the synthesis-vs-best comparison as `comparable: false`
 * for this output.
 */
import {
  type EvaluationResult,
  type EvaluatorInput,
  type StrategyEvaluationTask,
  type StrategyOutputEvaluator,
  type StructuralChecks,
  type ValidationStatus,
} from './strategy-output-evaluator';

export type TaskKind = 'code-generation' | 'json' | 'plain_text' | 'unknown';

/**
 * Optional injectable code runner. When provided, TaskSpecific can emit
 * a `fully_validated` verdict for code-generation. Without it, code
 * outputs stay `structurally_validated_only`.
 *
 * Implementations MUST be deterministic and side-effect-free in tests.
 */
export interface CodeRunner {
  run(input: {
    readonly code: string;
    readonly language?: string;
    readonly task: StrategyEvaluationTask;
  }): Promise<{
    /** 0..1 if there is a numeric basis (e.g., pass ratio); undefined otherwise. */
    readonly score: number | undefined;
    readonly verdict: 'pass' | 'fail' | 'uncertain';
    readonly notes?: string;
  }>;
}

export interface TaskSpecificEvaluatorOptions {
  /** Optional async runner. When absent, code is evaluated structurally only. */
  readonly codeRunner?: CodeRunner;
  /** Default minimum text length for plain_text outputs. */
  readonly defaultMinLength?: number;
}

export class TaskSpecificEvaluator implements StrategyOutputEvaluator {
  readonly mode = 'task_specific' as const;
  readonly id = 'task-specific-v1';

  constructor(private readonly opts: TaskSpecificEvaluatorOptions = {}) {}

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    const executionError = input.executionFailed === true;
    const text = input.output ?? '';
    const trimmed = text.trim();
    const nonEmpty = trimmed.length > 0;

    if (executionError) {
      return this.result({
        verdict: 'fail',
        score: 0,
        structural: { nonEmpty, meetsMinLength: false, executionError: true },
        notes: 'execution failed',
        validationStatus: 'fully_validated',
      });
    }

    if (!nonEmpty) {
      return this.result({
        verdict: 'fail',
        score: 0,
        structural: { nonEmpty: false, meetsMinLength: false, executionError: false },
        notes: 'empty output',
        validationStatus: 'fully_validated',
      });
    }

    const kind = inferTaskKind(input.task);

    switch (kind) {
      case 'code-generation':
        return this.evaluateCode(input, trimmed);
      case 'json':
        return this.evaluateJson(input, trimmed);
      case 'plain_text':
        return this.evaluatePlainText(input, trimmed);
      case 'unknown':
      default:
        return this.evaluateUnknown(input, trimmed);
    }
  }

  // ─── code-generation ────────────────────────────────────────────────

  private async evaluateCode(
    input: EvaluatorInput,
    trimmed: string,
  ): Promise<EvaluationResult> {
    const hasCodeBlock = /```[\s\S]*?```/.test(trimmed);

    // Hard rule: if the task explicitly asks for code, missing fence → fail.
    if (input.task.expectedFormat === 'code' && !hasCodeBlock) {
      return this.result({
        verdict: 'fail',
        score: 0,
        structural: {
          nonEmpty: true,
          meetsMinLength: trimmed.length >= 50,
          executionError: false,
          codeBlockPresent: false,
        },
        notes: 'expected code block but none found',
        validationStatus: 'fully_validated',
      });
    }

    // Objective signal (injected runner) wins when available.
    if (this.opts.codeRunner) {
      const extracted = extractCode(trimmed);
      const r = await this.opts.codeRunner.run({
        code: extracted,
        language: input.task.codeLanguage,
        task: input.task,
      });
      return this.result({
        verdict: r.verdict,
        score: r.score,
        structural: {
          nonEmpty: true,
          meetsMinLength: trimmed.length >= 50,
          executionError: false,
          codeBlockPresent: hasCodeBlock,
        },
        notes: r.notes ?? 'code runner evidence',
        validationStatus: r.score !== undefined ? 'fully_validated' : 'structurally_validated_only',
      });
    }

    // No runner — STRUCTURAL ONLY. Critical rule: don't reward appearance.
    return this.result({
      verdict: 'uncertain',
      score: undefined,
      structural: {
        nonEmpty: true,
        meetsMinLength: trimmed.length >= 50,
        executionError: false,
        codeBlockPresent: hasCodeBlock,
      },
      notes: 'code structure present but no objective check (compile/test/lint) available — staying structural-only',
      validationStatus: 'structurally_validated_only',
    });
  }

  // ─── json ──────────────────────────────────────────────────────────

  private async evaluateJson(
    input: EvaluatorInput,
    trimmed: string,
  ): Promise<EvaluationResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return this.result({
        verdict: 'fail',
        score: 0,
        structural: {
          nonEmpty: true,
          meetsMinLength: trimmed.length >= 50,
          executionError: false,
          jsonValid: false,
        },
        notes: 'invalid JSON',
        validationStatus: 'fully_validated',
      });
    }

    if (input.task.jsonSchema !== undefined) {
      const ok = matchesMinimalSchema(parsed, input.task.jsonSchema);
      return this.result({
        verdict: ok ? 'pass' : 'fail',
        score: ok ? 0.9 : 0,
        structural: {
          nonEmpty: true,
          meetsMinLength: trimmed.length >= 50,
          executionError: false,
          jsonValid: true,
          schemaValid: ok,
        },
        notes: ok ? 'JSON valid + matches schema' : 'JSON valid but schema mismatch',
        validationStatus: 'fully_validated',
      });
    }

    // Valid JSON with no schema → structural pass only.
    return this.result({
      verdict: 'pass',
      score: undefined,
      structural: {
        nonEmpty: true,
        meetsMinLength: trimmed.length >= 50,
        executionError: false,
        jsonValid: true,
      },
      notes: 'JSON valid; no schema provided — staying structural-only',
      validationStatus: 'structurally_validated_only',
    });
  }

  // ─── plain_text ────────────────────────────────────────────────────

  private async evaluatePlainText(
    _input: EvaluatorInput,
    trimmed: string,
  ): Promise<EvaluationResult> {
    const minLength = this.opts.defaultMinLength ?? 50;
    const meets = trimmed.length >= minLength;
    return this.result({
      verdict: meets ? 'uncertain' : 'fail',
      score: undefined,
      structural: {
        nonEmpty: true,
        meetsMinLength: meets,
        executionError: false,
      },
      notes: meets
        ? 'plain_text has no objective rubric — staying structural-only'
        : `plain_text below min length ${minLength}`,
      validationStatus: 'structurally_validated_only',
    });
  }

  // ─── unknown ───────────────────────────────────────────────────────

  private async evaluateUnknown(
    _input: EvaluatorInput,
    trimmed: string,
  ): Promise<EvaluationResult> {
    const minLength = this.opts.defaultMinLength ?? 50;
    const meets = trimmed.length >= minLength;
    return this.result({
      verdict: meets ? 'uncertain' : 'fail',
      score: undefined,
      structural: {
        nonEmpty: true,
        meetsMinLength: meets,
        executionError: false,
      },
      notes: 'unknown task kind — structural verdict only',
      validationStatus: 'structurally_validated_only',
    });
  }

  // ─── helper ────────────────────────────────────────────────────────

  private result(parts: {
    readonly verdict: 'pass' | 'fail' | 'uncertain';
    readonly score: number | undefined;
    readonly structural: StructuralChecks;
    readonly notes?: string;
    readonly validationStatus?: ValidationStatus;
  }): EvaluationResult {
    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score: parts.score,
      verdict: parts.verdict,
      structural: parts.structural,
      notes: parts.notes,
      validationStatus: parts.validationStatus,
    };
  }
}

// ─── pure helpers (exported for unit tests) ────────────────────────────

export function inferTaskKind(task: StrategyEvaluationTask): TaskKind {
  const fmt = task.expectedFormat;
  if (fmt === 'json') return 'json';
  if (fmt === 'code') return 'code-generation';
  if (fmt === 'free_text') return 'plain_text';
  const tt = (task.taskType ?? '').toLowerCase();
  if (tt.indexOf('json') !== -1) return 'json';
  if (tt.indexOf('code') !== -1) return 'code-generation';
  if (tt.indexOf('chat') !== -1 || tt.indexOf('text') !== -1 || tt.indexOf('analysis') !== -1) {
    return 'plain_text';
  }
  return 'unknown';
}

/**
 * Extract code body from a fenced block. Returns the original string if
 * no fence is found (the runner gets to decide what to do).
 */
export function extractCode(text: string): string {
  const m = text.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : text;
}

/**
 * Minimal JSON-schema check. Supports only:
 *   - schema.required: string[] — every key must be a property of parsed
 *   - schema.type: 'object' | 'array' | 'string' | 'number' | 'boolean'
 *
 * Anything else is treated as a permissive structural pass. Real schema
 * validation (Ajv / Zod) is intentionally deferred — adding a runtime
 * dep is out of scope. Operators wiring Composite can swap in a real
 * schema runner via task-context fields later.
 */
export function matchesMinimalSchema(parsed: unknown, schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return true;
  const s = schema as { type?: unknown; required?: unknown };
  if (s.type !== undefined) {
    const t = typeof s.type === 'string' ? s.type : '';
    if (t === 'object' && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
      return false;
    }
    if (t === 'array' && !Array.isArray(parsed)) return false;
    if (t === 'string' && typeof parsed !== 'string') return false;
    if (t === 'number' && typeof parsed !== 'number') return false;
    if (t === 'boolean' && typeof parsed !== 'boolean') return false;
  }
  if (Array.isArray(s.required) && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    for (const k of s.required) {
      if (typeof k !== 'string') continue;
      if (!(k in obj)) return false;
    }
  }
  return true;
}
