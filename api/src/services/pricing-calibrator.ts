// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pricing-calibrator.ts — derive the published per-tier rate card from the live
 * benchmark Pareto frontier, so tier prices TRACK the market instead of being
 * hand-chosen.
 *
 * CI already measures `(quality, cost)` per model (external fetch: Artificial
 * Analysis / BenchLM / LMArena; internal: `c3:v4`; live: the LLM-judge on
 * `RequestLog.qualityScore`), merged into `ModelQualityCalibrationSnapshot`. This
 * module turns that signal into tier prices:
 *
 *   1. Compute the cost↔quality Pareto frontier of the benchmark points
 *      (reusing the existing `computeParetoFrontier`).
 *   2. For each tier, ANCHOR on the cheapest frontier single that meets the
 *      tier's quality target.
 *   3. Decide the BAND from the anchor's price:
 *        - passthrough (cheap leader, e.g. Grok/DeepSeek): resell at anchor × (1+markup).
 *          The markup IS the margin; the COGS cap ≈ the provider's own price.
 *        - collective (expensive frontier, e.g. Opus/Fable): undercut at
 *          anchor × (1−discount). The ensemble hits the same quality for a COGS
 *          far below the frontier single, so price < top-tier AND margin stays fat.
 *
 * This is what makes the pricing self-correct: when a cheap-but-strong model
 * (Grok 4.3) lands on the leaderboard, it joins the frontier, the mid tiers
 * re-anchor to it, and their prices drop to track it — automatically.
 *
 * Pure: no I/O, no clock, no randomness. The DB/snapshot read lives in
 * `pricing-snapshot-loader.ts`, which feeds `BenchmarkPoint[]` into here.
 */

import { computeParetoFrontier } from '../core/pareto/cost-quality-frontier';
import {
  TIERS,
  TIER_ORDER,
  type PricingTier,
  type TierId,
  type TierRate,
  type TierRateCard,
} from './pricing-tiers';

export interface BenchmarkPoint {
  modelId: string;
  /** Resolution-rate proxy, 0–1 (from the calibration snapshot). */
  quality: number;
  inputPer1MUsd: number;
  outputPer1MUsd: number;
}

export type PricingBand = 'passthrough' | 'collective';

/** Per-tier derivation: the anchor it tracks, the band, the published rate, the guard margin. */
export interface TierAnchor {
  tier: TierId;
  anchorModelId: string;
  anchorQuality: number;
  anchorInputPer1MUsd: number;
  anchorOutputPer1MUsd: number;
  band: PricingBand;
  /** Published USER-token rate, USD per 1M (integer, rounded up). */
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  /** Band-aware contribution-margin floor → feeds the COGS guard (NOT the static one). */
  effectiveMarginTarget: number;
  /** True when no model reaches the tier's quality target (anchored to the best available). */
  aspirational: boolean;
}

/**
 * The knobs that ARE the pricing strategy. The operator owns these — they trade
 * competitiveness against margin. Tune here.
 *
 * Passthrough markup is DYNAMIC: it takes up to `targetMarkupPct` (the 100% goal —
 * 2× COGS, a 50% margin) over the anchor, but never prices above the next-cheapest
 * qualifying single (the competitive cap), and never below `floorMarkupPct`. So the
 * full 100% is realised wherever the spread to the next option allows it (e.g. right
 * at the quality "cliff"), and the price stays market-competitive everywhere else.
 */
export interface CalibratorPolicy {
  /** Input-token share of a representative request, for the frontier's blended cost axis (0–1). */
  inputShare: number;
  /** Anchor OUTPUT rate at/below which a tier is a passthrough resale (the cheap-leader band). */
  passthroughOutputThresholdPer1MUsd: number;
  /** Passthrough: markup GOAL over the anchor — 1.0 = 100% (2× COGS), taken whenever competitive. */
  targetMarkupPct: number;
  /** Passthrough: minimum markup kept even when the competitive cap is tight. */
  floorMarkupPct: number;
  /** Passthrough: undercut applied to the next-cheapest qualifying single (the competitive cap). */
  competitiveUndercutPct: number;
  /** Discount under the cheapest qualifying single (collective band) — the thesis "≤ top-tier". */
  collectiveDiscountPct: number;
}

export const DEFAULT_CALIBRATOR_POLICY: CalibratorPolicy = {
  inputShare: 0.5,
  passthroughOutputThresholdPer1MUsd: 6,
  targetMarkupPct: 1.0,
  floorMarkupPct: 0.2,
  competitiveUndercutPct: 0.05,
  collectiveDiscountPct: 0.2,
};

/**
 * Passthrough rate for one axis: take up to `target` markup over the anchor, capped
 * at an undercut of the next-cheapest qualifying single (competitive), floored at
 * `floor` markup (margin protection). Integer USD per 1M, never below 1.
 */
function dynamicMarkupRate(
  anchorRate: number,
  nextQualifierRate: number | undefined,
  p: CalibratorPolicy,
): number {
  const desired = Math.ceil(anchorRate * (1 + p.targetMarkupPct));
  const floored = Math.ceil(anchorRate * (1 + p.floorMarkupPct));
  if (nextQualifierRate == null || !Number.isFinite(nextQualifierRate)) {
    return Math.max(1, desired); // no competitor → full target markup.
  }
  const competitiveCap = Math.ceil(nextQualifierRate * (1 - p.competitiveUndercutPct));
  return Math.max(1, Math.max(floored, Math.min(desired, competitiveCap)));
}

