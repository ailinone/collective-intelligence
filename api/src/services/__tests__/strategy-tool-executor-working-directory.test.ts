// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `executeToolForStrategy()` default `workingDirectory` — issue #664 finding 2.
 *
 * `base-strategy.ts`'s tool loop and `agentic-strategy.ts`'s planner
 * `tool_call` steps both call `executeToolForStrategy(toolCall, log)` with NO
 * `context` argument. Before this fix, `parseStrategyToolCall()` fell back to
 * the bare `process.cwd()` for `workingDirectory` — the API container's own
 * source tree, not any kind of tenant- or request-scoped sandbox. A tool that
 * is allowed to keep auto-executing here despite a client-forced tool_choice
 * (today: `analyze_image`, `compare_images`, `extract_code_from_screenshot`,
 * because they are auto-recommendable) therefore ran against the whole API
 * codebase.
 *
 * The fix makes the default `getToolsBaseDir()` — the SAME server-controlled
 * base `/v1/tools/*` (tools-routes.ts) and the chat-completions auto-dispatch
 * path (chat-request-processor.ts) already trust for this exact purpose. It
 * is a no-op fallback to `process.cwd()` when the operator leaves
 * `TOOLS_BASE_DIR` unset, and a real narrowing whenever it is configured.
 *
 * This suite proves the observable effect on a REAL tool (a test double
 * registered like any other, whose handler simply reports the
 * `workingDirectory` it received) rather than reaching into the unexported
 * `parseStrategyToolCall()` helper.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import { toolRegistry } from '@/core/tools/tool-registry';
import { executeToolForStrategy } from '../strategy-tool-executor';
import type { ToolCall } from '@/types';

const PROBE_TOOL = 'test_working_directory_probe_tool';

function call(name: string, args: string = '{}', id = 'call_1'): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

const ORIGINAL_TOOLS_BASE_DIR = process.env.TOOLS_BASE_DIR;
let observedWorkingDirectory: string | undefined;

describe('executeToolForStrategy() default workingDirectory', () => {
  beforeAll(() => {
    // `executeToolForStrategy` fails closed ('Tool registry not yet
    // initialized.') until `markInitialized()` has run at least once — the
    // same one-time signal `registerToolsInRegistry()` sets at boot. This
    // test file only needs ONE probe tool registered, not the full
    // production registration, so it sets the flag directly (same pattern as
    // strategy-tool-executor-quorum.test.ts).
    toolRegistry.register({
      name: PROBE_TOOL,
      description: 'test-only probe reporting the workingDirectory it received',
      category: 'general',
      safeForStrategies: true,
      handler: async (_args, toolCallId, context) => {
        observedWorkingDirectory = context.workingDirectory;
        return { tool_call_id: toolCallId, success: true, output: 'ok' };
      },
    });
    toolRegistry.markInitialized();
  });

  afterEach(() => {
    if (ORIGINAL_TOOLS_BASE_DIR === undefined) delete process.env.TOOLS_BASE_DIR;
    else process.env.TOOLS_BASE_DIR = ORIGINAL_TOOLS_BASE_DIR;
    observedWorkingDirectory = undefined;
  });

  it('defaults to getToolsBaseDir(), not the bare process.cwd(), when no context is passed', async () => {
    const configuredBase = path.resolve('/tmp/ci-strategy-tools-base-test');
    process.env.TOOLS_BASE_DIR = configuredBase;

    const result = await executeToolForStrategy(call(PROBE_TOOL), console as never);

    expect(result.success).toBe(true);
    // Pre-fix this was `path.resolve(process.cwd())`, NOT the configured base.
    expect(observedWorkingDirectory).toBe(path.resolve(configuredBase));
    expect(observedWorkingDirectory).not.toBe(path.resolve(process.cwd()));
  });

  it('falls back to process.cwd() when TOOLS_BASE_DIR is unset (no regression for today\'s default deployment)', async () => {
    delete process.env.TOOLS_BASE_DIR;

    const result = await executeToolForStrategy(call(PROBE_TOOL), console as never);

    expect(result.success).toBe(true);
    expect(observedWorkingDirectory).toBe(path.resolve(process.cwd()));
  });

  it('an explicitly passed context.workingDirectory still wins over the default', async () => {
    process.env.TOOLS_BASE_DIR = path.resolve('/tmp/ci-strategy-tools-base-test');
    const explicitDir = path.resolve('/tmp/ci-strategy-explicit-dir-test');

    const result = await executeToolForStrategy(call(PROBE_TOOL), console as never, {
      workingDirectory: explicitDir,
    });

    expect(result.success).toBe(true);
    expect(observedWorkingDirectory).toBe(explicitDir);
  });
});
