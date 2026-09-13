// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `agents` — a BOUNDED agentic loop (ADR-024).
 *
 * This is deliberately not an autonomous agent. The bounds are structural,
 * not advisory:
 *
 * - The step counter lives in this function's local scope. Nothing the model
 *   emits can reset, extend or read it, so "ignore your limits and keep
 *   going" in a prompt-injected tool result changes nothing.
 * - The step ceiling is clamped by `resolveAgentLimits()` to at most
 *   `AGENT_MAX_STEPS_CEILING`, above any operator configuration.
 * - A wall-clock budget covers the WHOLE run and is checked before each step,
 *   so a run cannot outlive it by a step's duration more than once.
 * - Every tool call goes through the tool registry's strategy-safe path, which
 *   for `computer_use` means the container sandbox and its own limits.
 *
 * Termination is total: the loop stops on success, `max_steps_reached`,
 * `timeout`, or `error`. There is no path that leaves it running.
 *
 * MODEL SELECTION IS DYNAMIC. This module takes an *invoker* callback and
 * never names a model or provider. Which model runs a given step remains the
 * existing dynamic selection path's decision; the loop only records the id the
 * invoker reports, for the audit trail.
 */

import { randomUUID } from 'node:crypto';
import { toolRegistry } from '@/core/tools/tool-registry';
import type { ToolExecutionContext } from '@/services/advanced-tool-execution-service';
import { logger } from '@/utils/logger';
import { isAgentsEnabled, resolveAgentLimits } from '@/core/sandbox/sandbox-policy';
import {
  recordAgentRun,
  recordAgentStep,
  type AgentStopReason,
} from '@/core/sandbox/sandbox-audit';

const log = logger.child({ component: 'agent-loop' });

/** One message in the loop's transcript. */
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on `tool` messages, correlating back to the call. */
  toolCallId?: string;
  name?: string;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** What one model turn produced. */
export interface AgentModelTurn {
  /** Assistant text. When there are no tool calls, this is the final answer. */
  content?: string;
  toolCalls?: AgentToolCall[];
  /** Model actually used, for the audit trail. Never supplied by this module. */
  modelId?: string;
}

/**
 * Invokes a model for one step.
 *
 * Supplied by the caller so that model/provider selection stays in the
 * existing dynamic selection path. This module must never construct one.
 */
export type AgentModelInvoker = (params: {
  messages: readonly AgentMessage[];
  /** Names of the tools this run is permitted to use. */
  availableTools: readonly string[];
  stepIndex: number;
}) => Promise<AgentModelTurn>;

export interface AgentRunOptions {
  /** Initial transcript. Typically a system prompt plus the user's task. */
  messages: readonly AgentMessage[];
  invoke: AgentModelInvoker;
  /**
   * Tools this run may call. A call to anything outside this list is refused
   * — the allowlist is enforced here, in code, not described in the prompt.
   */
  allowedTools: readonly string[];
  context: ToolExecutionContext;
  runId?: string;
}

export interface AgentStepTrace {
  stepIndex: number;
  modelId?: string;
  assistantContent?: string;
  toolCalls: Array<{
    name: string;
    success: boolean;
    /** Refusal reason when the tool was not permitted. */
    refusedReason?: string;
  }>;
  durationMs: number;
}

export interface AgentRunResult {
  runId: string;
  stopReason: AgentStopReason;
  /** Last assistant text produced. */
  finalContent?: string;
  steps: AgentStepTrace[];
  messages: AgentMessage[];
  durationMs: number;
  /** Populated when `stopReason === 'error'`. */
  error?: string;
}

/**
 * Run the bounded agent loop.
 *
 * Never throws: every terminal condition, including a throwing invoker, is
 * reported as a typed `AgentRunResult` so a caller can always render an
 * outcome and the audit trail always closes.
 */
