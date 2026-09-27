// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `maybeExecuteDetectedCode` (ADR-026) — the pre-step orchestration-engine.ts
 * calls before building the execution system prompt. `core/sandbox/code-execution.ts`
 * is mocked here: this file is about WHEN the pre-step calls it and how it
 * populates (or deliberately leaves unset) `context.codeExecutionResult` —
 * not about the sandbox/Docker itself, which is proven for real in
 * `core/sandbox/__tests__/code-execution-adversarial.integration.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, OrchestrationContext } from '@/types';

const executeCodeMock = vi.fn();
vi.mock('@/core/sandbox/code-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/sandbox/code-execution')>();
  return { ...actual, executeCode: executeCodeMock };
});

const savedFlag: { value: string | undefined } = { value: undefined };

beforeEach(() => {
  savedFlag.value = process.env.CODE_EXECUTION_SANDBOX_ENABLED;
  delete process.env.CODE_EXECUTION_SANDBOX_ENABLED;
  executeCodeMock.mockReset();
});

afterEach(() => {
  if (savedFlag.value === undefined) delete process.env.CODE_EXECUTION_SANDBOX_ENABLED;
  else process.env.CODE_EXECUTION_SANDBOX_ENABLED = savedFlag.value;
});

function buildRequest(text: string): ChatRequest {
  return {
    model: 'ailin-economy',
    messages: [{ role: 'user', content: text }],
  } as ChatRequest;
}

function buildContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    requestId: 'req-1',
    models: [],
    ...overrides,
  } as OrchestrationContext;
}

describe('maybeExecuteDetectedCode — flag off (default): a total no-op', () => {
  it('never calls executeCode, never touches context, even with genuine intent + code', async () => {
    const { maybeExecuteDetectedCode } = await import('../code-execution-orchestration');
    const context = buildContext();
    await maybeExecuteDetectedCode(
      buildRequest('Execute este código:\n```python\nprint(1)\n```'),
      context
    );
    expect(executeCodeMock).not.toHaveBeenCalled();
    expect(context.codeExecutionResult).toBeUndefined();
  });
});

describe('maybeExecuteDetectedCode — flag on', () => {
  beforeEach(() => {
    process.env.CODE_EXECUTION_SANDBOX_ENABLED = 'true';
  });

  it('runs the detected code and populates context.codeExecutionResult', async () => {
    executeCodeMock.mockResolvedValue({
      outcome: 'ok',
      exitCode: 0,
      stdout: '1\n',
      stderr: '',
      durationMs: 5,
      auditId: 'a1',
      truncated: false,
      language: 'python',
    });
    const { maybeExecuteDetectedCode } = await import('../code-execution-orchestration');
    const context = buildContext();
    await maybeExecuteDetectedCode(
      buildRequest('Execute este código:\n```python\nprint(1)\n```'),
      context
    );
    expect(executeCodeMock).toHaveBeenCalledTimes(1);
    expect(executeCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'python',
        code: 'print(1)\n',
        organizationId: 'org-1',
        userId: 'user-1',
        runId: 'req-1',
      })
    );
    expect(context.codeExecutionResult).toMatchObject({ outcome: 'ok', stdout: '1\n' });
  });

  it('does nothing when there is no genuine execution intent', async () => {
    const { maybeExecuteDetectedCode } = await import('../code-execution-orchestration');
    const context = buildContext();
    await maybeExecuteDetectedCode(buildRequest('what is the weather today?'), context);
    expect(executeCodeMock).not.toHaveBeenCalled();
    expect(context.codeExecutionResult).toBeUndefined();
  });

  it('does nothing when intent is present but no supported fenced code block is found', async () => {
    const { maybeExecuteDetectedCode } = await import('../code-execution-orchestration');
    const context = buildContext();
    await maybeExecuteDetectedCode(buildRequest('Please execute this script for me'), context);
    expect(executeCodeMock).not.toHaveBeenCalled();
    expect(context.codeExecutionResult).toBeUndefined();
  });

  it('leaves context.codeExecutionResult unset (never throws) when the sandbox call fails', async () => {
    executeCodeMock.mockRejectedValue(new Error('SandboxUnavailableError: no Docker'));
    const { maybeExecuteDetectedCode } = await import('../code-execution-orchestration');
    const context = buildContext();
    await expect(
      maybeExecuteDetectedCode(
        buildRequest('Execute este código:\n```python\nprint(1)\n```'),
        context
      )
    ).resolves.toBeUndefined();
    expect(context.codeExecutionResult).toBeUndefined();
  });

  it('reads only the LAST user turn, matching the honesty-directive detector', async () => {
    const { maybeExecuteDetectedCode } = await import('../code-execution-orchestration');
    const context = buildContext();
    const request = {
      model: 'ailin-economy',
      messages: [
        { role: 'user', content: 'Execute este código:\n```python\nprint(1)\n```' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'thanks, what time is it?' },
      ],
    } as ChatRequest;
    await maybeExecuteDetectedCode(request, context);
    expect(executeCodeMock).not.toHaveBeenCalled();
  });
});
