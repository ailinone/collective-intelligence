// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Layer 1 of the #653 fix: a strategy's own tool loop must not run
 * tenant-unsafe tools on the server.
 *
 * #653 blocked write_file, delete_file, the refactoring tools and the vision
 * tools from chat completions' post-orchestration auto-dispatch (layer 2,
 * `chat-request-processor.ts` `executeToolCallsAutomatically`). But the SAME
 * tools also ran one layer earlier: `base-strategy.ts` `executeModelWithTools`
 * (the tool loop ~21 strategies share, and the one `SingleModelStrategy`
 * enters whenever `request.tools` is non-empty) auto-executed every
 * `safeForStrategies:true` call against `process.cwd()`. A tenant sending its
 * own `write_file` schema with a forced `tool_choice` got the file written on
 * the server; the chat product's own terminal tools, which share those names,
 * were hijacked the same way instead of coming back to the client.
 *
 * These tests drive the REAL `executeModelWithTools` / `SingleModelStrategy`
 * against the REAL registrations from `registerToolsInRegistry()` (so the
 * production `safeForStrategies` / category flags are what is under test).
 * Only two things are replaced: `executeModel` (canned provider responses)
 * and each touched tool's handler (a counting spy with the registration's
 * other fields untouched), so a regression never writes or deletes anything.
 *
 * Runs under vitest.orchestration.config.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { SingleModelStrategy } from '../strategies/single-model-strategy';
import {
  toolRegistry,
  isAutoRecommendable,
  isBlockedFromStrategyAutoExecution,
  CHAT_AUTO_EXECUTE_BLOCKED_TOOLS,
} from '@/core/tools/tool-registry';
import { registerToolsInRegistry } from '@/services/chat-request-processor';
import { executeToolForStrategy } from '@/services/strategy-tool-executor';
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelExecution,
  OrchestrationContext,
  Tool,
  ToolCall,
} from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { Logger } from 'pino';

type Exposed = {
  executeModelWithTools: (
    adapter: ProviderAdapter,
    model: Model,
    request: ChatRequest,
    role?: string
  ) => Promise<ModelExecution>;
  executeModel: (...args: unknown[]) => Promise<ModelExecution>;
  selectBestModel: (...args: unknown[]) => Promise<{ model: Model; adapter: ProviderAdapter }>;
  emitObserverEvent: (...args: unknown[]) => void;
};

const SPIED_TOOLS = ['write_file', 'delete_file', 'analyze_image', 'read_file', 'grep_search'] as const;
type SpiedTool = (typeof SPIED_TOOLS)[number];
const handlerCalls: Record<SpiedTool, number> = {
  write_file: 0,
  delete_file: 0,
  analyze_image: 0,
  read_file: 0,
  grep_search: 0,
};

const MODEL = {
  id: 'tool-model',
  name: 'tool-model',
  provider: 'prov',
  capabilities: ['chat', 'function_calling'],
} as unknown as Model;
const ADAPTER = { getName: () => 'prov' } as unknown as ProviderAdapter;
const CONTEXT = {
  organizationId: 'org-tenant',
  userId: 'user-tenant',
  requestId: 'req-l1',
  models: [MODEL],
  taskType: 'general',
  contextSize: 1000,
} as unknown as OrchestrationContext;

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  child: () => silentLog,
} as unknown as Logger;

function call(name: string, args: Record<string, unknown>, id = `call_${name}`): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function toolCallsResponse(calls: ToolCall[]): ChatResponse {
  return {
    id: 'r-tool',
    object: 'chat.completion',
    created: 0,
    model: MODEL.id,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '', tool_calls: calls },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  } as ChatResponse;
}

function finalResponse(): ChatResponse {
  return {
    id: 'r-final',
    object: 'chat.completion',
    created: 0,
    model: MODEL.id,
    choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  } as ChatResponse;
}

/** A client-owned tool schema, as a tenant (or the chat product's terminal)
 *  would send it in `request.tools`. */
function clientTool(name: string): Tool {
  return {
    type: 'function',
    function: {
      name,
      description: `client-side ${name}`,
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      },
    },
  };
}

