// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for forwarding the canonical `reasoning_effort` signal
 * (LOTE AZ resolver, `utils/reasoning-effort.ts`) to OpenAI's real wire
 * parameters — `reasoning_effort` on Chat Completions, `reasoning.effort`
 * on the Responses API.
 *
 * Covers the audited gap: the OpenAI adapter already detects o-series/
 * reasoning-capable models in three places (temperature clamping,
 * Responses-API routing, `max_completion_tokens` selection) but never
 * mapped any effort hint to the actual outgoing parameter. It also guards
 * a second, previously-latent bug found while fixing the first: both
 * `toChatCompletionParams()` and `toResponseParams()` are strict per-field
 * whitelists that would otherwise silently strip `reasoning_effort` /
 * `reasoning` before the non-streaming request ever reaches OpenAI, even
 * though the field was set correctly one layer up.
 */
import { describe, it, expect } from 'vitest';
import { OpenAIAdapter } from '@/providers/openai/openai-adapter';
import type { ChatRequest, ChatResponse, Model } from '@/types';

type CreateArgs = Record<string, unknown>;

/**
 * A reasoning-capable model explicitly pinned (via `metadata.endpoint`, the
 * FIRST thing `getModelEndpoint()` checks — see openai-adapter.ts) to the
 * `chat_completions` endpoint. Without this override, `getModelEndpoint()`'s
 * own capability inference would route any model carrying the `reasoning`
 * capability to the Responses API instead (see `reasoningResponsesModel`
 * below), which is a separate branch these tests cover independently.
 */
function reasoningModel(id: string): Model {
  return {
    id,
    name: id,
    displayName: id,
    providerId: 'openai',
    capabilities: ['chat', 'streaming', 'reasoning', 'thinking_mode'],
    status: 'active',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
    metadata: { endpoint: 'chat_completions' },
  } as unknown as Model;
}

/** A reasoning-capable model left to `getModelEndpoint()`'s natural capability
 *  inference, which routes any 'reasoning'-capable model to the Responses API. */
function reasoningResponsesModel(id: string): Model {
  return {
    id,
    name: id,
    displayName: id,
    providerId: 'openai',
    capabilities: ['chat', 'streaming', 'reasoning', 'thinking_mode'],
    status: 'active',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
  } as unknown as Model;
}

function plainChatModel(id: string): Model {
  return {
    id,
    name: id,
    displayName: id,
    providerId: 'openai',
    capabilities: ['chat', 'streaming'],
    status: 'active',
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
  } as unknown as Model;
}

