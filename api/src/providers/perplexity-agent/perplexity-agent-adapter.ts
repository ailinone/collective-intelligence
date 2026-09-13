// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Perplexity Agent API Adapter — Responses-style multi-vendor surface.
 *
 * Perplexity's classic `/chat/completions` (the `perplexity` catalog row)
 * only serves its own Sonar family. Separately, Perplexity exposes an
 * "Agent API" (`POST /v1/agent`, aliased at `/v1/responses`) that routes to
 * third-party vendor models (Anthropic, OpenAI, Google, xAI, z.ai, Moonshot,
 * NVIDIA) under one account/key. Live-probed 2026-07-13 with a real key:
 * anthropic/claude-haiku-4-5, openai/gpt-5.4-mini, google/gemini-3.5-flash,
 * xai/grok-4.5, perplexity/glm-5.2 (z.ai), nvidia/nemotron-3-super-120b-a12b
 * all returned 200. perplexity/kimi-k2.7-code (Moonshot) confirmed working
 * on 2026-07-16 — but subject to intermittent full-request hangs on a cold
 * upstream (first call can stall with zero bytes; a retry seconds later
 * answers normally). The orchestrator's first-chunk/idle timeouts plus
 * fallback already cover that failure mode; nothing here special-cases it.
 *
 * The wire shape is genuinely NOT OpenAI chat/completions — it is Responses-
 * API shaped (`input`/`output`, `max_output_tokens` instead of `max_tokens`,
 * response text nested at `output[].content[].text`). Discovery, by
 * contrast, IS plain OpenAI-list shape (`GET /v1/models` → `{data:[{id,
 * owned_by,...}]}`, confirmed live, authenticated) and needs no override —
 * only chatCompletion/chatCompletionStream are overridden here.
 *
 * Streaming (shape captured live 2026-07-16): the Agent API emits named SSE
 * events in the OpenAI Responses dialect —
 *   response.created → response.in_progress → response.output_item.added →
 *   response.output_text.delta (one per text fragment) →
 *   response.output_text.done → response.output_item.done →
 *   response.completed (carries final usage + cost)
 * Each `data:` payload duplicates the event name in a `type` field, so the
 * parser keys off `data.type` and ignores `event:` lines entirely. Two
 * captured quirks the parser must respect:
 *   - there is NO terminating `data: [DONE]` sentinel — the stream simply
 *     ends after response.completed;
 *   - `sequence_number` is NOT gap-free (observed 0,1,4,5,6,8,9,10), so
 *     nothing may assume contiguous sequencing.
 *
 * Tool calling (probed live 2026-07-16): the request takes FLAT Responses-
 * style tools ({type,name,description,parameters} — no `function` wrapper),
 * and tool invocations come back as output items of type `function_call`
 * with a JSON-string `arguments` and a `call_id`. This adapter converts
 * both directions to/from the OpenAI shapes the rest of ci speaks.
 *
 * Streaming tool-call deltas (2026-09-08 fix): prior to this fix, a
 * streaming request with `tools` delivered every tool call WHOLE, only in
 * the terminal `response.completed` event — identical to what a
 * non-streaming call returns, just wrapped in a chunk envelope. Verified
 * against https://docs.perplexity.ai/api-reference/agent-post and
 * https://docs.perplexity.ai/guides/streaming (fetched 2026-09-08): this
 * surface documents `response.output_item.added` (a `function_call` output
 * item STARTS) and `response.output_item.done` (it COMPLETES), each
 * carrying the `item` object, but — unlike OpenAI's own Responses API,
 * which this surface otherwise mirrors — there is no documented
 * `response.function_call_arguments.delta` event or any other mechanism to
 * fragment a call's `arguments` string across multiple events. Given that,
 * this adapter now streams a tool call's `id`/`name` announcement as soon
 * as `response.output_item.added` fires (arguments: '' — Perplexity's own
 * `added` payload isn't documented to carry a complete `arguments` string
 * yet), and its complete `arguments` in one fragment as soon as
 * `response.output_item.done` fires — both strictly earlier than waiting
 * for `response.completed`, which is the only real incrementality this API
 * supports for tool calls. This is not a fabricated partial-JSON delta: a
 * client doing the standard `arguments += delta` reconstruction still ends
 * up with the exact right string, since there is exactly one non-empty
 * fragment.
 *
 * `tool_choice` (2026-09-08 fix): the full `ResponsesRequest` schema at
 * https://docs.perplexity.ai/api-reference/agent-post enumerates every
 * accepted top-level field — input, background, instructions,
 * language_preference, max_output_tokens, max_steps, model, models, preset,
 * profile, previous_response_id, reasoning, response_format, store, stream,
 * tools, skills, temperature, top_p — and there is NO `tool_choice` field.
 * This surface has no native way to force/forbid tool use, unlike Chat
 * Completions. Previously this adapter ignored `request.tool_choice`
 * entirely, so a caller asking for `'none'` (stop calling tools, answer now)
 * still got the full `tools` array forwarded and the model could keep
 * calling them — a real behavioral gap for any agentic loop that relies on
 * `tool_choice: 'none'` to force a final answer. Two of the three internal
 * `tool_choice` values (see `types/index.ts`) have a faithful client-side
 * equivalent even without wire support and are now honored in
 * `buildAgentPayload`:
 *   - `'none'`   → omit `tools` from the payload outright (a model with zero
 *                  tools available cannot call one — functionally identical
 *                  to the OpenAI semantics of `tool_choice: 'none'`).
 *   - forced `{type:'function',function:{name}}` → narrow the outgoing
 *                  `tools` array to just that one tool, so if the model does
 *                  call a tool it can only be the requested one. This is a
 *                  best-effort emulation (the model can still choose to
 *                  answer without calling it — there is no way to make the
 *                  call mandatory on this surface), logged as such so a
 *                  caller relying on a hard-forced call can see why it
 *                  didn't happen.
 *   - `'auto'` / undefined → unchanged, forwards `tools` as-is.
 *
 * Docs: https://docs.perplexity.ai/docs/agent-api/models
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';
import type {
  ChatChoice,
  ChatRequest,
  ChatResponse,
  MessageContent,
  Tool,
  ToolCall,
} from '@/types';

