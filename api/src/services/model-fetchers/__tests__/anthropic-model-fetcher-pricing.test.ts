// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { AnthropicModelFetcher } from '@/services/model-fetchers/anthropic-model-fetcher';

/**
 * Pricing + capability regression tests for the Anthropic native fetcher.
 *
 * ## The 2026-09 bug
 *
 * `estimateModelSpecs` had three flat, generation-blind tier prices dated
 * "as of Nov 2024" (opus $15/$75, sonnet $3/$15, haiku $0.25/$1.25) and no
 * entry at all for the `fable`/`mythos` tiers. Checked against the 11 models
 * the live `anthropic-native` discovery source returns today
 * (`curl https://api.ailin.one/v1/models?provider=anthropic`, 2026-09-09) and
 * against the official rate card
 * (platform.claude.com/docs/en/about-claude/pricing): 9 of 11 (82%) were
 * mispriced.
 *
 * Separately, `convertAnthropicModel` never read the `capabilities` /
 * `max_input_tokens` / `max_tokens` fields Anthropic's own `/v1/models`
 * response already includes (platform.claude.com/docs/en/api/models/list),
 * relying entirely on a substring-of-the-id heuristic for vision/reasoning/
 * json_mode/context-window/max-output instead of the vendor's own answer.
 *
 * These tests pin: the corrected tier prices (each sourced from the official
 * pricing page, see code comments), the `pricingSource` safety tag for an
 * unrecognized tier, and the new declared-capabilities/declared-limits
 * preference over the heuristic.
 */

type EstimateResult = {
  contextWindow: number;
  maxOutputTokens: number;
  pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
  pricingSource: string;
};

type FetcherInternals = {
  estimateModelSpecs: (modelId: string) => EstimateResult;
  convertAnthropicModel: (m: {
    id: string;
    display_name: string;
    created_at: string;
    type: 'model';
    max_input_tokens?: number | null;
    max_tokens?: number | null;
    capabilities?: {
      image_input?: { supported?: boolean };
      pdf_input?: { supported?: boolean };
      thinking?: { supported?: boolean };
      structured_outputs?: { supported?: boolean };
    } | null;
  }) => {
    contextWindow: number;
    maxOutputTokens: number;
    capabilities: string[];
    pricing: { inputCostPer1M: number; outputCostPer1M: number };
    metadata: Record<string, unknown>;
  } | null;
};

function internals(): FetcherInternals {
  return new AnthropicModelFetcher('sk-ant-real-key') as unknown as FetcherInternals;
}

function estimate(modelId: string): EstimateResult {
  return internals().estimateModelSpecs(modelId);
}

function baseApiModel(id: string) {
  return { id, display_name: id, created_at: '2026-01-01T00:00:00Z', type: 'model' as const };
}

describe('anthropic-model-fetcher pricing — opus (confirmed rate-card)', () => {
  it('prices claude-opus-5 at $5/$25 (Opus 5 launch price, not the retired $15/$75)', () => {
    const { pricing, pricingSource } = estimate('claude-opus-5');
    expect(pricing).toEqual({ inputCostPer1M: 5, outputCostPer1M: 25, currency: 'USD' });
    expect(pricingSource).toBe('opus-tier-table');
  });

  it('prices claude-opus-4-5-20251101 (Opus 4.5) at $5/$25', () => {
    expect(estimate('claude-opus-4-5-20251101').pricing).toEqual({
      inputCostPer1M: 5,
      outputCostPer1M: 25,
      currency: 'USD',
    });
  });

  it('prices claude-opus-4-6 / 4-7 / 4-8 at $5/$25', () => {
    for (const id of ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8']) {
      expect(estimate(id).pricing.inputCostPer1M, id).toBe(5);
      expect(estimate(id).pricing.outputCostPer1M, id).toBe(25);
    }
  });

  it('keeps the legacy $15/$75 rate for pre-4.5 Opus (still live on Bedrock/Google Cloud)', () => {
    const { pricing, pricingSource } = estimate('claude-opus-4-1-20250805');
    expect(pricing).toEqual({ inputCostPer1M: 15, outputCostPer1M: 75, currency: 'USD' });
    expect(pricingSource).toBe('opus-legacy-tier-table');
  });
});

describe('anthropic-model-fetcher pricing — sonnet (confirmed rate-card)', () => {
  it('prices claude-sonnet-5 at $2/$10 (the launch price cut), not the old flat $3/$15', () => {
    const { pricing, pricingSource } = estimate('claude-sonnet-5');
    expect(pricing).toEqual({ inputCostPer1M: 2, outputCostPer1M: 10, currency: 'USD' });
    expect(pricingSource).toBe('sonnet-tier-table');
  });

  it('keeps $3/$15 for sonnet-4.5 and sonnet-4.6', () => {
    for (const id of ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-6']) {
      expect(estimate(id).pricing, id).toEqual({
        inputCostPer1M: 3,
        outputCostPer1M: 15,
        currency: 'USD',
      });
    }
  });
});

