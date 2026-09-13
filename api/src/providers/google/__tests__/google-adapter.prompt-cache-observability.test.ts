// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for Google Gemini prompt-cache observability (ADR-025
 * follow-up, 2026-09-08).
 *
 * Gemini's "implicit caching" is enabled by default for Gemini 2.5+ models
 * (ai.google.dev/gemini-api/docs/caching, verified live 2026-09-08) — no
 * request-side field to set, nothing for this adapter to send. The real,
 * valuable follow-up is observability: the SDK's own
 * `UsageMetadata.cachedContentTokenCount` (confirmed in
 * `@google/generative-ai`'s own type definitions,
 * `dist/generative-ai.d.ts:1392`) reports how many of the response's prompt
 * tokens were served from cache. This suite covers `convertResponse()`
 * (the non-streaming path) surfacing that field into
 * `ci_provider_prompt_cache_tokens_total`, deriving the miss count as
 * `promptTokenCount - cachedContentTokenCount` since Gemini only reports the
 * hit count directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleAdapter } from '@/providers/google/google-adapter';
import { providerPromptCacheTokensTotal } from '@/observability/ci-metrics';
import type { ChatRequest } from '@/types';

interface FakeGeminiResponse {
  response: {
    candidates: Array<{ content: { parts: Array<{ text?: string }> }; finishReason?: string }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
      cachedContentTokenCount?: number;
    };
  };
}

function fakeResponse(usageMetadata: FakeGeminiResponse['response']['usageMetadata']): FakeGeminiResponse {
  return {
    response: {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata,
    },
  };
}

function buildAdapter(responseToReturn: FakeGeminiResponse) {
  const adapter = new GoogleAdapter({ apiKey: 'AIzaTestKeyNotReal000000000000000' });
  const fakeModel = {
    generateContent: async () => responseToReturn,
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
  return adapter;
}

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

async function cacheValue(outcome: 'hit' | 'miss'): Promise<number> {
  const metric = await providerPromptCacheTokensTotal.get();
  return (
    metric.values.find((v) => v.labels.provider === 'google' && v.labels.outcome === outcome)
      ?.value ?? 0
  );
}

describe('GoogleAdapter — prompt-cache observability (cachedContentTokenCount)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('records hit tokens and derives miss tokens when cachedContentTokenCount is present', async () => {
    const adapter = buildAdapter(
      fakeResponse({ promptTokenCount: 5000, candidatesTokenCount: 100, totalTokenCount: 5100, cachedContentTokenCount: 4096 })
    );
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');

    await adapter.chatCompletion(baseRequest());

    expect((await cacheValue('hit')) - hitBefore).toBe(4096);
    expect((await cacheValue('miss')) - missBefore).toBe(904); // 5000 - 4096
  });

  it('is a no-op when cachedContentTokenCount is absent (below the implicit-caching minimum, or a non-2.5 model)', async () => {
    const adapter = buildAdapter(
      fakeResponse({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 })
    );
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');

    await adapter.chatCompletion(baseRequest());

    expect(await cacheValue('hit')).toBe(hitBefore);
    expect(await cacheValue('miss')).toBe(missBefore);
  });

  it('does not change the returned ChatResponse.usage shape (no cache fields leak into the fixed Usage type)', async () => {
    const adapter = buildAdapter(
      fakeResponse({ promptTokenCount: 5000, candidatesTokenCount: 100, totalTokenCount: 5100, cachedContentTokenCount: 4096 })
    );

    const result = await adapter.chatCompletion(baseRequest());

    expect(result.usage).toEqual({ prompt_tokens: 5000, completion_tokens: 100, total_tokens: 5100 });
  });
});
