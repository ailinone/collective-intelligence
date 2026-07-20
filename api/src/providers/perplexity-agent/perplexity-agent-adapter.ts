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

          if (event.type === 'response.completed' && event.response) {
            // NOTE: no `data: [DONE]` follows — this IS the terminal event.
            sawTerminal = true;
            const final = this.toChatResponse(event.response);
            yield {
              ...final,
              object: 'chat.completion.chunk',
              choices: final.choices.map(
                (choice): ChatChoice => ({
                  index: choice.index,
                  // Terminal chunk carries no repeated text (deltas already
                  // streamed it) — just the finish_reason, plus tool_calls
                  // when the model invoked a tool.
                  delta: {
                    role: 'assistant',
                    content: '',
                    ...(choice.message?.tool_calls
                      ? { tool_calls: choice.message.tool_calls }
                      : {}),
                  },
                  finish_reason: choice.finish_reason,
                }),
              ),
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!sawTerminal) {
      throw new Error(
        'perplexity-agent stream ended without a response.completed event (truncated upstream stream)',
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
      ...(request.tools?.length ? { tools: request.tools.map(toFlatResponsesTool) } : {}),
    };
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
