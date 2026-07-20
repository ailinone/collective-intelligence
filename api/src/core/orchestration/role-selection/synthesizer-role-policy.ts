// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1G §12 — Hybrid synthesizer role policy.
 *
 * Replaces the legacy single-dimension scoring (`quality * 1.2 +
 * reliability * 0.7 + cost * 0.1 + prefMatches * 0.07`) with a
 * multi-dimensional policy that includes:
 *   - quality floor (HARD gate, not soft term)
 *   - freshness (recency of catalog row)
 *   - multi-provider coverage (operational diversity)
 *   - live-ready route evidence (real probe evidence)
 *   - alias confidence (J1F evidence quality)
 *   - cost efficiency (per-call cost)
 *   - reliability (historical)
 *   - penalties (single-provider, stale-metadata, unresolved-alias,
 *     credit/auth risk, unknown-quality)
 *
 * EVIDENCE-DRIVEN: the J1G diagnose showed claude-3.7-sonnet wins
 * the current scorer by quality 0.9 vs claude-opus-4's 0.8 (a 0.12
 * advantage), while having only 2 providers vs claude-opus-4's 19.
 * The hybrid policy makes the 17-provider coverage gap dominate the
 * 0.1 quality advantage when the quality advantage is likely from
 * stale metadata.
 */

export type SynthesizerCandidateMetrics = {
  readonly modelId: string;
  readonly providerId: string;
  readonly familyKey: string;
  /** From model.performance.quality, 0-1. */
  readonly quality: number;
  /** From model.performance.reliability, 0-1. */
  readonly reliability: number;
  /** Estimated cost per call in USD. */
  readonly estimatedCostUsd: number;
  /** Number of providers/routers serving this logical model family. */
  readonly providerCoverageCount: number;
  /** Number of routes audited as liveReady=true for this model. */
  readonly liveReadyRouteCount: number;
  /** Discovery alias snapshot confidence ('exact'/'high'/'medium'/'low'/'unresolved'). */
  readonly aliasConfidence: 'exact' | 'high' | 'medium' | 'low' | 'unresolved';
  /**
   * Days since the catalog row was last updated. We use `updated_at`
   * since `last_synced_at` is currently NULL in this catalog (J1G
   * §G0.3 audit).
   */
  readonly daysSinceCatalogUpdate?: number;
  /** Whether ANY provider for this model is known credit-blocked. */
  readonly providerCreditRisk?: boolean;
  /** Whether ANY provider for this model is known auth-blocked. */
  readonly providerAuthRisk?: boolean;
  /** Maximum context window across providers. */
  readonly contextWindow?: number;
  /**
   * 01C.1B-J1G-R0 — count of preferred-capabilities matched (e.g.,
   * `reasoning`, `instruction_following`, `long_context` for synthesizer).
   * Resolver derives this from `policy.preferredCapabilities ∩ model.capabilities`.
   * Provides a small differentiator when other dimensions tie — preserves
   * the pre-J1G preference for capability-rich models. Defaults to 0.
   */
  readonly preferredCapabilityMatchCount?: number;
};

export type SynthesizerScoreBreakdown = {
  readonly qualityScore: number;
  readonly reliabilityScore: number;
  readonly costScore: number;
  readonly freshnessScore: number;
  readonly multiProviderCoverageScore: number;
  readonly liveReadyRouteScore: number;
  readonly aliasConfidenceScore: number;
  readonly preferredCapabilityMatchScore: number;
  readonly singleProviderPenalty: number;
  readonly stalenessPenalty: number;
  readonly unresolvedAliasPenalty: number;
  readonly creditAuthRiskPenalty: number;
  readonly lowCoveragePenalty: number;
  readonly unknownQualityPenalty: number;
  readonly finalScore: number;
};

export type SynthesizerScoredCandidate = {
  readonly metrics: SynthesizerCandidateMetrics;
  readonly breakdown: SynthesizerScoreBreakdown;
  readonly qualityFloorPassed: boolean;
  readonly selected: boolean;
  readonly selectionReason?: string;
  readonly rejectionReason?: string;
};

