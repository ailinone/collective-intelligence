// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression: live cost normalization on the per-execution path.
 *
 * TIER 1 (2026-06-11) — COST #1. base-strategy.executeModel now runs the LIVE
 * cost normalizer (`@/services/cost-normalization-service`) on every successful
 * ModelExecution so a $0-reporting hub provider that consumed tokens no longer
 * understates the C3 collective cost.
 *
 * This suite exercises the exact contract base-strategy depends on:
 *   normalizeCost(rawCost, executionProvider, modelId, promptTokens,
 *                 completionTokens, model.inputCostPer1k, model.outputCostPer1k)
 * and the mapping rule base-strategy applies:
 *   - use record.normalizedCostUsd when it is a finite number
 *   - otherwise keep the raw provider cost (never NaN, never throw).
 */

import { describe, it, expect } from 'vitest';
import { normalizeCost } from '@/services/cost-normalization-service';

// Mirror of the finite-or-raw mapping base-strategy applies after normalizeCost.
function effectiveExecutionCost(
  rawCost: number,
  provider: string,
  modelId: string,
  promptTokens?: number,
  completionTokens?: number,
  inputCostPer1k?: number,
  outputCostPer1k?: number,
): number {
  let cost = rawCost;
  try {
    const record = normalizeCost(
      rawCost,
      (provider || '').toLowerCase(),
      modelId,
      promptTokens,
      completionTokens,
      inputCostPer1k,
      outputCostPer1k,
    );
    const normalized = record.normalizedCostUsd;
    if (typeof normalized === 'number' && Number.isFinite(normalized)) {
      cost = normalized;
    }
  } catch {
    cost = rawCost;
  }
  return cost;
}

describe('base-strategy cost normalization (COST #1)', () => {
  it('a $0-reporting hub execution with tokens>0 yields normalizedCost>0', () => {
    // aihubmix runs openai/gpt-4o, reports cost=0 but burned 500+200 tokens.
    const cost = effectiveExecutionCost(
      0, // raw provider cost (the bug: hub reports $0)
      'aihubmix', // EXECUTION provider (adapter.getName()) — NOT self-hosted
      'openai/gpt-4o',
      500,
      200,
      0.01, // model.inputCostPer1k from catalog
      0.03, // model.outputCostPer1k from catalog
    );

    expect(cost).toBeGreaterThan(0);
    // 500/1000*0.01 + 200/1000*0.03 = 0.005 + 0.006 = 0.011
    expect(cost).toBeCloseTo(0.011, 6);
  });

  it('estimates from family/fallback pricing when catalog pricing is absent', () => {
    const cost = effectiveExecutionCost(
      0,
      'cometapi',
      'some-unknown/model-x',
      1000,
      1000,
      0, // no catalog pricing
      0,
    );
    // No DB pricing, no family match → generic fallback estimate, still > 0.
    expect(cost).toBeGreaterThan(0);
    expect(Number.isFinite(cost)).toBe(true);
  });

  it('a model with a real provider cost keeps that cost (non-zero, non-exploded)', () => {
    const rawCost = 0.05;
    const cost = effectiveExecutionCost(
      rawCost,
      'anthropic',
      'claude-sonnet-4',
      1000,
      500,
      0.003,
      0.015,
    );

    // Provider-reported positive cost is trusted as-is (high confidence).
    expect(cost).toBe(rawCost);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(1); // sane, not exploded
  });

  it('falls back to raw cost when there is no cost and no tokens (never NaN)', () => {
    // Cloud provider, cost 0, no tokens → normalizer returns null → keep raw 0.
    const cost = effectiveExecutionCost(0, 'aihubmix', 'openai/gpt-4o', 0, 0, 0.01, 0.03);
    expect(cost).toBe(0);
    expect(Number.isNaN(cost)).toBe(false);
  });

  it('normalized hub cost is medium/low confidence (not trusted as provider_reported)', () => {
    const record = normalizeCost(0, 'aihubmix', 'openai/gpt-4o', 500, 200, 0.01, 0.03);
    expect(record.normalizedCostUsd).toBeGreaterThan(0);
    expect(record.costSource).not.toBe('provider_reported');
    expect(record.rawCostUsd).toBe(0);
  });
});
