// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy Tool Executor
 *
 * Enables tool execution within orchestration strategies using the centralized Tool Registry.
 * Strategies can only execute tools marked as `safeForStrategies: true` in the registry —
 * OR a `strategyExecutionMode: 'quorumOnly'` tool whose auto-execution the CALLER has
 * already authorized via quorum (see `executeQuorumApprovedToolForStrategy` below).
 *
 * All tools (web_search, code_execute, read_file, grep_search, etc.) are REAL implementations
 * backed by the same tool infrastructure used by the chat processor. No stubs.
 */

import type { ToolCall } from '@/types';
import type { ToolResult, ToolExecutionContext } from '@/services/advanced-tool-execution-service';
import type { Logger } from 'pino';
import { toolRegistry } from '@/core/tools/tool-registry';

interface ParsedStrategyToolCall {
  functionName: string;
  args: Record<string, unknown>;
  execContext: ToolExecutionContext;
}

/** Shared arg-parsing/context-building for both execution entry points below —
 *  kept as one implementation so the two never drift on error shapes. */
function parseStrategyToolCall(
  toolCall: ToolCall,
  log: Logger,
  context?: Partial<ToolExecutionContext>
): ParsedStrategyToolCall | { errorResult: ToolResult } {
  const functionName = toolCall.function?.name;
  const argsStr = toolCall.function?.arguments || '{}';

  if (!functionName) {
    return {
      errorResult: { tool_call_id: toolCall.id, success: false, error: 'No function name in tool call' },
    };
  }

  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argsStr);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        errorResult: {
          tool_call_id: toolCall.id,
          success: false,
          error: `Tool arguments must be a JSON object: ${argsStr.substring(0, 200)}`,
        },
      };
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return {
      errorResult: {
        tool_call_id: toolCall.id,
        success: false,
        error: `Invalid JSON arguments: ${argsStr.substring(0, 200)}`,
      },
    };
  }

  const execContext: ToolExecutionContext = {
    workingDirectory: context?.workingDirectory || process.cwd(),
    log,
    organizationId: context?.organizationId,
    userId: context?.userId,
    timeout: context?.timeout || 30000,
  };

  return { functionName, args, execContext };
}

/**
 * Execute a tool call on behalf of a strategy.
 * Only tools marked `safeForStrategies: true` in the registry are permitted.
 * Uses the SAME real implementations as the chat processor.
 */
export async function executeToolForStrategy(
  toolCall: ToolCall,
  log: Logger,
  context?: Partial<ToolExecutionContext>
): Promise<ToolResult> {
  const parsed = parseStrategyToolCall(toolCall, log, context);
  if ('errorResult' in parsed) return parsed.errorResult;

  if (!toolRegistry.isInitialized()) {
    log.warn('Tool registry not initialized — tool execution unavailable in strategy context');
    return {
      tool_call_id: toolCall.id,
      success: false,
      error: 'Tool registry not yet initialized.',
    };
  }

  return toolRegistry.executeForStrategy(parsed.functionName, parsed.args, toolCall.id, parsed.execContext);
}

/**
 * Execute a tool call whose auto-execution the CALLER has already authorized
 * via quorum (`computeQuorumToolCall()` in
 * `core/aggregation/response-aggregator.ts`), for a tool registered
 * `strategyExecutionMode: 'quorumOnly'`.
 *
 * Deliberately bypasses `toolRegistry.executeForStrategy()`'s
 * `safeForStrategies` gate: a quorumOnly tool is `safeForStrategies:false`
 * (it is NOT unconditionally safe — see `tool-registry.ts`), so that gate
 * would otherwise reject it even when quorum-approved. The quorum check
 * itself must already have happened upstream — this function has no
 * visibility into sibling voters and cannot verify it. The ONLY intended
 * caller is `executeModelWithTools`'s quorum-gated branch
 * (`core/orchestration/base-strategy.ts`).
 *
 * As a defense-in-depth backstop (in case a future caller reaches this
 * without going through that gate), this still refuses to run anything the
 * registry itself doesn't mark `strategyExecutionMode: 'quorumOnly'` — it
 * grants NO general bypass, only the one specific mode this function exists
 * for.
 */
export async function executeQuorumApprovedToolForStrategy(
  toolCall: ToolCall,
  log: Logger,
  context?: Partial<ToolExecutionContext>
): Promise<ToolResult> {
  const parsed = parseStrategyToolCall(toolCall, log, context);
  if ('errorResult' in parsed) return parsed.errorResult;

  if (!toolRegistry.isInitialized()) {
    log.warn('Tool registry not initialized — tool execution unavailable in strategy context');
    return {
      tool_call_id: toolCall.id,
      success: false,
      error: 'Tool registry not yet initialized.',
    };
  }

  const registration = toolRegistry.get(parsed.functionName);
  if (registration?.strategyExecutionMode !== 'quorumOnly') {
    return {
      tool_call_id: toolCall.id,
      success: false,
      error: `Tool "${parsed.functionName}" is not registered strategyExecutionMode:'quorumOnly' — refusing the quorum-bypass execution path.`,
    };
  }

  return toolRegistry.execute(parsed.functionName, parsed.args, toolCall.id, parsed.execContext);
}
