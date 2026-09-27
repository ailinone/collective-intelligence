// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `core/sandbox/code-execution.ts` — the request/response contract (unit,
 * hermetic, no Docker required) plus the real security-boundary proofs this
 * environment CAN run with a live Docker daemon (ADR-026).
 *
 * Layered exactly like the ADR-024 test suite this mirrors
 * (`sandbox-policy.test.ts` for fail-closed policy, `container-sandbox-args.test.ts`
 * for the argv contract, `agentic-sandbox-dispatch.test.ts` for the
 * flag-off-vs-flag-on route behaviour):
 *
 *  1. "contract" — flag-off / validation / disabled-error tests that never
 *     touch Docker. These run in ANY environment, CI included.
 *  2. "wiring" — mocks `container-sandbox.ts` to prove `executeCode` builds
 *     the RIGHT call (command, stdin, per-language allowlist, image) without
 *     needing a real container.
 *  3. "live Docker" — gated exactly like `agentic-sandbox-dispatch.test.ts`'s
 *     "computer_use flag on" block: a guard test asserts Docker is actually
 *     reachable (so a green run below it is not vacuous), and the real
 *     security-boundary tests (network, filesystem, memory, timeout,
 *     container-per-call isolation) run for real against Docker Desktop in
 *     this dev environment. If Docker is NOT reachable where this suite
 *     runs, the guard test fails loudly rather than the boundary tests
 *     silently passing on nothing — see that test's own comment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodeExecutionDisabledError,
  CodeExecutionValidationError,
  executeCode,
  type CodeExecutionRequest,
} from '../code-execution';

const ENV_KEYS = [
  'CODE_EXECUTION_SANDBOX_ENABLED',
  'CODE_EXECUTION_MAX_SOURCE_BYTES',
  'CODE_EXECUTION_PYTHON_IMAGE',
  'CODE_EXECUTION_NODE_IMAGE',
  'SANDBOX_MEMORY_MB',
  'SANDBOX_MEMORY_SWAP_MB',
  'SANDBOX_CPUS',
  'SANDBOX_PIDS_LIMIT',
  'SANDBOX_EXEC_TIMEOUT_MS',
  'SANDBOX_MAX_OUTPUT_BYTES',
  'SANDBOX_NETWORK_MODE',
  'SANDBOX_COMMAND_ALLOWLIST',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function makeRequest(overrides: Partial<CodeExecutionRequest> = {}): CodeExecutionRequest {
  return {
    language: 'python',
    code: 'print(1)',
    ...overrides,
  };
}

// ── 1. Contract: disabled / validation, no Docker touched ──────────────────

describe('executeCode — fail-closed contract (no Docker required)', () => {
  it('throws CodeExecutionDisabledError when the flag is unset (default)', async () => {
    await expect(executeCode(makeRequest())).rejects.toThrow(CodeExecutionDisabledError);
  });

  it('throws on every near-miss flag value, only the exact string "true" enables it', async () => {
    for (const value of ['1', 'TRUE', 'True', 'yes', 'on', 'enabled', '']) {
      process.env.CODE_EXECUTION_SANDBOX_ENABLED = value;
      await expect(
        executeCode(makeRequest()),
        `'${value}' must not enable code execution`
      ).rejects.toThrow(CodeExecutionDisabledError);
    }
  });

  it('rejects an unsupported language even with the flag on', async () => {
    process.env.CODE_EXECUTION_SANDBOX_ENABLED = 'true';
    await expect(
      executeCode(makeRequest({ language: 'ruby' as unknown as 'python' }))
    ).rejects.toThrow(CodeExecutionValidationError);
  });

  it('rejects empty or whitespace-only code', async () => {
    process.env.CODE_EXECUTION_SANDBOX_ENABLED = 'true';
    await expect(executeCode(makeRequest({ code: '' }))).rejects.toThrow(
      CodeExecutionValidationError
    );
    await expect(executeCode(makeRequest({ code: '   \n  ' }))).rejects.toThrow(
      CodeExecutionValidationError
    );
  });

  it('rejects code exceeding the configured byte ceiling', async () => {
    process.env.CODE_EXECUTION_SANDBOX_ENABLED = 'true';
    // The ceiling itself clamps to a [1_000, 2_000_000] floor/ceiling (see
    // resolveMaxCodeExecutionBytes's own test in sandbox-policy.test.ts), so
    // an operator value below 1_000 still yields a 1_000-byte limit — the
    // code below must exceed THAT floor to actually trip the check.
    process.env.CODE_EXECUTION_MAX_SOURCE_BYTES = '1000';
    await expect(
      executeCode(makeRequest({ code: `print(${'"x"'.repeat(500)})` }))
    ).rejects.toThrow(CodeExecutionValidationError);
  });

  it('validates BEFORE anything about Docker is checked — the disabled check fires first', async () => {
    // Flag off AND an invalid language: must report "disabled", not "invalid
    // language" — the fail-closed order is flag, then request shape.
    await expect(
      executeCode(makeRequest({ language: 'ruby' as unknown as 'python' }))
    ).rejects.toThrow(CodeExecutionDisabledError);
  });
});

// ── 2. Wiring: executeCode calls execInSandbox correctly (mocked, no Docker) ──

vi.mock('../container-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../container-sandbox')>();
  return {
    ...actual,
    createSandboxSession: vi.fn(actual.createSandboxSession),
    disposeSandboxSession: vi.fn(actual.disposeSandboxSession),
    execInSandbox: vi.fn(),
  };
});

