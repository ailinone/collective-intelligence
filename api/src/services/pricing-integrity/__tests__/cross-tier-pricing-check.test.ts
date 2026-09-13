// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import {
  deriveModelFamily,
  isCheapTierModelId,
  findCrossTierPricingViolations,
  type PricedModel,
} from '@/services/pricing-integrity/cross-tier-pricing-check';

describe('deriveModelFamily', () => {
  it('collapses tier variants of the same family to the same key', () => {
    expect(deriveModelFamily('gemini-2.5-pro')).toBe(deriveModelFamily('gemini-2.5-flash'));
    expect(deriveModelFamily('gemini-2.5-flash')).toBe(deriveModelFamily('gemini-2.5-flash-lite'));
    expect(deriveModelFamily('o3')).toBe(deriveModelFamily('o3-mini'));
    expect(deriveModelFamily('gpt-5')).toBe(deriveModelFamily('gpt-5-mini'));
    // Anthropic's own opus/haiku naming convention is exactly the same
    // pattern — these two SHOULD collapse to one family so the cross-tier
    // check can compare them (haiku = cheap, opus = flagship).
    expect(deriveModelFamily('claude-opus-4')).toBe(deriveModelFamily('claude-haiku-4'));
  });

  it('keeps genuinely different model lines apart', () => {
    expect(deriveModelFamily('gpt-5')).not.toBe(deriveModelFamily('gpt-4'));
    expect(deriveModelFamily('gemini-2.5-pro')).not.toBe(deriveModelFamily('gemini-3.1-pro'));
    expect(deriveModelFamily('claude-opus-4')).not.toBe(deriveModelFamily('gemini-2.5-pro'));
  });
});

describe('isCheapTierModelId', () => {
  it('recognizes generic cheap-tier naming tokens', () => {
    for (const id of [
      'o3-mini',
      'gpt-5-nano',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'claude-haiku-4',
      'gpt-4-turbo-fast',
    ]) {
      expect(isCheapTierModelId(id), id).toBe(true);
    }
  });

  it('does not flag a flagship-tier or unqualified id', () => {
    for (const id of ['gpt-5', 'o3', 'gemini-2.5-pro', 'claude-opus-4']) {
      expect(isCheapTierModelId(id), id).toBe(false);
    }
  });

  it('matches whole naming tokens, not substrings of unrelated words', () => {
    // "flashcard-model" must not be treated as a Gemini "flash" tier just
    // because the substring "flash" appears inside a longer, unrelated word.
    expect(isCheapTierModelId('flashcard-model')).toBe(false);
  });
});

describe('findCrossTierPricingViolations', () => {
  it('reproduces the pre-fix openai bug: a fast/mini reasoning model priced at flagship rate', () => {
    const models: PricedModel[] = [
      { id: 'o3', providerId: 'openai', inputCostPer1M: 15, outputCostPer1M: 60 },
      // Pre-fix: o3-mini fell through to the same flagship reasoning price.
      { id: 'o3-mini', providerId: 'openai', inputCostPer1M: 15, outputCostPer1M: 60 },
    ];
    const violations = findCrossTierPricingViolations(models);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      providerId: 'openai',
      cheapModelId: 'o3-mini',
      flagshipModelId: 'o3',
      violatedOn: expect.arrayContaining(['input', 'output']),
    });
  });

  it('does NOT flag a correctly-tiered family (cheap strictly below flagship)', () => {
    const models: PricedModel[] = [
      { id: 'gemini-2.5-pro', providerId: 'vertex-ai', inputCostPer1M: 1.25, outputCostPer1M: 10 },
      {
        id: 'gemini-2.5-flash',
        providerId: 'vertex-ai',
        inputCostPer1M: 0.3,
        outputCostPer1M: 2.5,
      },
      {
        id: 'gemini-2.5-flash-lite',
        providerId: 'vertex-ai',
        inputCostPer1M: 0.1,
        outputCostPer1M: 0.4,
      },
    ];
    expect(findCrossTierPricingViolations(models)).toEqual([]);
  });

  it('flags a partial violation (input inverted, output still correctly ordered)', () => {
    const models: PricedModel[] = [
      { id: 'family-pro', providerId: 'acme', inputCostPer1M: 5, outputCostPer1M: 20 },
      { id: 'family-mini', providerId: 'acme', inputCostPer1M: 5, outputCostPer1M: 1 },
    ];
    const violations = findCrossTierPricingViolations(models);
    expect(violations).toHaveLength(1);
    expect(violations[0].violatedOn).toEqual(['input']);
  });

  it('does not compare models from different providers even if same family name', () => {
    const models: PricedModel[] = [
      { id: 'llama-3-8b', providerId: 'provider-a', inputCostPer1M: 0.04, outputCostPer1M: 0.04 },
      // Same family root, different provider, absurd price — not this provider's problem.
      { id: 'llama-3-70b-mini', providerId: 'provider-b', inputCostPer1M: 50, outputCostPer1M: 50 },
    ];
    expect(findCrossTierPricingViolations(models)).toEqual([]);
  });

  it('ignores unpriced (0/0) rows entirely — a 0 usually means "unknown", not "free"', () => {
    const models: PricedModel[] = [
      { id: 'family-pro', providerId: 'acme', inputCostPer1M: 0, outputCostPer1M: 0 },
      { id: 'family-mini', providerId: 'acme', inputCostPer1M: 0, outputCostPer1M: 0 },
    ];
    expect(findCrossTierPricingViolations(models)).toEqual([]);
  });

  it('ignores a singleton family (nothing to compare against)', () => {
    const models: PricedModel[] = [
      { id: 'only-mini-model', providerId: 'acme', inputCostPer1M: 999, outputCostPer1M: 999 },
    ];
    expect(findCrossTierPricingViolations(models)).toEqual([]);
  });
});
