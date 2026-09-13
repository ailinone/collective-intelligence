// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression coverage for the 2026-09-08 fix to buildExecutionSystemPrompt()
 * (execution-system-prompt.ts).
 *
 * Prior behavior: the function returned `null` ENTIRELY — dropping identity,
 * behavioral guardrails, AND the system-capability manifest, not just the
 * manifest — whenever `request.messages` already contained ANY system
 * message. That is the common case for:
 *   - OpenAI-compatible agentic clients (Cursor, Zed, Cline, Claude Code,
 *     Goose, ...) connecting to api.ailin.one/v1, which send their OWN
 *     system prompt.
 *   - The platform's own internal multi-stage triage pipeline
 *     (orchestration-engine.ts's executeMultiStagePlan()), which unshifts a
 *     raw `{ role: 'system', content: 'Task context: ...' }` message onto a
 *     stage's request before executing it.
 * In both cases the executing model reverted to its own training priors —
 * exactly the hallucination ("I ran your code and got...") / false-denial
 * ("I can't generate images") failure modes this whole prompt exists to
 * prevent.
 *
 * This file is distinct from system-capability-manifest.test.ts, which only
 * pins the inner `shouldIncludeSystemCapabilityManifest()` latency gate
 * (preferSpeed / max_tokens<=320) — a narrow, INTENTIONAL exclusion that
 * must keep working exactly as before, independent of whether a system
 * message is present (case (c) below).
 *
 * Both call sites that actually use this return value
 * (orchestration-engine.ts's execute() ~L1780 and executeStream() ~L3500)
 * already prepend the result as a brand-new LEADING system message — never
 * merging into the caller's own one — and rely on
 * system-message-normalizer.ts's normalizeSystemMessages() to collapse
 * however many system messages end up on the request, in order, before any
 * provider adapter sees it. So asserting non-null + content here is a
 * faithful proxy for "the model actually receives this grounding".
 */
import { describe, expect, it } from 'vitest';
import { buildExecutionSystemPrompt } from '@/core/orchestration/execution-system-prompt';
import { BEHAVIORAL_GUARDRAILS_DIRECTIVE } from '@/core/orchestration/prompts/behavioral-guardrails';
import type { ChatRequest, OrchestrationContext } from '@/types';

function makeContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    requestId: 'test-req',
    models: [],
    taskType: 'general',
    contextSize: 0,
    ...overrides,
  } as OrchestrationContext;
}

function makeRequestNoSystem(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'Can you also generate an image of this?' }],
    ...overrides,
  } as ChatRequest;
}

function makeRequestWithSystem(
  systemContent: string,
  overrides: Partial<ChatRequest> = {}
): ChatRequest {
  return {
    model: 'auto',
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: 'Can you also generate an image of this?' },
    ],
    ...overrides,
  } as ChatRequest;
}

describe('buildExecutionSystemPrompt — (a) no pre-existing system message (baseline, unchanged)', () => {
  it('still returns full grounding — identity, guardrails, and the capability manifest', () => {
    const prompt = buildExecutionSystemPrompt(makeRequestNoSystem(), makeContext());
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('Ailin¹');
    expect(prompt).toContain(BEHAVIORAL_GUARDRAILS_DIRECTIVE);
    expect(prompt).toContain('SYSTEM CAPABILITY AWARENESS');
  });
});

describe('buildExecutionSystemPrompt — (b) pre-existing system message no longer zeroes out grounding', () => {
  it('grounds a request whose system message simulates an agentic-IDE client (Cursor/Zed/Cline/Claude Code)', () => {
    const agenticSystemMessage =
      'You are Cline, an autonomous coding agent integrated into VS Code with file system and terminal tools.';
    const prompt = buildExecutionSystemPrompt(
      makeRequestWithSystem(agenticSystemMessage),
      makeContext()
    );
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('Ailin¹');
    expect(prompt).toContain(BEHAVIORAL_GUARDRAILS_DIRECTIVE);
    expect(prompt).toContain('SYSTEM CAPABILITY AWARENESS');
  });

  it('grounds a request whose system message simulates the internal triage stage-context injection', () => {
    // Mirrors executeMultiStagePlan()'s stageMessages.unshift({ role: 'system',
    // content: `Task context: ${stage.taskContext}` }) in orchestration-engine.ts.
    const prompt = buildExecutionSystemPrompt(
      makeRequestWithSystem('Task context: Focus on the checkout flow regression.'),
      makeContext()
    );
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('Ailin¹');
    expect(prompt).toContain(BEHAVIORAL_GUARDRAILS_DIRECTIVE);
    expect(prompt).toContain('SYSTEM CAPABILITY AWARENESS');
  });

  it('does not simply echo the caller-supplied system content back — it adds NEW grounding content', () => {
    const callerSystem = 'You are a helpful pirate-themed assistant. Speak like a pirate.';
    const prompt = buildExecutionSystemPrompt(makeRequestWithSystem(callerSystem), makeContext());
    // The builder never sees/copies the caller's own system text (that lives in a
    // separate message merged downstream by normalizeSystemMessages()) — it only
    // contributes the platform's own grounding sections.
    expect(prompt).not.toContain(callerSystem);
    expect(prompt).toContain('Ailin¹');
  });
});

describe('buildExecutionSystemPrompt — (c) the narrow preferSpeed/max_tokens gate is untouched by (b)', () => {
  it('still skips ONLY the manifest section when context.preferSpeed is true, system message present', () => {
    const prompt = buildExecutionSystemPrompt(
      makeRequestWithSystem('custom system'),
      makeContext({ preferSpeed: true })
    );
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('Ailin¹');
    expect(prompt).toContain(BEHAVIORAL_GUARDRAILS_DIRECTIVE);
    expect(prompt).not.toContain('SYSTEM CAPABILITY AWARENESS');
  });

  it('still skips ONLY the manifest section when max_tokens<=320, system message present', () => {
    const prompt = buildExecutionSystemPrompt(
      makeRequestWithSystem('custom system', { max_tokens: 200 }),
      makeContext()
    );
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('Ailin¹');
    expect(prompt).not.toContain('SYSTEM CAPABILITY AWARENESS');
  });

  it('still includes the manifest above the max_tokens ceiling, system message present', () => {
    const prompt = buildExecutionSystemPrompt(
      makeRequestWithSystem('custom system', { max_tokens: 4096 }),
      makeContext()
    );
    expect(prompt).toContain('SYSTEM CAPABILITY AWARENESS');
  });

  it('still skips ONLY the manifest section when preferSpeed is true and NO system message is present (baseline gate unaffected)', () => {
    const prompt = buildExecutionSystemPrompt(
      makeRequestNoSystem(),
      makeContext({ preferSpeed: true })
    );
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('Ailin¹');
    expect(prompt).not.toContain('SYSTEM CAPABILITY AWARENESS');
  });
});
