// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1G-R0 §10.3 — Role selection runtime trace inclusion.
 *
 * Proves that the SynthesizerSelectionSummary is correctly populated
 * from the runtime path (NOT just synthetic tests). Each field must
 * be derived from the actual scorer output — not zeroed, not stubbed.
 *
 * This test acts as the "trace integrity" guard: if a future refactor
 * accidentally produces an empty/zero summary because the data was
 * lost in a projection, this test fails immediately.
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '@/core/orchestration/model-selection/model-role-resolver';
import { DEFAULT_HYBRID_SYNTHESIZER_POLICY } from '@/core/orchestration/role-selection/synthesizer-role-policy';
import type { ModelCandidate } from '@/core/orchestration/model-selection/model-role-types';

function makeCandidate(opts: {
  id: string;
  providerId: string;
  quality?: number;
}): ModelCandidate {
  return {
    model: {
      id: opts.id,
      provider: opts.providerId,
      name: opts.id,
      displayName: opts.id,
      contextWindow: 128000,
      maxOutputTokens: 4096,
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.003,
      capabilities: ['chat', 'reasoning', 'instruction_following'] as never,
      status: 'active',
      performance: {
        latencyMs: 800, throughput: 100,
        quality: opts.quality ?? 0.8, reliability: 0.9,
      },
      metadata: {},
      providerName: opts.providerId,
      providerStatus: 'active',
    } as never,
    providerId: opts.providerId,
    estimatedCostPerCallUsd: 0.005,
    hasCredits: true,
    providerHealthy: true,
    rateLimited: false,
    isLocal: false,
    score: 0,
  };
}

describe('01C.1B-J1G-R0 §10.3 — role selection runtime trace inclusion', () => {
  it('summary.policyVersion matches DEFAULT_HYBRID_SYNTHESIZER_POLICY tag', async () => {
    const pool = [makeCandidate({ id: 'a', providerId: 'p1' })];
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus', role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {}, candidatePool: pool,
    });
    expect(result.synthesizerSelectionSummary!.policyVersion)
      .toBe('01C.1B-J1G-R2:DEFAULT_HYBRID_SYNTHESIZER_POLICY');
    expect(result.synthesizerSelectionSummary!.qualityFloor)
      .toBe(DEFAULT_HYBRID_SYNTHESIZER_POLICY.qualityFloor);
  });

  it('summary.poolSize / acceptedCount / rejectedCount match pool composition', async () => {
    // 3 above floor (0.8 > 0.6), 2 below floor (0.4 < 0.6) → 3 accepted, 2 rejected
    const pool = [
      makeCandidate({ id: 'good1', providerId: 'p1', quality: 0.8 }),
      makeCandidate({ id: 'good2', providerId: 'p2', quality: 0.85 }),
      makeCandidate({ id: 'good3', providerId: 'p3', quality: 0.9 }),
      makeCandidate({ id: 'bad1', providerId: 'p4', quality: 0.4 }),
      makeCandidate({ id: 'bad2', providerId: 'p5', quality: 0.3 }),
    ];
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus', role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {}, candidatePool: pool,
    });
    const s = result.synthesizerSelectionSummary!;
    expect(s.poolSize).toBe(5);
    expect(s.acceptedCount).toBe(3);
    expect(s.rejectedCount).toBe(2);
  });

  it('summary.rejectionsByReason histogram populated for sub-floor candidates', async () => {
    const pool = [
      makeCandidate({ id: 'good', providerId: 'p1', quality: 0.8 }),
      makeCandidate({ id: 'bad1', providerId: 'p2', quality: 0.3 }),
      makeCandidate({ id: 'bad2', providerId: 'p3', quality: 0.4 }),
    ];
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus', role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {}, candidatePool: pool,
    });
    const reasons = result.synthesizerSelectionSummary!.rejectionsByReason;
    expect(reasons.quality_below_floor).toBe(2);
  });

  it('summary.topAlternatives excludes the winner + ordered by finalScore desc', async () => {
    const pool = [
      makeCandidate({ id: 'best', providerId: 'p1', quality: 0.95 }),
      makeCandidate({ id: 'second', providerId: 'p2', quality: 0.85 }),
      makeCandidate({ id: 'third', providerId: 'p3', quality: 0.80 }),
      makeCandidate({ id: 'fourth', providerId: 'p4', quality: 0.75 }),
    ];
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus', role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {}, candidatePool: pool,
    });
    const s = result.synthesizerSelectionSummary!;
    // Winner should NOT appear in topAlternatives
    expect(s.topAlternatives.find((alt) => alt.modelId === s.winner!.modelId)).toBeUndefined();
    // Alternatives ordered by finalScore desc
    for (let i = 1; i < s.topAlternatives.length; i++) {
      expect(s.topAlternatives[i - 1].finalScore).toBeGreaterThanOrEqual(s.topAlternatives[i].finalScore);
    }
  });

  it('summary.winnerComponentBreakdown exposes all 14 components (8 weights + 6 penalties)', async () => {
    const pool = [makeCandidate({ id: 'a', providerId: 'p1' })];
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus', role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {}, candidatePool: pool,
    });
    const breakdown = result.synthesizerSelectionSummary!.winnerComponentBreakdown!;
    expect(Object.keys(breakdown).length).toBe(14);
    expect(breakdown).toHaveProperty('qualityScore');
    expect(breakdown).toHaveProperty('reliabilityScore');
    expect(breakdown).toHaveProperty('costScore');
    expect(breakdown).toHaveProperty('freshnessScore');
    expect(breakdown).toHaveProperty('multiProviderCoverageScore');
    expect(breakdown).toHaveProperty('liveReadyRouteScore');
    expect(breakdown).toHaveProperty('aliasConfidenceScore');
    expect(breakdown).toHaveProperty('preferredCapabilityMatchScore');
    expect(breakdown).toHaveProperty('singleProviderPenalty');
    expect(breakdown).toHaveProperty('lowCoveragePenalty');
    expect(breakdown).toHaveProperty('stalenessPenalty');
    expect(breakdown).toHaveProperty('unresolvedAliasPenalty');
    expect(breakdown).toHaveProperty('creditAuthRiskPenalty');
    expect(breakdown).toHaveProperty('unknownQualityPenalty');
  });

  it('summary.winner.providerCoverageCount equals distinct provider count of family in pool', async () => {
    // 5 candidates sharing same logical id `claude-opus-4` across 5 providers
    // → providerCoverageCount should be 5
    const pool = [
      makeCandidate({ id: 'claude-opus-4', providerId: 'p1' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'p2' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'p3' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'p4' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'p5' }),
    ];
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus', role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {}, candidatePool: pool,
    });
    expect(result.synthesizerSelectionSummary!.winner!.providerCoverageCount).toBe(5);
  });
});
