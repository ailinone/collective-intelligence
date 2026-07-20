// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the capability → tools heuristic.
 *
 * Mirrors the structure of `endpoint-inference.test.ts`: each test pins a
 * specific contract clause so a refactor that silently weakens the rule
 * fails loudly. The interesting cases:
 *
 *   - Empty capabilities ⇒ empty array, NOT undefined. This distinction is
 *     load-bearing for the persistence path: `[]` means "investigated, no
 *     tools surfaced", which is a meaningful state for downstream filters.
 *
 *   - Pre-existing `metadata.tools` (any array — including `[]`) wins. The
 *     fetcher's choice is authoritative; the inference is only a fallback.
 *
 *   - Output order is stable regardless of input capability order. This
 *     makes equality checks downstream cheap.
 */
import { describe, it, expect } from 'vitest';
import { inferTools, withInferredTools } from '../tools-inference';

describe('inferTools', () => {
  it('returns empty array when capabilities is empty', () => {
    expect(inferTools([])).toEqual([]);
  });

  it('returns empty array when no tool-mapped capability is present', () => {
    expect(inferTools(['chat', 'text_generation', 'reasoning'])).toEqual([]);
  });

  it('maps web_search capability to web_search tool', () => {
    expect(inferTools(['web_search'])).toEqual(['web_search']);
  });

  it('maps code_interpreter capability to code_interpreter tool', () => {
    expect(inferTools(['code_interpreter'])).toEqual(['code_interpreter']);
  });

  it('maps file_search capability to file_search tool', () => {
    expect(inferTools(['file_search'])).toEqual(['file_search']);
  });

  it('maps mcp capability to mcp tool', () => {
    expect(inferTools(['mcp'])).toEqual(['mcp']);
  });

  it('emits all four tools when all four capabilities are present', () => {
    const result = inferTools(['mcp', 'file_search', 'code_interpreter', 'web_search']);
    // Stable mapping order, not input order.
    expect(result).toEqual(['web_search', 'code_interpreter', 'file_search', 'mcp']);
  });

  it('preserves a pre-set non-empty tools array on metadata', () => {
    const result = inferTools(['web_search'], { tools: ['custom_tool'] });
    expect(result).toEqual(['custom_tool']);
  });

  it('preserves a pre-set EMPTY tools array on metadata (treats [] as authoritative)', () => {
    // Critical: the fetcher may have deliberately set tools=[] meaning
    // "investigated and there are no tools". inferTools must not overwrite
    // that with a heuristic guess.
    const result = inferTools(['web_search'], { tools: [] });
    expect(result).toEqual([]);
  });

  it('falls through to inference when metadata.tools is not an array', () => {
    // Defensive: a corrupted or legacy row might have `tools` as a string
    // or object. Treat it as missing and re-infer.
    const result = inferTools(['web_search'], { tools: 'web_search' as unknown as string[] });
    expect(result).toEqual(['web_search']);
  });

  it('strips non-string entries when metadata.tools is a mixed array', () => {
    const result = inferTools([], {
      tools: ['web_search', 42, null, 'mcp', undefined] as unknown as string[],
    });
    expect(result).toEqual(['web_search', 'mcp']);
  });
});

describe('withInferredTools', () => {
  it('adds tools to metadata when missing', () => {
    const meta = { source: 'openai-native' };
    const result = withInferredTools(meta, ['web_search', 'code_interpreter']);
    expect(result).toEqual({
      source: 'openai-native',
      tools: ['web_search', 'code_interpreter'],
    });
  });

  it('preserves an existing tools array (does not overwrite)', () => {
    const meta = { source: 'openai-native', tools: ['custom'] };
    const result = withInferredTools(meta, ['web_search']);
    expect(result.tools).toEqual(['custom']);
  });

  it('preserves an empty tools array (does not overwrite)', () => {
    const meta = { source: 'openai-native', tools: [] };
    const result = withInferredTools(meta, ['web_search']);
    expect(result.tools).toEqual([]);
  });

  it('replaces a malformed tools field via inference', () => {
    const meta = { source: 'openai-native', tools: 'web_search' };
    const result = withInferredTools(meta, ['web_search']);
    expect(result.tools).toEqual(['web_search']);
  });

  it('does not mutate the input metadata', () => {
    const meta = { source: 'openai-native' };
    withInferredTools(meta, ['mcp']);
    expect(meta).not.toHaveProperty('tools');
  });

  it('preserves all other metadata fields (passthrough semantics)', () => {
    const meta = {
      source: 'openai-native',
      sourceType: 'native_api' as const,
      sourcePriority: 1,
      pricing: { inputCostPer1M: 5 },
      customField: 'preserved',
    };
    const result = withInferredTools(meta, ['web_search']);
    expect(result.source).toBe('openai-native');
    expect(result.sourceType).toBe('native_api');
    expect(result.sourcePriority).toBe(1);
    expect(result.pricing).toEqual({ inputCostPer1M: 5 });
    expect(result.customField).toBe('preserved');
    expect(result.tools).toEqual(['web_search']);
  });
});
