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
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import path from 'node:path';
import type { Logger } from 'pino';
import type { ToolCall } from '@/types';
import {
  executeRealTool,
  resolveWorkingDirectory,
  registerToolsInRegistry,
  CHAT_AUTO_EXECUTE_BLOCKED_TOOLS,
} from '../chat-request-processor';
import {
  toolRegistry,
  CHAT_AUTO_EXECUTE_BLOCKED_TOOLS as REGISTRY_BLOCKED_TOOLS,
} from '@/core/tools/tool-registry';

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

  it('the blocklist matches every tool the registry marks safeForStrategies:false, plus the admin-only tools also blocked here', () => {
    // Keep this pinned to the exact registrations in registerToolsInRegistry()
    // (services/chat-request-processor.ts) so a future unsafe tool added there
    // without a matching blocklist entry fails this test rather than silently
    // reopening the hole for the pre-registry-boot switch fallback.
    //
    // The second group below (write_file .. extract_code_from_screenshot) is
    // registered `safeForStrategies: true` but is still blocked here: those
    // are the same filesystem-mutation and vision (SSRF-capable) tools the
    // /v1/tools/* routes restrict to admin/owner, and chat completions has no
    // role check at all (2026-09-23 fix).
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

        'write_file',
        'search_replace',
        'rename_symbol',
        'extract_function',
        'extract_variable',
        'inline_function',
        'refactor_code',
        'heal_file',
        'analyze_image',
        'compare_images',
        'extract_code_from_screenshot',

        // issue #664 finding 1 (2026-09-25): READ tools, same rationale —
        // safeForStrategies:true, not auto-recommendable, but a client can
        // force them via its own tools/tool_choice and have them read the
        // API container's own source tree instead of coming back unexecuted.
        'read_file',
        'grep_search',
        'explore_codebase',
        'list_directory',
        'file_search',
        'analyze_codebase',
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

  it('layer 2 reads the SAME blocklist object as layer 1 (tool-registry.ts), not a copy', () => {
    // base-strategy.executeModelWithTools and strategy-tool-executor gate on
    // `isBlockedFromStrategyAutoExecution`, which reads the registry's set; a
    // second literal here could drift from it.
    expect(CHAT_AUTO_EXECUTE_BLOCKED_TOOLS).toBe(REGISTRY_BLOCKED_TOOLS);
  });

  describe('read tools never auto-execute for a client-forced tool_choice (issue #664 finding 1)', () => {
    it('refuses "read_file" and does not read the API\'s own source tree', async () => {
      const log = makeLog();
      // A real path that exists in this repo (this test file's own package.json) —
      // proves the block happens BEFORE any filesystem access, not that the
      // path merely fails to resolve.
      const toolCall = makeToolCall('read_file', { file_path: 'package.json' });

      const result = await executeRealTool(toolCall, { messages: [] } as never, log, 'org_1', 'user_1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not permitted for automatic execution via chat completions');
    });

    it('refuses "grep_search" with a pattern that would match real source', async () => {
      const log = makeLog();
      const toolCall = makeToolCall('grep_search', { pattern: 'CHAT_AUTO_EXECUTE_BLOCKED_TOOLS' });

      const result = await executeRealTool(toolCall, { messages: [] } as never, log, 'org_1', 'user_1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not permitted for automatic execution via chat completions');
    });
  });

  describe('a blocked tool cannot be reached through one of its aliases (issue #664 hardening)', () => {
    beforeAll(() => {
      registerToolsInRegistry();
    });

    it("registry has 'grep_search' registered with the 'grep_tool'/'grep' aliases pointing at the same registration", () => {
      // Sanity check the premise: if this ever stops being true the aliasing
      // test below would pass for the wrong reason (no alias to bypass with).
      expect(toolRegistry.isInitialized()).toBe(true);
      const canonical = toolRegistry.get('grep_search');
      expect(canonical?.name).toBe('grep_search');
      expect(toolRegistry.get('grep_tool')?.name).toBe('grep_search');
      expect(toolRegistry.get('grep')?.name).toBe('grep_search');
    });

    it.each(['grep_tool', 'grep'])(
      'refuses "grep_search" reached via its "%s" alias, not just the canonical name',
      async (aliasName) => {
        const log = makeLog();
        // Pre-fix, layer 2's blocklist checks compared the RAW incoming name
        // against the literal set — `grep_search` is listed, but `grep_tool`
        // and `grep` are not, so a client sending the alias would have
        // slipped past both the `serverOwnsEveryToolCall` gate and
        // `executeRealTool`'s own check and actually run the search.
        const toolCall = makeToolCall(aliasName, { pattern: 'CHAT_AUTO_EXECUTE_BLOCKED_TOOLS' });

        const result = await executeRealTool(toolCall, { messages: [] } as never, log, 'org_1', 'user_1');

        expect(result.success).toBe(false);
        expect(result.error).toContain('not permitted for automatic execution via chat completions');
      }
    );
  });

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