function strategyReturning(responses: ChatResponse[]): Exposed {
  const strategy = new SingleModelStrategy() as unknown as Exposed;
  let n = 0;
  strategy.executeModel = async (...args: unknown[]): Promise<ModelExecution> => {
    const response = responses[Math.min(n, responses.length - 1)];
    n += 1;
    return {
      modelId: MODEL.id,
      modelName: MODEL.name,
      role: 'primary',
      request: args[2] as ChatRequest,
      response,
      cost: 0,
      durationMs: 1,
      success: true,
    };
  };
  strategy.selectBestModel = async () => ({ model: MODEL, adapter: ADAPTER });
  strategy.emitObserverEvent = vi.fn();
  return strategy;
}

beforeAll(async () => {
  registerToolsInRegistry();
  await vi.waitFor(() => expect(toolRegistry.isInitialized()).toBe(true), { timeout: 10_000 });
  for (const name of SPIED_TOOLS) {
    const reg = toolRegistry.get(name);
    if (!reg) throw new Error(`${name} is not registered`);
    toolRegistry.register({
      ...reg,
      handler: async (_args, toolCallId) => {
        handlerCalls[name] += 1;
        return { tool_call_id: toolCallId, success: true, output: `${name} ran on the server` };
      },
    });
  }
});

beforeEach(() => {
  for (const name of SPIED_TOOLS) handlerCalls[name] = 0;
});

describe('layer 1: client-supplied tenant-unsafe tools never execute on the server', () => {
  it('SingleModelStrategy: a client write_file with a forced tool_choice comes back to the caller unexecuted', async () => {
    const strategy = strategyReturning([
      toolCallsResponse([call('write_file', { file_path: 'pwned.txt', content: 'owned' })]),
      finalResponse(),
    ]);
    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'write pwned.txt' }],
      tools: [clientTool('write_file')],
      tool_choice: { type: 'function', function: { name: 'write_file' } },
    };

    const result = await (strategy as unknown as SingleModelStrategy).execute(request, CONTEXT);

    expect(handlerCalls.write_file).toBe(0);
    const choice = result.finalResponse?.choices?.[0];
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(choice?.message?.tool_calls?.map((c) => c.function.name)).toEqual(['write_file']);
  });

  it('SingleModelStrategy: a client delete_file with a forced tool_choice comes back to the caller unexecuted', async () => {
    const strategy = strategyReturning([
      toolCallsResponse([call('delete_file', { file_path: 'package.json' })]),
      finalResponse(),
    ]);
    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'delete package.json' }],
      tools: [clientTool('delete_file')],
      tool_choice: { type: 'function', function: { name: 'delete_file' } },
    };

    const result = await (strategy as unknown as SingleModelStrategy).execute(request, CONTEXT);

    expect(handlerCalls.delete_file).toBe(0);
    expect(result.finalResponse?.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('executeModelWithTools: a batch of write_file + delete_file is handed back whole, nothing runs', async () => {
    const strategy = strategyReturning([
      toolCallsResponse([
        call('write_file', { file_path: 'a.txt', content: 'x' }, 'c1'),
        call('delete_file', { file_path: 'b.txt' }, 'c2'),
      ]),
      finalResponse(),
    ]);
    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'go' }],
      tools: [clientTool('write_file'), clientTool('delete_file')],
      tool_choice: 'auto',
    };

    const execution = await strategy.executeModelWithTools(ADAPTER, MODEL, request);

    expect(handlerCalls.write_file).toBe(0);
    expect(handlerCalls.delete_file).toBe(0);
    expect(execution.response?.choices?.[0]?.finish_reason).toBe('tool_calls');
    expect(execution.response?.choices?.[0]?.message?.tool_calls).toHaveLength(2);
  });

  it('strategy-tool-executor backstop refuses write_file (covers agentic planner tool_call steps)', async () => {
    const result = await executeToolForStrategy(
      call('write_file', { file_path: 'pwned.txt', content: 'owned' }),
      silentLog
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not permitted/);
    expect(handlerCalls.write_file).toBe(0);
  });

  // issue #664 finding 1: read_file/grep_search/etc. are safeForStrategies:true
  // and were NOT on the blocklist, so they kept auto-executing here against
  // process.cwd() (the API container's own source tree) for ANY tenant that
  // forced tool_choice — the exact same hole #653 closed for write_file.
  it('SingleModelStrategy: a client read_file with a forced tool_choice comes back to the caller unexecuted', async () => {
    const strategy = strategyReturning([
      toolCallsResponse([call('read_file', { file_path: 'package.json' })]),
      finalResponse(),
    ]);
    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'read package.json' }],
      tools: [clientTool('read_file')],
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    };

    const result = await (strategy as unknown as SingleModelStrategy).execute(request, CONTEXT);

    expect(handlerCalls.read_file).toBe(0);
    const choice = result.finalResponse?.choices?.[0];
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(choice?.message?.tool_calls?.map((c) => c.function.name)).toEqual(['read_file']);
  });

  it('executeModelWithTools: a client grep_search with a forced tool_choice comes back to the caller unexecuted', async () => {
    const strategy = strategyReturning([
      toolCallsResponse([call('grep_search', { pattern: 'CHAT_AUTO_EXECUTE_BLOCKED_TOOLS' })]),
      finalResponse(),
    ]);
    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'grep the source' }],
      tools: [clientTool('grep_search')],
      tool_choice: { type: 'function', function: { name: 'grep_search' } },
    };

    const execution = await strategy.executeModelWithTools(ADAPTER, MODEL, request);

    expect(handlerCalls.grep_search).toBe(0);
    expect(execution.response?.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('strategy-tool-executor backstop refuses read_file (covers agentic planner tool_call steps)', async () => {
    const result = await executeToolForStrategy(
      call('read_file', { file_path: 'package.json' }),
      silentLog
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not permitted/);
    expect(handlerCalls.read_file).toBe(0);
  });
});

