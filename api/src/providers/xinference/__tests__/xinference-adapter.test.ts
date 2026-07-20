// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * XinferenceAdapter — rerank surface assertions, wire shape + error handling.
 *
 * Xinference's OAI surface is covered by hub tests; this pack exclusively
 * exercises the `rerank()` extension that distinguishes it from a plain
 * self-hosted OAI server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XinferenceAdapter } from '../xinference-adapter';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];

function stubFetch(response: { ok?: boolean; status?: number; body: unknown }) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeAdapter() {
  return new XinferenceAdapter({
    name: 'xinference',
    enabled: true,
    providerName: 'xinference',
    apiKey: '',
    baseUrl: 'http://localhost:9997/v1',
  });
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('XinferenceAdapter — rerank wire', () => {
  it('POSTs /v1/rerank with Cohere-shaped body', async () => {
    const restore = stubFetch({
      body: {
        results: [
          { index: 1, relevance_score: 0.92 },
          { index: 0, relevance_score: 0.45 },
        ],
      },
    });
    try {
      const adapter = makeAdapter();
      const res = await adapter.rerank({
        model: 'bge-reranker-v2-m3',
        query: 'what is vitamin C?',
        documents: ['unrelated doc', 'vitamin C is ascorbic acid'],
        top_n: 2,
      });
      expect(res.results).toHaveLength(2);
      expect(res.results[0].index).toBe(1);
      expect(calls[0].url).toBe('http://localhost:9997/v1/rerank');
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.model).toBe('bge-reranker-v2-m3');
      expect(body.query).toBe('what is vitamin C?');
      expect(body.documents).toHaveLength(2);
      expect(body.top_n).toBe(2);
      expect(body.return_documents).toBe(false);
    } finally {
      restore();
    }
  });

  it('returns empty results without hitting network for empty documents', async () => {
    const sentinel = { count: 0 };
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      sentinel.count++;
      return Promise.resolve({ ok: false, status: 500 } as Response);
    }) as unknown as typeof fetch;
    try {
      const adapter = makeAdapter();
      const res = await adapter.rerank({ model: 'm', query: 'q', documents: [] });
      expect(res.results).toEqual([]);
      expect(sentinel.count).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects missing model', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.rerank({ model: '', query: 'q', documents: ['a'] }),
    ).rejects.toThrow(/model is required/);
  });

  it('rejects missing query', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.rerank({ model: 'm', query: '', documents: ['a'] }),
    ).rejects.toThrow(/query is required/);
  });

  it('rejects non-array documents', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.rerank({ model: 'm', query: 'q', documents: 'not-an-array' as unknown as string[] }),
    ).rejects.toThrow(/documents must be an array/);
  });

  it('propagates HTTP error with snippet', async () => {
    const restore = stubFetch({ ok: false, status: 500, body: { error: 'model not loaded' } });
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.rerank({ model: 'm', query: 'q', documents: ['a'] }),
      ).rejects.toThrow(/500.*model not loaded/);
    } finally {
      restore();
    }
  });

  it('validates response shape — throws when results missing', async () => {
    const restore = stubFetch({ body: { not_results: [] } });
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.rerank({ model: 'm', query: 'q', documents: ['a'] }),
      ).rejects.toThrow(/results.*array/);
    } finally {
      restore();
    }
  });
});

describe('XinferenceAdapter — identity', () => {
  it('providerName is "xinference"', () => {
    const adapter = makeAdapter();
    expect((adapter as unknown as { providerName: string }).providerName).toBe('xinference');
    expect(adapter.displayName).toBe('Xinference');
  });
});
