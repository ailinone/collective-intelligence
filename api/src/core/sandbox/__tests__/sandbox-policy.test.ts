// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Sandbox policy — fail-closed invariants (ADR-024, LOTE AQ, 2026-09-05).
 *
 * These pin the FIRST layer of defence: the decisions taken before any
 * container starts. They are unit tests by design — the container-level
 * proofs live in `container-sandbox-adversarial.integration.test.ts`, which
 * runs real Docker. Both layers matter: this file proves the policy refuses,
 * that file proves the container contains even when the policy is defeated.
 *
 * Every assertion here is about a REFUSAL. A policy module that is permissive
 * by accident passes no test in this file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_MAX_STEPS_CEILING,
  assertArgAllowed,
  assertCommandAllowed,
  isAgentsEnabled,
  isCodeExecutionSandboxEnabled,
  isComputerUseEnabled,
  isMcpClientEnabled,
  isSupportedCodeExecutionLanguage,
  listCodeExecutionLanguages,
  resolveAgentLimits,
  resolveCodeExecutionAllowlist,
  resolveCodeExecutionArgs,
  resolveCodeExecutionCommand,
  resolveCodeExecutionImage,
  resolveCommandAllowlist,
  resolveMaxCodeExecutionBytes,
  resolveNetworkMode,
  resolveSandboxLimits,
  resolveScopedPath,
  SandboxPolicyError,
} from '../sandbox-policy';