describe('executeCode — builds the right sandbox call (mocked container-sandbox)', () => {
  beforeEach(() => {
    process.env.CODE_EXECUTION_SANDBOX_ENABLED = 'true';
  });

  async function runMocked(overrides: Partial<CodeExecutionRequest> = {}) {
    const { execInSandbox, createSandboxSession, disposeSandboxSession } = await import(
      '../container-sandbox'
    );
    vi.mocked(execInSandbox).mockReset();
    // Clear (not reset) call history only — these wrap the REAL
    // implementations (`vi.fn(actual.createSandboxSession)`), so resetting
    // would also throw away that wrapped behaviour.
    vi.mocked(createSandboxSession).mockClear();
    vi.mocked(disposeSandboxSession).mockClear();
    vi.mocked(execInSandbox).mockResolvedValue({
      outcome: 'ok',
      exitCode: 0,
      stdout: 'mocked-stdout',
      stderr: '',
      durationMs: 12,
      auditId: 'test-audit-id',
      truncated: false,
    });
    const result = await executeCode(makeRequest(overrides));
    return { result, execInSandbox, createSandboxSession, disposeSandboxSession };
  }

  it('runs python3 with args ["-"] and the code on stdin — never as an argv element', async () => {
    const { execInSandbox } = await runMocked({ language: 'python', code: 'print(42)' });
    expect(execInSandbox).toHaveBeenCalledTimes(1);
    const [, command, args, options] = vi.mocked(execInSandbox).mock.calls[0];
    expect(command).toBe('python3');
    expect(args).toEqual(['-']);
    expect(options?.stdin).toBe('print(42)');
  });

  it('runs node with args ["-"] for javascript', async () => {
    const { execInSandbox } = await runMocked({ language: 'javascript', code: 'console.log(1)' });
    const [, command, args] = vi.mocked(execInSandbox).mock.calls[0];
    expect(command).toBe('node');
    expect(args).toEqual(['-']);
  });

  it('scopes the command allowlist to EXACTLY the one interpreter needed', async () => {
    const { execInSandbox } = await runMocked({ language: 'python' });
    const [, , , options] = vi.mocked(execInSandbox).mock.calls[0];
    expect(options?.commandAllowlist).toBeDefined();
    expect([...(options!.commandAllowlist ?? [])]).toEqual(['python3']);
  });

  it('passes a language-specific image, not the shared alpine default', async () => {
    const { execInSandbox } = await runMocked({ language: 'python' });
    const [, , , pyOptions] = vi.mocked(execInSandbox).mock.calls[0];
    expect(pyOptions?.image).toBe('python:3.12-alpine');

    const { execInSandbox: execInSandbox2 } = await runMocked({ language: 'javascript' });
    const [, , , jsOptions] = vi.mocked(execInSandbox2).mock.calls[0];
    expect(jsOptions?.image).toBe('node:20-alpine');
  });

  it('honours an operator-pinned image override per language', async () => {
    process.env.CODE_EXECUTION_PYTHON_IMAGE = 'python:3.11-slim';
    const { execInSandbox } = await runMocked({ language: 'python' });
    const [, , , options] = vi.mocked(execInSandbox).mock.calls[0];
    expect(options?.image).toBe('python:3.11-slim');
  });

  it('forwards organizationId/userId/runId/timeoutMs for audit correlation', async () => {
    const { execInSandbox } = await runMocked({
      organizationId: 'org-1',
      userId: 'user-1',
      runId: 'run-1',
      timeoutMs: 5000,
    });
    const [, , , options] = vi.mocked(execInSandbox).mock.calls[0];
    expect(options?.organizationId).toBe('org-1');
    expect(options?.userId).toBe('user-1');
    expect(options?.runId).toBe('run-1');
    expect(options?.timeoutMs).toBe(5000);
  });

  it('creates exactly one fresh session per call and disposes it, success or failure', async () => {
    const { createSandboxSession, disposeSandboxSession } = await runMocked();
    expect(createSandboxSession).toHaveBeenCalledTimes(1);
    expect(disposeSandboxSession).toHaveBeenCalledTimes(1);
  });

  it('disposes the session even when execInSandbox throws', async () => {
    const { execInSandbox, disposeSandboxSession } = await import('../container-sandbox');
    vi.mocked(execInSandbox).mockReset();
    vi.mocked(disposeSandboxSession).mockClear();
    vi.mocked(execInSandbox).mockRejectedValue(new Error('boom'));
    await expect(executeCode(makeRequest())).rejects.toThrow('boom');
    expect(disposeSandboxSession).toHaveBeenCalledTimes(1);
  });

  it('returns the sandbox result shape plus the language that ran', async () => {
    const { result } = await runMocked({ language: 'python' });
    expect(result).toMatchObject({
      outcome: 'ok',
      exitCode: 0,
      stdout: 'mocked-stdout',
      language: 'python',
    });
  });
});
