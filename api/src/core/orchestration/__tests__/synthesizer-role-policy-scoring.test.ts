// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1G §17.1 — Hybrid synthesizer policy scoring tests.
 */
import { describe, it, expect } from 'vitest';
import {
  scoreSynthesizerCandidate,
  rankAndSelectSynthesizer,
  DEFAULT_HYBRID_SYNTHESIZER_POLICY,
  type SynthesizerCandidateMetrics,
} from '@/core/orchestration/role-selection/synthesizer-role-policy';

const baseMetrics = (overrides: Partial<SynthesizerCandidateMetrics> = {}): SynthesizerCandidateMetrics => ({
  modelId: 'model-x',
  providerId: 'p1',
  familyKey: 'family-x',
  quality: 0.85,
  reliability: 0.9,
  estimatedCostUsd: 0.01,
  providerCoverageCount: 5,
  liveReadyRouteCount: 1,
  aliasConfidence: 'high',
  daysSinceCatalogUpdate: 1,
  ...overrides,
});

describe('01C.1B-J1G §17.1 — synthesizer-role-policy scoring', () => {
  it('HARD-rejects candidate below qualityFloor', () => {
    const r = scoreSynthesizerCandidate(baseMetrics({ quality: 0.5 }));
    expect(r.qualityFloorPassed).toBe(false);
    expect(r.rejectionReason).toContain('quality_below_floor');
    expect(r.breakdown.finalScore).toBe(0);
  });

  it('admits candidate at qualityFloor exactly', () => {
    const r = scoreSynthesizerCandidate(baseMetrics({ quality: 0.6 }));
    expect(r.qualityFloorPassed).toBe(true);
  });

  it('claude-3.7-sonnet (high quality, 2 providers) LOSES to claude-opus-4 (lower quality, 19 providers)', () => {
    // J1G central evidence test
    const claude37 = baseMetrics({
      modelId: 'anthropic-claude-3.7-sonnet',
      familyKey: 'claude-3.7-sonnet',
      quality: 0.9,
      reliability: 0,  // no historical reliability data
      providerCoverageCount: 2,
      liveReadyRouteCount: 0,
      aliasConfidence: 'medium',
      daysSinceCatalogUpdate: 30,
    });
    const claudeOpus4 = baseMetrics({
      modelId: 'anthropic/claude-opus-4',
      familyKey: 'claude-opus-4',
      quality: 0.8,
      reliability: 0,
      providerCoverageCount: 19,
      liveReadyRouteCount: 3,
      aliasConfidence: 'high',
      daysSinceCatalogUpdate: 7,
    });
    const result = rankAndSelectSynthesizer([claude37, claudeOpus4]);
    expect(result.selected?.metrics.modelId).toBe('anthropic/claude-opus-4');
    expect(result.selected?.metrics.providerCoverageCount).toBe(19);
  });

  it('J1G-R2: multi-provider gets POSITIVE coverage bonus (not single-provider penalty)', () => {
    // 01C.1B-J1G-R2 — coverage penalties were REMOVED. The differentiation
    // between single-provider and multi-provider now comes ENTIRELY from
    // the positive multiProviderCoverageScore (log-normalized). Single-
    // provider is no longer hard-excluded — quality + cost can win.
    const single = scoreSynthesizerCandidate(baseMetrics({ providerCoverageCount: 1 }));
    const multi = scoreSynthesizerCandidate(baseMetrics({ providerCoverageCount: 10 }));
    // Penalty term is zero under J1G-R2 (rebalanced)
    expect(single.breakdown.singleProviderPenalty).toBe(0);
    expect(multi.breakdown.singleProviderPenalty).toBe(0);
    // Positive coverage score grows with provider count
    expect(multi.breakdown.multiProviderCoverageScore)
      .toBeGreaterThan(single.breakdown.multiProviderCoverageScore);
    // Multi-provider STILL wins overall (because positive coverage bonus is
    // significant), but the gap is now smaller than under R0 — a high-
    // quality single-provider model CAN realistically overcome it.
    expect(single.breakdown.finalScore).toBeLessThan(multi.breakdown.finalScore);
  });

  it('J1G-R2: single-provider with high quality + low cost CAN beat multi-provider with low quality', () => {
    // High-quality single-provider should now be competitive
    const specialized = scoreSynthesizerCandidate(baseMetrics({
      quality: 1.0,
      estimatedCostUsd: 0.001,
      providerCoverageCount: 1,
      liveReadyRouteCount: 1,
    }));
    const commodity = scoreSynthesizerCandidate(baseMetrics({
      quality: 0.65,  // just above floor
      estimatedCostUsd: 0.04,
      providerCoverageCount: 10,
      liveReadyRouteCount: 5,
    }));
    // Under J1G-R0 (penalties active), specialized would have LOST due to
    // -0.35 coverage penalties. Under J1G-R2, the quality + cost advantage
    // overcomes the smaller coverage gap.
    expect(specialized.breakdown.finalScore).toBeGreaterThan(commodity.breakdown.finalScore);
  });

  it('penalizes unresolved alias', () => {
    const unresolved = scoreSynthesizerCandidate(baseMetrics({ aliasConfidence: 'unresolved' }));
    const resolved = scoreSynthesizerCandidate(baseMetrics({ aliasConfidence: 'high' }));
    expect(unresolved.breakdown.unresolvedAliasPenalty).toBeLessThan(0);
    expect(unresolved.breakdown.finalScore).toBeLessThan(resolved.breakdown.finalScore);
  });

  it('penalizes stale catalog metadata', () => {
    const fresh = scoreSynthesizerCandidate(baseMetrics({ daysSinceCatalogUpdate: 1 }));
    const stale = scoreSynthesizerCandidate(baseMetrics({ daysSinceCatalogUpdate: 200 }));
    expect(stale.breakdown.stalenessPenalty).toBeLessThan(0);
    expect(stale.breakdown.freshnessScore).toBeLessThan(fresh.breakdown.freshnessScore);
  });

  it('penalizes credit/auth risk', () => {
    const risky = scoreSynthesizerCandidate(baseMetrics({ providerCreditRisk: true }));
    const safe = scoreSynthesizerCandidate(baseMetrics({}));
    expect(risky.breakdown.creditAuthRiskPenalty).toBeLessThan(0);
    expect(risky.breakdown.finalScore).toBeLessThan(safe.breakdown.finalScore);
  });

  it('rewards live-ready routes (concrete evidence beats discovery-only)', () => {
    const noLive = scoreSynthesizerCandidate(baseMetrics({ liveReadyRouteCount: 0 }));
    const livelyLive = scoreSynthesizerCandidate(baseMetrics({ liveReadyRouteCount: 5 }));
    expect(livelyLive.breakdown.liveReadyRouteScore).toBeGreaterThan(noLive.breakdown.liveReadyRouteScore);
  });

  it('penalizes unknown quality (quality === 0)', () => {
    // Quality 0 is HARD-rejected by floor, so this test uses a low-but-above-floor quality
    const known = scoreSynthesizerCandidate(baseMetrics({ quality: 0.7 }));
    const unknown = scoreSynthesizerCandidate(baseMetrics({ quality: 0 }));
    // Quality=0 is below 0.6 floor → rejected
    expect(unknown.qualityFloorPassed).toBe(false);
    expect(known.qualityFloorPassed).toBe(true);
  });

  it('coverage normalization uses log scale (diminishing returns)', () => {
    const r10 = scoreSynthesizerCandidate(baseMetrics({ providerCoverageCount: 10 }));
    const r20 = scoreSynthesizerCandidate(baseMetrics({ providerCoverageCount: 20 }));
    const r100 = scoreSynthesizerCandidate(baseMetrics({ providerCoverageCount: 100 }));
    // 20 and 100 should be close (both capped near 1.0 normalized)
    const delta_10_20 = r20.breakdown.multiProviderCoverageScore - r10.breakdown.multiProviderCoverageScore;
    const delta_20_100 = r100.breakdown.multiProviderCoverageScore - r20.breakdown.multiProviderCoverageScore;
    expect(delta_10_20).toBeGreaterThan(delta_20_100); // diminishing returns
  });

  it('selectionReason includes finalScore + key metrics for auditability', () => {
    const r = rankAndSelectSynthesizer([baseMetrics()]);
    expect(r.selected?.selectionReason).toContain('finalScore');
    expect(r.selected?.selectionReason).toContain('providers');
    expect(r.selected?.selectionReason).toContain('liveReady');
  });
});
