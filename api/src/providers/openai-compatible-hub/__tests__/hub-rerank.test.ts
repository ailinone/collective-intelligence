// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OpenAICompatibleHubAdapter.rerank — LOTE AP.
 *
 * One hub implementation covers every catalog provider that offers rerank,
 * because they all speak the Cohere dialect. These tests pin the two things
 * that make that safe:
 *
 *   1. **Fails closed with no catalog-declared path.** The override exists on
 *      EVERY hub instance, so `isAdapterMethodOverridden` reports rerank as
 *      present for all of them; the closed door is what keeps a non-rerank
 *      hub from blind-POSTing `/rerank` and 404ing. This is the exact failure
 *      apertis hit on 2026-07-16.
 *   2. **Normalizes both response dialects** into the portable contract —
 *      Cohere's `results[].document.text` object and Voyage-style `data[]`
 *      with a bare-string document — with descending order guaranteed and
 *      indices pointing into the ORIGINAL document array.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleHubAdapter } from '../openai-compatible-hub-adapter';
import type { Model } from '@/types';

const BASE = 'https://hub.example.test/v1';

function makeAdapter(rerankPath?: string): OpenAICompatibleHubAdapter {
  const adapter = new OpenAICompatibleHubAdapter({
    name: 'fixture-hub',
    enabled: true,
    providerName: 'fixture-hub',
    apiKey: 'sk-fixture',
    baseUrl: BASE,
    maxRetries: 0,
    metadata: { ...(rerankPath ? { rerankPath } : {}) },
  });
  // `normalizeModelName` (shared by every hub method) resolves ids against
  // the catalog via `getModels()`, which is a DB round trip. Stubbed so these
  // stay unit tests of the rerank wire, not of model-name resolution.
  vi.spyOn(adapter, 'getModels').mockResolvedValue([
    { id: 'bge-reranker-v2-m3', name: 'bge-reranker-v2-m3' } as unknown as Model,
  ]);
  return adapter;
}

const MODEL = {
  id: 'bge-reranker-v2-m3',
  name: 'bge-reranker-v2-m3',
  provider: 'fixture-hub',
} as unknown as Model;

const DOCS = ['alpha', 'beta', 'gamma'];

interface Captured {
  url: string;
  body: unknown;
}

function stubFetch(payload: unknown, captured: Captured[]) {
  return vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    captured.push({
      url: String(url),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  });
}

describe('OpenAICompatibleHubAdapter — rerank', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('fails closed when the catalog declared no rerank endpoint', async () => {
    const captured: Captured[] = [];
    globalThis.fetch = stubFetch({ results: [] }, captured) as unknown as typeof fetch;
    const adapter = makeAdapter();

    await expect(adapter.rerank(MODEL, { query: 'q', documents: DOCS })).rejects.toThrow(
      /declares no rerank endpoint/
    );
    // The important half: no HTTP was attempted at all.
    expect(captured).toHaveLength(0);
  });

  it('POSTs the catalog path with a Cohere-shaped body', async () => {
    const captured: Captured[] = [];
    globalThis.fetch = stubFetch(
      { results: [{ index: 0, relevance_score: 0.5 }] },
      captured
    ) as unknown as typeof fetch;
    // empiriolabs uses the PLURAL path — the catalog override must win.
    const adapter = makeAdapter('/reranks');

    await adapter.rerank(MODEL, { query: 'q', documents: DOCS, topN: 2, returnDocuments: true });

    expect(captured[0].url).toBe(`${BASE}/reranks`);
    expect(captured[0].body).toMatchObject({
      model: 'bge-reranker-v2-m3',
      query: 'q',
      documents: DOCS,
      top_n: 2,
      return_documents: true,
    });
  });

  it('normalizes the Cohere dialect (results[].document.text) and sorts descending', async () => {
    const captured: Captured[] = [];
    globalThis.fetch = stubFetch(
      {
        results: [
          { index: 0, relevance_score: 0.11, document: { text: 'alpha' } },
          { index: 2, relevance_score: 0.97, document: { text: 'gamma' } },
        ],
      },
      captured
    ) as unknown as typeof fetch;
    const adapter = makeAdapter('/rerank');

    const result = await adapter.rerank(MODEL, { query: 'q', documents: DOCS });

    expect(result.results).toEqual([
      { index: 2, relevanceScore: 0.97, document: 'gamma' },
      { index: 0, relevanceScore: 0.11, document: 'alpha' },
    ]);
  });

  it('normalizes the Voyage dialect (data[] with a bare-string document)', async () => {
    const captured: Captured[] = [];
    globalThis.fetch = stubFetch(
      {
        data: [
          { index: 1, relevance_score: 0.8, document: 'beta' },
          { index: 0, relevance_score: 0.2, document: 'alpha' },
        ],
        usage: { total_tokens: 31 },
      },
      captured
    ) as unknown as typeof fetch;
    const adapter = makeAdapter('/rerank');

    const result = await adapter.rerank(MODEL, { query: 'q', documents: DOCS });

    expect(result.results.map((r) => r.index)).toEqual([1, 0]);
    expect(result.results[0].document).toBe('beta');
    expect(result.totalTokens).toBe(31);
  });

  it('falls back to positional index when the provider omits one', async () => {
    const captured: Captured[] = [];
    globalThis.fetch = stubFetch(
      { results: [{ relevance_score: 0.9 }, { relevance_score: 0.1 }] },
      captured
    ) as unknown as typeof fetch;
    const adapter = makeAdapter('/rerank');

    const result = await adapter.rerank(MODEL, { query: 'q', documents: DOCS });

    // Without the positional fallback every entry would collapse onto index 0
    // and the caller could not address the documents at all.
    expect(result.results.map((r) => r.index)).toEqual([0, 1]);
  });

  it('rejects a response carrying neither results nor data', async () => {
    const captured: Captured[] = [];
    globalThis.fetch = stubFetch({ nonsense: true }, captured) as unknown as typeof fetch;
    const adapter = makeAdapter('/rerank');

    await expect(adapter.rerank(MODEL, { query: 'q', documents: DOCS })).rejects.toThrow(
      /neither a `results` nor a `data` array/
    );
  });

  it('validates locally before spending a round trip', async () => {
    const captured: Captured[] = [];
    globalThis.fetch = stubFetch({ results: [] }, captured) as unknown as typeof fetch;
    const adapter = makeAdapter('/rerank');

    await expect(adapter.rerank(MODEL, { query: '  ', documents: DOCS })).rejects.toThrow(
      /query must be non-empty/
    );
    await expect(adapter.rerank(MODEL, { query: 'q', documents: [] })).rejects.toThrow(
      /documents must be a non-empty array/
    );
    expect(captured).toHaveLength(0);
  });
});
