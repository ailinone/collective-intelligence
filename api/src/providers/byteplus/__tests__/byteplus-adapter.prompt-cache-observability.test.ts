// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * BytePlusModelArkAdapter — prompt-cache observability tests (ADR-025
 * follow-up, 2026-09-09).
 *
 * ModelArk's Context Cache (Session Cache + Prefix Cache) reports
 * `usage.prompt_tokens_details.cached_tokens` — confirmed live against
 * ModelArk/Volcengine Ark's Context Caching docs. This file's own
 * `ArkChatCompletion.usage` type already modeled this field; these tests
 * cover it actually being read and surfaced into
 * `ci_provider_prompt_cache_tokens_total`. Activating either cache mode
 * (which requires a separate context-creation call to obtain a
 * `context_id`) is a documented, deliberate follow-up — see the adapter's
 * own `recordCacheUsage()` comment — so this suite is observability-only,
 * matching what the adapter actually does today.
 */

import { describe, expect, it, vi } from 'vitest';
import { BytePlusModelArkAdapter } from '../byteplus-adapter';
import { providerPromptCacheTokensTotal } from '@/observability/ci-metrics';

const BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';

function stubJson(jsonBody: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => jsonBody,
      text: async () => JSON.stringify(jsonBody),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeAdapter(): BytePlusModelArkAdapter {
  return new BytePlusModelArkAdapter({
    apiKey: 'byteplus-test-key',
    baseUrl: BASE,
    maxRetries: 1,
    retryDelay: 1,
  });
}

function chatFixture(usage: Record<string, unknown>) {
  return {
    id: 'resp-1',
    object: 'chat.completion',
    created: 1742631811,
    model: 'seed-2-0-lite-260228',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello!' } },
    ],
    usage,
  };
}

async function cacheValue(outcome: 'hit' | 'miss'): Promise<number> {
  const metric = await providerPromptCacheTokensTotal.get();
  return (
    metric.values.find((v) => v.labels.provider === 'byteplus' && v.labels.outcome === outcome)
      ?.value ?? 0
  );
}

describe('BytePlusModelArkAdapter — prompt-cache observability', () => {
  it('records hit/miss tokens when prompt_tokens_details.cached_tokens is present', async () => {
    const restore = stubJson(
      chatFixture({
        prompt_tokens: 1200,
        completion_tokens: 40,
        total_tokens: 1240,
        prompt_tokens_details: { cached_tokens: 1024 },
      })
    );
    const hitBefore = await cacheValue('hit');
    const missBefore = await cacheValue('miss');
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'hi' }],
      });
    } finally {
      restore();
    }

    expect((await cacheValue('hit')) - hitBefore).toBe(1024);
    expect((await cacheValue('miss')) - missBefore).toBe(176); // 1200 - 1024
  });

  it('is a no-op when prompt_tokens_details is absent', async () => {
    const restore = stubJson(
      chatFixture({ prompt_tokens: 19, completion_tokens: 9, total_tokens: 28 })
    );
    const hitBefore = await cacheValue('hit');
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'hi' }],
      });
    } finally {
      restore();
    }

    expect(await cacheValue('hit')).toBe(hitBefore);
  });

  it('does not change the returned ChatResponse.usage shape', async () => {
    const restore = stubJson(
      chatFixture({
        prompt_tokens: 1200,
        completion_tokens: 40,
        total_tokens: 1240,
        prompt_tokens_details: { cached_tokens: 1024 },
      })
    );
    let res;
    try {
      res = await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'hi' }],
      });
    } finally {
      restore();
    }

    expect(res.usage).toEqual({ prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 });
  });
});