export interface SynthesizerRolePolicyWeights {
  readonly qualityFloor: number;        // HARD gate; below this → rejected
  readonly weights: {
    readonly quality: number;
    readonly reliability: number;
    readonly cost: number;
    readonly freshness: number;
    readonly multiProviderCoverage: number;
    readonly liveReadyRoute: number;
    readonly aliasConfidence: number;
    /**
     * 01C.1B-J1G-R0 — per-match weight for preferred capabilities. Small
     * (~0.03 per match) so it's a tie-breaker, not a primary signal.
     * 3 matches × 0.03 = 0.09 max contribution.
     */
    readonly preferredCapabilityMatch: number;
  };
  readonly penalties: {
    readonly singleProviderThreshold: number; // providers ≤ this → singleProviderPenalty
    readonly singleProviderPenalty: number;   // negative
    readonly stalenessThresholdDays: number;
    readonly stalenessPenalty: number;
    readonly unresolvedAliasPenalty: number;
    readonly creditAuthRiskPenalty: number;
    readonly lowCoverageThreshold: number;    // providers ≤ this → lowCoveragePenalty
    readonly lowCoveragePenalty: number;
    readonly unknownQualityPenalty: number;   // when quality === 0 (no metadata)
  };
  /** Coverage scaling: log-normalized to this max provider count. */
  readonly coverageMaxProviders: number;
}

/**
 * Default hybrid policy — J1G-R2 Cost-Benefit Rebalance.
 *
 * ─── Philosophy change vs J1G-R0 ──────────────────────────────────
 * J1G-R0 PENALIZED low-coverage models (singleProviderPenalty=-0.20,
 * lowCoveragePenalty=-0.15, total -0.35). This effectively HARD-EXCLUDED
 * single-provider models from consideration — even when a single-provider
 * model had genuinely superior quality + cost for the ensemble role.
 *
 * J1G-R2 follows the user's cost-benefit premise: "to deliver results
 * SUPERIOR to tier-1 single models via collective strategies, we must
 * consider models with fewer providers — possibly single-provider — when
 * quality × cost justifies it. Multi-provider should be a POSITIVE WEIGHT
 * that grows with provider count, NOT a penalty against single-provider."
 *
 * ─── What changed numerically ─────────────────────────────────────
 *   quality:               0.30 → 0.40  (user: "qualidade ... peso alto")
 *   cost:                  0.05 → 0.15  (user: "menor o custo, maior o peso")
 *   freshness:             0.15 → 0.10  (slight de-emphasis)
 *   liveReadyRoute:        0.15 → 0.10  (slight de-emphasis)
 *   aliasConfidence:       0.10 → 0.05  (alias resolution is now mostly
 *                                        solved post-J1E/J1F)
 *   multiProviderCoverage: 0.20 (UNCHANGED — still the primary positive
 *                                coverage signal, log-normalized to 20)
 *   preferredCapMatch:     0.03/match (UNCHANGED)
 *   singleProviderPenalty: -0.20 →  0   (REMOVED — was the hard exclusion)
 *   lowCoveragePenalty:    -0.15 →  0   (REMOVED — was the hard exclusion)
 *
 * ─── What stayed ──────────────────────────────────────────────────
 *   qualityFloor: 0.6 HARD gate           — unmodeled-quality is unsafe
 *   stalenessPenalty: -0.10               — stale = real quality signal
 *   unresolvedAliasPenalty: -0.15         — broken route is unusable
 *   creditAuthRiskPenalty: -0.10          — risk signal stays
 *   unknownQualityPenalty: -0.20          — quality=0 means no signal
 *
 * ─── Trade-off validation ─────────────────────────────────────────
 * Under J1G-R2, the legacy "claude-opus-4 (10p, q=0.8) > claude-3.7-sonnet
 * (1p, q=0.9)" still holds because the +0.157 coverage advantage
 * (log(11)/log(21) * 0.20) outweighs the -0.04 quality delta. But a
 * specialized single-provider model at q=1.0 vs commodity at q=0.7 CAN
 * win under R2 — exactly the cost-benefit calculus J1G-R2 was designed
 * to enable.
 */
export const DEFAULT_HYBRID_SYNTHESIZER_POLICY: SynthesizerRolePolicyWeights = {
  qualityFloor: 0.6,  // anything below 0.6 quality → rejected outright
  weights: {
    quality: 0.40,
    reliability: 0.05,
    cost: 0.15,
    freshness: 0.10,
    multiProviderCoverage: 0.20,
    liveReadyRoute: 0.10,
    aliasConfidence: 0.05,
    /**
     * Per-match weight. 3 preferred caps × 0.03 = 0.09 max boost — small
     * enough to be a tie-breaker, not a primary signal. Preserves the
     * legacy preference for `reasoning` + `instruction_following`
     * + `long_context` on synthesizer role.
     */
    preferredCapabilityMatch: 0.03,
  },
  penalties: {
    // 01C.1B-J1G-R2 — coverage penalties REMOVED. Multi-provider remains
    // a positive weight (multiProviderCoverage above) but single-provider
    // is no longer structurally excluded.
    singleProviderThreshold: 2,
    singleProviderPenalty: 0,
    stalenessThresholdDays: 90,
    stalenessPenalty: -0.10,
    unresolvedAliasPenalty: -0.15,
    creditAuthRiskPenalty: -0.10,
    lowCoverageThreshold: 5,
    lowCoveragePenalty: 0,
    unknownQualityPenalty: -0.20,
  },
  coverageMaxProviders: 20,
};

