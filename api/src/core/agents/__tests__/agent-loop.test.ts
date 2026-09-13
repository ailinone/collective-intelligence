// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Bounded agent loop (ADR-024, LOTE AQ, 2026-09-05).
 *
 * The properties under test are the BOUNDS, not the reasoning. Each test
 * describes a way an unbounded agent would misbehave and asserts that this
 * loop cannot: it stops at the step ceiling, it stops at the wall-clock
 * budget, it refuses tools outside its allowlist, it terminates on a throwing
 * model, and it does nothing at all while the feature flag is off.
 *
 * The model invoker is a stub — deliberately. What is being verified is the
 * loop's control flow, and a stub lets a test express "a model that never
 * stops asking for tools", which is exactly the adversary the bounds exist
 * for. The sandbox isolation these tool calls ultimately hit is proven
 * separately, against real Docker, in
 * `core/sandbox/__tests__/container-sandbox-adversarial.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logger } from '@/utils/logger';
import { toolRegistry } from '@/core/tools/tool-registry';
import type { ToolExecutionContext } from '@/services/advanced-tool-execution-service';
import { runBoundedAgent, type AgentModelInvoker } from '../agent-loop';

const ENV_KEYS = ['AGENTIC_AGENTS_ENABLED', 'AGENT_MAX_STEPS', 'AGENT_MAX_DURATION_MS'] as const;
const saved: Record<string, string | undefined> = {};

const context: ToolExecutionContext = {
  workingDirectory: process.cwd(),
  log: logger.child({ component: 'agent-loop-test' }),
  organizationId: 'org-test',
  userId: 'user-test',
};

/** A tool that always succeeds, registered for the duration of this file. */
const ECHO_TOOL = 'agent_loop_test_echo';
/** A tool that exists and is strategy-safe but is NOT in the run's allowlist. */
const OFF_LIST_TOOL = 'agent_loop_test_offlist';
/** A tool the registry itself forbids to strategies. */
const UNSAFE_TOOL = 'agent_loop_test_unsafe';

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AGENTIC_AGENTS_ENABLED = 'true';

  toolRegistry.register({
    name: ECHO_TOOL,
    description: 'test echo',
    category: 'general',
    safeForStrategies: true,
    autoRecommendable: false,
    handler: async (args, toolCallId) => ({
      tool_call_id: toolCallId,
      success: true,
      output: `echo:${String(args.value ?? '')}`,
    }),
  });
  toolRegistry.register({
    name: OFF_LIST_TOOL,
    description: 'test off-list',
    category: 'general',
    safeForStrategies: true,
    autoRecommendable: false,
    handler: async (_args, toolCallId) => ({
      tool_call_id: toolCallId,
      success: true,
      output: 'SHOULD_NOT_RUN',
    }),
  });
  toolRegistry.register({
    name: UNSAFE_TOOL,
    description: 'test unsafe',
    category: 'file',
    safeForStrategies: false,
    handler: async (_args, toolCallId) => ({
      tool_call_id: toolCallId,
      success: true,
      output: 'SHOULD_NOT_RUN',
    }),
  });
  toolRegistry.markInitialized();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** An invoker that requests the echo tool forever — it never volunteers to stop. */
const neverStops: AgentModelInvoker = async ({ stepIndex }) => ({
  modelId: `dynamic-model-${stepIndex}`,
  content: `step ${stepIndex}`,
  toolCalls: [{ id: `call-${stepIndex}`, name: ECHO_TOOL, arguments: { value: stepIndex } }],
});

describe('bounded agent loop — the bounds hold against a model that never stops', () => {
  it('stops at the configured step ceiling', async () => {
    process.env.AGENT_MAX_STEPS = '3';

    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: neverStops,
      allowedTools: [ECHO_TOOL],
      context,
    });

    expect(result.stopReason).toBe('max_steps_reached');
    expect(result.steps).toHaveLength(3);
  });

  it('clamps an operator step ceiling above the hard limit', async () => {
    process.env.AGENT_MAX_STEPS = '5000';

    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: neverStops,
      allowedTools: [ECHO_TOOL],
      context,
    });

    expect(result.stopReason).toBe('max_steps_reached');
    expect(
      result.steps.length,
      'the hard ceiling must win over operator configuration'
    ).toBeLessThanOrEqual(32);
  });

  it('stops at the wall-clock budget even when steps remain', async () => {
    process.env.AGENT_MAX_STEPS = '32';
    process.env.AGENT_MAX_DURATION_MS = '1000';

    const slow: AgentModelInvoker = async ({ stepIndex }) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        content: `slow ${stepIndex}`,
        toolCalls: [{ id: `c-${stepIndex}`, name: ECHO_TOOL, arguments: {} }],
      };
    };

    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: slow,
      allowedTools: [ECHO_TOOL],
      context,
    });

    expect(result.stopReason).toBe('timeout');
    expect(result.steps.length, 'must stop well before the 32-step ceiling').toBeLessThan(32);
  }, 20_000);

  it('a step counter the model cannot influence: extra tool calls in one turn do not buy extra steps', async () => {
    process.env.AGENT_MAX_STEPS = '2';

    const greedy: AgentModelInvoker = async ({ stepIndex }) => ({
      content: `greedy ${stepIndex}`,
      toolCalls: Array.from({ length: 10 }, (_unused, index) => ({
        id: `c-${stepIndex}-${index}`,
        name: ECHO_TOOL,
        arguments: { value: index },
      })),
    });

    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: greedy,
      allowedTools: [ECHO_TOOL],
      context,
    });

    expect(result.stopReason).toBe('max_steps_reached');
    expect(result.steps, 'ten tool calls per turn is still one step').toHaveLength(2);
  });
});

describe('bounded agent loop — the tool allowlist is enforced in code', () => {
  it('refuses a registered, strategy-safe tool that is not in the run allowlist', async () => {
    process.env.AGENT_MAX_STEPS = '1';

    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: async () => ({
        content: 'trying',
        toolCalls: [{ id: 'c1', name: OFF_LIST_TOOL, arguments: {} }],
      }),
      allowedTools: [ECHO_TOOL],
      context,
    });

    const call = result.steps[0].toolCalls[0];
    expect(call.success).toBe(false);
    expect(call.refusedReason).toContain('not permitted');
    // The decisive check: the handler never ran.
    expect(JSON.stringify(result.messages)).not.toContain('SHOULD_NOT_RUN');
  });

  it('refuses a tool the registry marks unsafe for strategies, even if the run allowlists it', async () => {
    process.env.AGENT_MAX_STEPS = '1';

    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: async () => ({
        content: 'trying',
        toolCalls: [{ id: 'c1', name: UNSAFE_TOOL, arguments: {} }],
      }),
      // Deliberately allowlisted by the run — the registry must still refuse.
      allowedTools: [UNSAFE_TOOL],
      context,
    });

    expect(result.steps[0].toolCalls[0].success).toBe(false);
    expect(JSON.stringify(result.messages)).not.toContain('SHOULD_NOT_RUN');
    expect(JSON.stringify(result.messages)).toContain('safety restriction');
  });

  it('refuses a tool that does not exist at all', async () => {
    process.env.AGENT_MAX_STEPS = '1';

    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: async () => ({
        content: 'trying',
        toolCalls: [{ id: 'c1', name: 'no_such_tool_anywhere', arguments: {} }],
      }),
      allowedTools: [ECHO_TOOL],
      context,
    });

    expect(result.steps[0].toolCalls[0].success).toBe(false);
  });
});

describe('bounded agent loop — termination is total', () => {
  it('stops with success when the model returns no tool calls', async () => {
    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: async () => ({ content: 'final answer', modelId: 'dynamic-model' }),
      allowedTools: [ECHO_TOOL],
      context,
    });

    expect(result.stopReason).toBe('success');
    expect(result.finalContent).toBe('final answer');
    expect(result.steps).toHaveLength(1);
  });

  it('stops with error when the model invoker throws, rather than propagating', async () => {
    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: async () => {
        throw new Error('provider exploded');
      },
      allowedTools: [ECHO_TOOL],
      context,
    });

    expect(result.stopReason).toBe('error');
    expect(result.error).toContain('provider exploded');
  });

  it('keeps running after a failing tool, and the failure reaches the transcript', async () => {
    process.env.AGENT_MAX_STEPS = '2';
    const failing = 'agent_loop_test_failing';
    toolRegistry.register({
      name: failing,
      description: 'always fails',
      category: 'general',
      safeForStrategies: true,
      autoRecommendable: false,
      handler: async (_args, toolCallId) => ({
        tool_call_id: toolCallId,
        success: false,
        error: 'deliberate tool failure',
      }),
    });

    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: async ({ stepIndex }) =>
        stepIndex === 0
          ? { content: 'call it', toolCalls: [{ id: 'c1', name: failing, arguments: {} }] }
          : { content: 'recovered' },
      allowedTools: [failing],
      context,
    });

    expect(result.stopReason).toBe('success');
    expect(JSON.stringify(result.messages)).toContain('deliberate tool failure');
  });
});

describe('bounded agent loop — feature flag', () => {
  it('does nothing when the capability is disabled', async () => {
    delete process.env.AGENTIC_AGENTS_ENABLED;
    let invoked = false;

    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: async () => {
        invoked = true;
        return { content: 'should not happen' };
      },
      allowedTools: [ECHO_TOOL],
      context,
    });

    expect(result.stopReason).toBe('disabled');
    expect(invoked, 'no model call may happen while the flag is off').toBe(false);
    expect(result.steps).toHaveLength(0);
  });

  it('does not enable on a near-miss flag value', async () => {
    process.env.AGENTIC_AGENTS_ENABLED = 'TRUE';
    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: async () => ({ content: 'x' }),
      allowedTools: [],
      context,
    });
    expect(result.stopReason).toBe('disabled');
  });
});

describe('bounded agent loop — no hardcoded model', () => {
  it('records whatever model the invoker reports, and never supplies one itself', async () => {
    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: async () => ({ content: 'done', modelId: 'whatever-selection-chose' }),
      allowedTools: [],
      context,
    });

    expect(result.steps[0].modelId).toBe('whatever-selection-chose');
  });

  it('runs fine when the invoker reports no model at all', async () => {
    const result = await runBoundedAgent({
      messages: [{ role: 'user', content: 'go' }],
      invoke: async () => ({ content: 'done' }),
      allowedTools: [],
      context,
    });

    expect(result.stopReason).toBe('success');
    expect(result.steps[0].modelId).toBeUndefined();
  });
});
