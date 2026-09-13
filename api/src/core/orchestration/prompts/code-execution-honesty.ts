// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Honesty directive for genuine "execute this code and show me the real
 * result" requests.
 *
 * Root cause this closes (production incident, 2026-09): no pipeline reached
 * from the plain chat path can actually run arbitrary user code in a sandbox
 * today. `CodeSandbox.testFunction()` (api/src/runtime/code-sandbox.ts) is a
 * HumanEval-style harness that requires a named function plus test cases —
 * used by the internal benchmark suite and the standalone `/v1/code/execute`
 * REST route — and no tool in `tool-registry.ts` offers a model a callable
 * "run this snippet, return stdout" primitive. `PR #444`'s Docker-sandbox
 * wiring for computer_use/agents/mcp remains flagged off, and even the
 * existing `LocalProcessSandbox` fallback spawns the target language's real
 * interpreter directly on the host with no container isolation — not safe to
 * expose to arbitrary chat input without that work landing first.
 *
 * Meanwhile `execution-system-prompt.ts`'s capability-awareness section can
 * tell the model "Available capabilities: tool_use, function_calling" purely
 * because the request text contains an execute-shaped verb (see
 * `capability-inference.ts`'s TOOL_USE_KEYWORDS) — with no real tool actually
 * attached to the request. A model primed that way, asked to "execute this
 * and show me the real result," has nothing honest to call and no instruction
 * for what to do instead — which is exactly the shape of the incident this
 * closes (a single garbage-letter response instead of the correct answer).
 *
 * This directive is injected (see execution-system-prompt.ts) only when
 * `capability-inference.ts`'s `detectCodeExecutionIntent()` fires on the last
 * user turn — narrow by design, see that function's doc comment. It does not
 * claim any tool exists; it tells the model to reason the answer out itself,
 * state it plainly, and be upfront that it did not run the code in a live
 * sandbox — a correct, honest answer instead of silent garbage.
 */
export const CODE_EXECUTION_HONESTY_DIRECTIVE =
  'CODE EXECUTION — you do NOT have a live, connected code-interpreter or sandbox tool in this ' +
  'conversation, even if "tool_use", "function_calling", "code_execution", or "code_generation" ' +
  'was mentioned above as an available capability. If the user asks you to execute, run, or ' +
  'compile code (in a sandbox or otherwise) and show the real/actual output: do NOT claim you ran ' +
  'it, do NOT fabricate a tool call or a fake execution trace, and do NOT answer with a bare code ' +
  'fragment, a single token, or a single letter. Instead, act as a careful interpreter yourself — ' +
  'work through the code step by step (track variable values, loop iterations, and function calls ' +
  'precisely), verify your arithmetic and logic, then state the exact final output/result in your ' +
  'answer. Be upfront, briefly, that you reasoned through the code rather than executing it in a ' +
  'live sandbox. Getting the computed result right matters more than anything else in this answer.';
