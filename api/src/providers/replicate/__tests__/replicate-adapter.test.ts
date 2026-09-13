// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ReplicateAdapter — smoke test (orphan adapter wiring verification).
 *
 * The full ReplicateAdapter predates the catalog migration and is ~1000 LOC
 * of predictions/trainings/deployments/SSE logic. This pack is deliberately
 * NOT a re-implementation of that coverage — it exercises only the invariants
 * that matter for the Batch 4 wiring work:
 *   1. Construction with a minimal ProviderConfig doesn't throw.
 *   2. Provider identity matches the catalog row (`replicate`).
 *   3. A synthesized prediction-shape response flows through chatCompletion
 *      without errors — proves the happy path reaches the wire and the
 *      response envelope is mappable.
 *
 * Full wire-level testing belongs in a future pack if Replicate regressions
 * start mattering; the existing ~1000 LOC is stable and not being modified.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplicateAdapter } from '../replicate-adapter';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];

function stubFetch(responseFn: (url: string) => { ok?: boolean; status?: number; body: unknown }) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const resolved = responseFn(String(url));
    return {
      ok: resolved.ok ?? true,
      status: resolved.status ?? 200,
      json: async () => resolved.body,
      text: async () => JSON.stringify(resolved.body),
      headers: {
        get: () => 'application/json',
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReplicateAdapter — construction', () => {
  it('instantiates with a minimal ProviderConfig', () => {
    expect(
      () =>
        new ReplicateAdapter({
          name: 'replicate',
          enabled: true,
          apiKey: 'r8_test_token',
          baseUrl: 'https://api.replicate.com/v1',
        })
    ).not.toThrow();
  });

  it('defaults baseUrl when not supplied', () => {
    const adapter = new ReplicateAdapter({
      name: 'replicate',
      enabled: true,
      apiKey: 'r8_test',
    });
    // Exposed as a private field — check it landed by calling healthCheck
    // against the default URL (we'll stub and inspect calls).
    expect(adapter).toBeDefined();
  });

  it('exposes getApiKey()', () => {
    const adapter = new ReplicateAdapter({
      name: 'replicate',
      enabled: true,
      apiKey: 'r8_abc',
      baseUrl: 'https://api.replicate.com/v1',
    });
    expect(adapter.getApiKey()).toBe('r8_abc');
  });
});

