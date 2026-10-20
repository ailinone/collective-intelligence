// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import type { DiscoveredModel } from '@/services/central-model-discovery-service';
import { CommunityPriceIndex } from '@/services/pricing-enrichment/community-price-index';
import {
  COMMUNITY_PRICING_SOURCE,
  applyCommunityPricing,
} from '@/services/pricing-enrichment/apply-community-pricing';

const index = CommunityPriceIndex.fromJson({
  'gpt-4o': {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.00000125,
    input_cost_per_token_batches: 0.00000125,
    output_cost_per_token_batches: 0.000005,
  },
});

function model(partial: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return { id: 'gpt-4o', name: 'gpt-4o', capabilities: ['chat'], metadata: {}, ...partial };
}

describe('applyCommunityPricing', () => {
  it('fills a $0 / missing price from the index and records provenance', () => {
    const out = applyCommunityPricing(model({ pricing: { inputCostPer1M: 0, outputCostPer1M: 0 } }), 'openai', index);
    expect(out.pricing?.inputCostPer1M).toBe(2.5);
    expect(out.pricing?.outputCostPer1M).toBe(10);
    expect(out.pricing?.currency).toBe('USD');
    expect(out.pricing?.cacheReadCostPer1M).toBe(1.25);
    expect(out.pricing?.batchInputCostPer1M).toBe(1.25);
    expect(out.pricing?.batchOutputCostPer1M).toBe(5);
    expect(out.metadata?.pricingSource).toBe(COMMUNITY_PRICING_SOURCE);
    expect(out.metadata?.pricingSourceKey).toBe('gpt-4o');
    expect(out.metadata?.pricingMatch).toBe('exact');

    const noPricing = applyCommunityPricing(model(), 'openai', index);
    expect(noPricing.pricing?.inputCostPer1M).toBe(2.5);
  });

  it('never overrides a price the provider itself reported', () => {
    const reported = model({ pricing: { inputCostPer1M: 4, outputCostPer1M: 12 } });
    const out = applyCommunityPricing(reported, 'openai', index);
    expect(out).toBe(reported);
    expect(out.pricing?.inputCostPer1M).toBe(4);
  });

  it('treats legacy prompt/completion prices as provider-reported too', () => {
    const legacy = model({ pricing: { prompt: 3, completion: 9 } });
    expect(applyCommunityPricing(legacy, 'openai', index)).toBe(legacy);
  });

  it.each(['premium-tier', 'reasoning-tier', 'fast-tier', 'specialized-tier', 'default-fallback'])(
    'replaces a fetcher heuristic estimate tagged %s',
    (tag) => {
      const estimated = model({
        pricing: { inputCostPer1M: 5, outputCostPer1M: 15 },
        metadata: { pricingSource: tag, family: 'GPT' },
      });
      const out = applyCommunityPricing(estimated, 'openai', index);
      expect(out.pricing?.inputCostPer1M).toBe(2.5);
      expect(out.metadata?.pricingSource).toBe(COMMUNITY_PRICING_SOURCE);
      // unrelated metadata is preserved
      expect(out.metadata?.family).toBe('GPT');
    }
  );

  it('keeps a price whose pricingSource is something other than a heuristic tag', () => {
    const tagged = model({
      pricing: { inputCostPer1M: 4, outputCostPer1M: 12 },
      metadata: { pricingSource: 'provider-api' },
    });
    expect(applyCommunityPricing(tagged, 'openai', index)).toBe(tagged);
  });

  it('returns the same object when the index has no match or is unavailable', () => {
    const unknown = model({ id: 'mystery', name: 'mystery' });
    expect(applyCommunityPricing(unknown, 'openai', index)).toBe(unknown);
    expect(applyCommunityPricing(model(), 'openai', undefined)).toEqual(model());
  });

  it('does not mutate its input', () => {
    const input = model({ pricing: { inputCostPer1M: 0, outputCostPer1M: 0 }, metadata: { a: 1 } });
    const snapshot = JSON.parse(JSON.stringify(input));
    applyCommunityPricing(input, 'openai', index);
    expect(input).toEqual(snapshot);
  });
});
