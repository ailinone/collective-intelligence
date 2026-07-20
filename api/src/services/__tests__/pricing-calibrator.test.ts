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
  cogsBudgetForAnchor,
  deriveRateCard,
  type BenchmarkPoint,
} from '@/services/pricing-calibrator';
import { cogsBudgetUsd, tierBilledCostUsd } from '@/services/pricing-tiers';

/**
 * The operator's leaderboard (resolution-rate × price) — the shape CI's benchmark
 * pipeline produces — plus Grok 4.3, the cheap-but-strong entrant we worried about.
 */
const LEADERBOARD: BenchmarkPoint[] = [
  { modelId: 'deepseek-v3.2', quality: 0.7, inputPer1MUsd: 0.27, outputPer1MUsd: 1.1 },
  { modelId: 'minimax-m2.5', quality: 0.75, inputPer1MUsd: 0.3, outputPer1MUsd: 1.2 },
  { modelId: 'deepseek-v4', quality: 0.806, inputPer1MUsd: 0.5, outputPer1MUsd: 2 },
  { modelId: 'gemini-3.1-pro', quality: 0.806, inputPer1MUsd: 2, outputPer1MUsd: 12 },
  { modelId: 'grok-4.3', quality: 0.85, inputPer1MUsd: 1.25, outputPer1MUsd: 2.5 },
  { modelId: 'opus-4.8', quality: 0.886, inputPer1MUsd: 5, outputPer1MUsd: 25 },
  { modelId: 'gpt-5.5', quality: 0.887, inputPer1MUsd: 5, outputPer1MUsd: 30 },
  { modelId: 'fable-5', quality: 0.95, inputPer1MUsd: 10, outputPer1MUsd: 50 },
];