const ENV_KEYS = [
  'AGENTIC_COMPUTER_USE_ENABLED',
  'AGENTIC_AGENTS_ENABLED',
  'MCP_CLIENT_ENABLED',
  'CODE_EXECUTION_SANDBOX_ENABLED',
  'CODE_EXECUTION_PYTHON_IMAGE',
  'CODE_EXECUTION_NODE_IMAGE',
  'CODE_EXECUTION_MAX_SOURCE_BYTES',
  'SANDBOX_COMMAND_ALLOWLIST',
  'SANDBOX_NETWORK_MODE',
  'SANDBOX_MEMORY_MB',
  'SANDBOX_CPUS',
  'SANDBOX_PIDS_LIMIT',
  'SANDBOX_EXEC_TIMEOUT_MS',
  'AGENT_MAX_STEPS',
  'AGENT_MAX_DURATION_MS',
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

describe('feature flags — every agentic surface is OFF by default', () => {
  it('defaults all three capabilities to disabled', () => {
    expect(isComputerUseEnabled(), 'computer_use must not be on by default').toBe(false);
    expect(isAgentsEnabled(), 'agents must not be on by default').toBe(false);
    expect(isMcpClientEnabled(), 'mcp must not be on by default').toBe(false);
  });

  it('enables only on the exact string "true"', () => {
    for (const value of ['1', 'yes', 'TRUE', 'True', 'on', 'enabled', '']) {
      process.env.AGENTIC_COMPUTER_USE_ENABLED = value;
      expect(isComputerUseEnabled(), `'${value}' must not enable the capability`).toBe(false);
    }
    process.env.AGENTIC_COMPUTER_USE_ENABLED = 'true';
    expect(isComputerUseEnabled()).toBe(true);
  });

  it('reads the flag per call, so a flag flipped at runtime takes effect', () => {
    expect(isAgentsEnabled()).toBe(false);
    process.env.AGENTIC_AGENTS_ENABLED = 'true';
    expect(isAgentsEnabled()).toBe(true);
    delete process.env.AGENTIC_AGENTS_ENABLED;
    expect(isAgentsEnabled()).toBe(false);
  });
});

describe('network posture — "open internet" is unreachable from configuration', () => {
  it('defaults to no network at all', () => {
    expect(resolveNetworkMode()).toBe('none');
    expect(resolveSandboxLimits().networkMode).toBe('none');
  });

  it('refuses to honour bridge/host, collapsing them to none', () => {
    for (const value of ['bridge', 'host', 'default', 'container:foo', 'BRIDGE']) {
      process.env.SANDBOX_NETWORK_MODE = value;
      expect(
        resolveNetworkMode(),
        `SANDBOX_NETWORK_MODE=${value} must NOT produce an unrestricted network`
      ).toBe('none');
    }
  });

  it('allows the explicitly modelled allowlist mode only', () => {
    process.env.SANDBOX_NETWORK_MODE = 'allowlist';
    expect(resolveNetworkMode()).toBe('allowlist');
  });
});

describe('command allowlist', () => {
  it('rejects network clients, shells and interpreters by default', () => {
    for (const command of ['curl', 'wget', 'nc', 'ssh', 'sh', 'bash', 'python', 'node', 'perl']) {
      expect(
        () => assertCommandAllowed(command),
        `'${command}' must not be allowlisted by default`
      ).toThrow(SandboxPolicyError);
    }
  });

  it('rejects any command given as a path, so /bin/sh cannot be smuggled past a basename check', () => {
    for (const command of ['/bin/sh', './sh', '../../bin/sh', 'bin/cat', 'C:\\Windows\\cmd.exe']) {
      expect(() => assertCommandAllowed(command)).toThrow(SandboxPolicyError);
    }
  });

  it('rejects shell metacharacters embedded in the command name', () => {
    for (const command of ['cat;wget', 'cat|sh', 'cat&&sh', 'cat$(id)', 'cat`id`', 'cat ls']) {
      expect(() => assertCommandAllowed(command)).toThrow(SandboxPolicyError);
    }
  });

  it('rejects the empty command', () => {
    expect(() => assertCommandAllowed('')).toThrow(SandboxPolicyError);
    expect(() => assertCommandAllowed('   ')).toThrow(SandboxPolicyError);
  });

  it('permits the conservative default set', () => {
    for (const command of ['cat', 'ls', 'grep', 'echo']) {
      expect(() => assertCommandAllowed(command)).not.toThrow();
    }
  });

  it('treats an unparseable operator allowlist as "allow nothing", not "allow the defaults"', () => {
    process.env.SANDBOX_COMMAND_ALLOWLIST = ',,,   ,';
    expect(resolveCommandAllowlist().size).toBe(0);
    expect(() => assertCommandAllowed('cat')).toThrow(SandboxPolicyError);
  });

  it('honours an explicit operator allowlist exactly', () => {
    process.env.SANDBOX_COMMAND_ALLOWLIST = 'cat,ls';
    expect(() => assertCommandAllowed('cat')).not.toThrow();
    expect(() => assertCommandAllowed('grep'), 'grep is a default, but not in this list').toThrow(
      SandboxPolicyError
    );
  });

  it('tags refusals with the blocked_command violation for the audit trail', () => {
    try {
      assertCommandAllowed('curl');
      expect.unreachable('curl must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxPolicyError);
      expect((err as SandboxPolicyError).violation).toBe('blocked_command');
    }
  });
});

describe('argument validation', () => {
  it('rejects NUL bytes, which truncate C strings downstream', () => {
    expect(() => assertArgAllowed('safe\0--privileged')).toThrow(SandboxPolicyError);
  });

  it('rejects absurdly long arguments', () => {
    expect(() => assertArgAllowed('x'.repeat(4_097))).toThrow(SandboxPolicyError);
  });

  it('permits ordinary arguments, including shell metacharacters (they are never shell-interpreted)', () => {
    for (const arg of ['-la', 'file.txt', 'a;b|c', '$(id)', '--flag=value']) {
      expect(() => assertArgAllowed(arg)).not.toThrow();
    }
  });
});

describe('scope containment — resolveScopedPath', () => {
  let scope: string;

  beforeEach(() => {
    scope = mkdtempSync(join(tmpdir(), 'scope-test-'));
  });

  afterEach(() => {
    rmSync(scope, { recursive: true, force: true });
  });

  it('accepts ordinary relative paths inside the scope', () => {
    expect(() => resolveScopedPath(scope, 'a.txt')).not.toThrow();
    expect(() => resolveScopedPath(scope, 'nested/dir/a.txt')).not.toThrow();
    expect(() => resolveScopedPath(scope, './a.txt')).not.toThrow();
  });

  it('refuses traversal out of the scope', () => {
    for (const path of [
      '../escape.txt',
      '../../escape.txt',
      'nested/../../escape.txt',
      '../../../../etc/passwd',
      'a/b/c/../../../../../escape',
    ]) {
      expect(() => resolveScopedPath(scope, path), `'${path}' must be refused`).toThrow(
        SandboxPolicyError
      );
    }
  });

  it('refuses absolute paths on both POSIX and Windows forms', () => {
    for (const path of ['/etc/passwd', '/workspace/x', 'C:\\Windows\\System32\\x', 'D:/x']) {
      expect(() => resolveScopedPath(scope, path), `'${path}' must be refused`).toThrow(
        SandboxPolicyError
      );
    }
  });

  it('refuses NUL bytes and empty paths', () => {
    expect(() => resolveScopedPath(scope, 'a\0b')).toThrow(SandboxPolicyError);
    expect(() => resolveScopedPath(scope, '')).toThrow(SandboxPolicyError);
    expect(() => resolveScopedPath(scope, '   ')).toThrow(SandboxPolicyError);
  });

  it('is not fooled by a sibling directory sharing the scope prefix', () => {
    // The classic `startsWith` bug: '/tmp/scope-evil' starts with '/tmp/scope'.
    const sibling = `${scope}-evil`;
    mkdirSync(sibling, { recursive: true });
    try {
      expect(() => resolveScopedPath(scope, '../' + sibling.split(/[\\/]/).pop())).toThrow(
        SandboxPolicyError
      );
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('refuses a path that resolves out of the scope through a symlink', () => {
    const link = join(scope, 'out');
    let supported = true;
    try {
      symlinkSync(join(scope, '..'), link, 'dir');
    } catch {
      supported = false;
    }
    if (!supported) return; // Windows without SeCreateSymbolicLink privilege.
    expect(() => resolveScopedPath(scope, 'out/escaped.txt')).toThrow(SandboxPolicyError);
  });

  it('tags escapes with the path_escape violation', () => {
    try {
      resolveScopedPath(scope, '../x');
      expect.unreachable('traversal must be refused');
    } catch (err) {
      expect((err as SandboxPolicyError).violation).toBe('path_escape');
    }
  });
});

describe('limit clamping — an operator cannot configure the limits away', () => {
  it('clamps the agent step ceiling', () => {
    process.env.AGENT_MAX_STEPS = '100000';
    expect(resolveAgentLimits().maxSteps).toBe(AGENT_MAX_STEPS_CEILING);

    process.env.AGENT_MAX_STEPS = '0';
    expect(resolveAgentLimits().maxSteps).toBe(1);

    process.env.AGENT_MAX_STEPS = '-5';
    expect(resolveAgentLimits().maxSteps).toBe(1);
  });

  it('falls back to the safe default for junk values rather than to the operator value', () => {
    for (const value of ['abc', 'NaN', 'Infinity', '']) {
      process.env.AGENT_MAX_STEPS = value;
      expect(resolveAgentLimits().maxSteps, `'${value}' must yield the default`).toBe(8);
    }
  });

  it('clamps sandbox resource limits into a bounded range', () => {
    process.env.SANDBOX_MEMORY_MB = '999999';
    process.env.SANDBOX_CPUS = '512';
    process.env.SANDBOX_PIDS_LIMIT = '999999';
    process.env.SANDBOX_EXEC_TIMEOUT_MS = '99999999';
    const limits = resolveSandboxLimits();
    expect(limits.memoryMb).toBe(4_096);
    expect(limits.cpus).toBe(4);
    expect(limits.pidsLimit).toBe(1_024);
    expect(limits.timeoutMs).toBe(300_000);
  });

  it('clamps a zeroed-out timeout up to the floor, so there is always a real budget', () => {
    process.env.SANDBOX_EXEC_TIMEOUT_MS = '0';
    expect(resolveSandboxLimits().timeoutMs).toBe(1_000);
  });

  it('never runs the container as root by default', () => {
    expect(resolveSandboxLimits().user).not.toBe('0:0');
    expect(resolveSandboxLimits().user).toBe('65534:65534');
  });
});

// ── ADR-026: code execution ─────────────────────────────────────────────

describe('code execution flag — off by default, same strict-opt-in convention', () => {
  it('defaults to disabled', () => {
    expect(isCodeExecutionSandboxEnabled()).toBe(false);
  });

  it('enables only on the exact string "true"', () => {
    for (const value of ['1', 'yes', 'TRUE', 'True', 'on', 'enabled', '']) {
      process.env.CODE_EXECUTION_SANDBOX_ENABLED = value;
      expect(isCodeExecutionSandboxEnabled(), `'${value}' must not enable it`).toBe(false);
    }
    process.env.CODE_EXECUTION_SANDBOX_ENABLED = 'true';
    expect(isCodeExecutionSandboxEnabled()).toBe(true);
  });

  it('is independent of the three ADR-024 flags — none of them enable it, and it does not enable them', () => {
    process.env.AGENTIC_COMPUTER_USE_ENABLED = 'true';
    process.env.AGENTIC_AGENTS_ENABLED = 'true';
    process.env.MCP_CLIENT_ENABLED = 'true';
    expect(isCodeExecutionSandboxEnabled()).toBe(false);

    delete process.env.AGENTIC_COMPUTER_USE_ENABLED;
    delete process.env.AGENTIC_AGENTS_ENABLED;
    delete process.env.MCP_CLIENT_ENABLED;
    process.env.CODE_EXECUTION_SANDBOX_ENABLED = 'true';
    expect(isComputerUseEnabled()).toBe(false);
    expect(isAgentsEnabled()).toBe(false);
    expect(isMcpClientEnabled()).toBe(false);
  });
});

describe('code execution — supported languages', () => {
  it('supports exactly python and javascript, nothing else', () => {
    expect(listCodeExecutionLanguages().sort()).toEqual(['javascript', 'python']);
    expect(isSupportedCodeExecutionLanguage('python')).toBe(true);
    expect(isSupportedCodeExecutionLanguage('javascript')).toBe(true);
    for (const bogus of ['ruby', 'go', 'java', 'bash', 'sh', 'perl', '', 'Python', 'PYTHON']) {
      expect(isSupportedCodeExecutionLanguage(bogus), `'${bogus}' must not be supported`).toBe(
        false
      );
    }
  });

  it('maps each language to its own bare interpreter command', () => {
    expect(resolveCodeExecutionCommand('python')).toBe('python3');
    expect(resolveCodeExecutionCommand('javascript')).toBe('node');
  });

  it('reads the program from stdin via a fixed, non-caller-controlled "-" argv', () => {
    expect(resolveCodeExecutionArgs('python')).toEqual(['-']);
    expect(resolveCodeExecutionArgs('javascript')).toEqual(['-']);
  });

  it('scopes the allowlist to exactly one command per language', () => {
    const pythonAllowlist = resolveCodeExecutionAllowlist('python');
    expect(pythonAllowlist.size).toBe(1);
    expect(pythonAllowlist.has('python3')).toBe(true);
    expect(pythonAllowlist.has('node')).toBe(false);

    const jsAllowlist = resolveCodeExecutionAllowlist('javascript');
    expect(jsAllowlist.size).toBe(1);
    expect(jsAllowlist.has('node')).toBe(true);
    expect(jsAllowlist.has('python3')).toBe(false);
  });

  it('the computer_use default allowlist is UNCHANGED — still excludes every interpreter', () => {
    // The regression this guards: adding code-execution support must not
    // widen the shared allowlist computer_use's shell tool consults.
    for (const command of ['python3', 'python', 'node', 'sh', 'bash']) {
      expect(
        resolveCommandAllowlist().has(command),
        `'${command}' must still be absent from the SHARED default allowlist`
      ).toBe(false);
    }
  });

  it('defaults to a minimal, pinned image per language and honours an operator override', () => {
    expect(resolveCodeExecutionImage('python')).toBe('python:3.12-alpine');
    expect(resolveCodeExecutionImage('javascript')).toBe('node:20-alpine');

    process.env.CODE_EXECUTION_PYTHON_IMAGE = 'python:3.11-slim';
    expect(resolveCodeExecutionImage('python')).toBe('python:3.11-slim');
    // The other language's image is unaffected by the first's override.
    expect(resolveCodeExecutionImage('javascript')).toBe('node:20-alpine');
  });
});

describe('code execution — source-size ceiling', () => {
  it('defaults to a bounded ceiling and clamps operator configuration into range', () => {
    expect(resolveMaxCodeExecutionBytes()).toBe(200_000);

    process.env.CODE_EXECUTION_MAX_SOURCE_BYTES = '999999999';
    expect(resolveMaxCodeExecutionBytes()).toBe(2_000_000);

    process.env.CODE_EXECUTION_MAX_SOURCE_BYTES = '0';
    expect(resolveMaxCodeExecutionBytes()).toBe(1_000);
  });
});

describe('assertCommandAllowed — per-call allowlist override (ADR-026)', () => {
  it('honours a caller-supplied allowlist instead of the shared default', () => {
    // 'python3' is refused against the shared default (see the "rejects
    // network clients, shells and interpreters by default" test above) but
    // permitted against code execution's own one-command allowlist.
    expect(() => assertCommandAllowed('python3')).toThrow(SandboxPolicyError);
    expect(() => assertCommandAllowed('python3', new Set(['python3']))).not.toThrow();
  });

  it('a language-scoped allowlist still refuses every OTHER command, including the other language', () => {
    const pythonOnly = resolveCodeExecutionAllowlist('python');
    expect(() => assertCommandAllowed('node', pythonOnly)).toThrow(SandboxPolicyError);
    expect(() => assertCommandAllowed('sh', pythonOnly)).toThrow(SandboxPolicyError);
    expect(() => assertCommandAllowed('cat', pythonOnly)).toThrow(SandboxPolicyError);
  });

  it('still rejects a path or shell metacharacters even against a permissive override', () => {
    const permissive = new Set(['python3', 'sh']);
    expect(() => assertCommandAllowed('/bin/python3', permissive)).toThrow(SandboxPolicyError);
    expect(() => assertCommandAllowed('python3;sh', permissive)).toThrow(SandboxPolicyError);
  });

  it('with no override, still reads the shared resolveCommandAllowlist() per call (unchanged default behaviour)', () => {
    process.env.SANDBOX_COMMAND_ALLOWLIST = 'cat';
    expect(() => assertCommandAllowed('cat')).not.toThrow();
    expect(() => assertCommandAllowed('ls')).toThrow(SandboxPolicyError);
  });
});
