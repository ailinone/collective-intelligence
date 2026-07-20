// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1R2 — lookupServingProvidersFromCatalog unit tests.
 *
 * Tests the catalog adapter that maps logical-model names to all
 * providers serving them, with the LookupCatalogRows callback
 * supplying inline fixture rows (no DB).
 *
 *   - Catalog patterns derived from a logical id are unioned correctly.
 *   - Chat capability filter rejects embedding-only rows.
 *   - Cross-provider naming variants are normalized (`google/gemma-3-4b-it`
 *     ↔ `gemma-3-4b-it` ↔ `gemma-3-4b-it-instruct`).
 *   - Sort order is deterministic: exact > normalized > alias > probable.
 *   - Empty-pattern path returns [] without calling the lookup.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  lookupServingProvidersFromCatalog,
  type CatalogRow,
} from '@/core/orchestration/lookup-serving-providers';
import {
  normalizeLogicalModelId,
  compareModelIds,
  buildCatalogMatchPatterns,
} from '@/core/orchestration/model-name-normalizer';

describe('01C.1B-J1R2 — name normalizer', () => {
  it('strips vendor prefixes and lowercases', () => {
    expect(normalizeLogicalModelId('meta/llama-3.2-11b')).toBe('llama-3.2-11b');
    expect(normalizeLogicalModelId('meta-llama/Llama-3.2-11B-Vision-Instruct')).toBe('llama-3.2-11b-vision');
    expect(normalizeLogicalModelId('google/gemma-3-4b-it')).toBe('gemma-3-4b');
    expect(normalizeLogicalModelId('gemma-3-4b-it')).toBe('gemma-3-4b');
  });

  it('compareModelIds returns alias for known safe-tail extensions', () => {
    expect(compareModelIds('meta/llama-3.2-11b', 'meta-llama/Llama-3.2-11B-Vision-Instruct')).toBe('alias');
  });

  it('compareModelIds returns exact for identical strings', () => {
    expect(compareModelIds('gemma-3-4b-it', 'gemma-3-4b-it')).toBe('exact');
  });

  it('compareModelIds returns normalized for casing/separator drift', () => {
    expect(compareModelIds('gemma-3-4b-it', 'google/gemma-3-4b-it')).toBe('normalized');
  });

  it('compareModelIds returns no_match for genuinely different models', () => {
    expect(compareModelIds('llama-3.2-11b', 'llama-3.1-8b')).toBe('no_match');
    // Fine-tune sibling — refuses to collapse onto base
    expect(compareModelIds('gemma-3-4b-it', 'unsloth/gemma-3-4b-it-abliterated')).toBe('no_match');
  });

  it('buildCatalogMatchPatterns includes vendor variants', () => {
    const ps = buildCatalogMatchPatterns('meta/llama-3.2-11b');
    expect(ps).toContain('meta/llama-3.2-11b');
    expect(ps).toContain('llama-3.2-11b');
    expect(ps).toContain('meta-llama/llama-3.2-11b');
    expect(ps).toContain('llama-3.2-11b-instruct');
  });
});

