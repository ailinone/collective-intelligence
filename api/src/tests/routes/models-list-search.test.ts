// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for the GET /v1/models server-side search/filter core
 * (search / provider / capability / modality + facets), extracted into the
 * dependency-light serialization module so — like models-list-serialization
 * tests — they run WITHOUT a database, Docker, or the provider registry.
 *
 * Contract being guarded (chat/ailin.one proxy consumer):
 * - multi-token search = AND, case-insensitive substring over id/name/
 *   displayName (substring subsumes id-prefix)
 * - provider matches provider OR originProvider; capability/modality are
 *   membership checks
 * - NO filter params → the SAME array reference flows through (legacy path
 *   stays byte-identical)
 * - facets = provider/capability counts over the FILTERED set, top 12
 * - pagination operates on the post-filter set (total == filtered length)
 */

import { describe, it, expect } from 'vitest';
import {
  buildModelsFacets,
  filterRankedEntries,
  hasModelsListFilters,
  MODELS_FACET_LIMIT,
  resolveModelsPage,
  type RankedEntry,
} from '@/routes/models/models-list-serialization';

type EntryOverrides = {
  id?: string;
  name?: string;
  displayName?: string;
  provider?: string;
  originProvider?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
};

function makeSearchEntry(overrides: EntryOverrides = {}): RankedEntry {
  const provider = overrides.provider ?? 'openai';
  const id = overrides.id ?? `model-${Math.random().toString(36).slice(2)}`;
  const model = {
    id,
    name: overrides.name ?? `${provider}/${id}`,
    displayName: overrides.displayName ?? id,
    provider,
    capabilities: overrides.capabilities ?? ['chat', 'streaming'],
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    performance: { reliability: 0.9, quality: 0.8 },
    status: 'active',
    metadata: overrides.metadata ?? {},
  };
  const operability = {
    runnable: true,
    originProvider: overrides.originProvider ?? provider,
    executionProvider: provider,
    resolvedProvider: provider,
    fallbackChain: [] as string[],
    nonOperationalReasons: [] as string[],
    warnings: [] as string[],
  };
  // Cast: the test only populates the fields the filter/facet code reads.
  return { model, operability } as unknown as RankedEntry;
}

function searchFixture(): RankedEntry[] {
  return [
    makeSearchEntry({
      id: 'qwen3-next-80b-a3b',
      name: 'qwen/qwen3-next-80b-a3b',
      displayName: 'Qwen3 Next 80B',
      provider: 'qwen',
      capabilities: ['chat', 'function_calling', 'streaming'],
      metadata: { input_modalities: ['text'], output_modalities: ['text'] },
    }),
    makeSearchEntry({
      id: 'qwen3-coder-480b',
      name: 'qwen/qwen3-coder-480b',
      displayName: 'Qwen3 Coder 480B',
      provider: 'qwen',
      capabilities: ['chat', 'streaming'],
      metadata: { input_modalities: ['text'], output_modalities: ['text'] },
    }),
    makeSearchEntry({
      id: 'openai-gpt-5.1',
      name: 'gpt-5.1',
      displayName: 'GPT-5.1',
      provider: 'openai',
      originProvider: 'azure-openai', // execution differs from origin
      capabilities: ['chat', 'function_calling', 'vision'],
      metadata: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    }),
    makeSearchEntry({
      id: 'openai-dall-e-3',
      name: 'dall-e-3',
      displayName: 'DALL·E 3',
      provider: 'openai',
      capabilities: ['image_generation'],
      metadata: { input_modalities: ['text'], output_modalities: ['image'] },
    }),
    makeSearchEntry({
      id: 'meta-llama-text-embed',
      name: 'llama/text-embed',
      displayName: 'Llama Text Embed',
      provider: 'meta',
      capabilities: ['embedding'],
      metadata: { input_modalities: ['text'], output_modalities: ['embedding'] },
    }),
  ];
}

describe('hasModelsListFilters', () => {
  it('is false for absent/blank params (legacy no-filter path)', () => {
    expect(hasModelsListFilters({})).toBe(false);
    expect(hasModelsListFilters({ search: '   ', provider: '' })).toBe(false);
  });

  it('is true when any filter param is set', () => {
    expect(hasModelsListFilters({ search: 'qwen' })).toBe(true);
    expect(hasModelsListFilters({ provider: 'openai' })).toBe(true);
    expect(hasModelsListFilters({ capability: 'chat' })).toBe(true);
    expect(hasModelsListFilters({ modality: 'image' })).toBe(true);
  });
});

describe('filterRankedEntries — multi-token search', () => {
  it('ANDs whitespace-separated tokens and is case-insensitive', () => {
    const filtered = filterRankedEntries(searchFixture(), { search: 'qwen3 NEXT' });
    expect(filtered.map((e) => e.model.id)).toEqual(['qwen3-next-80b-a3b']);
  });

  it('matches tokens against id, name AND displayName', () => {
    const byId = filterRankedEntries(searchFixture(), { search: 'gpt-5.1' });
    const byDisplay = filterRankedEntries(searchFixture(), { search: 'Coder 480' });
    const byAliasName = filterRankedEntries(searchFixture(), { search: 'llama text' });

    expect(byId.map((e) => e.model.id)).toEqual(['openai-gpt-5.1']);
    expect(byDisplay.map((e) => e.model.id)).toEqual(['qwen3-coder-480b']);
    expect(byAliasName.map((e) => e.model.id)).toEqual(['meta-llama-text-embed']);
  });

  it('id prefix matching works (substring subsumes prefix)', () => {
    const filtered = filterRankedEntries(searchFixture(), { search: 'openai-' });
    expect(filtered.map((e) => e.model.id).sort()).toEqual(['openai-dall-e-3', 'openai-gpt-5.1']);
  });

  it('a token matching nothing empties the result (strict AND)', () => {
    expect(filterRankedEntries(searchFixture(), { search: 'qwen3 zzzz' })).toHaveLength(0);
  });
});

