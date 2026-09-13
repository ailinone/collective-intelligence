// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { OpenAIModelFetcher } from '@/services/model-fetchers/openai-model-fetcher';
import type { ProviderModel } from '@/services/model-fetchers/provider-model-fetcher';

/**
 * Pricing regression tests for the OpenAI fetcher's tier-keyword estimator.
 *
 * ## The 2026-09 bug
 *
 * `isPremium` correctly excluded fast/mini variants (`isPremium && !isFast`),
 * but the sibling `isReasoning` branch was missing that guard, so any
 * reasoning-pattern id (`/^o\d/`) that ALSO matched the fast/mini pattern —
 * `o3-mini`, `o4-mini`, `o4-mini-deep-research` — was priced as full flagship
 * reasoning ($15/$60 per 1M) instead of the cheap tier ($0.5/$1.5), a ~30x
 * overcharge. Fixed by mirroring isPremium's guard exactly:
 * `isReasoning && !isFast`.
 *
 * These tests pin that fix and the `pricingSource` tagging added alongside it
 * (this fetcher had zero pricing tests before this file — every model here
 * gets an ESTIMATE, not a provider-confirmed price, since OpenAI's
 * `models.list()` exposes no pricing at all; `pricingSource` makes clear
 * which estimate bucket produced a given price, and 'default-fallback' in
 * particular must never fire silently).
 */

function estimate(modelId: string) {
  const fetcher = new OpenAIModelFetcher('sk-real-test-key-not-mock');
  return (
    fetcher as unknown as {
      estimateModelSpecs: (id: string) => {
        contextWindow: number;
        maxOutputTokens: number;
        pricing: ProviderModel['pricing'];
        pricingSource: string;
      };
    }
  ).estimateModelSpecs(modelId);
}

describe('openai-model-fetcher pricing — reasoning vs fast-tier guard', () => {
  it('prices a fast/mini reasoning model at the cheap fast tier, not flagship reasoning', () => {
    for (const modelId of ['o3-mini', 'o4-mini', 'o4-mini-deep-research']) {
      const { pricing, pricingSource } = estimate(modelId);
      expect(pricing.inputCostPer1M, `${modelId} input`).toBe(0.5);
      expect(pricing.outputCostPer1M, `${modelId} output`).toBe(1.5);
      expect(pricingSource, modelId).toBe('fast-tier');
    }
  });

  it('still prices a non-fast reasoning model as full flagship reasoning', () => {
    for (const modelId of ['o3', 'o1', 'o3-deep-research']) {
      const { pricing, pricingSource } = estimate(modelId);
      expect(pricing.inputCostPer1M, `${modelId} input`).toBe(15.0);
      expect(pricing.outputCostPer1M, `${modelId} output`).toBe(60.0);
      expect(pricingSource, modelId).toBe('reasoning-tier');
    }
  });

  it('mirrors the same guard already correct on the premium branch', () => {
    // gpt-4-turbo-mini is a fabricated id chosen purely to exercise the
    // guard: isPremium (turbo) && isFast (mini) together must fall through
    // premium to the fast tier, exactly like isReasoning does after the fix.
    const { pricing, pricingSource } = estimate('gpt-4-turbo-mini');
    expect(pricing.inputCostPer1M).toBe(0.5);
    expect(pricing.outputCostPer1M).toBe(1.5);
    expect(pricingSource).toBe('fast-tier');
  });

  it('prices a genuine flagship premium model at the premium tier', () => {
    const { pricing, pricingSource } = estimate('gpt-4-turbo');
    expect(pricing.inputCostPer1M).toBe(15.0);
    expect(pricing.outputCostPer1M).toBe(60.0);
    expect(pricingSource).toBe('premium-tier');
  });
});

describe('openai-model-fetcher pricing — default-fallback is never silent', () => {
  it('tags a model matching none of the tier keyword patterns as default-fallback', () => {
    const { pricing, pricingSource } = estimate('completely-unclassifiable-model-xyz');
    expect(pricing.inputCostPer1M).toBe(5.0);
    expect(pricing.outputCostPer1M).toBe(15.0);
    expect(pricingSource).toBe('default-fallback');
  });

  it('never tags a classified tier as default-fallback', () => {
    const classified = ['gpt-4-turbo', 'o3-mini', 'o3', 'gpt-4o-mini', 'whisper-1', 'dall-e-3'];
    for (const modelId of classified) {
      expect(estimate(modelId).pricingSource, modelId).not.toBe('default-fallback');
    }
  });
});