export interface CalibrationResult {
  rateCard: TierRateCard;
  anchors: Record<TierId, TierAnchor>;
  frontier: readonly BenchmarkPoint[];
  generatedFrom: { points: number; frontier: number };
}

function ceilPos(n: number): number {
  return Math.max(1, Math.ceil(n));
}

/**
 * Derive the calibrated rate card + per-tier anchors from benchmark points.
 * Deterministic and side-effect-free.
 */
export function deriveRateCard(
  points: readonly BenchmarkPoint[],
  policy: CalibratorPolicy = DEFAULT_CALIBRATOR_POLICY,
  tiers: Record<TierId, PricingTier> = TIERS,
): CalibrationResult {
  const blended = (p: BenchmarkPoint): number =>
    p.inputPer1MUsd * policy.inputShare + p.outputPer1MUsd * (1 - policy.inputShare);

  const frontier = computeParetoFrontier(points, {
    quality: (p) => p.quality,
    cost: blended,
    tieKey: (p) => p.modelId,
  });

  const anchors = {} as Record<TierId, TierAnchor>;
  const rateCard = {} as TierRateCard;

  for (const id of TIER_ORDER) {
    const tier = tiers[id];
    // frontier is ascending cost → the first point meeting the target is the cheapest qualifier.
    const qualifying = frontier.filter((p) => p.quality >= tier.qualityTarget);
    let anchor: BenchmarkPoint | undefined = qualifying[0];
    let aspirational = false;
    if (!anchor && frontier.length > 0) {
      anchor = [...frontier].sort((a, b) => b.quality - a.quality)[0];
      aspirational = true;
    }

    let band: PricingBand;
    let inRate: number;
    let outRate: number;
    let effectiveMargin: number;

    if (anchor && anchor.outputPer1MUsd <= policy.passthroughOutputThresholdPer1MUsd) {
      // Cheap-leader band: dynamic markup toward 100%, capped below the next qualifier.
      band = 'passthrough';
      const nextQualifier = qualifying[1]; // next-cheapest single ≥ target = competitive reference.
      inRate = dynamicMarkupRate(anchor.inputPer1MUsd, nextQualifier?.inputPer1MUsd, policy);
      outRate = dynamicMarkupRate(anchor.outputPer1MUsd, nextQualifier?.outputPer1MUsd, policy);
      // COGS = the provider (anchor) price; the realized margin is read from the integer rates.
      const blendedRate = inRate * policy.inputShare + outRate * (1 - policy.inputShare);
      const blendedAnchor =
        anchor.inputPer1MUsd * policy.inputShare + anchor.outputPer1MUsd * (1 - policy.inputShare);
      effectiveMargin = blendedRate > 0 ? Math.max(0, 1 - blendedAnchor / blendedRate) : 0;
    } else if (anchor) {
      // Frontier band: undercut the expensive single; the ensemble's COGS is far below it.
      band = 'collective';
      const d = 1 - policy.collectiveDiscountPct;
      inRate = ceilPos(anchor.inputPer1MUsd * d);
      outRate = ceilPos(anchor.outputPer1MUsd * d);
      effectiveMargin = tier.marginTarget;
    } else {
      // No benchmark data at all → keep the hand-set static rate for this tier.
      band = 'collective';
      inRate = tier.inputPer1MUsd;
      outRate = tier.outputPer1MUsd;
      effectiveMargin = tier.marginTarget;
    }

    const rate: TierRate = { inputPer1MUsd: inRate, outputPer1MUsd: outRate };
    rateCard[id] = rate;
    anchors[id] = {
      tier: id,
      anchorModelId: anchor?.modelId ?? '(static fallback)',
      anchorQuality: anchor?.quality ?? tier.qualityTarget,
      anchorInputPer1MUsd: anchor?.inputPer1MUsd ?? tier.inputPer1MUsd,
      anchorOutputPer1MUsd: anchor?.outputPer1MUsd ?? tier.outputPer1MUsd,
      band,
      inputPer1MUsd: inRate,
      outputPer1MUsd: outRate,
      effectiveMarginTarget: effectiveMargin,
      aspirational,
    };
  }

  return {
    rateCard,
    anchors,
    frontier,
    generatedFrom: { points: points.length, frontier: frontier.length },
  };
}

/**
 * COGS budget (the credit-governor spend cap) using the calibrated, band-aware
 * margin. Passthrough → cap ≈ the provider's own price (markup is the only margin);
 * collective → cap = revenue × (1 − fat margin), funding a real fan-out that still
 * lands below the frontier single's price.
 */
export function cogsBudgetForAnchor(
  anchor: TierAnchor,
  userPromptTokens: number,
  expectedCompletionTokens: number,
): number {
  const revenue =
    (userPromptTokens / 1_000_000) * anchor.inputPer1MUsd +
    (expectedCompletionTokens / 1_000_000) * anchor.outputPer1MUsd;
  return revenue * (1 - anchor.effectiveMarginTarget);
}
