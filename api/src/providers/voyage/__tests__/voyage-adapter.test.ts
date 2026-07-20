// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * VoyageAdapter — contract tests against the documented Voyage API surface.
 *
 * These are unit tests, not integration tests: we stub `globalThis.fetch` and
 * assert on the URL, method, headers, and body the adapter sends. That mirrors
 * the documented Voyage docs 1:1 and catches regressions in the request
 * assembler without needing a real API key.
 *
 * Voyage's documented endpoints:
 *   - GET  /v1/models
 *   - POST /v1/embeddings
 *   - POST /v1/rerank
 *   (No chat endpoint — adapter MUST throw on chatCompletion.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoyageAdapter } from '../voyage-adapter';

const BASE = 'https://api.voyageai.com/v1';

// Build a helper that stubs `fetch` to return a configured response.
type FetchCall = { url: string; init: RequestInit };
const calls: FetchCall[] = [];

function stubFetch(jsonBody: unknown, init: { ok?: boolean; status?: number } = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, fetchInit?: RequestInit) => {
    calls.push({ url: String(url), init: fetchInit ?? {} });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => jsonBody,
      text: async () => JSON.stringify(jsonBody),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function makeAdapter(): VoyageAdapter {
  return new VoyageAdapter({
    apiKey: 'voyage-test-key',
    baseUrl: BASE,
  });
}

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('VoyageAdapter — embeddings', () => {
  it('POSTs /embeddings with documented body shape', async () => {
    const restore = stubFetch({
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
      model: 'voyage-fixture-embed',
      usage: { total_tokens: 5 },
    });
    try {
      const adapter = makeAdapter();
      const res = await adapter.generateEmbeddings({
        model: 'voyage-fixture-embed',
        input: 'hello world',
      });
      expect(res.data).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${BASE}/embeddings`);
      expect(calls[0].init.method).toBe('POST');
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.model).toBe('voyage-fixture-embed');
      expect(body.input).toBe('hello world');
    } finally {
      restore();
    }
  });

  it('forwards voyage-specific input_type when set on request', async () => {
    const restore = stubFetch({ object: 'list', data: [], model: 'voyage-fixture-embed' });
    try {
      const adapter = makeAdapter();
      await adapter.generateEmbeddings({
        model: 'voyage-fixture-embed',
        input: ['doc1', 'doc2'],
        // voyage extension, threaded via request cast
        input_type: 'document',
      } as unknown as Parameters<VoyageAdapter['generateEmbeddings']>[0]);

      const body = JSON.parse(String(calls[0].init.body));
      expect(body.input_type).toBe('document');
    } finally {
      restore();
    }
  });

  it('sends Authorization: Bearer header', async () => {
    const restore = stubFetch({ object: 'list', data: [], model: 'voyage-fixture-embed' });
    try {
      const adapter = makeAdapter();
      await adapter.generateEmbeddings({ model: 'voyage-fixture-embed', input: 'q' });
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer voyage-test-key');
      expect(headers['Content-Type']).toBe('application/json');
    } finally {
      restore();
    }
  });
});

describe('VoyageAdapter — rerank', () => {
  it('POSTs /rerank with documented body shape', async () => {
    const restore = stubFetch({
      object: 'list',
      model: 'rerank-fixture',
      data: [{ index: 0, relevance_score: 0.9 }],
      usage: { total_tokens: 10 },
    });
    try {
      const adapter = makeAdapter();
      const res = await adapter.rerank({
        query: 'what is rust',
        documents: ['rust is a systems language', 'go is simpler'],
        model: 'rerank-fixture',
        top_k: 1,
        return_documents: false,
      });
      expect(res.data[0].relevance_score).toBe(0.9);
      expect(calls[0].url).toBe(`${BASE}/rerank`);
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.query).toBe('what is rust');
      expect(body.documents).toHaveLength(2);
      expect(body.top_k).toBe(1);
      expect(body.return_documents).toBe(false);
    } finally {
      restore();
    }
  });

  it('rejects empty query and empty documents before hitting the wire', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.rerank({ query: '', documents: ['a'], model: 'rerank-fixture' }),
    ).rejects.toThrow(/query.*non-empty/i);
    await expect(
      adapter.rerank({ query: 'q', documents: [], model: 'rerank-fixture' }),
    ).rejects.toThrow(/documents.*non-empty/i);
  });
});

describe('VoyageAdapter — chat is explicitly unsupported', () => {
  it('chatCompletion throws a clear message', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.chatCompletion({
        model: 'voyage-fixture-embed',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/embeddings \+ rerank only/i);
  });

  it('chatCompletionStream throws a clear message', async () => {
    const adapter = makeAdapter();
    const gen = adapter.chatCompletionStream({
      model: 'voyage-fixture-embed',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await expect(gen.next()).rejects.toThrow(/embeddings \+ rerank only/i);
  });
});

describe('VoyageAdapter — healthcheck', () => {
  it('returns unhealthy when apiKey missing', async () => {
    const adapter = new VoyageAdapter({
      apiKey: '',
      baseUrl: BASE,
    });
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/VOYAGE_API_KEY/);
  });
});
