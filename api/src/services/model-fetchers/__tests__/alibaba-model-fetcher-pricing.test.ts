// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { AlibabaModelFetcher } from '@/services/model-fetchers/alibaba-model-fetcher';

/**
 * Regression tests for the Alibaba/DashScope pricing estimates.
 *
 * Two production incidents motivated these tests:
 * 1. The default branch of estimateModelSpecs scaled a per-1k price by
 *    1_000_000 instead of 1_000, publishing $250/$500 per 1M tokens for ~62
 *    catalog rows (real magnitude: $0.25/$0.50). Those rows were the
 *    contamination source removed in PR#126.
 * 2. Family matchers only recognized hyphenated ids (qwen-max, qwen-2.5),
 *    while DashScope returns hyphenless open-weights ids
 *    (qwen2.5-7b-instruct, qwen3-4b), so nearly every real model fell through
 *    to the buggy default branch.
 *
 * Prices asserted here come from the Model Studio international price list:
 * https://www.alibabacloud.com/help/en/model-studio/model-pricing
 */

type Specs = {
  contextWindow: number;
  maxOutputTokens: number;
  pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
};

function specsFor(modelId: string): Specs {
  const fetcher = new AlibabaModelFetcher('');
  return fetcher['estimateModelSpecs'](modelId);
}

// Real ids observed in the production catalog (providers alibaba/unknown),
// including the ones that carried the 1000x-inflated pricing.
const REAL_DASHSCOPE_IDS = [
  'qwen-max',
  'qwen-max-latest',
  'qwen-plus',
  'qwen-turbo',
  'qwen-flash',
  'qwen-vl-max',
  'qwen-vl-plus',
  'qwen-mt-turbo',
  'qwen2.5-7b-instruct',
  'qwen2.5-14b-instruct',
  'qwen2.5-32b-instruct',
  'qwen2.5-72b-instruct',
  'qwen2.5-coder-32b-instruct',
  'qwen2.5-vl-7b-instruct',
  'qwen2-72b-instruct',
  'qwen3-4b',
  'qwen3-8b',
  'qwen3-32b',
  'qwen3-30b-a3b',
  'qwen3-235b-a22b',
  'qwen3-coder-plus',
  'qwen3-coder-flash',
  'qwen3-tts-flash',
  'qvq-max',
];

describe('alibaba-model-fetcher pricing estimates', () => {
  it('never emits prices anywhere near the historical 1000x inflation ($250/$500 per 1M)', () => {
    for (const id of REAL_DASHSCOPE_IDS) {
      const { pricing } = specsFor(id);
      expect(pricing.inputCostPer1M, `${id} input`).toBeGreaterThan(0);
      expect(pricing.inputCostPer1M, `${id} input`).toBeLessThanOrEqual(2);
      expect(pricing.outputCostPer1M, `${id} output`).toBeGreaterThan(0);
      expect(pricing.outputCostPer1M, `${id} output`).toBeLessThanOrEqual(8);
      expect(pricing.currency).toBe('USD');
    }
  });

  it('matches hyphenless open-weights ids instead of falling through to the default', () => {
    // These previously all fell into the default branch because matchers
    // required a hyphen between "qwen" and the version.
    expect(specsFor('qwen2.5-7b-instruct').pricing).toEqual({
      inputCostPer1M: 0.2,
      outputCostPer1M: 0.8,
      currency: 'USD',
    });
    expect(specsFor('qwen3-4b').pricing).toEqual({
      inputCostPer1M: 0.2,
      outputCostPer1M: 0.8,
      currency: 'USD',
    });
    expect(specsFor('qwen3-30b-a3b').pricing).toEqual({
      inputCostPer1M: 0.2,
      outputCostPer1M: 0.8,
      currency: 'USD',
    });
  });

  it('pins named tiers to the official Model Studio international price list', () => {
    expect(specsFor('qwen-max').pricing).toMatchObject({ inputCostPer1M: 1.6, outputCostPer1M: 6.4 });
    expect(specsFor('qwen-plus').pricing).toMatchObject({ inputCostPer1M: 0.4, outputCostPer1M: 1.2 });
    expect(specsFor('qwen-turbo').pricing).toMatchObject({ inputCostPer1M: 0.05, outputCostPer1M: 0.2 });
    expect(specsFor('qwen-flash').pricing).toMatchObject({ inputCostPer1M: 0.05, outputCostPer1M: 0.4 });
    expect(specsFor('qwen-vl-max').pricing).toMatchObject({ inputCostPer1M: 0.8, outputCostPer1M: 3.2 });
    expect(specsFor('qwen-vl-plus').pricing).toMatchObject({ inputCostPer1M: 0.21, outputCostPer1M: 0.63 });
    expect(specsFor('qwen3-coder-plus').pricing).toMatchObject({ inputCostPer1M: 1.0, outputCostPer1M: 5.0 });
    expect(specsFor('qwen3-coder-flash').pricing).toMatchObject({ inputCostPer1M: 0.3, outputCostPer1M: 1.5 });
  });

  it('routes hyphenated flagship variants to the max tier, not VL or default', () => {
    expect(specsFor('qwen3-max').pricing).toMatchObject({ inputCostPer1M: 1.6, outputCostPer1M: 6.4 });
    // VL max must NOT be priced as text flagship
    expect(specsFor('qwen-vl-max').pricing.inputCostPer1M).toBe(0.8);
  });

  it('keeps a conservative sub-dollar default for unknown ids', () => {
    expect(specsFor('wan2.2-t2v').pricing).toEqual({
      inputCostPer1M: 0.25,
      outputCostPer1M: 0.5,
      currency: 'USD',
    });
  });
});
