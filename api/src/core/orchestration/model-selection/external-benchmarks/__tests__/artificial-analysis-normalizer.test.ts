// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R6 §8 — Normalizer unit tests.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeAaId,
  normalizeArtificialAnalysisModel,
  normalizeArtificialAnalysisModels,
} from '@/core/orchestration/model-selection/external-benchmarks/artificial-analysis-normalizer';

describe('01C.1B-J2-C-R6 — normalizeAaId', () => {
  it('strips fireworks wrapper', () => {
    expect(normalizeAaId('accounts/fireworks/models/deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });

  it('strips vendor prefixes', () => {
    expect(normalizeAaId('deepseek-ai/DeepSeek-R1-0528')).toBe('deepseek-r1-0528');
  });

  it('normalizes dots/spaces/underscores to dashes', () => {
    expect(normalizeAaId('Claude_Opus 4.7')).toBe('claude-opus-4-7');
  });

  it('preserves numeric version (4.7 != 4)', () => {
    expect(normalizeAaId('claude-opus-4.7')).not.toBe(normalizeAaId('claude-opus-4'));
  });

  it('empty input returns empty string', () => {
    expect(normalizeAaId(undefined)).toBe('');
    expect(normalizeAaId('')).toBe('');
  });
});

describe('01C.1B-J2-C-R6 — normalizeArtificialAnalysisModel', () => {
  it('maps id/name/slug/creator into aliases', () => {
    const m = normalizeArtificialAnalysisModel({
      id: 'aa-id-001',
      name: 'DeepSeek V4 Pro',
      slug: 'deepseek-v4-pro',
      model_creator: { id: 'deepseek', name: 'DeepSeek', slug: 'deepseek-ai' },
    } as never);
    expect(m.aaModelId).toBe('aa-id-001');
    expect(m.aaName).toBe('DeepSeek V4 Pro');
    expect(m.aaSlug).toBe('deepseek-v4-pro');
    expect(m.normalizedAliases).toContain('deepseek-v4-pro');
    expect(m.normalizedAliases.length).toBeGreaterThan(0);
  });

  it('extracts evaluations / pricing / speed', () => {
    const m = normalizeArtificialAnalysisModel({
      id: 'x',
      name: 'X',
      evaluations: {
        artificial_analysis_intelligence_index: 84,
        artificial_analysis_coding_index: 90,
        gpqa: 75,
      },
      pricing: { price_1m_blended_3_to_1: 5.5, price_1m_input_tokens: 3, price_1m_output_tokens: 11 },
      median_output_tokens_per_second: 120,
      median_time_to_first_token_seconds: 0.42,
    } as never);
    expect(m.evaluations.intelligenceIndex).toBe(84);
    expect(m.evaluations.codingIndex).toBe(90);
    expect(m.evaluations.gpqa).toBe(75);
    expect(m.pricing.blended3To1UsdPer1MTokens).toBe(5.5);
    expect(m.pricing.inputUsdPer1MTokens).toBe(3);
    expect(m.pricing.outputUsdPer1MTokens).toBe(11);
    expect(m.speed.outputTokensPerSecond).toBe(120);
    expect(m.speed.timeToFirstTokenSeconds).toBe(0.42);
  });

  it('treats undefined evaluations / pricing as undefined (not 0)', () => {
    const m = normalizeArtificialAnalysisModel({ id: 'x', name: 'X' } as never);
    expect(m.evaluations.intelligenceIndex).toBeUndefined();
    expect(m.pricing.inputUsdPer1MTokens).toBeUndefined();
    expect(m.speed.outputTokensPerSecond).toBeUndefined();
  });

  it('alias set is deterministic + sorted', () => {
    const m1 = normalizeArtificialAnalysisModel({ id: 'a', name: 'A', slug: 'a' } as never);
    const m2 = normalizeArtificialAnalysisModel({ id: 'a', name: 'A', slug: 'a' } as never);
    expect(m1.normalizedAliases).toEqual(m2.normalizedAliases);
    const sorted = [...m1.normalizedAliases].slice().sort();
    expect(m1.normalizedAliases).toEqual(sorted);
  });

  it('normalizeArtificialAnalysisModels maps the array', () => {
    const r = normalizeArtificialAnalysisModels([
      { id: 'a', name: 'A' } as never,
      { id: 'b', name: 'B' } as never,
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]!.aaModelId).toBe('a');
    expect(r[1]!.aaModelId).toBe('b');
  });
});
