// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for `createDynamicAgentInvoker` (ADR-024, LOTE AV).
 *
 * Three things this invoker must get right, each with its own test:
 *   1. A text-only turn (no tool calls) — the common "final answer" case.
 *   2. A tool-call turn — arguments arrive as a JSON string from the
 *      provider and must be parsed into an object before reaching
 *      `AgentToolCall.arguments`.
 *   3. A provider/selection error propagates as a rejected promise rather
 *      than being swallowed — `agent-loop.ts` is the layer that turns a
 *      throwing invoker into a clean `stopReason: 'error'`, so this
 *      function must not do that itself.
 *
 * Also covers: it must never construct or pin a model/provider id — every
 * call goes through the mocked `getDynamicModelSelector()` — per the
 * session's permanent no-hardcoded-model rule.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { OrchestrationContext, Tool } from '@/types';

const selectModelsMock = vi.fn();
const providerGetMock = vi.fn();
const toolRegistryGetMock = vi.fn();

vi.mock('@/core/selection/dynamic-model-selector', () => ({
  getDynamicModelSelector: () => ({ selectModels: selectModelsMock }),
}));
vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({ get: providerGetMock }),
}));
vi.mock('@/core/tools/tool-registry', () => ({
  toolRegistry: { get: toolRegistryGetMock },
}));

const userContext: OrchestrationContext = {
  organizationId: 'org-1',
  userId: 'user-1',
  requestId: 'req-1',
  models: [],
  taskType: 'general',
  contextSize: 4096,
};

async function loadInvoker() {
  const { createDynamicAgentInvoker } = await import('../agent-model-invoker');
  return createDynamicAgentInvoker('req-1', userContext);
}

describe('createDynamicAgentInvoker', () => {
  beforeEach(() => {
    selectModelsMock.mockReset();
    providerGetMock.mockReset();
    toolRegistryGetMock.mockReset();
  });

  it('never hardcodes a model/provider id — always asks the dynamic selector', async () => {
    const chatCompletion = vi.fn().mockResolvedValue({
      id: 'r1',
      object: 'chat.completion',
      created: 0,
      model: 'dyn-model-a',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });
    selectModelsMock.mockResolvedValue([
      { model: { id: 'dyn-model-a', provider: 'dyn-provider-a' }, score: 1, reason: 'test' },
    ]);
    providerGetMock.mockImplementation((name: string) =>
      name === 'dyn-provider-a' ? { chatCompletion } : undefined
    );

    const invoke = await loadInvoker();
    await invoke({ messages: [{ role: 'user', content: 'hi' }], availableTools: [], stepIndex: 0 });

    expect(selectModelsMock).toHaveBeenCalledTimes(1);
    // criteria (2nd arg) and context (3rd arg) passed through; no model/provider literal.
    const [availableModels, criteria, context, maxModels] = selectModelsMock.mock.calls[0];
    expect(availableModels).toBeNull();
    expect(criteria.requiredCapabilities).toContain('tool_use');
    expect(context).toBe(userContext);
    expect(maxModels).toBe(1);
    expect(providerGetMock).toHaveBeenCalledWith('dyn-provider-a');
    expect(chatCompletion).toHaveBeenCalledWith(expect.objectContaining({ model: 'dyn-model-a' }));
  });

  it('a text-only turn (no tool calls) returns content and no toolCalls', async () => {
    selectModelsMock.mockResolvedValue([
      { model: { id: 'm1', provider: 'p1' }, score: 1, reason: 'test' },
    ]);
    providerGetMock.mockReturnValue({
      chatCompletion: vi.fn().mockResolvedValue({
        id: 'r1',
        object: 'chat.completion',
        created: 0,
        model: 'm1',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'final answer' }, finish_reason: 'stop' },
        ],
      }),
    });

    const invoke = await loadInvoker();
    const turn = await invoke({
      messages: [{ role: 'user', content: 'question' }],
      availableTools: [],
      stepIndex: 0,
    });

    expect(turn.content).toBe('final answer');
    expect(turn.toolCalls).toBeUndefined();
    expect(turn.modelId).toBe('m1');
  });

  it('a tool-call turn parses JSON-string arguments into an object', async () => {
    selectModelsMock.mockResolvedValue([
      { model: { id: 'm1', provider: 'p1' }, score: 1, reason: 'test' },
    ]);
    const fakeTool: Tool = {
      type: 'function',
      function: { name: 'computer_shell', description: 'run a command', parameters: {} },
    };
    toolRegistryGetMock.mockImplementation((name: string) =>
      name === 'computer_shell'
        ? { name: 'computer_shell', description: fakeTool.function.description, parameters: {} }
        : undefined
    );
    providerGetMock.mockReturnValue({
      chatCompletion: vi.fn().mockResolvedValue({
        id: 'r1',
        object: 'chat.completion',
        created: 0,
        model: 'm1',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'computer_shell', arguments: '{"command":"echo","args":["hi"]}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    });

    const invoke = await loadInvoker();
    const turn = await invoke({
      messages: [{ role: 'user', content: 'run echo hi' }],
      availableTools: ['computer_shell'],
      stepIndex: 0,
    });

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls?.[0]).toEqual({
      id: 'call_1',
      name: 'computer_shell',
      arguments: { command: 'echo', args: ['hi'] },
    });
  });

  it('malformed JSON arguments become an empty object rather than throwing', async () => {
    selectModelsMock.mockResolvedValue([
      { model: { id: 'm1', provider: 'p1' }, score: 1, reason: 'test' },
    ]);
    providerGetMock.mockReturnValue({
      chatCompletion: vi.fn().mockResolvedValue({
        id: 'r1',
        object: 'chat.completion',
        created: 0,
        model: 'm1',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'some_tool', arguments: 'not json' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    });

    const invoke = await loadInvoker();
    const turn = await invoke({ messages: [], availableTools: [], stepIndex: 0 });

    expect(turn.toolCalls?.[0]).toEqual({ id: 'call_1', name: 'some_tool', arguments: {} });
  });

  it('propagates a selection error rather than swallowing it', async () => {
    selectModelsMock.mockRejectedValue(new Error('selector exploded'));

    const invoke = await loadInvoker();
    await expect(
      invoke({ messages: [], availableTools: [], stepIndex: 0 })
    ).rejects.toThrow('selector exploded');
  });

  it('throws a clear error when no model is dynamically selected', async () => {
    selectModelsMock.mockResolvedValue([]);

    const invoke = await loadInvoker();
    await expect(invoke({ messages: [], availableTools: [], stepIndex: 0 })).rejects.toThrow(
      /No model dynamically selected/
    );
  });

  it('throws a clear error when the selected model names an unregistered provider', async () => {
    selectModelsMock.mockResolvedValue([
      { model: { id: 'm1', provider: 'ghost-provider' }, score: 1, reason: 'test' },
    ]);
    providerGetMock.mockReturnValue(undefined);

    const invoke = await loadInvoker();
    await expect(invoke({ messages: [], availableTools: [], stepIndex: 0 })).rejects.toThrow(
      /ghost-provider/
    );
  });
});