interface PerplexityAgentOutputPart {
  type: string;
  text?: string;
}

interface PerplexityAgentOutputItem {
  type?: string;
  content?: PerplexityAgentOutputPart[];
  // present on `function_call` output items
  name?: string;
  arguments?: string;
  call_id?: string;
  id?: string;
}

interface PerplexityAgentResponse {
  id: string;
  created_at: number;
  model: string;
  status?: string;
  output?: PerplexityAgentOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

/** One parsed `data:` payload from the Agent API SSE stream. */
interface PerplexityAgentStreamEvent {
  type?: string;
  delta?: string;
  response?: PerplexityAgentResponse;
  /** Present on `response.output_item.added` / `response.output_item.done`. */
  item?: PerplexityAgentOutputItem;
}

export class PerplexityAgentAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: OpenAICompatibleHubAdapterConfig) {
    super({
      ...config,
      providerName: 'perplexity-agent',
      displayName: config.displayName || 'Perplexity Agent API',
    });
  }

  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const normalizedModel = await this.normalizeModelName(request.model || '');
    const response = await this.sendJsonRequestWithRetry({
      path: '/agent',
      operation: 'chat completion (agent api)',
      payload: this.buildAgentPayload(normalizedModel, request),
    });
    const raw = (await response.json()) as PerplexityAgentResponse;
    return this.toChatResponse(raw);
  }

  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse> {
    const normalizedModel = await this.normalizeModelName(request.model || '');
    const response = await this.sendJsonRequestWithRetry({
      path: '/agent',
      operation: 'streaming chat completion (agent api)',
      payload: { ...this.buildAgentPayload(normalizedModel, request), stream: true },
    });

    if (!response.body) {
      throw new Error('perplexity-agent streaming response body is empty');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    // Stamped from the first event that carries the full response envelope
    // (response.created fires before any delta), with safe fallbacks.
    let streamId = 'perplexity-agent-stream';
    let created = Math.floor(Date.now() / 1000);
    let sawTerminal = false;

    // Streamed tool calls (see the class doc comment's "Streaming tool-call
    // deltas" section): keyed by the item's `call_id` (falling back to `id`)
    // so `response.output_item.added` and the matching `.done` for the same
    // call agree on the same dense, zero-based `ToolCall.index` an
    // OpenAI-compatible client keys concurrent tool-call accumulation on.
    const toolCallIndexByKey = new Map<string, number>();
    let nextToolCallIndex = 0;

    try {
      while (true) {
        const readResult = await reader.read();
        if (readResult.done) {
          break;
        }
        const chunkValue: unknown = readResult.value;
        if (!(chunkValue instanceof Uint8Array)) {
          continue;
        }

        buffer += decoder.decode(chunkValue, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          // `event:` lines duplicate data.type — key off the data payload only.
          if (!line.startsWith('data: ')) {
            continue;
          }

          let event: PerplexityAgentStreamEvent;
          try {
            event = JSON.parse(line.slice(6)) as PerplexityAgentStreamEvent;
          } catch {
            continue;
          }

          if (event.response?.id) {
            streamId = event.response.id;
          }
          if (typeof event.response?.created_at === 'number') {
            created = event.response.created_at;
          }

          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            yield {
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model: normalizedModel,
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: event.delta },
                  finish_reason: null,
                },
              ],
            };
            continue;
          }

          if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
            const item = event.item;
            const name = item.name;
            const key = item.call_id || item.id;
            if (typeof name === 'string' && key) {
              const toolCallIndex = nextToolCallIndex++;
              toolCallIndexByKey.set(key, toolCallIndex);
              yield {
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model: normalizedModel,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      tool_calls: [
                        {
                          id: key,
                          type: 'function',
                          function: { name, arguments: '' },
                          index: toolCallIndex,
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
            }
            continue;
          }

          if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
            const item = event.item;
            const name = item.name;
            const key = item.call_id || item.id;
            if (typeof name === 'string' && key) {
              // Falls back to registering here (rather than dropping the
              // call) if `added` was missed/reordered — defensive, since the
              // documented ordering (`added` before `done`) isn't a
              // guarantee this parser needs to hard-depend on to be correct.
              const toolCallIndex = toolCallIndexByKey.get(key) ?? nextToolCallIndex++;
              toolCallIndexByKey.set(key, toolCallIndex);
              yield {
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model: normalizedModel,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          id: key,
                          type: 'function',
                          // Complete arguments in one fragment — see the
                          // class doc comment for why Perplexity's Agent API
                          // has no finer-grained argument delta to forward.
                          function: {
                            name,
                            arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
                          },
                          index: toolCallIndex,
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
            }
            continue;
          }

          if (event.type === 'response.completed' && event.response) {
            // NOTE: no `data: [DONE]` follows — this IS the terminal event.
            sawTerminal = true;
            const final = this.toChatResponse(event.response);
            yield {
              ...final,
              object: 'chat.completion.chunk',
              choices: final.choices.map((choice): ChatChoice => ({
                index: choice.index,
                // Terminal chunk carries no repeated text or tool_calls —
                // both already streamed incrementally above (text via
                // response.output_text.delta, tool calls via
                // response.output_item.added/.done) — just the finish_reason.
                delta: { role: 'assistant', content: '' },
                finish_reason: choice.finish_reason,
              })),
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!sawTerminal) {
      throw new Error(
        'perplexity-agent stream ended without a response.completed event (truncated upstream stream)'
      );
    }
  }

  private buildAgentPayload(model: string, request: ChatRequest): Record<string, unknown> {
    return {
      model,
      input: request.messages.map((message) => ({
        role: message.role,
        content: this.extractText(message.content),
      })),
      max_output_tokens: request.max_tokens ?? 1024,
      ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
      ...this.buildToolsField(request),
    };
  }

  /**
   * Map `request.tool_choice` onto the ResponsesRequest `tools` field — the
   * only tool-related field this API accepts (no `tool_choice` exists on
   * this surface; see the class doc comment). Returns `{}` when there is
   * nothing to send.
   */
  private buildToolsField(request: ChatRequest): { tools?: Record<string, unknown>[] } {
    const tools = request.tools;
    if (!tools?.length) {
      return {};
    }

    const choice = request.tool_choice;

    if (choice === 'none') {
      // No wire-level tool_choice to set — the equivalent effect is sending
      // no tools at all, so the model has nothing to call.
      return {};
    }

    if (choice && typeof choice === 'object' && choice.type === 'function') {
      const forcedName = choice.function.name;
      const narrowed = tools.filter((tool) => tool.function.name === forcedName);
      if (narrowed.length === 0) {
        this.providerLog.warn(
          { forcedName },
          'perplexity-agent: tool_choice named a function not present in tools[] — forwarding the full tool list since there is nothing to narrow to'
        );
        return { tools: tools.map(toFlatResponsesTool) };
      }
      this.providerLog.warn(
        { forcedName },
        "perplexity-agent: ResponsesRequest has no tool_choice field, so a forced function call can't be guaranteed — narrowing tools[] to only the requested function as a best-effort emulation"
      );
      return { tools: narrowed.map(toFlatResponsesTool) };
    }

    // 'auto' or undefined — default behavior, forward every declared tool.
    return { tools: tools.map(toFlatResponsesTool) };
  }

  private extractText(content: string | MessageContent[]): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter((text) => text.length > 0)
      .join('\n');
  }

  private toChatResponse(raw: PerplexityAgentResponse): ChatResponse {
    const items = raw.output ?? [];

    const text = items
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');

    const toolCalls: ToolCall[] = items
      .filter((item) => item.type === 'function_call' && typeof item.name === 'string')
      .map((item, index) => ({
        // `call_id` (toolu_/call_ style) is the correlation id the follow-up
        // tool-result turn must echo; the item `id` (fc_...) is only the
        // output-item identity. Prefer call_id.
        id: item.call_id || item.id || `perplexity-agent-call-${index}`,
        type: 'function' as const,
        function: {
          name: item.name as string,
          arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
        },
        index,
      }));

    const finishReason: ChatChoice['finish_reason'] =
      toolCalls.length > 0 ? 'tool_calls' : raw.status === 'incomplete' ? 'length' : 'stop';

    return {
      id: raw.id,
      object: 'chat.completion',
      created: raw.created_at,
      model: raw.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage: raw.usage
        ? {
            prompt_tokens: raw.usage.input_tokens,
            completion_tokens: raw.usage.output_tokens,
            total_tokens: raw.usage.total_tokens,
          }
        : undefined,
    };
  }
}

/**
 * OpenAI tool shape → flat Responses-style tool shape (no `function`
 * wrapper). Probed live 2026-07-16: the flat shape is what /v1/agent
 * accepts; the wrapped shape was never needed.
 */
function toFlatResponsesTool(tool: Tool): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    parameters: tool.function.parameters,
  };
}