describe('pricing-calibrator', () => {
  const { rateCard, anchors, frontier } = deriveRateCard(LEADERBOARD);

  it('drops dominated singles from the frontier (Gemini is dominated by DeepSeek-V4)', () => {
    const ids = frontier.map((p) => p.modelId);
    expect(ids).toContain('deepseek-v4');
    // Gemini (q0.806, out $12) is dominated by DeepSeek-V4 (q0.806, out $2) — same quality, cheaper.
    expect(ids).not.toContain('gemini-3.1-pro');
  });

  it('anchors low/mid tiers on the cheap leaders and resells (passthrough band)', () => {
    expect(anchors.medium.band).toBe('passthrough');
    expect(anchors.medium.anchorModelId).toBe('deepseek-v4');
    // anchor out $2 × 1.2 markup → ceil = $3; in $0.5 × 1.2 → ceil = $1.
    expect(rateCard.medium).toEqual({ inputPer1MUsd: 1, outputPer1MUsd: 3 });
  });

  it("BEATS Grok 4.3 at mid — the 'perdemos feio' is gone", () => {
    // Grok 4.3: $1.25 in / $2.50 out. CI medium: $1 in / $3 out — cheaper input, ~parity output,
    // while adding routing/reliability/fallback. The collective margin is reserved for the frontier.
    expect(rateCard.medium.inputPer1MUsd).toBeLessThan(1.25);
    expect(rateCard.medium.outputPer1MUsd).toBeLessThanOrEqual(3);
  });

  it('anchors top tiers on the expensive frontier and UNDERCUTS it (collective band)', () => {
    expect(anchors.large.band).toBe('collective');
    expect(anchors.large.anchorModelId).toBe('opus-4.8'); // Grok 0.85 < 0.88 target, doesn't qualify.
    // Opus $5/$25 × (1 − 0.20) → $4 / $20. Below top-tier → thesis holds.
    expect(rateCard.large).toEqual({ inputPer1MUsd: 4, outputPer1MUsd: 20 });
    expect(rateCard.large.outputPer1MUsd).toBeLessThan(25);

    expect(anchors.extra.anchorModelId).toBe('fable-5');
    expect(rateCard.extra).toEqual({ inputPer1MUsd: 8, outputPer1MUsd: 40 }); // $10/$50 × 0.80.
    expect(rateCard.extra.outputPer1MUsd).toBeLessThan(50);
  });

  it('keeps a FAT margin at the frontier and a healthy, MEASURED one on resale', () => {
    expect(anchors.extra.effectiveMarginTarget).toBeGreaterThan(0.5); // collective: fat.
    // Passthrough margin is read from the realized integer rates (medium $1/$3 over DeepSeek-V4 $0.5/$2).
    expect(anchors.medium.effectiveMarginTarget).toBeGreaterThan(0.3);
    expect(anchors.medium.effectiveMarginTarget).toBeLessThan(0.6);
  });

  it('dynamic markup caps passthrough below the next qualifier (competitive)', () => {
    // medium output $3 must not exceed the next qualifier (Grok $2.50) by more than rounding allows.
    expect(rateCard.medium.outputPer1MUsd).toBeLessThanOrEqual(Math.ceil(2.5));
  });

  it('takes the FULL 100% markup when the spread to the next qualifier is wide', () => {
    // A cheap 0.80 single, then a big cliff to a 0.90 single → medium has huge headroom.
    const cliff = deriveRateCard([
      { modelId: 'cheap-strong', quality: 0.8, inputPer1MUsd: 1, outputPer1MUsd: 2 },
      { modelId: 'pricey-top', quality: 0.9, inputPer1MUsd: 20, outputPer1MUsd: 40 },
    ]);
    expect(cliff.anchors.medium.band).toBe('passthrough');
    // 100% markup → 2× the anchor, still far below the $20/$40 alternative; margin = 50%.
    expect(cliff.rateCard.medium).toEqual({ inputPer1MUsd: 2, outputPer1MUsd: 4 });
    expect(cliff.anchors.medium.effectiveMarginTarget).toBeCloseTo(0.5, 5);
  });

  it('self-corrects: a cheaper strong entrant re-anchors the tier DOWN', () => {
    // Drop Grok further in price; the tier it qualifies for must not get MORE expensive.
    const cheaperGrok = LEADERBOARD.map((p) =>
      p.modelId === 'grok-4.3' ? { ...p, outputPer1MUsd: 1.5 } : p,
    );
    const after = deriveRateCard(cheaperGrok);
    expect(after.rateCard.medium.outputPer1MUsd).toBeLessThanOrEqual(rateCard.medium.outputPer1MUsd);
  });

  it('the COGS guard never exceeds revenue and matches the band margin', () => {
    const PROMPT = 200_000;
    const COMPLETION = 200_000;
    // Passthrough: cap ≈ provider price (markup is the only margin) → cap < revenue, margin thin.
    const revMed = tierBilledCostUsd('medium', PROMPT, COMPLETION, rateCard);
    const capMed = cogsBudgetForAnchor(anchors.medium, PROMPT, COMPLETION);
    expect(capMed).toBeLessThan(revMed);
    expect(capMed / revMed).toBeCloseTo(1 - anchors.medium.effectiveMarginTarget, 5);

    // Collective: fat margin → cap is a small fraction of revenue.
    const revExtra = tierBilledCostUsd('extra', PROMPT, COMPLETION, rateCard);
    const capExtra = cogsBudgetForAnchor(anchors.extra, PROMPT, COMPLETION);
    expect(capExtra).toBeLessThan(revExtra * 0.5);
  });

  it('the calibrated rate card flows through the tier billing functions unchanged', () => {
    // 1M + 1M tokens at the calibrated `extra` rate = $8 + $40 = $48.
    expect(tierBilledCostUsd('extra', 1_000_000, 1_000_000, rateCard)).toBeCloseTo(48, 5);
    // And the static-margin COGS helper still works when fed the calibrated card.
    expect(cogsBudgetUsd('extra', 1_000_000, 1_000_000, rateCard)).toBeGreaterThan(0);
  });

  it('falls back to static rates when there is no benchmark data', () => {
    const empty = deriveRateCard([]);
    expect(empty.anchors.base.anchorModelId).toBe('(static fallback)');
    expect(empty.rateCard.base.outputPer1MUsd).toBeGreaterThan(0);
  });
});
