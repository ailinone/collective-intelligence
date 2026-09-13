// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { GoogleModelFetcher } from '@/services/model-fetchers/google-model-fetcher';

/**
 * Pricing regression tests for the native Google AI Studio (Gemini API)
 * fetcher — `provider: 'google'`, `GOOGLE_API_KEY`, `generativelanguage.googleapis.com`.
 *
 * ## The 2026-09 bug
 *
 * `estimateModelSpecs` had branches only for `gemini-1.5`, the 2023-era bare
 * `gemini-pro`, and PaLM's `bison`. Every current-generation Gemini model
 * (`gemini-2.0`, `gemini-2.5`, `gemini-3.1`, `gemini-3.5` — the entire live
 * Gemini lineup) fell through to the generic default price
 * (~$0.00025/$0.0005 per 1M), 1000-5000x below the real rate card.
 *
 * This is the SAME bug class independently found and fixed in the sibling
 * `VertexAIModelFetcher.estimateVertexModelSpecs` on 2026-09-05 ("82 of 89
 * (92%) of google/vertex-ai rows were affected") but never ported to this
 * fetcher, which backs a separate catalog provider (`google`, native Gemini
 * API) from Vertex AI (`vertex-ai`, `aiplatform.googleapis.com`).
 *
 * These tests pin the ported tier prices (each cross-checked against
 * ai.google.dev/gemini-api/docs/pricing, 2026-09-09 — Gemini API and Vertex
 * AI price identically per token) and the `default-fallback` safety tag for
 * anything this table doesn't yet recognize (e.g. the gemini-3.6/3.7/3.8
 * lines that shipped after this fix).
 */

function estimate(modelId: string) {
  const fetcher = new GoogleModelFetcher('fake-key-not-used-by-estimate');
  return (
    fetcher as unknown as {
      estimateModelSpecs: (id: string) => {
        contextWindow: number;
        maxOutputTokens: number;
        pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
        pricingSource: string;
      };
    }
  ).estimateModelSpecs(modelId);
}

describe('google-model-fetcher pricing — gemini-2.5 (confirmed rate-card)', () => {
  it('prices gemini-2.5-pro at $1.25/$10, not the ~1000x-too-low default', () => {
    const { pricing, pricingSource } = estimate('gemini-2.5-pro');
    expect(pricing).toEqual({ inputCostPer1M: 1.25, outputCostPer1M: 10.0, currency: 'USD' });
    expect(pricingSource).toBe('gemini-2.5-tier-table');
  });

  it('prices gemini-2.5-flash at its own confirmed rate ($0.30/$2.50)', () => {
    expect(estimate('gemini-2.5-flash').pricing).toEqual({
      inputCostPer1M: 0.3,
      outputCostPer1M: 2.5,
      currency: 'USD',
    });
  });

  it('prices gemini-2.5-flash-lite below flash, not at flash\'s rate ($0.10/$0.40)', () => {
    const { pricing, pricingSource } = estimate('gemini-2.5-flash-lite');
    expect(pricing).toEqual({ inputCostPer1M: 0.1, outputCostPer1M: 0.4, currency: 'USD' });
    expect(pricingSource).toBe('gemini-2.5-tier-table');
  });
});

describe('google-model-fetcher pricing — gemini-3.1 / gemini-3.5 (confirmed rate-card)', () => {
  it('prices gemini-3.1-pro at $2/$12', () => {
    expect(estimate('gemini-3.1-pro').pricing).toEqual({
      inputCostPer1M: 2.0,
      outputCostPer1M: 12.0,
      currency: 'USD',
    });
  });

  it('prices gemini-3.1-flash-lite at $0.25/$1.50', () => {
    expect(estimate('gemini-3.1-flash-lite').pricing).toEqual({
      inputCostPer1M: 0.25,
      outputCostPer1M: 1.5,
      currency: 'USD',
    });
  });

  it('prices gemini-3.5-flash at $1.50/$9', () => {
    expect(estimate('gemini-3.5-flash').pricing).toEqual({
      inputCostPer1M: 1.5,
      outputCostPer1M: 9.0,
      currency: 'USD',
    });
  });

  it('prices gemini-3.5-flash-lite at its OWN rate, not flash\'s ($0.30/$2.50)', () => {
    const { pricing } = estimate('gemini-3.5-flash-lite');
    expect(pricing).toEqual({ inputCostPer1M: 0.3, outputCostPer1M: 2.5, currency: 'USD' });
  });
});

describe('google-model-fetcher pricing — untouched pre-existing branches', () => {
  it('still prices gemini-1.5 and legacy gemini-pro/bison as before', () => {
    expect(estimate('gemini-1.5-pro').pricing.inputCostPer1M).toBe(3.5);
    expect(estimate('gemini-1.5-flash').pricing.inputCostPer1M).toBe(0.075);
    expect(estimate('gemini-pro').pricingSource).toBe('gemini-pro-legacy-tier-table');
    expect(estimate('text-bison-001').pricingSource).toBe('bison-legacy-tier-table');
  });
});

describe('google-model-fetcher pricing — default-fallback is never silent', () => {
  it('does not invent a price for a sub-pattern with no confirmed reference (bare gemini-3.1-flash)', () => {
    expect(estimate('gemini-3.1-flash').pricingSource).toBe('default-fallback');
  });

  it('does not invent a price for gemini-3.5-pro (no confirmed reference exists yet)', () => {
    expect(estimate('gemini-3.5-pro').pricingSource).toBe('default-fallback');
  });

  it('tags an unrecognized future generation (e.g. gemini-3.8) as default-fallback, not silently wrong', () => {
    expect(estimate('gemini-3.8-flash').pricingSource).toBe('default-fallback');
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
      'gemini-2.0-flash',
      'gemini-1.5-pro',
      'gemini-pro',
      'text-bison-001',
    ];
    for (const modelId of confirmed) {
      expect(estimate(modelId).pricingSource, modelId).not.toBe('default-fallback');
    }
  });
});
