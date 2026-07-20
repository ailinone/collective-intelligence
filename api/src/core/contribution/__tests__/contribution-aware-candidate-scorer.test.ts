// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * contribution-aware-candidate-scorer.test.ts — MVP 8A
 *
 * Tests the candidate scorer:
 *   - modality mismatch ⇒ rejected
 *   - historical harm ⇒ rejected
 *   - cheap-but-good gets a reasonable score
 *   - insufficient_data candidates rejected unless allowExploration
 *   - hard cost ceiling triggers rejection
 *   - explanation surfaces accepted/rejected outcomes
 */

import { describe, expect, it } from 'vitest';
import {
  scoreContributionAwareCandidate,
  DEFAULT_CONTRIBUTION_AWARE_POLICY,
  type ContributionAwareCandidate,
} from '../contribution-aware-candidate-scorer';
import type { ModelTaskPerformanceProfile } from '../model-task-performance-profile';

function profile(
  overrides: Partial<ModelTaskPerformanceProfile> & { modelId: string },
): ModelTaskPerformanceProfile {
  return Object.freeze({
    modelId: overrides.modelId,
    taskType: 'code-generation',
    sampleCount: 10,
    judgeMean: 0.7,
    judgeMedian: 0.7,
    judgeP80: 0.8,
    winRate: 0.5,
    lossRate: 0.1,
    zeroRate: 0,
    harmRate: 0.1,
    costMean: 0.02,
    costP95: 0.025,
    qualityPerDollar: 35,
    contributionScore: 0.6,
    harmScore: 0.1,
    confidence: 0.85,
    recommendedRole: 'anchor',
    ...overrides,
  });
}

function candidate(
  overrides: Partial<ContributionAwareCandidate> & { modelId: string; routeId: string },
): ContributionAwareCandidate {
  return {
    routeId: overrides.routeId,
    modelId: overrides.modelId,
    taskType: 'code-generation',
    taskModality: 'text',
    capabilities: ['chat'],
    modality: 'text',
    routeKind: 'native',
    estimatedCostUsd: 0.02,
    structuralScore: 0.7,
    ...overrides,
  };
}

describe('scoreContributionAwareCandidate', () => {
  it('accepts a healthy anchor candidate', () => {
    const c = candidate({
      modelId: 'm-anchor',
      routeId: 'r-anchor',
      historicalProfile: profile({ modelId: 'm-anchor' }),
    });
    const s = scoreContributionAwareCandidate(c);
    expect(s.rejected).toBe(false);
    expect(s.recommendedRole).toBe('anchor');
    expect(s.totalScore).toBeGreaterThan(0.4);
    expect(s.explanation).toContain('accepted');
  });

  it('rejects modality mismatch under strict policy', () => {
    const c = candidate({
      modelId: 'm-audio',
      routeId: 'r-audio',
      modality: 'audio',
      taskModality: 'text',
      historicalProfile: profile({ modelId: 'm-audio' }),
    });
    const s = scoreContributionAwareCandidate(c);
    expect(s.rejected).toBe(true);
    expect(s.rejectionReasons).toContain('modality_mismatch');
    expect(s.totalScore).toBe(0);
    expect(s.explanation).toContain('rejected');
  });

  it('rejects insufficient_data candidates by default', () => {
    const c = candidate({
      modelId: 'm-new',
      routeId: 'r-new',
      historicalProfile: profile({
        modelId: 'm-new',
        sampleCount: 1,
        recommendedRole: 'insufficient_data',
        contributionScore: 0.3,
        confidence: 0.1,
      }),
    });
    const s = scoreContributionAwareCandidate(c);
    expect(s.rejected).toBe(true);
    expect(s.rejectionReasons).toContain('insufficient_data');
  });

  it('allows insufficient_data when allowExploration=true', () => {
    const c = candidate({
      modelId: 'm-new',
      routeId: 'r-new',
      historicalProfile: profile({
        modelId: 'm-new',
        sampleCount: 1,
        recommendedRole: 'insufficient_data',
        contributionScore: 0.3,
        confidence: 0.1,
      }),
    });
    const s = scoreContributionAwareCandidate(c, {
      ...DEFAULT_CONTRIBUTION_AWARE_POLICY,
      allowExploration: true,
    });
    expect(s.rejected).toBe(false);
  });

  it('rejects harm-rate-above-policy', () => {
    const c = candidate({
      modelId: 'm-bad',
      routeId: 'r-bad',
      historicalProfile: profile({
        modelId: 'm-bad',
        harmRate: 0.6,
        harmScore: 0.6,
        recommendedRole: 'avoid',
      }),
    });
    const s = scoreContributionAwareCandidate(c);
    expect(s.rejected).toBe(true);
    expect(s.rejectionReasons.length).toBeGreaterThan(0);
  });

  it('rejects cost above hard ceiling', () => {
    const c = candidate({
      modelId: 'm-pricey',
      routeId: 'r-pricey',
      estimatedCostUsd: 0.8,
      historicalProfile: profile({ modelId: 'm-pricey' }),
    });
    const s = scoreContributionAwareCandidate(c);
    expect(s.rejected).toBe(true);
    expect(s.rejectionReasons).toContain('cost_above_hard_ceiling');
  });

  it('cheap-but-good earns a positive total score', () => {
    const c = candidate({
      modelId: 'm-budget',
      routeId: 'r-budget',
      estimatedCostUsd: 0.001,
      historicalProfile: profile({
        modelId: 'm-budget',
        judgeMean: 0.55,
        qualityPerDollar: 800,
        recommendedRole: 'budget_support',
      }),
    });
    const s = scoreContributionAwareCandidate(c);
    expect(s.rejected).toBe(false);
    expect(s.recommendedRole).toBe('budget_support');
    expect(s.totalScore).toBeGreaterThan(0.3);
  });

  it('rejects candidate missing required capability', () => {
    const c = candidate({
      modelId: 'm-x',
      routeId: 'r-x',
      capabilities: ['chat'],
      requiredCapabilities: ['vision'],
      historicalProfile: profile({ modelId: 'm-x' }),
    });
    const s = scoreContributionAwareCandidate(c);
    expect(s.rejected).toBe(true);
    expect(s.rejectionReasons).toContain('capability_mismatch');
  });

  it('breakdown carries every signal', () => {
    const c = candidate({
      modelId: 'm-x',
      routeId: 'r-x',
      historicalProfile: profile({ modelId: 'm-x' }),
    });
    const s = scoreContributionAwareCandidate(c);
    expect(s.breakdown.structuralScore).toBe(0.7);
    expect(s.breakdown.contributionScore).toBeGreaterThan(0);
    expect(s.breakdown.modalityFit).toBe(1);
    expect(s.breakdown.taskTypeFit).toBe(1);
    expect(s.breakdown.harmPenalty).toBeLessThan(0);
    expect(s.breakdown.costPenalty).toBeLessThan(0);
  });

  it('output is frozen', () => {
    const c = candidate({
      modelId: 'm-x',
      routeId: 'r-x',
      historicalProfile: profile({ modelId: 'm-x' }),
    });
    const s = scoreContributionAwareCandidate(c);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.breakdown)).toBe(true);
  });
});