describe('filterRankedEntries — provider / capability / modality', () => {
  it('filters by exact provider (case-insensitive)', () => {
    const filtered = filterRankedEntries(searchFixture(), { provider: 'QWEN' });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((e) => e.model.provider === 'qwen')).toBe(true);
  });

  it('provider filter also matches originProvider (metadata.originalProvider)', () => {
    const filtered = filterRankedEntries(searchFixture(), { provider: 'azure-openai' });
    expect(filtered.map((e) => e.model.id)).toEqual(['openai-gpt-5.1']);
  });

  it('filters by capability membership', () => {
    const filtered = filterRankedEntries(searchFixture(), { capability: 'function_calling' });
    expect(filtered.map((e) => e.model.id).sort()).toEqual([
      'openai-gpt-5.1',
      'qwen3-next-80b-a3b',
    ]);
  });

  it('filters by modality (input or output)', () => {
    const imageOut = filterRankedEntries(searchFixture(), { modality: 'image' });
    expect(imageOut.map((e) => e.model.id).sort()).toEqual([
      'openai-dall-e-3',
      'openai-gpt-5.1', // image INPUT (vision) counts too
    ]);
  });

  it('composes search + provider + capability + modality with AND', () => {
    const filtered = filterRankedEntries(searchFixture(), {
      search: 'qwen3',
      provider: 'qwen',
      capability: 'function_calling',
      modality: 'text',
    });
    expect(filtered.map((e) => e.model.id)).toEqual(['qwen3-next-80b-a3b']);
  });
});

describe('filterRankedEntries — backward compatibility', () => {
  it('returns the SAME array reference when no filter is active', () => {
    const entries = searchFixture();
    expect(filterRankedEntries(entries, {})).toBe(entries);
    expect(filterRankedEntries(entries, { search: '   ' })).toBe(entries);
  });

  it('a warm search over 105k entries stays under the 50ms budget', () => {
    const big = Array.from({ length: 105_000 }, (_, i) =>
      makeSearchEntry({ id: `model-${i}`, name: `prov-${i % 40}/model-${i}` })
    );
    // First pass pays one-time haystack normalization (cached on the array
    // reference — see getSearchHaystacks); measure the steady-state request.
    filterRankedEntries(big, { search: 'warmup' });

    const start = performance.now();
    const hits = filterRankedEntries(big, { search: 'model-999' });
    const elapsed = performance.now() - start;

    expect(hits.length).toBeGreaterThan(0);
    // Generous CI ceiling (5x the ~<10ms observed locally) to avoid flakiness;
    // the design budget is 50ms — see filterRankedEntries JSDoc.
    expect(elapsed).toBeLessThan(250);
  });
});

describe('buildModelsFacets', () => {
  it('counts providers and capabilities over the filtered set, sorted desc', () => {
    const facets = buildModelsFacets(searchFixture());

    expect(facets.providers[0]).toEqual({ name: 'openai', count: 2 });
    expect(facets.providers).toContainEqual({ name: 'qwen', count: 2 }); // tie broken by name
    expect(facets.providers).toContainEqual({ name: 'meta', count: 1 });

    expect(facets.capabilities[0]).toEqual({ name: 'chat', count: 3 });
    expect(facets.capabilities).toContainEqual({ name: 'function_calling', count: 2 });
    expect(facets.capabilities).toContainEqual({ name: 'image_generation', count: 1 });
  });

  it('truncates each facet to MODELS_FACET_LIMIT buckets', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      makeSearchEntry({ id: `m-${i}`, provider: `prov-${i}` })
    );
    const facets = buildModelsFacets(many);
    expect(facets.providers).toHaveLength(MODELS_FACET_LIMIT);
    expect(facets.capabilities).toHaveLength(2); // default chat+streaming on every row
    expect(facets.capabilities[0]).toEqual({ name: 'chat', count: 40 });
    expect(facets.providers[0].count).toBe(1);
  });

  it('facets reflect the SEARCH-filtered set, not the raw catalog', () => {
    const filtered = filterRankedEntries(searchFixture(), { search: 'qwen3' });
    const facets = buildModelsFacets(filtered);
    expect(facets.providers).toEqual([{ name: 'qwen', count: 2 }]);
    expect(facets.capabilities).not.toContainEqual({ name: 'image_generation', count: 1 });
  });
});

describe('search + pagination composition', () => {
  it('pagination.total/hasMore/nextOffset describe the post-filter set', () => {
    const base = Array.from({ length: 250 }, (_, i) =>
      makeSearchEntry({
        id: `qwen3-variant-${String(i).padStart(3, '0')}`,
        name: `qwen/qwen3-variant-${i}`,
      })
    );
    base.push(makeSearchEntry({ id: 'unrelated-model', name: 'other/unrelated' }));

    const filtered = filterRankedEntries(base, { search: 'qwen3 variant' });
    expect(filtered).toHaveLength(250);

    const page1 = resolveModelsPage(filtered, { limit: 100, offset: 0 });
    expect(page1.total).toBe(250);
    expect(page1.returned).toBe(100);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextOffset).toBe(100);

    const page3 = resolveModelsPage(filtered, { limit: 100, offset: 200 });
    expect(page3.returned).toBe(50);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextOffset).toBeNull();

    // The unfiltered set would page differently — proving the window is sliced
    // from the POST-filter array.
    expect(resolveModelsPage(base, { limit: 100, offset: 200 }).returned).toBe(51);
  });
});
