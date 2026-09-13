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
 * (LOTE AZ resolver, `utils/reasoning-effort.ts`) to xAI's real Grok wire
 * parameter.
 *
 * xAI's own reasoning guide (https://docs.x.ai/docs/guides/reasoning)
 * states: "grok-3-mini and grok-3-mini-fast are currently the only models
 * that support the reasoning_effort parameter", and that its accepted
 * values are `'low'` and `'high'` only — there is no `'medium'` tier, and
 * every other Grok model (grok-4 and later) REJECTS the field with an API
 * error if it is sent. These tests cover both the gating (only grok-3-mini
 * gets the field at all) and the 3-tier -> 2-tier translation (`medium`
 * rounds up to `high`).
 */
import { describe, it, expect } from 'vitest';
import { XAIAdapter } from '@/providers/xai/xai-adapter';
import type { ChatRequest } from '@/types';

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

function buildAdapter(responseBody: unknown = { id: 'x', choices: [], model: 'grok-3-mini' }) {
  const calls: FetchCall[] = [];
  const adapter = new XAIAdapter({ apiKey: 'test-key' });

  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    return {
      ok: true,
      status: 200,
      json: async () => responseBody,
    } as unknown as Response;
  }) as typeof fetch;

  (globalThis as { fetch: typeof fetch }).fetch = fakeFetch;

  return { adapter, calls };
}

const BASE_MESSAGES: ChatRequest['messages'] = [{ role: 'user', content: 'hello' }];

describe('XAIAdapter — reasoning_effort forwarding (chatCompletion)', () => {
  it('forwards low effort verbatim for grok-3-mini', async () => {
    const { adapter, calls } = buildAdapter();
    const request: ChatRequest = {
      model: 'grok-3-mini',
      messages: BASE_MESSAGES,
      reasoning_effort: 'low',
    };

    await adapter.chatCompletion(request);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.reasoning_effort).toBe('low');
  });

  it('rounds medium up to high for grok-3-mini (no medium tier on the real API)', async () => {
    const { adapter, calls } = buildAdapter();
    const request: ChatRequest = {
      model: 'grok-3-mini',
      messages: BASE_MESSAGES,
      reasoning_effort: 'medium',
    };

    await adapter.chatCompletion(request);

    expect(calls[0]?.body.reasoning_effort).toBe('high');
  });

  it('forwards high effort verbatim for grok-3-mini-fast', async () => {
    const { adapter, calls } = buildAdapter();
    const request: ChatRequest = {
      model: 'grok-3-mini-fast',
      messages: BASE_MESSAGES,
      reasoning_effort: 'high',
    };

    await adapter.chatCompletion(request);

    expect(calls[0]?.body.reasoning_effort).toBe('high');
  });

  it('never sends reasoning_effort to grok-4, which rejects the parameter', async () => {
    const { adapter, calls } = buildAdapter();
    const request: ChatRequest = {
      model: 'grok-4',
      messages: BASE_MESSAGES,
      reasoning_effort: 'high',
    };

    await adapter.chatCompletion(request);

    expect('reasoning_effort' in calls[0]!.body).toBe(false);
  });

  it('never sends reasoning_effort to a non-reasoning Grok model', async () => {
    const { adapter, calls } = buildAdapter();
    const request: ChatRequest = {
      model: 'grok-2-latest',
      messages: BASE_MESSAGES,
      reasoning_effort: 'high',
    };

    await adapter.chatCompletion(request);

    expect('reasoning_effort' in calls[0]!.body).toBe(false);
  });

  it('omits reasoning_effort when the caller expressed no effort at all', async () => {
    const { adapter, calls } = buildAdapter();
    const request: ChatRequest = {
      model: 'grok-3-mini',
      messages: BASE_MESSAGES,
    };

    await adapter.chatCompletion(request);

    expect('reasoning_effort' in calls[0]!.body).toBe(false);
  });

  it('defaults to medium->high when only the legacy enable_reasoning flag is set', async () => {
    const { adapter, calls } = buildAdapter();
    const request: ChatRequest = {
      model: 'grok-3-mini',
      messages: BASE_MESSAGES,
      ailin_constraints: { enable_reasoning: true },
    };

    await adapter.chatCompletion(request);

    expect(calls[0]?.body.reasoning_effort).toBe('high');
  });
});

describe('XAIAdapter — reasoning_effort forwarding (chatCompletionStream)', () => {
  it('forwards reasoning_effort on the streaming request body', async () => {
    const adapter = new XAIAdapter({ apiKey: 'test-key' });
    const request: ChatRequest = {
      model: 'grok-3-mini',
      messages: BASE_MESSAGES,
      reasoning_effort: 'low',
    };

    let capturedBody: Record<string, unknown> | undefined;
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      _url: string,
      init?: RequestInit
    ) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return { ok: true, body: stream } as unknown as Response;
    }) as typeof fetch;

    const generator = adapter.chatCompletionStream(request);
    for await (const _chunk of generator) {
      // Drain — only the outgoing request body matters here.
    }

    expect(capturedBody?.reasoning_effort).toBe('low');
  });
});
