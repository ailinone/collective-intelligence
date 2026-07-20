// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tool-calling objective grader (capability #4).
 *
 * PURE — no I/O, no DB, no network — so the "a model that calls the tool scores
 * 1, one that answers blind scores 0" guarantee is unit-testable deterministically
 * (tool-calling-grading.test.ts) without a live server.
 *
 * Two independent objective signals, OR'd so a tool task is scorable regardless
 * of whether the server executed the agentic loop:
 *   • answer_check — the FINAL answer (extracted from the `FINAL:` line) matches
 *     the task's declarative checker. This is the PRIMARY signal for this repo,
 *     because the server DOES run the loop (base-strategy.executeModelWithTools):
 *     it consumes the tool_calls and returns the model's final grounded answer.
 *     Since the tools return FICTIONAL data, this number is only reachable by
 *     actually calling the tool → blind answers fail.
 *   • tool_call — the response still carries `message.tool_calls` matching the
 *     expected function name + args. This fires only when a path returns the raw
 *     call WITHOUT the loop consuming it; it's the "grade the request" fallback.
 */

import { resolveAnswerChecker, type AnswerCheckSpec } from '@/core/orchestration/verification/answer-check-resolver';
import { extractFinalAnswer } from '@/core/orchestration/verification/best-of-n-verifier';
import type { ExperimentTask } from './experiment-types';

/** Minimal structural view of a response tool_call (OpenAI shape). */
export interface ObservedToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ToolGradeResult {
  /** 1 if either objective signal passed, else 0. */
  objectiveScore: number;
  /** null when the task has no answerCheck. */
  answerMatched: boolean | null;
  /** null when the task has no expectTool. */
  toolMatched: boolean | null;
  /** Which signal(s) were available/decisive. */
  method: 'answer_check' | 'tool_call' | 'both' | 'none';
  /** The extracted FINAL answer used for answer_check (for auditability). */
  finalAnswer: string;
}

/** A task is a tool-calling task if it offers tools or declares an expected call. */
export function isToolCallingTask(task: ExperimentTask): boolean {
  return !!(task.expectTool || (task.tools && task.tools.length > 0));
}

function looseValueMatch(expected: string | number | boolean, actual: unknown): boolean {
  const e = String(expected).trim().toLowerCase();
  if (actual === undefined || actual === null) return false;
  const a = String(actual).trim().toLowerCase();
  return a === e || a.includes(e);
}

/**
 * True if some observed tool_call matches the expected function name and every
 * key in `argsMatch` (loose, case-insensitive substring on the parsed args).
 * Argument JSON that fails to parse is treated as {} (name-only match still works).
 */
export function matchToolCall(
  observed: ReadonlyArray<ObservedToolCall> | undefined,
  expect: NonNullable<ExperimentTask['expectTool']>,
): boolean {
  if (!observed || observed.length === 0) return false;
  const wantName = expect.name.trim().toLowerCase();
  for (const call of observed) {
    const name = call.function?.name?.trim().toLowerCase();
    if (name !== wantName) continue;
    if (!expect.argsMatch) return true; // name-only match
    let args: Record<string, unknown> = {};
    const raw = call.function?.arguments;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // unparseable args → only name matched; fall through to arg check (fails)
      }
    }
    const allMatch = Object.entries(expect.argsMatch).every(([k, v]) => looseValueMatch(v, args[k]));
    if (allMatch) return true;
  }
  return false;
}

/**
 * Grade a tool-calling task's response objectively. Returns objectiveScore ∈ {0,1}.
 */
export function gradeToolCallingResponse(
  task: ExperimentTask,
  resp: { content: string; toolCalls?: ReadonlyArray<ObservedToolCall> },
): ToolGradeResult {
  const content = resp.content ?? '';
  // Mirrors the FINAL-scope path of experiment-runner.gradeObjectiveAnswer
  // (canonical extractFinalAnswer), so a tool task's answer is extracted and
  // checked by the same instrument as every other verifiable task. Inlined
  // rather than imported to avoid a runner→grader→runner cycle. Tool tasks are
  // final-scope by construction (a short FINAL line, never a large artifact),
  // so the 'full'-scope truncation/completeness gates there do not apply here.
  const finalAnswer =
    task.answerCheckScope === 'full' ? content : (extractFinalAnswer(content) ?? content);

  let answerMatched: boolean | null = null;
  if (task.answerCheck) {
    const checker = resolveAnswerChecker(task.answerCheck as AnswerCheckSpec);
    answerMatched = checker ? checker(finalAnswer) : null;
  }

  let toolMatched: boolean | null = null;
  if (task.expectTool) {
    toolMatched = matchToolCall(resp.toolCalls, task.expectTool);
  }

  const passed = answerMatched === true || toolMatched === true;

  let method: ToolGradeResult['method'] = 'none';
  if (answerMatched !== null && toolMatched !== null) method = 'both';
  else if (answerMatched !== null) method = 'answer_check';
  else if (toolMatched !== null) method = 'tool_call';

  return { objectiveScore: passed ? 1 : 0, answerMatched, toolMatched, method, finalAnswer };
}
