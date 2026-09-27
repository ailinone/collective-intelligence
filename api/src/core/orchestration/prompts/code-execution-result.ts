// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Real-execution-result directive (ADR-026) — the flag-ON counterpart to
 * `code-execution-honesty.ts`'s honesty directive.
 *
 * `code-execution-honesty.ts` exists because, with `CODE_EXECUTION_SANDBOX_ENABLED`
 * off (the default), there is genuinely no live sandbox to report a real
 * result from — the correct, honest behaviour is telling the model to reason
 * the answer out itself and say so. This file is what runs INSTEAD of that,
 * for the one case where the flag is on AND
 * `code-execution-orchestration.ts` actually got a result back from
 * `core/sandbox/code-execution.ts` before this prompt was built: the model
 * should report the REAL captured output, not reason about it, and
 * (symmetrically) must not pretend the run succeeded when it didn't.
 *
 * Both directives share the same non-negotiable: never let the model
 * silently fabricate an execution outcome. The honesty directive achieves
 * that by declaring no sandbox exists; this one achieves it by handing over
 * the actual, ground-truth result so there is nothing left to fabricate.
 */
import type { CodeExecutionResult } from '@/core/sandbox/code-execution';

/** Hard cap on how much sandbox stdout/stderr this directive will quote verbatim into the prompt. */
const MAX_QUOTED_OUTPUT_CHARS = 4_000;

function quote(text: string): string {
  if (text.length <= MAX_QUOTED_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_QUOTED_OUTPUT_CHARS)}\n… (truncated for the prompt; the sandbox already reported ${text.length} characters)`;
}

/**
 * Build the directive for one real execution result. Two shapes:
 *
 * - `outcome === 'ok'`: hand over the real stdout/stderr/exit code and
 *   instruct the model to report it verbatim, not recompute it.
 * - anything else (`timeout` | `error` | `oom` | `blocked`): the run was
 *   genuinely ATTEMPTED but did not succeed — say so plainly, with the
 *   reason, and forbid inventing a successful result. This is still strictly
 *   more honest than the no-sandbox-at-all directive, because the model now
 *   knows a real attempt happened and why it didn't produce output, rather
 *   than being left to guess.
 */
export function buildCodeExecutionResultDirective(result: CodeExecutionResult): string {
  const header = `CODE EXECUTION — the platform actually ran this ${result.language} code in an isolated, network-disabled Docker sandbox (no fabrication needed or permitted).`;

  if (result.outcome === 'ok') {
    const stdout = result.stdout.trim().length > 0 ? quote(result.stdout) : '(no stdout)';
    const stderr = result.stderr.trim().length > 0 ? `\nSTDERR:\n${quote(result.stderr)}` : '';
    const truncatedNote = result.truncated
      ? '\n(sandbox output was truncated at the configured size limit)'
      : '';
    return (
      `${header} It completed with exit code ${result.exitCode}. This is the REAL, ground-truth ` +
      `result — report it to the user accurately (quote the exact output where relevant); do not ` +
      `recompute it by reasoning, do not second-guess it, and do not alter it.\n\n` +
      `STDOUT:\n${stdout}${stderr}${truncatedNote}`
    );
  }

  // timeout | error | oom | blocked — a real attempt that did not succeed.
  const reason = result.reason ? ` Reason: ${result.reason}.` : '';
  return (
    `${header} The run did NOT complete successfully (outcome: ${result.outcome}).${reason} Tell ` +
    `the user plainly that execution was attempted and did not succeed, and why, if known. Do NOT ` +
    `fabricate a successful run, invented output, or a plausible-looking result — an honest report ` +
    `of the failure is the correct answer here.`
  );
}