/**
 * Score a candidate against the hybrid policy. Returns null when the
 * quality floor is not met (HARD reject — not a soft term).
 */
export function scoreSynthesizerCandidate(
  metrics: SynthesizerCandidateMetrics,
  policy: SynthesizerRolePolicyWeights = DEFAULT_HYBRID_SYNTHESIZER_POLICY,
): SynthesizerScoredCandidate {
  const w = policy.weights;
  const p = policy.penalties;

  // HARD gate: quality floor
  const qualityFloorPassed = metrics.quality >= policy.qualityFloor;
  if (!qualityFloorPassed) {
    return {
      metrics,
      breakdown: zeroBreakdown(),
      qualityFloorPassed: false,
      selected: false,
      rejectionReason: `quality_below_floor (${metrics.quality} < ${policy.qualityFloor})`,
    };
  }

  // Component scores
  const qualityScore = metrics.quality * w.quality;
  const reliabilityScore = metrics.reliability * w.reliability;
  // Cost score: 1 - normalized(cost) — cheaper is better
  const costScore = Math.max(0, 1 - metrics.estimatedCostUsd / 0.05) * w.cost;
  // Freshness: 1.0 if updated within 7d, 0 if > 365d
  const freshnessScore = freshnessNormalizedScore(metrics.daysSinceCatalogUpdate) * w.freshness;
  // Coverage: log-normalized to coverageMaxProviders
  const coverageNormalized = Math.min(
    1,
    Math.log(metrics.providerCoverageCount + 1) / Math.log(policy.coverageMaxProviders + 1),
  );
  const multiProviderCoverageScore = coverageNormalized * w.multiProviderCoverage;
  // Live-ready: log-normalized count
  const liveReadyNormalized = Math.min(1, Math.log(metrics.liveReadyRouteCount + 1) / Math.log(10));
  const liveReadyRouteScore = liveReadyNormalized * w.liveReadyRoute;
  // Alias confidence
  const aliasConfidenceScore = aliasConfidenceNormalized(metrics.aliasConfidence) * w.aliasConfidence;
  // 01C.1B-J1G-R0 — preferred capability match boost (small tie-breaker)
  const preferredCapabilityMatchScore =
    (metrics.preferredCapabilityMatchCount ?? 0) * w.preferredCapabilityMatch;

  // Penalties
  const singleProviderPenalty =
    metrics.providerCoverageCount <= p.singleProviderThreshold ? p.singleProviderPenalty : 0;
  const stalenessPenalty =
    metrics.daysSinceCatalogUpdate !== undefined && metrics.daysSinceCatalogUpdate > p.stalenessThresholdDays
      ? p.stalenessPenalty
      : 0;
  const unresolvedAliasPenalty =
    metrics.aliasConfidence === 'unresolved' ? p.unresolvedAliasPenalty : 0;
  const creditAuthRiskPenalty =
    (metrics.providerCreditRisk || metrics.providerAuthRisk) ? p.creditAuthRiskPenalty : 0;
  const lowCoveragePenalty =
    metrics.providerCoverageCount <= p.lowCoverageThreshold ? p.lowCoveragePenalty : 0;
  const unknownQualityPenalty = metrics.quality === 0 ? p.unknownQualityPenalty : 0;

  const finalScore =
    qualityScore + reliabilityScore + costScore + freshnessScore +
    multiProviderCoverageScore + liveReadyRouteScore + aliasConfidenceScore +
    preferredCapabilityMatchScore +
    singleProviderPenalty + stalenessPenalty + unresolvedAliasPenalty +
    creditAuthRiskPenalty + lowCoveragePenalty + unknownQualityPenalty;

  return {
    metrics,
    breakdown: {
      qualityScore, reliabilityScore, costScore, freshnessScore,
      multiProviderCoverageScore, liveReadyRouteScore, aliasConfidenceScore,
      preferredCapabilityMatchScore,
      singleProviderPenalty, stalenessPenalty, unresolvedAliasPenalty,
      creditAuthRiskPenalty, lowCoveragePenalty, unknownQualityPenalty,
      finalScore,
    },
    qualityFloorPassed: true,
    selected: false, // caller sets after ranking
  };
}

function freshnessNormalizedScore(days?: number): number {
  if (days === undefined) return 0.5; // unknown → neutral
  if (days <= 7) return 1.0;
  if (days <= 30) return 0.8;
  if (days <= 90) return 0.5;
  if (days <= 365) return 0.2;
  return 0;
}

