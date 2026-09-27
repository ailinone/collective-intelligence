// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ADR-026 — the flag-ON counterpart to
 * `execution-system-prompt-code-execution-honesty.test.ts` (which pins the
 * flag-OFF, default, current-production behaviour and is UNCHANGED by this
 * ADR). This file proves three things about the new branch in
 * `buildExecutionSystemPrompt`:
 *
 *   1. Flag off (default): identical to before ADR-026, even if
 *      `context.codeExecutionResult` were somehow populated — the flag gates
 *      the branch, not just the result's presence.
 *   2. Flag on + a result present: the REAL result is reported, the honesty
 *      directive is NOT injected.
 *   3. Flag on + NO result present (extraction failed, execution errored,
 *      unsupported language, or the pre-step was simply never invoked): falls
 *      back to the exact same honesty directive as the flag-off path — never
 *      silence, never a fabricated claim.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildExecutionSystemPrompt } from '@/core/orchestration/execution-system-prompt';
import { CODE_EXECUTION_HONESTY_DIRECTIVE } from '@/core/orchestration/prompts/code-execution-honesty';
import type { CodeExecutionResult } from '@/core/sandbox/code-execution';
import type { ChatRequest, OrchestrationContext } from '@/types';

const savedFlag: { value: string | undefined } = { value: undefined };

beforeEach(() => {
  savedFlag.value = process.env.CODE_EXECUTION_SANDBOX_ENABLED;
  delete process.env.CODE_EXECUTION_SANDBOX_ENABLED;
});

afterEach(() => {
  if (savedFlag.value === undefined) delete process.env.CODE_EXECUTION_SANDBOX_ENABLED;
  else process.env.CODE_EXECUTION_SANDBOX_ENABLED = savedFlag.value;
});

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
    messages: [
      {
        role: 'user',
        content: 'Execute este codigo Python em sandbox e me mostre o resultado real: print(sum(range(1, 101)))',
      },
    ],
    ...overrides,
  } as ChatRequest;
}

const okResult: CodeExecutionResult = {
  outcome: 'ok',
  exitCode: 0,
  stdout: '5050\n',
  stderr: '',
  durationMs: 120,
  auditId: 'test-audit',
  truncated: false,
  language: 'python',
};

describe('execution-system-prompt — flag OFF (default): unchanged even if a result is present', () => {
  it('still injects the honesty directive, ignoring any stray codeExecutionResult', () => {
    const prompt = buildExecutionSystemPrompt(
      buildRequest(),
      buildContext({ codeExecutionResult: okResult })
    );
    expect(prompt).toContain(CODE_EXECUTION_HONESTY_DIRECTIVE);
    expect(prompt).not.toContain('the platform actually ran');
  });

  it('produces byte-for-byte the same prompt as before ADR-026 for the exact incident text', () => {
    const withResult = buildExecutionSystemPrompt(
      buildRequest(),
      buildContext({ codeExecutionResult: okResult })
    );
    const withoutResult = buildExecutionSystemPrompt(buildRequest(), buildContext());
    expect(withResult).toBe(withoutResult);
  });
});

describe('execution-system-prompt — flag ON with a real result: reports it, no honesty directive', () => {
  beforeEach(() => {
    process.env.CODE_EXECUTION_SANDBOX_ENABLED = 'true';
  });

  it('injects the real-result directive instead of the honesty directive', () => {
    const prompt = buildExecutionSystemPrompt(
      buildRequest(),
      buildContext({ codeExecutionResult: okResult })
    );
    expect(prompt).not.toContain(CODE_EXECUTION_HONESTY_DIRECTIVE);
    expect(prompt).toContain('the platform actually ran this python code');
    expect(prompt).toContain('5050');
    expect(prompt).toContain('exit code 0');
  });

  it('reports a failed/timed-out real attempt honestly, still without the no-sandbox-at-all directive', () => {
    const timedOut: CodeExecutionResult = {
      outcome: 'timeout',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 3000,
      auditId: 'test-audit-2',
      truncated: false,
      reason: 'Execution exceeded the 3000ms sandbox timeout and was killed',
      language: 'python',
    };
    const prompt = buildExecutionSystemPrompt(
      buildRequest(),
      buildContext({ codeExecutionResult: timedOut })
    );
    expect(prompt).not.toContain(CODE_EXECUTION_HONESTY_DIRECTIVE);
    expect(prompt).toContain('did NOT complete successfully');
    expect(prompt).toContain('timeout');
    expect(prompt.toLowerCase()).toContain('do not');
  });
});

describe('execution-system-prompt — flag ON but NO result: falls back to the honesty directive', () => {
  beforeEach(() => {
    process.env.CODE_EXECUTION_SANDBOX_ENABLED = 'true';
  });

  it('falls back exactly like the flag-off path when codeExecutionResult is absent', () => {
    const prompt = buildExecutionSystemPrompt(buildRequest(), buildContext());
    expect(prompt).toContain(CODE_EXECUTION_HONESTY_DIRECTIVE);
  });

  it('still does not inject anything for a request with no execution intent at all', () => {
    const prompt = buildExecutionSystemPrompt(
      buildRequest({ messages: [{ role: 'user', content: 'hello there' }] }),
      buildContext()
    );
    expect(prompt).not.toContain(CODE_EXECUTION_HONESTY_DIRECTIVE);
    expect(prompt).not.toContain('the platform actually ran');
  });
});
