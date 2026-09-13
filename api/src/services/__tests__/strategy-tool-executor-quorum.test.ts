// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `executeQuorumApprovedToolForStrategy()` — media-generation-delegation
 * plan, PR2.
 *
 * `executeToolForStrategy()` already existed and is STILL strict: it only
 * ever runs a tool registered `safeForStrategies: true` (via
 * `toolRegistry.executeForStrategy()`). That gate has other callers this PR
 * must not weaken — `agentic-strategy.ts`'s own tool loop and
 * `chat-request-processor.ts`'s automatic (non-collective, single-model)
 * chat-completions tool_calls loop both call it directly, with NO quorum
 * context available to them. A `strategyExecutionMode: 'quorumOnly'` tool
 * (`generate_video`, `generate_media`) is `safeForStrategies: false`, so it
 * correctly stays refused there.
 *
 * `executeQuorumApprovedToolForStrategy()` is the new, narrow bypass:
 * `executeModelWithTools` (base-strategy.ts) calls it ONLY after
 * independently verifying quorum via `computeQuorumToolCall()`. This suite
 * checks the bypass (a) actually runs a quorumOnly tool despite
 * `safeForStrategies:false`, and (b) as a defense-in-depth backstop, refuses
 * anything the registry doesn't itself mark `strategyExecutionMode:
 * 'quorumOnly'` — it grants no general bypass.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { logger } from '@/utils/logger';
import { toolRegistry } from '@/core/tools/tool-registry';
import {
  executeToolForStrategy,
  executeQuorumApprovedToolForStrategy,
} from '../strategy-tool-executor';
import type { ToolCall } from '@/types';

const log = logger.child({ component: 'strategy-tool-executor-quorum.test' });

const QUORUM_TOOL = 'test_quorum_only_tool';
const SAFE_TOOL = 'test_safe_tool_for_quorum_suite';
const UNSAFE_NON_QUORUM_TOOL = 'test_unsafe_non_quorum_tool';

function call(name: string, args: string = '{}', id = 'call_1'): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

describe('executeQuorumApprovedToolForStrategy()', () => {
  let quorumCalls = 0;
  let safeCalls = 0;
  let unsafeCalls = 0;

  beforeEach(() => {
    quorumCalls = 0;
    safeCalls = 0;
    unsafeCalls = 0;

    toolRegistry.register({
      name: QUORUM_TOOL,
      description: 'test-only quorumOnly tool',
      category: 'video',
      safeForStrategies: false,
      strategyExecutionMode: 'quorumOnly',
      handler: async (_args, toolCallId) => {
        quorumCalls += 1;
        return { tool_call_id: toolCallId, success: true, output: 'quorum-ok' };
      },
    });
    toolRegistry.register({
      name: SAFE_TOOL,
      description: 'test-only unconditionally-safe tool',
      category: 'web',
      safeForStrategies: true,
      handler: async (_args, toolCallId) => {
        safeCalls += 1;
        return { tool_call_id: toolCallId, success: true, output: 'safe-ok' };
      },
    });
    toolRegistry.register({
      name: UNSAFE_NON_QUORUM_TOOL,
      description: 'test-only tool that is neither safe nor quorumOnly',
      category: 'general',
      safeForStrategies: false,
      handler: async (_args, toolCallId) => {
        unsafeCalls += 1;
        return { tool_call_id: toolCallId, success: true, output: 'unsafe-ok' };
      },
    });
    toolRegistry.markInitialized();
  });

  it('executes a strategyExecutionMode:"quorumOnly" tool despite safeForStrategies:false', async () => {
    const result = await executeQuorumApprovedToolForStrategy(call(QUORUM_TOOL), log);
    expect(quorumCalls).toBe(1);
    expect(result.success).toBe(true);
    expect(result.output).toBe('quorum-ok');
  });

  it('refuses a safeForStrategies:true tool that is not registered quorumOnly (defense-in-depth: no general bypass)', async () => {
    const result = await executeQuorumApprovedToolForStrategy(call(SAFE_TOOL), log);
    expect(safeCalls).toBe(0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/quorumOnly/);
  });

  it('refuses a tool that is neither safeForStrategies:true nor quorumOnly', async () => {
    const result = await executeQuorumApprovedToolForStrategy(call(UNSAFE_NON_QUORUM_TOOL), log);
    expect(unsafeCalls).toBe(0);
    expect(result.success).toBe(false);
  });

  it('refuses an unregistered tool name', async () => {
    const result = await executeQuorumApprovedToolForStrategy(call('does_not_exist'), log);
    expect(result.success).toBe(false);
  });

  it('rejects malformed JSON arguments before reaching the handler (shared parsing with executeToolForStrategy)', async () => {
    const result = await executeQuorumApprovedToolForStrategy(
      call(QUORUM_TOOL, 'not json'),
      log
    );
    expect(quorumCalls).toBe(0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid JSON/);
  });
});

describe('executeToolForStrategy() still refuses a quorumOnly tool (the standard gate is unweakened)', () => {
  beforeEach(() => {
    toolRegistry.register({
      name: QUORUM_TOOL,
      description: 'test-only quorumOnly tool',
      category: 'video',
      safeForStrategies: false,
      strategyExecutionMode: 'quorumOnly',
      handler: async (_args, toolCallId) => ({
        tool_call_id: toolCallId,
        success: true,
        output: 'should not run',
      }),
    });
    toolRegistry.markInitialized();
  });

  it('refuses to run it — the OTHER callers of executeToolForStrategy (agentic-strategy.ts, chat-request-processor.ts) have no quorum context and must keep failing closed', async () => {
    const result = await executeToolForStrategy(call(QUORUM_TOOL), log);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not permitted/);
  });
});
