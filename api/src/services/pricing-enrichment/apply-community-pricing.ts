// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Decides when a discovered model's price may be taken from the community
 * price index, and produces the enriched model.
 *
 * Precedence (highest first):
 *   1. a price the provider itself reported          -> never touched
 *   2. community price index (this module)           -> replaces 3 and 4
 *   3. a heuristic estimate the fetcher tagged with a *-tier / default-fallback
 *      `metadata.pricingSource` (e.g. OpenAI's keyword tiers, which were >25%
 *      off for 70% of the models comparable against the community table)
 *   4. nothing (persisted as $0 — "unknown", not "free")
 *
 * Provenance is always recorded: `metadata.pricingSource = 'community-litellm'`,
 * the matched key, and how it matched, so cost accounting and the pricing
 * integrity job can tell a published price from a community one.
 *
 * Cache/batch/long-context prices ride along inside `metadata.pricing` (the
 * models table only has input/output columns; metadata.pricing is persisted
 * whole by bulkUpsertModels).
 */
import type { DiscoveredModel } from '@/services/central-model-discovery-service';
import type { CommunityPriceIndex } from './community-price-index';

export const COMMUNITY_PRICING_SOURCE = 'community-litellm';

const HEURISTIC_PRICING_SOURCES = new Set([
  'premium-tier',
  'reasoning-tier',
  'fast-tier',
  'specialized-tier',
  'default-fallback',
]);

function hasProviderReportedPrice(model: DiscoveredModel): boolean {
  const pricing = model.pricing;
  if (!pricing) return false;
  const input = pricing.inputCostPer1M ?? pricing.prompt ?? 0;
  const output = pricing.outputCostPer1M ?? pricing.completion ?? 0;
  if (input <= 0 && output <= 0) return false;

  const source = model.metadata?.pricingSource;
  return !(typeof source === 'string' && HEURISTIC_PRICING_SOURCES.has(source));
}

export function applyCommunityPricing(
  model: DiscoveredModel,
  providerId: string,
  index: CommunityPriceIndex | undefined
): DiscoveredModel {
  if (!index || hasProviderReportedPrice(model)) return model;

  const lookup = index.lookup(providerId, model.name || model.id);
  if (!lookup) return model;

  const { price } = lookup;
  return {
    ...model,
    pricing: {
      ...model.pricing,
      inputCostPer1M: price.inputCostPer1M,
      outputCostPer1M: price.outputCostPer1M,
      currency: 'USD',
      ...(price.cacheReadCostPer1M !== undefined && { cacheReadCostPer1M: price.cacheReadCostPer1M }),
      ...(price.cacheWriteCostPer1M !== undefined && {
        cacheWriteCostPer1M: price.cacheWriteCostPer1M,
      }),
      ...(price.batchInputCostPer1M !== undefined && {
        batchInputCostPer1M: price.batchInputCostPer1M,
      }),
      ...(price.batchOutputCostPer1M !== undefined && {
        batchOutputCostPer1M: price.batchOutputCostPer1M,
      }),
      ...(price.inputCostPer1MAbove200k !== undefined && {
        inputCostPer1MAbove200k: price.inputCostPer1MAbove200k,
      }),
      ...(price.outputCostPer1MAbove200k !== undefined && {
        outputCostPer1MAbove200k: price.outputCostPer1MAbove200k,
      }),
    },
    metadata: {
      ...model.metadata,
      pricingSource: COMMUNITY_PRICING_SOURCE,
      pricingSourceKey: lookup.sourceKey,
      pricingMatch: lookup.match,
    },
  };
}