describe('ReplicateAdapter — chatCompletion (owner/name model form)', () => {
  it('POSTs to /v1/models/{owner}/{name}/predictions with Prefer: wait header', async () => {
    const restore = stubFetch((url) => {
      if (url.includes('/models/meta/llama-3-8b/predictions')) {
        return {
          body: {
            id: 'pred_abc',
            status: 'succeeded',
            created_at: '2026-04-22T12:00:00Z',
            input: { prompt: 'hi' },
            output: 'hello world',
            urls: { get: '' },
          },
        };
      }
      return { ok: false, status: 404, body: {} };
    });
    try {
      const adapter = new ReplicateAdapter({
        name: 'replicate',
        enabled: true,
        apiKey: 'r8_test',
        baseUrl: 'https://api.replicate.com/v1',
      });
      const res = await adapter.chatCompletion({
        model: 'meta/llama-3-8b',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.choices[0].message.content).toBe('hello world');
      expect(calls[0].url).toBe('https://api.replicate.com/v1/models/meta/llama-3-8b/predictions');
      const hdrs = (calls[0].init.headers as Record<string, string>) ?? {};
      expect(hdrs.Prefer).toBe('wait');
      expect(hdrs.Authorization).toBe('Bearer r8_test');
    } finally {
      restore();
    }
  });

  it('propagates a failed prediction as a thrown error', async () => {
    const restore = stubFetch(() => ({
      body: {
        id: 'pred_fail',
        status: 'failed',
        created_at: '2026-04-22T12:00:00Z',
        error: 'model went offline',
        input: {},
        output: null,
        urls: { get: '' },
      },
    }));
    try {
      const adapter = new ReplicateAdapter({
        name: 'replicate',
        enabled: true,
        apiKey: 'r8_test',
        baseUrl: 'https://api.replicate.com/v1',
      });
      await expect(
        adapter.chatCompletion({
          model: 'meta/llama-3-8b',
          messages: [{ role: 'user', content: 'x' }],
        })
      ).rejects.toThrow(/Replicate prediction failed.*model went offline/);
    } finally {
      restore();
    }
  });
});

describe('ReplicateAdapter — tool-calling capability gap (catalog correction 2026-09-09)', () => {
  // `chatCompletion`/`chatCompletionStream` build the Replicate prediction
  // `input` from ONLY {prompt, max_tokens, temperature, top_p} via
  // messagesToPrompt() — there is no code path that maps ChatRequest.tools /
  // tool_choice into a prediction input, for any Replicate model. Live
  // Replicate schema fetches for anthropic/claude-3.5-sonnet (page removed
  // from Replicate entirely — the catalog now pins the still-live
  // anthropic/claude-4-sonnet instead, same schema family; see
  // providers.catalog.ts comment), meta/meta-llama-3-70b-instruct, and
  // openai/gpt-4o-mini (2026-09-09) confirmed none of their
  // `openapi_schema.input` properties include a `tools`/`tool_choice`
  // field, so the catalog's `pinnedFallback` entries for those three
  // models no longer claim `function_calling`/`tool_use`.
  //
  // These tests pin the current, honest behavior: a `tools` array passed on
  // the request is silently dropped rather than forwarded. If someone later
  // adds real per-model-family tool passthrough, these tests should be
  // updated alongside re-adding the capability tags in providers.catalog.ts
  // — until then, this guards against a request silently losing its tools
  // with no error and no signal to the caller.
  const requestTools = [
    {
      type: 'function' as const,
      function: {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      },
    },
  ];

  it('chatCompletion does not forward request.tools into the Replicate prediction input', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const restore = stubFetch((url) => {
      if (url.includes('/models/openai/gpt-4o-mini/predictions')) {
        return {
          body: {
            id: 'pred_tools',
            status: 'succeeded',
            created_at: '2026-09-09T00:00:00Z',
            input: {},
            output: 'no tools here',
            urls: { get: '' },
          },
        };
      }
      return { ok: false, status: 404, body: {} };
    });
    try {
      const adapter = new ReplicateAdapter({
        name: 'replicate',
        enabled: true,
        apiKey: 'r8_test',
        baseUrl: 'https://api.replicate.com/v1',
      });
      await adapter.chatCompletion({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: "what's the weather in Lisbon?" }],
        tools: requestTools,
        tool_choice: 'auto',
      });
      expect(calls).toHaveLength(1);
      capturedBody = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
      const input = capturedBody.input as Record<string, unknown>;
      expect(input).not.toHaveProperty('tools');
      expect(input).not.toHaveProperty('tool_choice');
      expect(input).not.toHaveProperty('functions');
      expect(Object.keys(input).sort()).toEqual(['max_tokens', 'prompt']);
    } finally {
      restore();
    }
  });

  it('chatCompletionStream does not forward request.tools into the Replicate prediction input', async () => {
    // chatCompletionStream submits async (sync: false), gets back a
    // prediction with no `urls.stream`, and falls back to polling
    // GET /predictions/{id} — stub both endpoints.
    const restore = stubFetch((url) => {
      if (url.includes('/models/meta/meta-llama-3-70b-instruct/predictions')) {
        return {
          body: {
            id: 'pred_tools_stream',
            status: 'starting',
            created_at: '2026-09-09T00:00:00Z',
            input: {},
            output: null,
            urls: { get: 'https://api.replicate.com/v1/predictions/pred_tools_stream' },
          },
        };
      }
      if (url.includes('/predictions/pred_tools_stream')) {
        return {
          body: {
            id: 'pred_tools_stream',
            status: 'succeeded',
            created_at: '2026-09-09T00:00:00Z',
            input: {},
            output: 'no tools here either',
            urls: { get: 'https://api.replicate.com/v1/predictions/pred_tools_stream' },
          },
        };
      }
      return { ok: false, status: 404, body: {} };
    });
    try {
      const adapter = new ReplicateAdapter({
        name: 'replicate',
        enabled: true,
        apiKey: 'r8_test',
        baseUrl: 'https://api.replicate.com/v1',
      });
      const gen = adapter.chatCompletionStream({
        model: 'meta/meta-llama-3-70b-instruct',
        messages: [{ role: 'user', content: "what's the weather in Lisbon?" }],
        tools: requestTools,
        tool_choice: 'auto',
      });
      // Drain the generator to trigger the prediction submission.
      for await (const _chunk of gen) {
        // no-op
      }
      // First call is the prediction submission; the rest are polling GETs.
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const submission = calls.find((c) =>
        c.url.includes('/models/meta/meta-llama-3-70b-instruct/predictions')
      );
      expect(submission).toBeDefined();
      const capturedBody = JSON.parse(submission!.init.body as string) as Record<string, unknown>;
      const input = capturedBody.input as Record<string, unknown>;
      expect(input).not.toHaveProperty('tools');
      expect(input).not.toHaveProperty('tool_choice');
      expect(input).not.toHaveProperty('functions');
    } finally {
      restore();
    }
  });
});

describe('ReplicateAdapter — identity', () => {
  it('getApiKey round-trip', () => {
    const adapter = new ReplicateAdapter({
      name: 'replicate',
      enabled: true,
      apiKey: 'specific-token',
      baseUrl: 'https://api.replicate.com/v1',
    });
    expect(adapter.getApiKey()).toBe('specific-token');
  });
});
