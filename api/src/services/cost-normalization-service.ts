// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cost Normalization Service
 *
 * Resolves the widespread cost=$0 problem from the C3 pilot where hub
 * adapters returned zero cost despite consuming tokens. This service:
 *
 * 1. Preserves raw cost exactly as reported by the provider
 * 2. Produces a normalized cost with confidence level
 * 3. Estimates cost from token counts + pricing table when raw is missing
 * 4. Marks cost as "missing" when no estimation is possible
 *
 * Rules:
 * - cost=0 from a cloud hub with tokens>0 is NOT "free" — it's "missing"
 * - cost=0 from self-hosted/local IS genuinely free
 * - cost>0 from any provider is "provider_reported" (high confidence)
 * - estimated costs are "medium" confidence
 * - imputed costs (from model family average) are "low" confidence
 */

import { logger } from '@/utils/logger';
import { getProviderOperabilityHub } from '@/core/provider-operability-hub';

const _log = logger.child({ component: 'cost-normalization' });

// ─── Types ──────────────────────────────────────────────────────────────

export type CostSource =
  | 'provider_reported'
  | 'hub_reported'
  | 'estimated_from_tokens'
  | 'estimated_from_pricing_table'
  | 'imputed_from_model_family'
  | 'genuinely_free'
  | 'missing';

export type CostConfidence = 'high' | 'medium' | 'low' | 'none';

export interface CostRecord {
  rawCostUsd: number | null;
  normalizedCostUsd: number | null;
  costSource: CostSource;
  costConfidence: CostConfidence;
  normalizationReason: string;
  inputTokens?: number;
  outputTokens?: number;
}

// ─── Default Pricing (fallback when DB pricing is unavailable) ──────────

/**
 * Conservative pricing estimates per 1K tokens.
 * Used when the DB has no pricing for a model and we need to estimate.
 * These are intentionally slightly ABOVE market rates to avoid
 * under-counting costs.
 */
const DEFAULT_PRICING_PER_1K: Record<string, { input: number; output: number }> = {
  // Frontier models
  'gpt-5': { input: 0.015, output: 0.060 },
  'gpt-4': { input: 0.010, output: 0.030 },
  'claude-opus': { input: 0.015, output: 0.075 },
  'claude-sonnet': { input: 0.003, output: 0.015 },
  'claude-haiku': { input: 0.00025, output: 0.00125 },
  'gemini-pro': { input: 0.001, output: 0.002 },
  'gemini-flash': { input: 0.0001, output: 0.0004 },
  'mistral-large': { input: 0.004, output: 0.012 },
  'grok': { input: 0.005, output: 0.015 },
  // Budget models
  'deepseek': { input: 0.00014, output: 0.00028 },
  'qwen': { input: 0.0002, output: 0.0006 },
  'llama': { input: 0.0002, output: 0.0006 },
  // Generic fallback
  '_default': { input: 0.002, output: 0.006 },
};

// ─── Service ────────────────────────────────────────────────────────────

/**
 * Normalize a cost value from a model execution.
 *
 * @param rawCostUsd - Cost as reported by the adapter (may be 0 or null)
 * @param provider - The EXECUTION provider (adapter name, not logical)
 * @param modelId - The model ID (used for pricing lookup)
 * @param inputTokens - Token count (if available from usage data)
 * @param outputTokens - Token count (if available from usage data)
 * @param modelInputCostPer1k - Pricing from DB model record (may be 0)
 * @param modelOutputCostPer1k - Pricing from DB model record (may be 0)
 */