const CHAT_COMPLETION_RESPONSE = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: 'test-model',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const RESPONSES_API_RESPONSE = {
  id: 'resp-test',
  model: 'test-model',
  output: 'ok',
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

/** Wire up an adapter whose catalog/DB-backed lookups are all stubbed. */
function buildAdapter(model: Model | null) {
  const chatCalls: CreateArgs[] = [];
  const responsesCalls: CreateArgs[] = [];
  const adapter = new OpenAIAdapter({ apiKey: 'test-key', maxRetries: 0 });

  const stub = {
    chat: {
      completions: {
        create: async (args: CreateArgs) => {
          chatCalls.push({ ...args });
          return CHAT_COMPLETION_RESPONSE;
        },
      },
    },
    responses: {
      create: async (args: CreateArgs) => {
        responsesCalls.push({ ...args });
        return RESPONSES_API_RESPONSE;
      },
    },
  };
  (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => stub;
  (
    adapter as unknown as { normalizeModelName(id: string): Promise<string> }
  ).normalizeModelName = async (id: string) => id;
  (
    adapter as unknown as { getModelObject(id: string): Promise<Model | null> }
  ).getModelObject = async () => model;

  return { adapter, chatCalls, responsesCalls };
}

const BASE_MESSAGES: ChatRequest['messages'] = [{ role: 'user', content: 'hello' }];

describe('OpenAIAdapter — reasoning_effort forwarding (chatCompletion, chat_completions endpoint)', () => {
  it('forwards an explicit reasoning_effort to a reasoning-capable model', async () => {
    const { adapter, chatCalls } = buildAdapter(reasoningModel('o3-mini'));
    const request: ChatRequest = {
      model: 'o3-mini',
      messages: BASE_MESSAGES,
      reasoning_effort: 'high',
    };

    const response: ChatResponse = await adapter.chatCompletion(request);

    expect(response).toBeDefined();
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]?.reasoning_effort).toBe('high');
  });

  it('does not set reasoning_effort when the model is not reasoning-capable', async () => {
    const { adapter, chatCalls } = buildAdapter(plainChatModel('gpt-4o-mini'));
    const request: ChatRequest = {
      model: 'gpt-4o-mini',
      messages: BASE_MESSAGES,
      reasoning_effort: 'high',
    };

    await adapter.chatCompletion(request);

    expect(chatCalls).toHaveLength(1);
    expect('reasoning_effort' in chatCalls[0]!).toBe(false);
  });

  it('does not set reasoning_effort when the caller expressed no effort at all', async () => {
    const { adapter, chatCalls } = buildAdapter(reasoningModel('o3-mini'));
    const request: ChatRequest = {
      model: 'o3-mini',
      messages: BASE_MESSAGES,
    };

    await adapter.chatCompletion(request);

    expect('reasoning_effort' in chatCalls[0]!).toBe(false);
  });

  it('does not set reasoning_effort from a bare numeric thinking_budget (no reasoning_effort field)', async () => {
    // Per resolveReasoningEffort's precedence rule, an explicit numeric
    // thinking_budget with no reasoning_effort resolves `effort: undefined`
    // — it is a different signal (native-thinking token budget), not an
    // OpenAI reasoning_effort tier, so nothing should be forwarded here.
    const { adapter, chatCalls } = buildAdapter(reasoningModel('o3-mini'));
    const request: ChatRequest = {
      model: 'o3-mini',
      messages: BASE_MESSAGES,
      thinking_budget: 8000,
    };

    await adapter.chatCompletion(request);

    expect('reasoning_effort' in chatCalls[0]!).toBe(false);
  });

  it('defaults to medium when only the legacy enable_reasoning flag is set', async () => {
    const { adapter, chatCalls } = buildAdapter(reasoningModel('o3-mini'));
    const request: ChatRequest = {
      model: 'o3-mini',
      messages: BASE_MESSAGES,
      ailin_constraints: { enable_reasoning: true },
    };

    await adapter.chatCompletion(request);

    expect(chatCalls[0]?.reasoning_effort).toBe('medium');
  });
});

describe('OpenAIAdapter — reasoning.effort forwarding (chatCompletion, Responses API endpoint)', () => {
  it('forwards reasoning.effort for a model routed to the Responses API', async () => {
    // reasoningResponsesModel()'s 'reasoning' capability routes
    // getModelEndpoint() to 'responses' (see getModelEndpoint's capability
    // inference) since it carries no metadata.endpoint override.
    const { adapter, responsesCalls } = buildAdapter(reasoningResponsesModel('o3'));
    const request: ChatRequest = {
      model: 'o3',
      messages: BASE_MESSAGES,
      reasoning_effort: 'low',
    };

    const response = await adapter.chatCompletion(request);

    expect(response).toBeDefined();
    expect(responsesCalls).toHaveLength(1);
    expect(responsesCalls[0]?.reasoning).toEqual({ effort: 'low' });
  });

  it('omits reasoning entirely when no effort was requested', async () => {
    const { adapter, responsesCalls } = buildAdapter(reasoningResponsesModel('o3'));
    const request: ChatRequest = {
      model: 'o3',
      messages: BASE_MESSAGES,
    };

    await adapter.chatCompletion(request);

    expect('reasoning' in responsesCalls[0]!).toBe(false);
  });
});

describe('OpenAIAdapter — reasoning_effort forwarding (chatCompletionStream)', () => {
  it('forwards reasoning_effort on the streaming request body', async () => {
    const { adapter } = buildAdapter(reasoningModel('o3-mini'));
    const calls: CreateArgs[] = [];

    async function* fakeStream() {
      yield {
        id: 'chunk-1',
        created: Math.floor(Date.now() / 1000),
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      };
    }

    const stub = {
      chat: {
        completions: {
          create: async (args: CreateArgs) => {
            calls.push({ ...args });
            return fakeStream();
          },
        },
      },
    };
    (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => stub;
    (
      adapter as unknown as { isChatCompletionModel(id: string): Promise<boolean> }
    ).isChatCompletionModel = async () => true;

    const request: ChatRequest = {
      model: 'o3-mini',
      messages: BASE_MESSAGES,
      reasoning_effort: 'medium',
    };

    const generator = adapter.chatCompletionStream(request);
    // Drain the generator so the request is actually issued.
    for await (const _chunk of generator) {
      // no-op — only interested in the outgoing request args
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.reasoning_effort).toBe('medium');
  });
});