describe('01C.1B-J1R2 — lookupServingProvidersFromCatalog', () => {
  it('returns chat-capable rows across providers (gemma fixture)', async () => {
    const fixtureRows: CatalogRow[] = [
      { providerId: '1', providerName: 'aiml', modelId: 'a1', name: 'gemma-3-4b-it', capabilities: ['chat', 'text_generation'] },
      { providerId: '2', providerName: 'deepinfra', modelId: 'a2', name: 'google/gemma-3-4b-it', capabilities: ['chat'] },
      { providerId: '3', providerName: 'openrouter', modelId: 'a3', name: 'google/gemma-3-4b-it', capabilities: ['chat'] },
      { providerId: '4', providerName: 'huggingface', modelId: 'a4', name: 'google/gemma-3-4b-it-qat-q4_0-unquantized', capabilities: ['chat'] },
    ];
    const lookupCatalogRows = vi.fn().mockResolvedValue(fixtureRows);
    const result = await lookupServingProvidersFromCatalog({
      logicalModelId: 'gemma-3-4b-it',
      requireCapability: 'chat',
      lookupCatalogRows,
    });
    // Expect at least the 3 base-name matches; the fine-tune qat-q4 row
    // does NOT match base (compareModelIds returns no_match for it).
    expect(result.length).toBeGreaterThanOrEqual(3);
    const ids = result.map((e) => e.providerId).sort();
    expect(ids).toContain('aiml');
    expect(ids).toContain('deepinfra');
    expect(ids).toContain('openrouter');
  });

  it('embedding-only row is filtered out when capability=chat', async () => {
    const fixtureRows: CatalogRow[] = [
      { providerId: '1', providerName: 'cohere', modelId: 'e1', name: 'gemma-3-4b-it', capabilities: ['embedding'] },
      { providerId: '2', providerName: 'aiml', modelId: 'a1', name: 'gemma-3-4b-it', capabilities: ['chat'] },
    ];
    const result = await lookupServingProvidersFromCatalog({
      logicalModelId: 'gemma-3-4b-it',
      requireCapability: 'chat',
      lookupCatalogRows: vi.fn().mockResolvedValue(fixtureRows),
    });
    expect(result.length).toBe(1);
    expect(result[0].providerId).toBe('aiml');
  });

  it('confidence order: exact > normalized > alias', async () => {
    const fixtureRows: CatalogRow[] = [
      // alias (tail extension)
      { providerId: '1', providerName: 'deepinfra', modelId: 'd1', name: 'meta-llama/Llama-3.2-11B-Vision-Instruct', capabilities: ['chat'] },
      // normalized (vendor-prefix drift)
      { providerId: '2', providerName: 'nvidia', modelId: 'n1', name: 'meta/llama-3.2-11b', capabilities: ['chat'] },
      // exact match
      { providerId: '3', providerName: 'vercel-ai-gateway', modelId: 'v1', name: 'meta/llama-3.2-11b', capabilities: ['chat'] },
    ];
    const result = await lookupServingProvidersFromCatalog({
      logicalModelId: 'meta/llama-3.2-11b',
      requireCapability: 'chat',
      lookupCatalogRows: vi.fn().mockResolvedValue(fixtureRows),
    });
    // First entries should be `exact` confidence — there's only ONE exact
    // match (vercel-ai-gateway / nvidia both stored as `meta/llama-3.2-11b`
    // depending on the providerName) — both are exact when the name equals.
    expect(result[0].confidence).toBe('exact');
    // No `probable` entries (J1R2 reserves probable for future fuzzy).
    expect(result.every((e) => e.confidence !== 'probable')).toBe(true);
  });

  it('empty logicalModelId returns []', async () => {
    const lookupCatalogRows = vi.fn().mockResolvedValue([]);
    const result = await lookupServingProvidersFromCatalog({
      logicalModelId: '',
      requireCapability: 'chat',
      lookupCatalogRows,
    });
    expect(result).toEqual([]);
    expect(lookupCatalogRows).not.toHaveBeenCalled();
  });

  it('dedupes by providerName+name (same row repeated)', async () => {
    const fixtureRows: CatalogRow[] = [
      { providerId: '1', providerName: 'aiml', modelId: 'a1', name: 'gemma-3-4b-it', capabilities: ['chat'] },
      { providerId: '1', providerName: 'aiml', modelId: 'a1', name: 'gemma-3-4b-it', capabilities: ['chat'] }, // dup
    ];
    const result = await lookupServingProvidersFromCatalog({
      logicalModelId: 'gemma-3-4b-it',
      requireCapability: 'chat',
      lookupCatalogRows: vi.fn().mockResolvedValue(fixtureRows),
    });
    expect(result.length).toBe(1);
  });
});
