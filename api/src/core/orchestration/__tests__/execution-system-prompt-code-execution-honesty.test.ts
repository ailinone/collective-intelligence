// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test reproducing the exact production incident (2026-09): a
 * chat request — "Execute este codigo Python em sandbox e me mostre o
 * resultado real: print(sum(range(1, 101)))" — got a single garbage letter
 * ("y") as its entire response instead of the correct answer (5050).
 *
 * No pipeline reachable from the plain chat path can actually run arbitrary
 * user code (see code-execution-honesty.ts's doc comment for the full
 * writeup). The fix injects an honesty directive whenever the user's last
 * turn shows genuine execution intent (`detectCodeExecutionIntent`), telling
 * the model to reason the answer out and say so plainly instead of faking a
 * tool call or emitting a bare fragment.
 */
import { describe, expect, it } from 'vitest';
import { buildExecutionSystemPrompt } from '@/core/orchestration/execution-system-prompt';
import { CODE_EXECUTION_HONESTY_DIRECTIVE } from '@/core/orchestration/prompts/code-execution-honesty';
import type { ChatRequest, OrchestrationContext } from '@/types';

function buildContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    requestId: 'req-1',
    models: [],
    ...overrides,
  } as OrchestrationContext;
}

function buildRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'ailin-economy',
    messages: [{ role: 'user', content: 'oi' }],
    ...overrides,
  } as ChatRequest;
}

describe('execution system prompt — code-execution honesty directive', () => {
  it('injects the honesty directive for the exact reproduced incident text', () => {
    const request = buildRequest({
      messages: [
        {
          role: 'user',
          content:
            'Execute este codigo Python em sandbox e me mostre o resultado real: print(sum(range(1, 101)))',
        },
      ],
    });
    const prompt = buildExecutionSystemPrompt(request, buildContext());
    expect(prompt).toContain(CODE_EXECUTION_HONESTY_DIRECTIVE);
  });

  it('injects the directive for an equivalent English execution request', () => {
    const request = buildRequest({
      messages: [{ role: 'user', content: 'Run this code and show me the real output' }],
    });
    const prompt = buildExecutionSystemPrompt(request, buildContext());
    expect(prompt).toContain(CODE_EXECUTION_HONESTY_DIRECTIVE);
  });

  it('does NOT inject the directive for an ordinary coding question', () => {
    const request = buildRequest({
      messages: [{ role: 'user', content: 'Can you help me debug my python function?' }],
    });
    const prompt = buildExecutionSystemPrompt(request, buildContext());
    expect(prompt).not.toContain(CODE_EXECUTION_HONESTY_DIRECTIVE);
  });

  it('does NOT inject the directive for an unrelated greeting', () => {
    const prompt = buildExecutionSystemPrompt(buildRequest(), buildContext());
    expect(prompt).not.toContain(CODE_EXECUTION_HONESTY_DIRECTIVE);
  });

  it('checks only the LAST user turn (mirrors the streaming media gate contract)', () => {
    const request = buildRequest({
      messages: [
        { role: 'user', content: 'Execute this code and run it for me' },
        { role: 'assistant', content: 'Sure — here is the computed result: 42.' },
        { role: 'user', content: 'thanks, and what is the weather like today?' },
      ],
    });
    const prompt = buildExecutionSystemPrompt(request, buildContext());
    expect(prompt).not.toContain(CODE_EXECUTION_HONESTY_DIRECTIVE);
  });

  it('the directive tells the model to reason the answer out and never emit a bare fragment', () => {
    expect(CODE_EXECUTION_HONESTY_DIRECTIVE.toLowerCase()).toContain('single letter');
    expect(CODE_EXECUTION_HONESTY_DIRECTIVE.toLowerCase()).toContain('step by step');
    expect(CODE_EXECUTION_HONESTY_DIRECTIVE).not.toMatch(/i (ran|executed) (it|the code)/i);
  });

  it('STILL injects the honesty directive when the caller supplied a system message (2026-09-08 fix: this used to return null entirely)', () => {
    const request = buildRequest({
      messages: [
        { role: 'system', content: 'custom system' },
        { role: 'user', content: 'Execute este código em sandbox e me mostre o resultado' },
      ],
    });
    const prompt = buildExecutionSystemPrompt(request, buildContext());
    expect(prompt).not.toBeNull();
    expect(prompt).toContain(CODE_EXECUTION_HONESTY_DIRECTIVE);
  });
});
