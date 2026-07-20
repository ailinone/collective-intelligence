// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the composed metadata normaliser.
 *
 * The two underlying inference modules (endpoint, tools) have their own
 * exhaustive unit tests. These tests assert only the composition contract:
 * both fields are populated, neither overwrites pre-existing values, and
 * passthrough fields survive intact.
 */
import { describe, it, expect } from 'vitest';
import { withNormalizedMetadata } from '../metadata-normalization';

describe('withNormalizedMetadata', () => {
  it('populates both endpoint and tools when neither is present', () => {
    const result = withNormalizedMetadata({}, ['web_search', 'image_generation']);
    expect(result.endpoint).toBe('images'); // image_generation wins over chat default
    expect(result.tools).toEqual(['web_search']);
  });

  it('preserves pre-existing endpoint AND falls through tools inference', () => {
    const result = withNormalizedMetadata(
      { endpoint: 'realtime' },
      ['web_search'],
    );
    expect(result.endpoint).toBe('realtime');
    expect(result.tools).toEqual(['web_search']);
  });

  it('preserves pre-existing tools AND falls through endpoint inference', () => {
    const result = withNormalizedMetadata(
      { tools: ['custom_tool'] },
      ['embedding'],
    );
    expect(result.endpoint).toBe('embeddings');
    expect(result.tools).toEqual(['custom_tool']);
  });

  it('preserves both when both are pre-set', () => {
    const result = withNormalizedMetadata(
      { endpoint: 'completions', tools: [] },
      ['image_generation', 'web_search'],
    );
    expect(result.endpoint).toBe('completions');
    expect(result.tools).toEqual([]);
  });

  it('preserves passthrough fields (source, sourceType, pricing, etc.)', () => {
    const meta = {
      source: 'anthropic-native',
      sourceType: 'native_api' as const,
      sourcePriority: 1,
      discoveredAt: '2026-04-29T00:00:00Z',
      pricing: { inputCostPer1M: 3, outputCostPer1M: 15 },
    };
    const result = withNormalizedMetadata(meta, ['code_interpreter']);
    expect(result.source).toBe('anthropic-native');
    expect(result.sourceType).toBe('native_api');
    expect(result.sourcePriority).toBe(1);
    expect(result.discoveredAt).toBe('2026-04-29T00:00:00Z');
    expect(result.pricing).toEqual({ inputCostPer1M: 3, outputCostPer1M: 15 });
    expect(result.endpoint).toBe('chat_completions');
    expect(result.tools).toEqual(['code_interpreter']);
  });

  it('does not mutate the input metadata', () => {
    const meta = { source: 'foo' };
    withNormalizedMetadata(meta, ['web_search']);
    expect(meta).not.toHaveProperty('endpoint');
    expect(meta).not.toHaveProperty('tools');
  });
});