export function normalizeCost(
  rawCostUsd: number | null | undefined,
  provider: string,
  modelId: string,
  inputTokens?: number,
  outputTokens?: number,
  modelInputCostPer1k?: number,
  modelOutputCostPer1k?: number,
): CostRecord {
  const hub = getProviderOperabilityHub();
  const isSelfHosted = hub.isSelfHostedProvider(provider);
  const hasTokens = (inputTokens && inputTokens > 0) || (outputTokens && outputTokens > 0);
  const rawCost = typeof rawCostUsd === 'number' ? rawCostUsd : null;

  // Case 1: Provider reported a positive cost → trust it
  if (rawCost !== null && rawCost > 0) {
    return {
      rawCostUsd: rawCost,
      normalizedCostUsd: rawCost,
      costSource: 'provider_reported',
      costConfidence: 'high',
      normalizationReason: 'Provider reported positive cost',
      inputTokens,
      outputTokens,
    };
  }

  // Case 2: Self-hosted/local with cost=0 → genuinely free
  if (isSelfHosted) {
    return {
      rawCostUsd: rawCost ?? 0,
      normalizedCostUsd: 0,
      costSource: 'genuinely_free',
      costConfidence: 'high',
      normalizationReason: `Self-hosted provider "${provider}" has zero marginal cost`,
      inputTokens,
      outputTokens,
    };
  }

  // Case 3: Cloud provider with cost=0 but tokens consumed → estimate
  if (hasTokens) {
    const inTokens = inputTokens || 0;
    const outTokens = outputTokens || 0;

    // Try DB pricing first
    const dbInputCost = modelInputCostPer1k && modelInputCostPer1k > 0 ? modelInputCostPer1k : 0;
    const dbOutputCost = modelOutputCostPer1k && modelOutputCostPer1k > 0 ? modelOutputCostPer1k : 0;

    if (dbInputCost > 0 || dbOutputCost > 0) {
      const estimated = (inTokens / 1000) * dbInputCost + (outTokens / 1000) * dbOutputCost;
      return {
        rawCostUsd: rawCost,
        normalizedCostUsd: Math.max(estimated, 0.000001), // floor at 1 micro-cent
        costSource: 'estimated_from_pricing_table',
        costConfidence: 'medium',
        normalizationReason: `Estimated from DB pricing: in=$${dbInputCost}/1k, out=$${dbOutputCost}/1k, tokens=${inTokens}+${outTokens}`,
        inputTokens,
        outputTokens,
      };
    }

    // Try family-based pricing
    const familyPricing = matchFamilyPricing(modelId);
    if (familyPricing) {
      const estimated = (inTokens / 1000) * familyPricing.input + (outTokens / 1000) * familyPricing.output;
      return {
        rawCostUsd: rawCost,
        normalizedCostUsd: Math.max(estimated, 0.000001),
        costSource: 'imputed_from_model_family',
        costConfidence: 'low',
        normalizationReason: `Imputed from "${familyPricing.family}" family pricing: in=$${familyPricing.input}/1k, out=$${familyPricing.output}/1k`,
        inputTokens,
        outputTokens,
      };
    }

    // Last resort: generic estimate
    const fallback = DEFAULT_PRICING_PER_1K['_default'];
    const estimated = (inTokens / 1000) * fallback.input + (outTokens / 1000) * fallback.output;
    return {
      rawCostUsd: rawCost,
      normalizedCostUsd: Math.max(estimated, 0.000001),
      costSource: 'estimated_from_tokens',
      costConfidence: 'low',
      normalizationReason: `Generic estimate from token count: ${inTokens}+${outTokens} tokens, fallback rate $${fallback.input}/$${fallback.output} per 1k`,
      inputTokens,
      outputTokens,
    };
  }

  // Case 4: No cost AND no tokens → truly missing
  return {
    rawCostUsd: rawCost,
    normalizedCostUsd: null,
    costSource: 'missing',
    costConfidence: 'none',
    normalizationReason: `No cost reported and no token counts available from provider "${provider}" for model "${modelId}"`,
    inputTokens,
    outputTokens,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function matchFamilyPricing(modelId: string): { family: string; input: number; output: number } | null {
  const lowered = modelId.toLowerCase();

  for (const [family, pricing] of Object.entries(DEFAULT_PRICING_PER_1K)) {
    if (family === '_default') continue;
    if (lowered.includes(family)) {
      return { family, ...pricing };
    }
  }

  return null;
}

/**
 * Determine the effective cost for sorting/ranking purposes.
 *
 * Used by cost-cascade and dynamic model selector to avoid the bug where
 * cost=0 hub variants were sorted as "cheapest" and tried first.
 *
 * Rules:
 * - Provider-reported cost > 0 → use as-is
 * - Self-hosted → 0 (genuinely free, prefer for budget)
 * - Cloud with cost=0 → MAX_SAFE_INTEGER (unknown = bottom of sort)
 * - Estimated cost → use estimated value
 */
export function effectiveCostForSorting(costRecord: CostRecord): number {
  if (costRecord.costSource === 'genuinely_free') return 0;
  if (costRecord.normalizedCostUsd !== null && costRecord.normalizedCostUsd > 0) return costRecord.normalizedCostUsd;
  if (costRecord.costSource === 'missing') return Number.MAX_SAFE_INTEGER;
  return costRecord.normalizedCostUsd ?? Number.MAX_SAFE_INTEGER;
}