describe('anthropic-model-fetcher pricing — haiku (confirmed rate-card)', () => {
  it('prices claude-haiku-4-5 at $1/$5, not the Claude-3-Haiku-era $0.25/$1.25', () => {
    const { pricing, pricingSource } = estimate('claude-haiku-4-5-20251001');
    expect(pricing).toEqual({ inputCostPer1M: 1, outputCostPer1M: 5, currency: 'USD' });
    expect(pricingSource).toBe('haiku-tier-table');
    expect(estimate('claude-haiku-4-5-20251001').maxOutputTokens).toBe(64_000);
  });

  it('does not mistake a bare dated legacy id for a high generation number', () => {
    // Old-style id: tier word directly followed by an 8-digit date with no
    // version number in between (unlike every current id, which always has
    // one). A naive \d{1,2} read would grab "20" off the date as "major
    // version 20" and wrongly treat this as newer than Haiku 4.5.
    const { pricing, pricingSource } = estimate('claude-3-5-haiku-20241022');
    expect(pricingSource).toBe('haiku-legacy-tier-table');
    expect(pricing).toEqual({ inputCostPer1M: 0.8, outputCostPer1M: 4, currency: 'USD' });
  });
});

describe('anthropic-model-fetcher pricing — fable/mythos (previously the wrong generic default)', () => {
  it('prices claude-fable-5 and claude-fable-5-1 at $10/$50, not the unknown-tier default', () => {
    for (const id of ['claude-fable-5', 'claude-fable-5-1']) {
      const { pricing, pricingSource } = estimate(id);
      expect(pricing, id).toEqual({ inputCostPer1M: 10, outputCostPer1M: 50, currency: 'USD' });
      expect(pricingSource, id).toBe('fable-mythos-tier-table');
    }
  });

  it('prices a mythos id the same way', () => {
    expect(estimate('claude-mythos-5-1').pricing).toEqual({
      inputCostPer1M: 10,
      outputCostPer1M: 50,
      currency: 'USD',
    });
  });
});

describe('anthropic-model-fetcher pricing — default-fallback is never silent', () => {
  it('tags a totally unrecognized tier as default-fallback instead of guessing a real price', () => {
    const { pricingSource } = estimate('claude-some-future-tier-1');
    expect(pricingSource).toBe('default-fallback');
  });

  it('never tags a recognized tier as default-fallback', () => {
    const confirmed = [
      'claude-opus-5',
      'claude-opus-4-5-20251101',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-fable-5',
      'claude-mythos-5-1',
    ];
    for (const id of confirmed) {
      expect(estimate(id).pricingSource, id).not.toBe('default-fallback');
    }
  });
});

describe('anthropic-model-fetcher — declared capabilities/limits override the id heuristic', () => {
  it('uses max_input_tokens/max_tokens from the API instead of the tier estimate when present', () => {
    const model = internals().convertAnthropicModel({
      ...baseApiModel('claude-opus-5'),
      max_input_tokens: 999_000,
      max_tokens: 111_000,
    });
    expect(model?.contextWindow).toBe(999_000);
    expect(model?.maxOutputTokens).toBe(111_000);
  });

  it('falls back to the tier estimate when the API omits the limit fields', () => {
    const model = internals().convertAnthropicModel(baseApiModel('claude-opus-5'));
    expect(model?.contextWindow).toBe(1_000_000); // opus-5 tier estimate
    expect(model?.maxOutputTokens).toBe(128_000);
  });

  it('adds vision/multimodal from a declared image_input:true even for an id with no version hint', () => {
    const model = internals().convertAnthropicModel({
      ...baseApiModel('claude-some-future-tier-1'),
      capabilities: { image_input: { supported: true } },
    });
    expect(model?.capabilities).toContain('vision');
    expect(model?.capabilities).toContain('multimodal');
  });

  it('removes a heuristic-guessed capability when the API declares it unsupported', () => {
    // The id-based heuristic adds json_mode unconditionally as a baseline —
    // a declared structured_outputs:false must override that guess.
    const model = internals().convertAnthropicModel({
      ...baseApiModel('claude-opus-5'),
      capabilities: { structured_outputs: { supported: false } },
    });
    expect(model?.capabilities).not.toContain('json_mode');
  });

  it('leaves the heuristic alone when the API reports capabilities: null', () => {
    const withNull = internals().convertAnthropicModel({
      ...baseApiModel('claude-opus-5'),
      capabilities: null,
    });
    const withoutField = internals().convertAnthropicModel(baseApiModel('claude-opus-5'));
    expect(withNull?.capabilities.sort()).toEqual(withoutField?.capabilities.sort());
  });

  it('adds pdf_understanding from a declared pdf_input:true', () => {
    const model = internals().convertAnthropicModel({
      ...baseApiModel('claude-opus-5'),
      capabilities: { pdf_input: { supported: true } },
    });
    expect(model?.capabilities).toContain('pdf_understanding');
  });
});
