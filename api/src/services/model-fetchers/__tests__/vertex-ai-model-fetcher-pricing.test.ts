// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { VertexAIModelFetcher } from '@/services/model-fetchers/vertex-ai-model-fetcher';

/**
 * Pricing regression tests for the Vertex AI / Gemini fetcher.
 *
 * ## The 2026-09 bug
 *
 * `estimateVertexModelSpecs` had explicit branches only for `gemini-1.5`,
 * `gemini-2.0`, and `claude` model-id patterns. Every current-generation
 * Gemini model (`gemini-2.5`, `gemini-3.1`, `gemini-3.5`) fell through to the
 * generic DEFAULT price (~$0.00125/$0.005 per 1M) — roughly 1000x below the
 * real rate-card price this repo's own
 * `api/config/c3/operator-approval/cross-provider-pricing-canonical.json`
 * already records (gemini-2.5-pro at $1.25/$10). 82 of 89 (92%) of the
 * google/vertex-ai catalog rows were affected. This fetcher had zero pricing
 * tests before this file.
 *
 * These tests pin the added branches (each price sourced from this repo's
 * own operator-approved pricing references — see the code comments in
 * vertex-ai-model-fetcher.ts for exactly which file/field each number comes
 * from) AND the safety net added alongside them: a model matching none of
 * the confirmed sub-patterns must be tagged `pricingSource: 'default-fallback'`
 * rather than silently priced as if confirmed.
 */

function estimate(modelName: string) {
  const fetcher = new VertexAIModelFetcher();
  return (
    fetcher as unknown as {
      estimateVertexModelSpecs: (name: string) => {
        contextWindow: number;
        maxOutputTokens: number;
        pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
        pricingSource: string;
      };
    }
  ).estimateVertexModelSpecs(modelName);
}

describe('vertex-ai-model-fetcher pricing — gemini-2.5 (confirmed rate-card)', () => {
  it('prices gemini-2.5-pro at the canonical tier1Baseline rate ($1.25/$10)', () => {
    const { pricing, pricingSource } = estimate('gemini-2.5-pro');
    expect(pricing.inputCostPer1M).toBe(1.25);
    expect(pricing.outputCostPer1M).toBe(10.0);
    expect(pricingSource).toBe('gemini-2.5-tier-table');
  });

  it('prices gemini-2.5-flash at its own confirmed rate, not the pro rate ($0.30/$2.50)', () => {
    const { pricing, pricingSource } = estimate('gemini-2.5-flash');
    expect(pricing.inputCostPer1M).toBe(0.3);
    expect(pricing.outputCostPer1M).toBe(2.5);
    expect(pricingSource).toBe('gemini-2.5-tier-table');
  });

  it('prices gemini-2.5-flash-lite below flash ($0.10/$0.40)', () => {
    const { pricing, pricingSource } = estimate('gemini-2.5-flash-lite');
    expect(pricing.inputCostPer1M).toBe(0.1);
    expect(pricing.outputCostPer1M).toBe(0.4);
    expect(pricingSource).toBe('gemini-2.5-tier-table');
  });
});

describe('vertex-ai-model-fetcher pricing — gemini-3.1 (confirmed rate-card)', () => {
  it('prices gemini-3.1-pro at the canonical tier1Baseline rate ($2/$12)', () => {
    const { pricing, pricingSource } = estimate('gemini-3.1-pro');
    expect(pricing.inputCostPer1M).toBe(2.0);
    expect(pricing.outputCostPer1M).toBe(12.0);
    expect(pricingSource).toBe('gemini-3.1-tier-table');
  });

  it('prices gemini-3.1-flash-lite at its own confirmed rate ($0.25/$1.50)', () => {
    const { pricing, pricingSource } = estimate('gemini-3.1-flash-lite');
    expect(pricing.inputCostPer1M).toBe(0.25);
    expect(pricing.outputCostPer1M).toBe(1.5);
    expect(pricingSource).toBe('gemini-3.1-tier-table');
  });
});

describe('vertex-ai-model-fetcher pricing — gemini-3.5 (confirmed rate-card)', () => {
  it('prices gemini-3.5-flash at its own confirmed rate ($1.50/$9)', () => {
    const { pricing, pricingSource } = estimate('gemini-3.5-flash');
    expect(pricing.inputCostPer1M).toBe(1.5);
    expect(pricing.outputCostPer1M).toBe(9.0);
    expect(pricingSource).toBe('gemini-3.5-tier-table');
  });

  it('prices gemini-3.5-flash-lite at its OWN rate, not flash\'s (2026-09 regression)', () => {
    // Bug: 'gemini-3.5-flash-lite'.includes('flash') is true, so the old
    // `if (name.includes('flash'))` check (with no flash-lite branch first,
    // unlike the gemini-2.5 and gemini-3.1 blocks) silently priced every
    // flash-lite row at flash's $1.50/$9 — confirmed 5x too high against
    // ai.google.dev/gemini-api/docs/pricing's real $0.30/$2.50 — while still
    // tagging it 'gemini-3.5-tier-table' as if the price were confirmed.
    const { pricing, pricingSource } = estimate('gemini-3.5-flash-lite');
    expect(pricing.inputCostPer1M).toBe(0.3);
    expect(pricing.outputCostPer1M).toBe(2.5);
    expect(pricingSource).toBe('gemini-3.5-tier-table');
  });
});

describe('vertex-ai-model-fetcher pricing — untouched pre-existing branches', () => {
  it('still prices gemini-1.5 and gemini-2.0 and claude as before', () => {
    expect(estimate('gemini-1.5-pro').pricing.inputCostPer1M).toBe(3.5);
    expect(estimate('gemini-1.5-flash').pricing.inputCostPer1M).toBe(0.075);
    expect(estimate('gemini-2.0-flash').pricing).toEqual({
      inputCostPer1M: 5.0,
      outputCostPer1M: 15.0,
      currency: 'USD',
    });
    expect(estimate('claude-3-5-sonnet').pricing).toEqual({
      inputCostPer1M: 3.0,
      outputCostPer1M: 15.0,
      currency: 'USD',
    });
  });
});

describe('vertex-ai-model-fetcher pricing — default-fallback is never silent', () => {
  it('does NOT invent a price for a sub-pattern with no confirmed reference (bare gemini-3.1-flash)', () => {
    // Deliberately distinct from gemini-3.1-flash-lite's confirmed price —
    // reusing that number here would just be a smaller version of the same
    // "silently trust an unconfirmed number" bug this fix closes.
    const { pricingSource } = estimate('gemini-3.1-flash');
    expect(pricingSource).toBe('default-fallback');
  });

  it('does NOT invent a price for gemini-3.5-pro (no confirmed reference exists yet)', () => {
    const { pricingSource } = estimate('gemini-3.5-pro');
    expect(pricingSource).toBe('default-fallback');
  });

  it('tags a totally unrecognized model id as default-fallback with the original conservative estimate', () => {
    const { pricing, pricingSource } = estimate('some-future-unrecognized-model');
    expect(pricingSource).toBe('default-fallback');
    expect(pricing.inputCostPer1M).toBe(0.00125);
    expect(pricing.outputCostPer1M).toBe(0.005);
  });

  it('never tags a confirmed sub-pattern as default-fallback', () => {
    const confirmed = [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-3.1-pro',
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-1.5-pro',
      'gemini-2.0-flash',
      'claude-3-5-sonnet',
    ];
    for (const modelId of confirmed) {
      expect(estimate(modelId).pricingSource, modelId).not.toBe('default-fallback');
    }
  });
});