function aliasConfidenceNormalized(c: SynthesizerCandidateMetrics['aliasConfidence']): number {
  switch (c) {
    case 'exact': return 1.0;
    case 'high': return 0.85;
    case 'medium': return 0.6;
    case 'low': return 0.3;
    case 'unresolved': return 0;
  }
}

function zeroBreakdown(): SynthesizerScoreBreakdown {
  return {
    qualityScore: 0, reliabilityScore: 0, costScore: 0, freshnessScore: 0,
    multiProviderCoverageScore: 0, liveReadyRouteScore: 0, aliasConfidenceScore: 0,
    preferredCapabilityMatchScore: 0,
    singleProviderPenalty: 0, stalenessPenalty: 0, unresolvedAliasPenalty: 0,
    creditAuthRiskPenalty: 0, lowCoveragePenalty: 0, unknownQualityPenalty: 0,
    finalScore: 0,
  };
}

/**
 * Rank a candidate pool and select the top synthesizer. Returns the
 * full scored list (including quality-floor rejections) for explainability.
 */
export function rankAndSelectSynthesizer(
  candidates: readonly SynthesizerCandidateMetrics[],
  policy: SynthesizerRolePolicyWeights = DEFAULT_HYBRID_SYNTHESIZER_POLICY,
): {
  readonly selected: SynthesizerScoredCandidate | undefined;
  readonly ranked: readonly SynthesizerScoredCandidate[];
  readonly rejected: readonly SynthesizerScoredCandidate[];
} {
  const scored = candidates.map((c) => scoreSynthesizerCandidate(c, policy));
  const passed = scored.filter((s) => s.qualityFloorPassed);
  const rejected = scored.filter((s) => !s.qualityFloorPassed);
  passed.sort((a, b) => b.breakdown.finalScore - a.breakdown.finalScore);
  const winner = passed[0];
  if (winner) {
    const w: SynthesizerScoredCandidate = {
      ...winner,
      selected: true,
      selectionReason: `top finalScore=${winner.breakdown.finalScore.toFixed(4)} (quality=${winner.metrics.quality}, providers=${winner.metrics.providerCoverageCount}, liveReady=${winner.metrics.liveReadyRouteCount})`,
    };
    return {
      selected: w,
      ranked: [w, ...passed.slice(1)],
      rejected,
    };
  }
  return { selected: undefined, ranked: passed, rejected };
}

/**
 * 01C.1B-J1G §14 — Collective cost-benefit estimate.
 *
 * Compares the sum of selected role costs against a baseline single
 * model. If collective > baseline AND no expected-quality-gain
 * justifies it, returns a warning. Strict mode can reject.
 */
export interface CollectiveCostBenefitInput {
  readonly synthesizerCost: number;
  readonly participantCosts: readonly number[];
  readonly judgeCost: number;
  readonly fallbackCost?: number;
  readonly baselineSingleModelId: string;
  readonly baselineSingleModelCostUsd: number;
  readonly expectedQualityGainScore?: number;
}

export interface CollectiveCostBenefitEstimate {
  readonly strategy: 'consensus';
  readonly estimatedCollectiveCostUsd: number;
  readonly baselineSingleModelId: string;
  readonly baselineSingleModelCostUsd: number;
  readonly costRatioVsBaseline: number;
  readonly expectedQualityGainScore?: number;
  readonly pass: boolean;
  readonly reason: string;
}

export function estimateCollectiveCostBenefit(
  input: CollectiveCostBenefitInput,
): CollectiveCostBenefitEstimate {
  const sum =
    input.synthesizerCost +
    input.participantCosts.reduce((a, c) => a + c, 0) +
    input.judgeCost +
    (input.fallbackCost ?? 0);
  const ratio = input.baselineSingleModelCostUsd > 0 ? sum / input.baselineSingleModelCostUsd : Infinity;
  const gain = input.expectedQualityGainScore ?? 1.0; // 1.0 = no advantage
  const pass = ratio <= 1.0 || gain >= 1.2;
  return {
    strategy: 'consensus',
    estimatedCollectiveCostUsd: sum,
    baselineSingleModelId: input.baselineSingleModelId,
    baselineSingleModelCostUsd: input.baselineSingleModelCostUsd,
    costRatioVsBaseline: ratio,
    expectedQualityGainScore: input.expectedQualityGainScore,
    pass,
    reason: pass
      ? ratio <= 1.0
        ? 'collective_cost_within_baseline'
        : 'collective_cost_above_baseline_but_quality_gain_justifies'
      : 'collective_cost_exceeds_baseline_without_quality_premium',
  };
}