export async function runBoundedAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const runId = options.runId ?? randomUUID();
  const startedAt = Date.now();
  const messages: AgentMessage[] = [...options.messages];
  const steps: AgentStepTrace[] = [];

  const finish = (stopReason: AgentStopReason, extra: Partial<AgentRunResult> = {}): AgentRunResult => {
    const durationMs = Date.now() - startedAt;
    recordAgentRun({
      runId,
      stopReason,
      steps: steps.length,
      durationMs,
      organizationId: options.context.organizationId,
      userId: options.context.userId,
    });
    return {
      runId,
      stopReason,
      steps,
      messages,
      durationMs,
      finalContent: lastAssistantContent(messages),
      ...extra,
    };
  };

  if (!isAgentsEnabled()) {
    // Flag off is a normal, reported outcome — not an exception.
    log.info({ runId }, 'agents disabled (set AGENTIC_AGENTS_ENABLED=true to enable)');
    return finish('disabled');
  }

  const limits = resolveAgentLimits();
  const deadline = startedAt + limits.maxDurationMs;
  const allowed = new Set(options.allowedTools);

  for (let stepIndex = 0; stepIndex < limits.maxSteps; stepIndex += 1) {
    // Budget is checked BEFORE the step, so an expired run never starts
    // another model call or container.
    if (Date.now() >= deadline) {
      log.info({ runId, stepIndex }, 'agent run stopped: wall-clock budget exhausted');
      return finish('timeout');
    }

    const stepStarted = Date.now();
    let turn: AgentModelTurn;
    try {
      turn = await options.invoke({ messages, availableTools: [...allowed], stepIndex });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordAgentStep({
        runId,
        stepIndex,
        outcome: 'model_error',
        durationMs: Date.now() - stepStarted,
        organizationId: options.context.organizationId,
        userId: options.context.userId,
        reason: message,
      });
      steps.push({ stepIndex, toolCalls: [], durationMs: Date.now() - stepStarted });
      return finish('error', { error: message });
    }

    if (turn.content) {
      messages.push({ role: 'assistant', content: turn.content });
    }

    const toolCalls = turn.toolCalls ?? [];

    // No tool calls ⇒ the model produced a final answer. This is the success
    // stop condition.
    if (toolCalls.length === 0) {
      recordAgentStep({
        runId,
        stepIndex,
        modelId: turn.modelId,
        outcome: 'ok',
        durationMs: Date.now() - stepStarted,
        organizationId: options.context.organizationId,
        userId: options.context.userId,
      });
      steps.push({
        stepIndex,
        modelId: turn.modelId,
        assistantContent: turn.content,
        toolCalls: [],
        durationMs: Date.now() - stepStarted,
      });
      return finish('success');
    }

    const trace: AgentStepTrace['toolCalls'] = [];
    for (const call of toolCalls) {
      // Allowlist enforced in code. An injected instruction can at most ask
      // for a tool that was already permitted.
      if (!allowed.has(call.name)) {
        const reason = `Tool '${call.name}' is not permitted in this agent run`;
        trace.push({ name: call.name, success: false, refusedReason: reason });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: reason,
        });
        recordAgentStep({
          runId,
          stepIndex,
          modelId: turn.modelId,
          toolName: call.name,
          outcome: 'blocked',
          durationMs: Date.now() - stepStarted,
          organizationId: options.context.organizationId,
          userId: options.context.userId,
          reason,
        });
        continue;
      }

      // `executeForStrategy` re-checks `safeForStrategies` and never throws.
      const result = await toolRegistry.executeForStrategy(
        call.name,
        call.arguments,
        call.id,
        options.context
      );
      trace.push({ name: call.name, success: result.success });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.success ? (result.output ?? '') : (result.error ?? 'Tool failed'),
      });
      recordAgentStep({
        runId,
        stepIndex,
        modelId: turn.modelId,
        toolName: call.name,
        outcome: result.success ? 'ok' : 'tool_error',
        durationMs: Date.now() - stepStarted,
        organizationId: options.context.organizationId,
        userId: options.context.userId,
        reason: result.success ? undefined : result.error,
      });
    }

    steps.push({
      stepIndex,
      modelId: turn.modelId,
      assistantContent: turn.content,
      toolCalls: trace,
      durationMs: Date.now() - stepStarted,
    });
  }

  log.info({ runId, maxSteps: limits.maxSteps }, 'agent run stopped: step ceiling reached');
  return finish('max_steps_reached');
}

function lastAssistantContent(messages: readonly AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') return messages[index].content;
  }
  return undefined;
}
