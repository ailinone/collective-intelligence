// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * executeModelWithTools()'s quorum-gated auto-execution — media-generation-
 * delegation plan, PR2.
 *
 * Background: `generate_video` was `safeForStrategies:false`, so
 * `executeModelWithTools` (base-strategy.ts) NEVER auto-executed it inside a
 * collective strategy's tool loop — the loop just handed the unexecuted
 * tool_calls back to the caller. PR2 adds a second, narrower path:
 * `strategyExecutionMode: 'quorumOnly'` lets a tool auto-execute WITHOUT
 * being unconditionally `safeForStrategies:true`, but ONLY when a strict
 * majority of the collective's voters (passed in via the new `quorumVoters`
 * parameter) independently proposed the EXACT SAME call — reusing
 * `computeQuorumToolCall()` (core/aggregation/response-aggregator.ts), the
 * same mechanism the response aggregator itself already used for its
 * post-hoc tool_calls policy.
 *
 * This suite drives the REAL `executeModelWithTools` on a real (if minimal)
 * concrete strategy — not a mirrored copy of the gate logic — so a
 * regression in the actual production code path fails these tests. Only
 * `executeModel` (the underlying single-completion call) is replaced with a
 * canned response; the tool registry, quorum computation, and tool
 * execution all run for real.
 *
 * Also locks the artifact-wiring half of PR2: a tool's `ToolResult.artifact`
 * (PR1 plumbing, `advanced-tool-execution-service.ts`) must survive into the
 * returned `ModelExecution.artifacts` (`ArtifactRef[]`, PR1 plumbing) once
 * the call actually executes — with `sourceToolCallId`/`role` filled in.
 *
 * Runs under vitest.orchestration.config.ts (see that file's doc comment):
 * anything under `src/core/orchestration/__tests__/**` is excluded from the
 * bare `vitest.ci.config.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SingleModelStrategy } from '../strategies/single-model-strategy';
import { toolRegistry } from '@/core/tools/tool-registry';
import type { ChatResponse, ChatRequest, Model, ModelExecution } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { ModelResponse } from '@/core/aggregation/response-aggregator';

const TOOL_NAME = 'test_quorum_media_tool';

/** Structural view exposing the protected methods this suite drives/mocks —
 *  same technique as quality-multipass-final-pass.test.ts's `Private` type. */
type Exposed = {
  executeModelWithTools: (
    adapter: ProviderAdapter,
    model: Model,
    request: ChatRequest,
    role?: string,
    maxToolIterations?: number,
    signal?: AbortSignal,
    quorumVoters?: ModelResponse[]
  ) => Promise<ModelExecution>;
  executeModel: (...args: unknown[]) => Promise<ModelExecution>;
};

function toolCallResponse(args: string, id = 'call_1'): ChatResponse {
  return {
    id: 'r-toolcall',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id, type: 'function', function: { name: TOOL_NAME, arguments: args } }],
        },
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
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  } as ChatResponse;
}

function voterResponse(args: string, modelId: string): ModelResponse {
  return {
    modelId,
    modelName: modelId,
    response: toolCallResponse(args, `${modelId}-call`),
    cost: 0,
    durationMs: 1,
    success: true,
  };
}

const REQUEST: ChatRequest = {
  model: 'auto',
  messages: [{ role: 'user', content: 'make a video of a cat' }],
};
const MODEL = { id: 'm', name: 'm' } as Model;
const ADAPTER = {} as ProviderAdapter;

let handlerCallCount = 0;
let lastHandlerArgs: Record<string, unknown> | null = null;

/** Builds a SingleModelStrategy with `executeModel` replaced by a canned
 *  sequence of responses (one per tool-loop iteration; the last entry
 *  repeats for any further iteration). */
function strategyWithMockedExecution(responses: ChatResponse[]): Exposed {
  const strategy = new SingleModelStrategy() as unknown as Exposed;
  let call = 0;
  strategy.executeModel = async (): Promise<ModelExecution> => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      modelId: 'm',
      modelName: 'm',
      role: 'primary',
      request: REQUEST,
      response,
      cost: 0,
      durationMs: 1,
      success: true,
    };
  };
  return strategy;
}

describe('executeModelWithTools() — quorumOnly auto-execution gate', () => {
  beforeEach(() => {
    handlerCallCount = 0;
    lastHandlerArgs = null;
    toolRegistry.register({
      name: TOOL_NAME,
      description: 'test-only quorum-gated media tool',
      category: 'video',
      safeForStrategies: false,
      strategyExecutionMode: 'quorumOnly',
      handler: async (args, toolCallId) => {
        handlerCallCount += 1;
        lastHandlerArgs = args;
        return {
          tool_call_id: toolCallId,
          success: true,
          output: 'generated',
          artifact: {
            type: 'video',
            url: 'https://example.com/generated.mp4',
            mimeType: 'video/mp4',
          },
        };
      },
    });
    toolRegistry.markInitialized();
  });

  it('does NOT auto-execute when no quorumVoters are supplied — fail-closed default, unchanged from safeForStrategies:false', async () => {
    const strategy = strategyWithMockedExecution([toolCallResponse('{"prompt":"a cat"}')]);
    const execution = await strategy.executeModelWithTools(ADAPTER, MODEL, REQUEST);

    expect(handlerCallCount).toBe(0);
    expect(execution.response?.choices?.[0]?.finish_reason).toBe('tool_calls');
    expect(execution.artifacts).toBeUndefined();
  });

  it('does NOT auto-execute when voters do not reach a strict majority on this exact call', async () => {
    const strategy = strategyWithMockedExecution([toolCallResponse('{"prompt":"a cat"}')]);
    const quorumVoters = [
      voterResponse('{"prompt":"a cat"}', 'v1'),
      voterResponse('{"prompt":"a dog"}', 'v2'),
      voterResponse('{"prompt":"a bird"}', 'v3'),
    ];

    const execution = await strategy.executeModelWithTools(
      ADAPTER,
      MODEL,
      REQUEST,
      'primary',
      5,
      undefined,
      quorumVoters
    );

    expect(handlerCallCount).toBe(0);
    expect(execution.response?.choices?.[0]?.finish_reason).toBe('tool_calls');
    expect(execution.artifacts).toBeUndefined();
  });

  it('auto-executes when a strict majority of voters agree on the exact call, and populates ModelExecution.artifacts from ToolResult.artifact', async () => {
    const args = '{"prompt":"a cat riding a bike"}';
    const strategy = strategyWithMockedExecution([toolCallResponse(args), finalResponse()]);
    const quorumVoters = [
      voterResponse(args, 'v1'),
      voterResponse(args, 'v2'),
      voterResponse('{"prompt":"something else entirely"}', 'v3'),
    ];

    const execution = await strategy.executeModelWithTools(
      ADAPTER,
      MODEL,
      REQUEST,
      'primary',
      5,
      undefined,
      quorumVoters
    );

    expect(handlerCallCount).toBe(1);
    expect(lastHandlerArgs).toEqual({ prompt: 'a cat riding a bike' });
    expect(execution.response?.choices?.[0]?.finish_reason).toBe('stop');
    expect(execution.artifacts).toEqual([
      {
        type: 'video',
        url: 'https://example.com/generated.mp4',
        mimeType: 'video/mp4',
        sourceToolCallId: 'call_1',
        role: 'primary',
      },
    ]);
  });

  it('matches quorum regardless of JSON key order (normalized args, via the same computeQuorumToolCall() the aggregator uses)', async () => {
    const strategy = strategyWithMockedExecution([
      toolCallResponse('{"prompt":"p","duration":5}'),
      finalResponse(),
    ]);
    const quorumVoters = [
      voterResponse('{"duration":5,"prompt":"p"}', 'v1'),
      voterResponse('{"prompt":"p","duration":5}', 'v2'),
    ];

    const execution = await strategy.executeModelWithTools(
      ADAPTER,
      MODEL,
      REQUEST,
      'primary',
      5,
      undefined,
      quorumVoters
    );

    expect(handlerCallCount).toBe(1);
    expect(execution.response?.choices?.[0]?.finish_reason).toBe('stop');
  });

  it('a safeForStrategies:true tool keeps auto-executing unconditionally, quorumVoters or not (no regression)', async () => {
    const SAFE_TOOL = 'test_safe_tool';
    let safeCalls = 0;
    toolRegistry.register({
      name: SAFE_TOOL,
      description: 'test-only unconditionally-safe tool',
      category: 'web',
      safeForStrategies: true,
      handler: async (_args, toolCallId) => {
        safeCalls += 1;
        return { tool_call_id: toolCallId, success: true, output: 'ok' };
      },
    });

    const safeToolCallResponse: ChatResponse = {
      id: 'r-safe',
      object: 'chat.completion',
      created: 0,
      model: 'm',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'safe_call_1', type: 'function', function: { name: SAFE_TOOL, arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as ChatResponse;

    const strategy = strategyWithMockedExecution([safeToolCallResponse, finalResponse()]);
    const execution = await strategy.executeModelWithTools(ADAPTER, MODEL, REQUEST);

    expect(safeCalls).toBe(1);
    expect(execution.response?.choices?.[0]?.finish_reason).toBe('stop');
  });
});
