// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ADR-026 orchestration hook — the pre-step `orchestration-engine.ts` calls,
 * immediately before `buildExecutionSystemPrompt`, to actually run a
 * detected code snippet when `CODE_EXECUTION_SANDBOX_ENABLED` is on.
 *
 * This is the seam between the heuristic layer (`capability-inference.ts`'s
 * `resolveExecutableCodeRequest`, which stays dependency-free by design) and
 * the real sandbox (`core/sandbox/code-execution.ts`). Kept as its own file,
 * not folded into either, so:
 *   - `capability-inference.ts` never has to import `core/sandbox/*`.
 *   - `execution-system-prompt.ts` stays a pure, synchronous prompt builder —
 *     it only ever READS `context.codeExecutionResult`, set here, never
 *     triggers execution itself. Making the prompt builder asynchronous
 *     would touch its ~15 existing call sites/tests; this hook keeps that
 *     surface completely unchanged.
 *
 * FAIL-CLOSED CONTRACT: every branch that does not end in a populated
 * `context.codeExecutionResult` is silent and cheap — it deliberately never
 * throws out of this function. `execution-system-prompt.ts` treats an unset
 * `codeExecutionResult` as "fall back to the honesty directive", which is
 * always a safe, correct answer, so a failure here degrades gracefully
 * instead of breaking the request.
 */
import { logger } from '@/utils/logger';
import type { ChatRequest, OrchestrationContext } from '@/types';
import { extractLastUserTurnText } from './execution-system-prompt';
import { resolveExecutableCodeRequest } from './capability-inference';
import { isCodeExecutionSandboxEnabled } from '@/core/sandbox/sandbox-policy';
import { executeCode } from '@/core/sandbox/code-execution';

const log = logger.child({ component: 'code-execution-orchestration' });

/**
 * Populate `context.codeExecutionResult` in place (mutation, matching this
 * module's existing idiom for context — e.g. `context.isCollectiveStrategy`
 * in `orchestration-engine.ts` — rather than returning a new object callers
 * would have to remember to reassign) when, and only when:
 *
 *   1. `CODE_EXECUTION_SANDBOX_ENABLED === 'true'`.
 *   2. The last user turn shows genuine "run this and show me the real
 *      result" intent (`capability-inference.ts`'s `detectCodeExecutionIntent`).
 *   3. A fenced code block in a language the sandbox supports was found in
 *      that same turn (`extractExecutableCodeBlock`) — an untagged or
 *      unsupported-language fence yields no result, deliberately never a
 *      guess.
 *   4. The sandbox actually returned a terminal outcome. A thrown
 *      `SandboxUnavailableError` (no Docker reachable) or any other
 *      unexpected error is caught and logged here, NOT rethrown — this
 *      pre-step must never turn a sandbox/infra problem into a broken chat
 *      response when the honesty directive is right there as a safe answer.
 *
 * With the flag off (the default, and current production state) this
 * function does zero work beyond the single boolean check: no regex is run
 * against the user's text and the sandbox module is never called — the ONLY
 * code path that matters for "flag off behaves exactly as before ADR-026".
 */
export async function maybeExecuteDetectedCode(
  request: ChatRequest,
  context: OrchestrationContext
): Promise<void> {
  if (!isCodeExecutionSandboxEnabled()) return;

  const text = extractLastUserTurnText(request.messages);
  const detected = resolveExecutableCodeRequest(text);
  if (!detected) return;

  try {
    const result = await executeCode({
      language: detected.language,
      code: detected.code,
      organizationId: context.organizationId,
      userId: context.userId,
      runId: context.requestId,
    });
    context.codeExecutionResult = result;
    log.info(
      {
        requestId: context.requestId,
        language: result.language,
        outcome: result.outcome,
        durationMs: result.durationMs,
      },
      'code-execution-orchestration: real execution completed for this request'
    );
  } catch (err) {
    log.warn(
      {
        requestId: context.requestId,
        err: err instanceof Error ? err.message : String(err),
      },
      'code-execution-orchestration: execution attempt failed; falling back to the honesty directive'
    );
  }
}
