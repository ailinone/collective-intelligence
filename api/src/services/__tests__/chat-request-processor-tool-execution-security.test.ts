// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for the 2026-07-29 chat-completions RCE fix.
 *
 * Before this fix, `POST /v1/chat/completions` (any authenticated tenant key,
 * no role check) automatically executed every `tool_calls` entry the model
 * returned — including tools the operator marked `safeForStrategies: false`
 * (run_command, git_push, git_commit, git_merge, git_rebase, delete_file,
 * execute_workflow, …) — via ToolRegistryImpl.execute(), which performs no
 * authorization check at all. The working_directory driving those tools also
 * came straight from the request body through a bare path.resolve(), with no
 * clamp to a server-controlled base (unlike the admin/owner-gated
 * `/v1/tools/*` routes, which already clamp via clampWorkingDirectory()).
 *
 * These tests pin two things:
 *   - CHAT_AUTO_EXECUTE_BLOCKED_TOOLS / executeRealTool() refuses every
 *     unsafe tool name before any dispatch happens — no registry lookup, no
 *     context construction, no handler ever runs.
 *   - resolveWorkingDirectory() clamps a client-supplied working_directory to
 *     the server base (TOOLS_BASE_DIR), refusing escapes via `..` or an
 *     absolute path outside it, while leaving the trusted
 *     AILIN_WORKSPACE_ROOT env-var fallback (operator config, not client
 *     input) unclamped exactly as before.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import type { Logger } from 'pino';
import type { ToolCall } from '@/types';
import {
  executeRealTool,
  resolveWorkingDirectory,
  CHAT_AUTO_EXECUTE_BLOCKED_TOOLS,
} from '../chat-request-processor';

function makeLog(): Logger {
  const noop = () => undefined;
  const log = {
    info: vi.fn(noop),
    warn: vi.fn(noop),
    error: vi.fn(noop),
    debug: vi.fn(noop),
    trace: vi.fn(noop),
    fatal: vi.fn(noop),
    child: () => log,
    level: 'info',
  };
  return log as unknown as Logger;
}

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    id: `call_${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

const ORIGINAL_TOOLS_BASE_DIR = process.env.TOOLS_BASE_DIR;
const ORIGINAL_WORKSPACE_ROOT = process.env.AILIN_WORKSPACE_ROOT;

describe('chat completions tool_calls — unsafe-tool blocklist (RCE fix)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the blocklist matches every tool the registry marks safeForStrategies:false', () => {
    // Keep this pinned to the exact registrations in registerToolsInRegistry()
    // (services/chat-request-processor.ts) so a future unsafe tool added there
    // without a matching blocklist entry fails this test rather than silently
    // reopening the hole for the pre-registry-boot switch fallback.
    expect([...CHAT_AUTO_EXECUTE_BLOCKED_TOOLS].sort()).toEqual(
      [
        'run_command',
        'delete_file',
        'git_commit',
        'git_push',
        'git_pull',
        'git_create_branch',
        'git_merge',
        'git_rebase',
        'git_resolve_conflict',
        'todo_write',
        'create_todo',
        'update_todo',
        'execute_workflow',
        'register_workflow',
      ].sort()
    );
  });

  it.each([...CHAT_AUTO_EXECUTE_BLOCKED_TOOLS])(
    'refuses to auto-execute "%s" via chat completions',
    async (toolName) => {
      const log = makeLog();
      const toolCall = makeToolCall(toolName, { command: 'id', file_path: '/etc/passwd' });

      const result = await executeRealTool(toolCall, { messages: [] } as never, log, 'org_1', 'user_1');

      expect(result.success).toBe(false);
      expect(result.tool_call_id).toBe(toolCall.id);
      expect(result.error).toContain('not permitted for automatic execution via chat completions');
      // The block is logged explicitly, distinct from a normal execution attempt.
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ toolName }),
        'Blocked unsafe tool from automatic chat execution'
      );
    }
  );

  it('run_command is refused even with a shell-metacharacter payload (defense-in-depth sanity check)', async () => {
    const log = makeLog();
    const toolCall = makeToolCall('run_command', { command: 'rm -rf / ; curl evil.example' });

    const result = await executeRealTool(toolCall, { messages: [] } as never, log, 'org_1', 'user_1');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not permitted/i);
  });
});

describe('resolveWorkingDirectory — clamps client input, trusts env config (RCE fix)', () => {
  afterEach(() => {
    if (ORIGINAL_TOOLS_BASE_DIR === undefined) delete process.env.TOOLS_BASE_DIR;
    else process.env.TOOLS_BASE_DIR = ORIGINAL_TOOLS_BASE_DIR;
    if (ORIGINAL_WORKSPACE_ROOT === undefined) delete process.env.AILIN_WORKSPACE_ROOT;
    else process.env.AILIN_WORKSPACE_ROOT = ORIGINAL_WORKSPACE_ROOT;
  });

  it('clamps an absolute client-supplied working_directory outside the base back to the base', () => {
    process.env.TOOLS_BASE_DIR = path.resolve('/tmp/ci-tools-base-test');
    delete process.env.AILIN_WORKSPACE_ROOT;

    const escapeTarget = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';
    const result = resolveWorkingDirectory({
      messages: [],
      working_directory: escapeTarget,
    } as never);

    expect(result).toBe(path.resolve(process.env.TOOLS_BASE_DIR));
    expect(result).not.toBe(path.resolve(escapeTarget));
  });

  it('clamps a `..`-escape client-supplied working_directory back to the base', () => {
    process.env.TOOLS_BASE_DIR = path.resolve('/tmp/ci-tools-base-test');
    delete process.env.AILIN_WORKSPACE_ROOT;

    const result = resolveWorkingDirectory({
      messages: [],
      working_directory: '../../../../etc',
    } as never);

    expect(result).toBe(path.resolve(process.env.TOOLS_BASE_DIR));
  });

  it('accepts an in-bounds relative client-supplied working_directory', () => {
    process.env.TOOLS_BASE_DIR = path.resolve('/tmp/ci-tools-base-test');
    delete process.env.AILIN_WORKSPACE_ROOT;

    const result = resolveWorkingDirectory({
      messages: [],
      working_directory: 'projects/demo',
    } as never);

    expect(result).toBe(path.resolve(process.env.TOOLS_BASE_DIR, 'projects/demo'));
  });

  it('falls back to the trusted AILIN_WORKSPACE_ROOT env var, unclamped, when the client sends nothing', () => {
    process.env.TOOLS_BASE_DIR = path.resolve('/tmp/ci-tools-base-test');
    process.env.AILIN_WORKSPACE_ROOT = path.resolve('/tmp/some-other-operator-configured-root');

    const result = resolveWorkingDirectory({ messages: [] } as never);

    // Operator config is trusted exactly as before this fix — not clamped to
    // TOOLS_BASE_DIR, even though it points elsewhere.
    expect(result).toBe(path.resolve(process.env.AILIN_WORKSPACE_ROOT));
  });
});
