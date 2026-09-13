// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dynamic model invoker for the bounded agent loop (ADR-024, LOTE AV).
 *
 * `runBoundedAgent()` (agent-loop.ts) takes an `AgentModelInvoker` callback
 * and never names a model or provider itself — model/provider selection must
 * stay in the existing dynamic selection path, per the session's permanent
 * "never hardcode a model/provider id" rule. This module is that callback.
 *
 * Two things this invoker must NOT do, both load-bearing:
 *
 * 1. It must not go through `getCapabilityExecutionService().executeWithCapabilities()`
 *    or `OrchestrationEngine.execute()`. Those enter a strategy's own
 *    `executeModelWithTools`, which has ITS OWN internal tool-auto-execution
 *    loop. Stacking that under `runBoundedAgent` — which also executes tool
 *    calls itself, via `toolRegistry.executeForStrategy` — would double-run
 *    tool calls against the sandbox under two uncoordinated bounding
 *    mechanisms. This invoker performs exactly ONE model turn per call and
 *    returns proposed tool calls without executing them; `agent-loop.ts`
 *    owns execution.
 *
 * 2. It must never construct or pin a model/provider id. Every step asks
 *    `getDynamicModelSelector()` fresh.
 */

import { logger } from '@/utils/logger';
import { getDynamicModelSelector } from '@/core/selection/dynamic-model-selector';
import { getProviderRegistry } from '@/providers/provider-registry';
import { toolRegistry } from '@/core/tools/tool-registry';
import type { AgentModelInvoker, AgentToolCall } from './agent-loop';
import type { ChatMessage, OrchestrationContext, Tool } from '@/types';

const log = logger.child({ component: 'agent-model-invoker' });

/**
 * Build an `AgentModelInvoker` bound to one request's identity/context.
 *
 * `userContext` is the same `OrchestrationContext` already threaded through
 * every other capability-execution mode (`getUserContext(request)` in
 * capabilities-routes.ts) — it carries `organizationId`/`userId` for the
 * dynamic selector's tenant-scoped scoring and for the audit trail.
 */
export function createDynamicAgentInvoker(
  requestId: string,
  userContext: OrchestrationContext
): AgentModelInvoker {
  return async ({ messages, availableTools, stepIndex }) => {
    const selector = getDynamicModelSelector();
    const selected = await selector.selectModels(
      null,
      {
        taskType: 'general',
        complexity: 'medium',
        contextSize: estimateContextSize(messages),
        requiredCapabilities: ['tool_use'],
      },
      userContext,
      1
    );

    if (selected.length === 0) {
      throw new Error(
        'No model dynamically selected for this agent step (requiredCapabilities: tool_use)'
      );
    }

    const { model } = selected[0];
    const adapter = getProviderRegistry().get(model.provider);
    if (!adapter) {
      throw new Error(
        `Dynamically selected model '${model.id}' names provider '${model.provider}', which has no registered adapter`
      );
    }

    const tools = buildToolDefinitions(availableTools);
    const chatMessages: ChatMessage[] = messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.name ? { name: message.name } : {}),
    }));

    log.debug(
      { requestId, stepIndex, modelId: model.id, provider: model.provider, toolCount: tools.length },
      'agent-model-invoker: dispatching one model turn'
    );

    const response = await adapter.chatCompletion({
      model: model.id,
      messages: chatMessages,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
    });

    const message = response.choices[0]?.message;
    const toolCalls = parseToolCalls(message?.tool_calls, requestId, stepIndex);

    return {
      content: typeof message?.content === 'string' ? message.content : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      modelId: model.id,
    };
  };
}

/** Rough token-free context-size estimate: total character count / 4. */
function estimateContextSize(messages: readonly { content: string }[]): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/** Project registered tool names onto the provider-facing `Tool[]` shape. */
function buildToolDefinitions(names: readonly string[]): Tool[] {
  const tools: Tool[] = [];
  for (const name of names) {
    const registration = toolRegistry.get(name);
    if (!registration) continue;
    tools.push({
      type: 'function',
      function: {
        name: registration.name,
        description: registration.description,
        parameters: registration.parameters ?? { type: 'object', properties: {} },
      },
    });
  }
  return tools;
}

/**
 * Parse a provider's raw `tool_calls` (JSON-string arguments) into the
 * agent loop's `AgentToolCall` shape. A malformed arguments string becomes
 * an empty-object call rather than a thrown error — the tool itself, or the
 * `allowedTools` check, is the right place to reject a bad call, not the
 * parser.
 */
function parseToolCalls(
  rawCalls: ChatMessage['tool_calls'],
  requestId: string,
  stepIndex: number
): AgentToolCall[] {
  if (!rawCalls || rawCalls.length === 0) return [];
  return rawCalls.map((call) => {
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || '{}');
      if (parsed && typeof parsed === 'object') {
        args = parsed as Record<string, unknown>;
      }
    } catch (err) {
      log.warn(
        {
          requestId,
          stepIndex,
          toolCallId: call.id,
          toolName: call.function.name,
          err: err instanceof Error ? err.message : String(err),
        },
        'agent-model-invoker: tool call arguments were not valid JSON, treating as empty'
      );
    }
    return { id: call.id, name: call.function.name, arguments: args };
  });
}