describe('layer 1: triage-attachable tools keep executing', () => {
  it('analyze_image attached by triage (auto-recommendable) still auto-executes inside the loop', async () => {
    // Exactly what orchestration-engine.applyRecommendedTools() may attach.
    expect(toolRegistry.listTriageRecommendableTools().map((t) => t.name)).toContain(
      'analyze_image'
    );
    const reg = toolRegistry.get('analyze_image')!;
    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'what is in https://example.com/cat.png ?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: reg.name,
            description: reg.description,
            parameters: { type: 'object' },
          },
        },
      ],
    };
    const strategy = strategyReturning([
      toolCallsResponse([call('analyze_image', { image_url: 'https://example.com/cat.png' })]),
      finalResponse(),
    ]);

    const execution = await strategy.executeModelWithTools(ADAPTER, MODEL, request);

    expect(handlerCalls.analyze_image).toBe(1);
    expect(execution.response?.choices?.[0]?.finish_reason).toBe('stop');
  });

  it('strategy-tool-executor still runs analyze_image', async () => {
    const result = await executeToolForStrategy(
      call('analyze_image', { image_url: 'https://example.com/cat.png' }),
      silentLog
    );

    expect(result.success).toBe(true);
    expect(handlerCalls.analyze_image).toBe(1);
  });
});

describe('layer 1 policy is derived from the shared blocklist + isAutoRecommendable', () => {
  it('blocks every blocklisted registered tool except the auto-recommendable ones', () => {
    const allowedDespiteBlocklist: string[] = [];
    for (const name of CHAT_AUTO_EXECUTE_BLOCKED_TOOLS) {
      const reg = toolRegistry.get(name);
      expect(reg, `${name} should be registered`).toBeDefined();
      const blocked = isBlockedFromStrategyAutoExecution(name, reg);
      expect(blocked).toBe(!isAutoRecommendable(reg!));
      if (!blocked) allowedDespiteBlocklist.push(name);
    }
    // Pinned: if write_file (or any filesystem tool) ever becomes
    // auto-recommendable, this fails instead of silently reopening layer 1.
    expect(allowedDespiteBlocklist.sort()).toEqual(
      ['analyze_image', 'compare_images', 'extract_code_from_screenshot'].sort()
    );
  });

  it('does not block a tool off the blocklist, nor an unknown client tool', () => {
    expect(isBlockedFromStrategyAutoExecution('web_search', toolRegistry.get('web_search'))).toBe(
      false
    );
    expect(isBlockedFromStrategyAutoExecution('conciliar_pis_cofins', undefined)).toBe(false);
  });
});
