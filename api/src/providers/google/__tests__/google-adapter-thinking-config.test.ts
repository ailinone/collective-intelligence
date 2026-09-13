// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GoogleAdapter — native `thinkingConfig.thinkingBudget` forwarding
 * (LOTE AZ follow-up, Google adapter gap).
 *
 * Audited gap: the Google/Gemini adapter never sent `thinkingConfig` despite
 * Gemini 2.5's real native support for it, so `reasoning_effort`/
 * `thinking_budget` were silently dropped for every Gemini call. This wires
 * `resolveReasoningEffort()` (the LOTE AZ canonical resolver) into both the
 * non-streaming and streaming request builders, gated on the resolved
 * model actually being a `thinkingConfig`-capable Gemini 2.5 model, and
 * clamped to that model's real documented `thinkingBudget` range (Pro:
 * 128-32768; Flash/Flash-Lite: 0-24576).
 */
import { describe, it, expect } from 'vitest';
import { GoogleAdapter } from '@/providers/google/google-adapter';
import type { ChatRequest } from '@/types';

interface FakeGeminiResponse {
  response: {
    candidates: Array<{ content: { parts: Array<{ text?: string }> }; finishReason?: string }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
}

function fakeResponse(text = 'ok'): FakeGeminiResponse {
  return {
    response: {
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    },
  };
}

/** Builds an adapter whose Gemini client is a stub capturing the exact
 *  request object passed to `generateContent` / `generateContentStream`. */
function buildAdapter() {
  const adapter = new GoogleAdapter({ apiKey: 'AIzaTestKeyNotReal000000000000000' });
  let capturedRequest: { generationConfig?: { thinkingConfig?: unknown } } | undefined;

  const fakeModel = {
    generateContent: async (req: typeof capturedRequest) => {
      capturedRequest = req;
      return fakeResponse();
    },
    generateContentStream: async (req: typeof capturedRequest) => {
      capturedRequest = req;
      async function* empty() {
        yield { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] };
      }
      return { stream: empty() };
    },
  };
  const fakeClient = { getGenerativeModel: () => fakeModel };
  (adapter as unknown as { client: unknown }).client = fakeClient;
  (adapter as unknown as { clientPool: unknown[] }).clientPool = [fakeClient];
  (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => fakeClient;
  (adapter as unknown as { normalizeModelName(m: string): Promise<string> }).normalizeModelName =
    async (m: string) => m;
  (
    adapter as unknown as { executeThroughBulkhead<T>(fn: () => Promise<T>): Promise<T> }
  ).executeThroughBulkhead = async (fn) => fn();

  return {
    adapter,
    getCapturedRequest: () => capturedRequest,
  };
}

function baseRequest(overrides: Partial<ChatRequest>): ChatRequest {
  return {
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

describe('GoogleAdapter — thinkingConfig forwarding (non-streaming)', () => {
  it('forwards a documented per-tier budget for reasoning_effort on a thinking-capable model', async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await adapter.chatCompletion(baseRequest({ model: 'gemini-2.5-pro', reasoning_effort: 'high' }));

    expect(getCapturedRequest()?.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 16384,
      includeThoughts: false,
    });
  });

  it('forwards an explicit thinking_budget verbatim when within the model range', async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await adapter.chatCompletion(
      baseRequest({ model: 'gemini-2.5-flash', thinking_budget: 2048 })
    );

    expect(getCapturedRequest()?.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 2048,
      includeThoughts: false,
    });
  });

  it('clamps an explicit thinking_budget above Flash/Flash-Lite max (24576) down to the max', async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await adapter.chatCompletion(
      baseRequest({ model: 'gemini-2.5-flash-lite', thinking_budget: 99999 })
    );

    expect(getCapturedRequest()?.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 24576,
      includeThoughts: false,
    });
  });

  it('clamps an explicit thinking_budget below Pro min (128) up to the floor — Pro cannot fully disable thinking', async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await adapter.chatCompletion(baseRequest({ model: 'gemini-2.5-pro', thinking_budget: 1 }));

    expect(getCapturedRequest()?.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 128,
      includeThoughts: false,
    });
  });

  it('omits thinkingConfig entirely for a non-thinking-capable model even with reasoning_effort set', async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await adapter.chatCompletion(
      baseRequest({ model: 'gemini-1.5-flash', reasoning_effort: 'high' })
    );

    expect(getCapturedRequest()?.generationConfig?.thinkingConfig).toBeUndefined();
  });

  it('omits thinkingConfig when the request carries no reasoning signal at all', async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await adapter.chatCompletion(baseRequest({ model: 'gemini-2.5-pro' }));

    expect(getCapturedRequest()?.generationConfig?.thinkingConfig).toBeUndefined();
  });

  it('defaults enable_reasoning-only requests to the medium tier budget (4096)', async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    await adapter.chatCompletion(
      baseRequest({
        model: 'gemini-2.5-flash',
        ailin_constraints: { enable_reasoning: true },
      })
    );

    expect(getCapturedRequest()?.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 4096,
      includeThoughts: false,
    });
  });
});

describe('GoogleAdapter — thinkingConfig forwarding (streaming)', () => {
  it('forwards the resolved budget on the streaming request too', async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    const req = baseRequest({ model: 'gemini-2.5-flash', reasoning_effort: 'low', stream: true });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of adapter.chatCompletionStream(req)) {
      // drain
    }

    expect(getCapturedRequest()?.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 1024,
      includeThoughts: false,
    });
  });

  it('omits thinkingConfig on the streaming request for a non-thinking model', async () => {
    const { adapter, getCapturedRequest } = buildAdapter();
    const req = baseRequest({ model: 'gemini-1.0-pro', thinking_budget: 500, stream: true });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of adapter.chatCompletionStream(req)) {
      // drain
    }

    expect(getCapturedRequest()?.generationConfig?.thinkingConfig).toBeUndefined();
  });
});
