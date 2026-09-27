// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * System capability manifest — grounded platform-wide capability awareness
 * for the EXECUTING model, not just the triage brain.
 *
 * WHY THIS EXISTS: `triage-service.ts` already builds a full system-level
 * view (every strategy, every auto-recommendable tool, model roster) for the
 * routing LLM. The model that actually PRODUCES the user-visible answer gets
 * none of that — it only sees the user's messages, whatever `request.tools`
 * happened to be attached to THIS call, and whatever task-specific guidance
 * `execution-system-prompt.ts` injects. Asked directly ("can you generate an
 * image / run this past multiple models / execute this code for real?"), it
 * has nothing to go on but its own training priors, which produces exactly
 * one of two wrong answers: hallucinating a capability the platform doesn't
 * have, or flatly denying one it genuinely supports through a different
 * path than the one attached to this turn. This closes that gap at platform
 * scope, mirroring the fix `code-execution-honesty.ts` already made for the
 * single narrow code-execution case.
 *
 * GROUNDING — every claim below is verified against real, currently-live
 * code, not aspirational:
 *  - Image/video generation, text-to-speech/speech-to-text audio,
 *    translation, and structured file generation (csv/json/etc.) are real,
 *    live capabilities exposed through `CapabilityInvoker`
 *    (core/orchestration/capability-invoker.ts: `generateImage`,
 *    `generateVideo`, `synthesize`, `transcribe`, `translate`,
 *    `generateFile`) and the `generate_video`/`generate_media` tools
 *    (tool-registry.ts) — live today via the platform's own media-intent
 *    routing and media-generation strategies, independent of whether a
 *    specific tool happens to be attached to any one turn.
 *  - Multi-model collective strategies (consensus, debate, expert-panel,
 *    blind-debate, war-room, and others — see the strategy catalog in
 *    triage-service.ts) are real, selectable strategies; a request can ask
 *    for one explicitly (the `strategy` field) even when the current turn
 *    is running as a single model.
 *  - Whether there is a live, connected code-interpreter/sandbox that
 *    executes arbitrary user code depends on `CODE_EXECUTION_SANDBOX_ENABLED`
 *    (ADR-026, default off): OFF (the default, and current production state)
 *    — confirmed by `code-execution-honesty.ts`'s incident writeup — there is
 *    none; `run_command` and the dev-workflow tools (git/refactor/testing
 *    categories) operate on the server's own repo/filesystem for agentic
 *    coding tasks, neither is a general "run this snippet, return stdout"
 *    primitive for chat users. ON, `code-execution-orchestration.ts` actually
 *    runs a detected Python/JS snippet in the isolated Docker sandbox
 *    (`core/sandbox/code-execution.ts`) before this prompt is built, and
 *    `execution-system-prompt.ts` reports the REAL result instead of this
 *    manifest's honest-denial sentence for that one turn.
 *  - The tool CATEGORY list is derived live from `toolRegistry.listCategories()`
 *    (not a hardcoded name list), so it reflects reality even as tools are
 *    added, renamed, or removed.
 *
 * SCOPING: `shouldIncludeSystemCapabilityManifest()` gates this on the SAME
 * latency-sensitivity heuristic orchestration-engine.ts already uses for its
 * own quality/deliberation trade-offs (`prefer_speed`, or an explicit small
 * `max_tokens` cap) — a real proxy for "this is a trivial/cheap/low-latency
 * ping", not turn count. Turn count was deliberately rejected as the gate:
 * gating on "multi-turn only" would silently miss the most common real
 * scenario this feature exists for — a FIRST message asking "can you also
 * do X?" — which is exactly the case a turn-count gate would starve of the
 * very awareness it needs. A substantive first message (the overwhelming
 * majority of real traffic) gets this section; a token-capped or
 * speed-prioritized ping does not, keeping the tightest-budget requests
 * out of an already multi-section system prompt.
 */
import { toolRegistry } from '@/core/tools/tool-registry';
import { isCodeExecutionSandboxEnabled } from '@/core/sandbox/sandbox-policy';
import type { ChatRequest, OrchestrationContext } from '@/types';

/** Requests below this max_tokens cap are treated as latency-sensitive pings — mirrors
 *  orchestration-engine.ts's own `requestedMaxTokens <= 320` threshold for the same class
 *  of trade-off, so the two heuristics don't silently diverge over time. */
const LATENCY_SENSITIVE_MAX_TOKENS_CEILING = 320;

/**
 * Whether this request should receive the system-capability-manifest section.
 * See the module doc comment above for the scoping rationale.
 */
export function shouldIncludeSystemCapabilityManifest(
  request: ChatRequest,
  context: OrchestrationContext
): boolean {
  if (context.preferSpeed) return false;
  if (
    typeof request.max_tokens === 'number' &&
    request.max_tokens <= LATENCY_SENSITIVE_MAX_TOKENS_CEILING
  ) {
    return false;
  }
  return true;
}

/**
 * Builds the manifest text. Pure function of live, process-wide state — no
 * request/context parameters, since its content does not vary PER-REQUEST
 * (only whether it's included does, via `shouldIncludeSystemCapabilityManifest`).
 * `CODE_EXECUTION_SANDBOX_ENABLED` (ADR-026) is one such process-wide input:
 * a deployment-level flag, not a per-request one, so reading it here keeps
 * that invariant rather than breaking it.
 */
export function buildSystemCapabilityManifest(): string {
  const categories = toolRegistry.listCategories();
  const categoryNote =
    categories.length > 0
      ? ` Tool categories registered system-wide (a different turn may attach tools from any of these even when absent above): ${categories.join(', ')}.`
      : '';

  // ADR-026: this sentence must stay in lockstep with what
  // `code-execution-orchestration.ts` can actually do when the flag is on —
  // see that module and `core/sandbox/code-execution.ts`. With the flag off
  // (the default), the sentence is byte-for-byte what it was before ADR-026.
  const codeExecutionNote = isCodeExecutionSandboxEnabled()
    ? ' It DOES have a live, isolated code-execution sandbox (Python/JavaScript) for this ' +
      "conversation — when the user's message shows genuine \"run this and show me the real " +
      'output\" intent with a fenced code block in one of those languages, the platform runs it ' +
      "for real before you answer and gives you the actual result to report, rather than you " +
      'reasoning it out yourself.'
    : ' It does NOT have a live, connected code-interpreter/sandbox that executes arbitrary user ' +
      'code in this conversation today.';

  return (
    'SYSTEM CAPABILITY AWARENESS: beyond this turn\'s own tools, the platform can independently ' +
    'route requests to specialist pipelines for image/video generation, text-to-speech/' +
    'speech-to-text audio, translation, and structured file generation (csv/json/etc.), and can ' +
    're-run a request through multi-model collective strategies (consensus, debate, expert-panel, ' +
    'and others) on request or when the task warrants it, even when none of that is active on this ' +
    'call.' +
    categoryNote +
    codeExecutionNote +
    " If asked for something outside this turn's own tools, say so " +
    'honestly and point to what the platform can do a different way, instead of claiming you did ' +
    'something you did not or flatly denying a capability the system genuinely supports elsewhere.'
  );
}
