// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for the GET /v1/models serialization + pagination core.
 *
 * These guard the fix for the 2026-06-10 production OOM: serializing the full
 * ~64k-row runnable catalog into one ~53MB JSON string overran V8's old-space
 * heap and crash-looped the container (exit 139). The endpoint now defaults to
 * a BOUNDED page and only streams the full set on explicit `?all=true`.
 *
 * The logic under test lives in a deliberately dependency-light module
 * (`models-list-serialization.ts`) so it can be exercised here WITHOUT a
 * database, Docker, or the heavy provider-registry import chain — hence this
 * file lives under src/tests/** (covered by the no-DB vitest.unit.config.ts).
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildModelDto,
  entrySupportsEndpoint,
  resolveModelsPage,
  streamModelsResponse,
  type RankedEntry,
} from '@/routes/models/models-list-serialization';

function makeEntry(
  i: number,
  overrides: { capabilities?: string[]; provider?: string } = {}
): RankedEntry {
  const provider = overrides.provider ?? 'openai';
  const capabilities = overrides.capabilities ?? ['chat', 'text_generation'];
  const model = {
    id: `model-${i}`,
    name: `${provider}/model-${i}`,
    displayName: `Model ${i}`,
    provider,
    capabilities,
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    performance: { reliability: 0.9, quality: 0.8 },
    status: 'active',
    metadata: {},
  };
  const operability = {
    runnable: true,
    originProvider: provider,
    executionProvider: provider,
    resolvedProvider: provider,
    fallbackChain: [] as string[],
    nonOperationalReasons: [] as string[],
    warnings: [] as string[],
  };
  // Cast: the test only populates the fields buildModelDto / operability read.
  return { model, operability } as unknown as RankedEntry;
}

function makeEntries(n: number): RankedEntry[] {
  return Array.from({ length: n }, (_, i) => makeEntry(i));
}

describe('resolveModelsPage — bounded by default', () => {
  it('returns at most DEFAULT_PAGE_SIZE rows out of a 64k catalog', () => {
    const entries = makeEntries(64_000);
    const page = resolveModelsPage(entries, {});

    expect(page.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(page.returned).toBe(DEFAULT_PAGE_SIZE);
    expect(page.pageEntries).toHaveLength(DEFAULT_PAGE_SIZE);
    // The full catalog is reported as the total, but only one page is sliced.
    expect(page.total).toBe(64_000);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(DEFAULT_PAGE_SIZE);
  });

  it('serializes a tiny payload for the default page (not the whole ~53MB catalog)', () => {
    const entries = makeEntries(64_000);
    const page = resolveModelsPage(entries, {});

    const pageBody = JSON.stringify(page.pageEntries.map(buildModelDto));
    const oneRowBytes = JSON.stringify(buildModelDto(entries[0])).length;
    const fullCatalogEstimate = oneRowBytes * entries.length;

    // Sanity: a full serialization really would be multi-megabyte.
    expect(fullCatalogEstimate).toBeGreaterThan(5_000_000);
    // The default page is bounded to ~one page, a tiny fraction of the catalog.
    expect(pageBody.length).toBeLessThan(fullCatalogEstimate / 100);
    expect(pageBody.length).toBeLessThan(250_000); // < 250KB regardless of catalog size
  });

  it('clamps limit into [1, MAX_PAGE_SIZE] and truncates non-integers', () => {
    expect(resolveModelsPage(makeEntries(5_000), { limit: 99_999 }).limit).toBe(MAX_PAGE_SIZE);
    expect(resolveModelsPage(makeEntries(10), { limit: 0 }).limit).toBe(1);
    expect(resolveModelsPage(makeEntries(10), { limit: -5 }).limit).toBe(1);
    expect(resolveModelsPage(makeEntries(10), { limit: 3.9 }).limit).toBe(3);
  });

  it('even the maximum allowed page is bounded well below the catalog', () => {
    const entries = makeEntries(64_000);
    const page = resolveModelsPage(entries, { limit: 10_000 }); // clamped to MAX_PAGE_SIZE
    expect(page.limit).toBe(MAX_PAGE_SIZE);
    expect(page.returned).toBe(MAX_PAGE_SIZE);
    expect(page.returned).toBeLessThan(entries.length);
  });
});

describe('resolveModelsPage — offset paging', () => {
  it('walks to the final partial page and reports hasMore=false', () => {
    const entries = makeEntries(250);
    const page = resolveModelsPage(entries, { limit: 100, offset: 200 });
    expect(page.offset).toBe(200);
    expect(page.returned).toBe(50);
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  it('returns an empty page when offset is past the end', () => {
    const entries = makeEntries(250);
    const page = resolveModelsPage(entries, { offset: 1_000 });
    expect(page.returned).toBe(0);
    expect(page.pageEntries).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  it('clamps a negative offset to 0', () => {
    expect(resolveModelsPage(makeEntries(10), { offset: -10 }).offset).toBe(0);
  });

  it('produces a contiguous, complete walk via nextOffset', () => {
    const entries = makeEntries(450);
    const seen = new Set<string>();
    let offset = 0;
    let guard = 0;
    for (;;) {
      const page = resolveModelsPage(entries, { limit: 100, offset });
      for (const e of page.pageEntries) seen.add(e.model.id);
      if (!page.hasMore) break;
      offset = page.nextOffset!;
      if (++guard > 100) throw new Error('pagination did not terminate');
    }
    expect(seen.size).toBe(450); // every row visited exactly once across pages
  });
});

describe('buildModelDto — row shape', () => {
  it('projects the OpenAI-style row with pricing and operability', () => {
    const dto = buildModelDto(makeEntry(7));
    expect(dto.id).toBe('model-7');
    expect(dto.runnable).toBe(true);
    expect(dto.operability).toBe('operational');
    expect(dto.pricing).toEqual({ inputCostPer1M: 1.0, outputCostPer1M: 2.0, currency: 'USD' });
    expect(Array.isArray(dto.endpoints)).toBe(true);
    expect(dto.endpoints).toContain('chat_completions');
  });
});

describe('entrySupportsEndpoint — cheap endpoint filter', () => {
  it('matches chat models to chat_completions and embedding models to embeddings', () => {
    const chat = makeEntry(1, { capabilities: ['chat', 'text_generation'] });
    const embed = makeEntry(2, { capabilities: ['embeddings'] });

    expect(entrySupportsEndpoint(chat, 'chat_completions')).toBe(true);
    expect(entrySupportsEndpoint(chat, 'embeddings')).toBe(false);
    expect(entrySupportsEndpoint(embed, 'embeddings')).toBe(true);
    expect(entrySupportsEndpoint(embed, 'chat_completions')).toBe(false);
  });
});

describe('streamModelsResponse — memory-bounded full inventory', () => {
  it('emits valid JSON containing every row, one chunk per row', async () => {
    const entries = makeEntries(1_000);
    const head = {
      object: 'list',
      scope: 'runnable',
      endpointFilter: null,
      streamed: true,
      counts: { catalog: 1_000, runnable: 1_000, scoped: 1_000, matched: 1_000, returned: 1_000 },
    };

    const chunks: string[] = [];
    for await (const chunk of streamModelsResponse(head, entries)) {
      chunks.push(chunk);
    }
    const whole = chunks.join('');
    const parsed = JSON.parse(whole);

    expect(parsed.object).toBe('list');
    expect(parsed.streamed).toBe(true);
    expect(parsed.counts.matched).toBe(1_000);
    expect(parsed.data).toHaveLength(1_000);
    expect(parsed.data[0].id).toBe('model-0');
    expect(parsed.data[999].id).toBe('model-999');

    // Memory-bound proof: head + one chunk per row + closing tail. No single
    // chunk ever holds the whole array, so peak heap is ~one row, not O(catalog).
    expect(chunks.length).toBe(entries.length + 2);
    const maxChunk = Math.max(...chunks.map((c) => c.length));
    expect(maxChunk).toBeLessThan(whole.length / 100);
  });

  it('streamed rows are byte-identical to the paginated DTO (single source of truth)', async () => {
    const entry = makeEntry(42);
    const chunks: string[] = [];
    for await (const chunk of streamModelsResponse({ object: 'list', counts: {} }, [entry])) {
      chunks.push(chunk);
    }
    const parsed = JSON.parse(chunks.join(''));
    expect(parsed.data[0]).toEqual(buildModelDto(entry));
  });
});
