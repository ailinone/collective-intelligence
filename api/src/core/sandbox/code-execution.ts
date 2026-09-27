// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Real, sandboxed code execution for the `code_interpreter` capability
 * (`code_execution` in the ontology's aliases — see `capability-ontology.ts`)
 * — ADR-026.
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * `code_interpreter` has, until now, had exactly one live execution path:
 * `CodeExecutionService` → `getCodeSandbox()` → `MultiBackendSandbox`, which
 * tries `e2b` → `daytona` → `local` in order. Whenever neither E2B nor
 * Daytona is configured — the default — that resolves to `LocalProcessSandbox`,
 * documented in ADR-024 as `child_process.spawn` **on the API host**,
 * inheriting the full `process.env` (every provider key, `JWT_SECRET`,
 * `DATABASE_URL`), with no memory limit and no network restriction. ADR-024
 * explicitly named migrating `code_interpreter` onto the container sandbox as
 * a deliberate, NOT-yet-taken follow-up ("Deliberately out of scope" #2).
 * This module is that follow-up.
 *
 * Separately, the plain chat path never had ANY execution pipeline at all — a
 * request like "execute this code and show me the real output" got a fixed
 * honesty directive (`execution-system-prompt.ts`,
 * `capability-inference.ts`'s `detectCodeExecutionIntent`) telling the model
 * to reason the answer out itself, precisely BECAUSE no real tool existed.
 * That fallback stays the default; this module is what makes the
 * `CODE_EXECUTION_SANDBOX_ENABLED` flag able to make it true.
 *
 * WHY THIS REUSES `container-sandbox.ts` RATHER THAN A SECOND SANDBOX
 * ---------------------------------------------------------------------
 * `container-sandbox.ts` already provides everything a security review would
 * otherwise have to re-audit from scratch: `--network none`, `--read-only`,
 * `--cap-drop ALL`, a non-root user, memory/cpu/pids/output/wall-clock
 * limits, no Docker-socket mount, no fallback to a host process
 * (`SandboxUnavailableError` instead), and a structured audit trail. Building
 * a second Docker wrapper for code execution would duplicate that surface and
 * give it its own, independently-reviewable (and independently-breakable)
 * copy of the same isolation flags. This module is a thin, purpose-specific
 * caller of that shared primitive, not a parallel implementation of it.
 *
 * TWO DELIBERATE DIFFERENCES FROM computer_use/agents/mcp'S USE OF THE SAME SANDBOX
 * -----------------------------------------------------------------------------------
 * 1. **The program travels over stdin, never argv or a mounted file.**
 *    `container-sandbox.ts`'s command allowlist for computer_use deliberately
 *    excludes every interpreter and shell — "any interpreter that trivially
 *    re-implements them" would make the allowlist decorative for THAT
 *    surface. Code execution's entire purpose is to run an interpreter, so it
 *    cannot use that same default allowlist without weakening computer_use's
 *    contract. Instead: (a) `execInSandbox` accepts a per-call
 *    `commandAllowlist` override (`SandboxExecOptions.commandAllowlist`) so
 *    this module can allow exactly `python3`/`node` for exactly this one
 *    exec, without touching the shared default; (b) the program is piped to
 *    the container's stdin (`python3 -` / `node -` both read their program
 *    from stdin) rather than passed as an argv element or written to the
 *    `/workspace` bind mount. Two reasons: `assertArgAllowed` caps a single
 *    argv element at 4096 bytes, far too small for real code, and — more
 *    importantly — `container-sandbox.ts`'s own docs record an UNRESOLVED
 *    host-process-fs-vs-Docker-daemon-fs split on this project's actual CI
 *    runner topology (see `ensureScopeWritable`'s doc in `container-sandbox.ts`):
 *    a file this API process writes via `fs.writeFile` to a session's scope
 *    directory is not reliably visible to a container reading that same path
 *    on that runner. Stdin never touches that path at all — it flows directly
 *    from this process into the container's stdin pipe — so code execution is
 *    NOT exposed to that unresolved bug. The `/workspace` mount is still
 *    present (for a script's own internal scratch files, read back within the
 *    SAME container invocation only), but the source code itself never
 *    depends on it.
 * 2. **Container-per-call, never a reused session.** `sandbox-session-manager.ts`
 *    deliberately caches one scope directory per caller identity across
 *    multiple tool calls, because a multi-step computer_use/agent run needs
 *    `computer_write_file` then a later `computer_shell cat` to see the same
 *    files. Code execution has no such multi-step contract — each call is a
 *    single, complete run — so this module calls `createSandboxSession` /
 *    `disposeSandboxSession` directly, around exactly one `execInSandbox`
 *    call, guaranteeing a fresh scope directory (and, since `--rm` is always
 *    passed, a fresh container) for every single request. Nothing here is
 *    reused across requests or tenants.
 */

import { logger } from '@/utils/logger';
import {
  createSandboxSession,
  disposeSandboxSession,
  execInSandbox,
  type SandboxExecResult,
} from './container-sandbox';
import {
  isCodeExecutionSandboxEnabled,
  isSupportedCodeExecutionLanguage,
  listCodeExecutionLanguages,
  resolveCodeExecutionAllowlist,
  resolveCodeExecutionArgs,
  resolveCodeExecutionCommand,
  resolveCodeExecutionImage,
  resolveMaxCodeExecutionBytes,
  type CodeExecutionLanguage,
} from './sandbox-policy';

const log = logger.child({ component: 'code-execution' });

export type { CodeExecutionLanguage } from './sandbox-policy';
export { isSupportedCodeExecutionLanguage, listCodeExecutionLanguages } from './sandbox-policy';

/** Raised when `CODE_EXECUTION_SANDBOX_ENABLED` is not `'true'`. Fail-closed by construction. */
export class CodeExecutionDisabledError extends Error {
  constructor(
    message = 'Real code execution is disabled (set CODE_EXECUTION_SANDBOX_ENABLED=true to enable)'
  ) {
    super(message);
    this.name = 'CodeExecutionDisabledError';
  }
}

/** Raised for a malformed request — never for anything the SANDBOXED code itself does. */
export class CodeExecutionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeExecutionValidationError';
  }
}

export interface CodeExecutionRequest {
  language: CodeExecutionLanguage;
  /** Source code, piped to the interpreter over stdin — never argv, never a mounted file. */
  code: string;
  /** Per-call override, still clamped by the resolved sandbox policy ceiling. */
  timeoutMs?: number;
  organizationId?: string;
  userId?: string;
  runId?: string;
}

/** Identical contract to `SandboxExecResult`, plus the language actually run. */
export type CodeExecutionResult = SandboxExecResult & { language: CodeExecutionLanguage };

function assertValidRequest(
  request: CodeExecutionRequest
): asserts request is CodeExecutionRequest {
  if (!isSupportedCodeExecutionLanguage(request.language)) {
    throw new CodeExecutionValidationError(
      `Unsupported language '${String(request.language)}'. Supported: ${listCodeExecutionLanguages().join(', ')}`
    );
  }
  if (typeof request.code !== 'string' || request.code.trim().length === 0) {
    throw new CodeExecutionValidationError('code must be a non-empty string');
  }
  const maxBytes = resolveMaxCodeExecutionBytes();
  const codeBytes = Buffer.byteLength(request.code, 'utf8');
  if (codeBytes > maxBytes) {
    throw new CodeExecutionValidationError(
      `code is ${codeBytes} bytes, exceeding the ${maxBytes}-byte limit (CODE_EXECUTION_MAX_SOURCE_BYTES)`
    );
  }
}

/**
 * Run `request.code` in a fresh, isolated, network-disabled container and
 * return its real stdout/stderr/exit code.
 *
 * Fail-closed at every step: disabled flag → throws before anything is
 * created; invalid request → throws before a session is created; Docker
 * unavailable → `execInSandbox` throws `SandboxUnavailableError` (propagated
 * here, never swallowed into a fabricated result). Only a policy violation or
 * a genuine execution outcome (`ok`/`timeout`/`error`/`oom`) is returned as a
 * value — see `SandboxExecResult`'s own doc for why.
 *
 * Container-per-call: creates and tears down its own session around exactly
 * one exec, never touching `sandbox-session-manager.ts`'s cross-call cache.
 */
export async function executeCode(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
  if (!isCodeExecutionSandboxEnabled()) {
    throw new CodeExecutionDisabledError();
  }
  assertValidRequest(request);

  const { language } = request;
  const command = resolveCodeExecutionCommand(language);
  const args = resolveCodeExecutionArgs(language);
  const image = resolveCodeExecutionImage(language);
  const commandAllowlist = resolveCodeExecutionAllowlist(language);

  const session = await createSandboxSession();
  log.info(
    { sessionId: session.sessionId, language, codeBytes: Buffer.byteLength(request.code, 'utf8') },
    'code-execution: starting'
  );
  try {
    const result = await execInSandbox(session, command, args, {
      runId: request.runId,
      organizationId: request.organizationId,
      userId: request.userId,
      timeoutMs: request.timeoutMs,
      stdin: request.code,
      commandAllowlist,
      image,
    });
    return { ...result, language };
  } finally {
    // Always torn down, success or failure — the scope directory (and the
    // container, via `--rm`) never outlives this single call.
    await disposeSandboxSession(session);
  }
}
