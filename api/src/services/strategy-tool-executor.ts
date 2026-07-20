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
 * Strategies can only execute tools marked as `safeForStrategies: true` in the registry.
 *
 * All tools (web_search, code_execute, read_file, grep_search, etc.) are REAL implementations
 * backed by the same tool infrastructure used by the chat processor. No stubs.
 */

import type { ToolCall } from '@/types';
import type { ToolResult, ToolExecutionContext } from '@/services/advanced-tool-execution-service';
import type { Logger } from 'pino';
import { toolRegistry } from '@/core/tools/tool-registry';

/**
 * Execute a tool call on behalf of a strategy.
 * Only tools marked `safeForStrategies: true` in the registry are permitted.
 * Uses the SAME real implementations as the chat processor.
 */
export async function executeToolForStrategy(
  toolCall: ToolCall,
  log: Logger,
  context?: Partial<ToolExecutionContext>,
): Promise<ToolResult> {
  const functionName = toolCall.function?.name;
  const argsStr = toolCall.function?.arguments || '{}';

  if (!functionName) {
    return { tool_call_id: toolCall.id, success: false, error: 'No function name in tool call' };
  }

  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argsStr);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { tool_call_id: toolCall.id, success: false, error: `Tool arguments must be a JSON object: ${argsStr.substring(0, 200)}` };
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return { tool_call_id: toolCall.id, success: false, error: `Invalid JSON arguments: ${argsStr.substring(0, 200)}` };
  }

  const execContext: ToolExecutionContext = {
    workingDirectory: context?.workingDirectory || process.cwd(),
    log,
    organizationId: context?.organizationId,
    userId: context?.userId,
    timeout: context?.timeout || 30000,
  };

  if (!toolRegistry.isInitialized()) {
    log.warn('Tool registry not initialized — tool execution unavailable in strategy context');
    return { tool_call_id: toolCall.id, success: false, error: 'Tool registry not yet initialized.' };
  }

  return toolRegistry.executeForStrategy(functionName, args, toolCall.id, execContext);
}
