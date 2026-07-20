// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * candidate-fixtures.ts — MVP 8A
 *
 * Test-only candidate factories. Encodes the candidate shapes used by
 * the historical fixture: anchor, pair-winner, multi-mini, modality-bad,
 * cheap-good, cheap-harmful, expensive-not-pareto, etc.
 *
 * Production code never sees these names — they're opaque ids.
 */

import {
  scoreContributionAwareCandidate,
  type ContributionAwareCandidate,
  type ContributionAwareScore,
} from '../../../contribution/contribution-aware-candidate-scorer';
import type { ModelTaskPerformanceProfile } from '../../../contribution/model-task-performance-profile';

function profile(
  modelId: string,
  overrides: Partial<ModelTaskPerformanceProfile> = {},
): ModelTaskPerformanceProfile {
  return Object.freeze({
    modelId,
    taskType: 'code-generation',
    sampleCount: 8,
    judgeMean: 0.7,
    judgeMedian: 0.7,
    judgeP80: 0.8,
    judgeStdDev: 0.1,
    judgeVariance: 0.01,
    winRate: 0.55,
    lossRate: 0.1,
    zeroRate: 0,
    harmRate: 0.05,
    costMean: 0.02,
    costP95: 0.025,
    qualityPerDollar: 35,
    contributionScore: 0.62,
    harmScore: 0.05,
    confidence: 0.9,
    calibrationConfidence: 0.85,
    sampleWeight: 0.62,
    recommendedRole: 'anchor',
    ...overrides,
  });
}

function candidate(
  routeId: string,
  modelId: string,
  cost: number,
  modality: 'text' | 'image' | 'audio' = 'text',
  hist?: ModelTaskPerformanceProfile,
): ContributionAwareCandidate {
  return {
    routeId,
    modelId,
    taskType: 'code-generation',
    taskModality: 'text',
    capabilities: ['chat'],
    modality,
    routeKind: 'native',
    estimatedCostUsd: cost,
    structuralScore: 0.7,
    historicalProfile: hist,
  };
}

// ─── Score-level builders ───────────────────────────────────────────────

export function scoreAnchorA(): ContributionAwareScore {
  return scoreContributionAwareCandidate(
    candidate(
      'r-anchor-a',
      'fx-anchor-a',
      0.022,
      'text',
      profile('fx-anchor-a', {
        judgeMean: 0.68,
        winRate: 0.5,
        contributionScore: 0.62,
        harmRate: 0.08,
        confidence: 0.9,
        recommendedRole: 'anchor',
      }),
    ),
  );
}

export function scoreAnchorB(): ContributionAwareScore {
  return scoreContributionAwareCandidate(
    candidate(
      'r-anchor-b',
      'fx-anchor-b',
      0.025,
      'text',
      profile('fx-anchor-b', {
        judgeMean: 0.65,
        winRate: 0.45,
        contributionScore: 0.6,
        harmRate: 0.1,
        confidence: 0.85,
        recommendedRole: 'anchor',
      }),
    ),
  );
}

export function scorePairX(): ContributionAwareScore {
  return scoreContributionAwareCandidate(
    candidate(
      'r-pair-x',
      'fx-pair-x',
      0.0014,
      'text',
      profile('fx-pair-x', {
        judgeMean: 0.78,
        winRate: 0.7,
        contributionScore: 0.7,
        harmRate: 0.05,
        confidence: 0.9,
        qualityPerDollar: 600,
        recommendedRole: 'anchor',
        costMean: 0.0014,
      }),
    ),
  );
}

export function scorePairY(): ContributionAwareScore {
  return scoreContributionAwareCandidate(
    candidate(
      'r-pair-y',
      'fx-pair-y',
      0.0014,
      'text',
      profile('fx-pair-y', {
        judgeMean: 0.75,
        winRate: 0.65,
        contributionScore: 0.68,
        harmRate: 0.05,
        confidence: 0.9,
        qualityPerDollar: 600,
        recommendedRole: 'anchor',
        costMean: 0.0014,
      }),
    ),
  );
}

export function scoreCheapGood(): ContributionAwareScore {
  return scoreContributionAwareCandidate(
    candidate(
      'r-cheap-good',
      'fx-cheap-good',
      0.0015,
      'text',
      profile('fx-cheap-good', {
        judgeMean: 0.55,
        winRate: 0.4,
        contributionScore: 0.5,
        harmRate: 0.1,
        confidence: 0.85,
        qualityPerDollar: 500,
        recommendedRole: 'budget_support',
        costMean: 0.0015,
      }),
    ),
  );
}

export function scoreCheapHarmful(): ContributionAwareScore {
  return scoreContributionAwareCandidate(
    candidate(
      'r-cheap-harm',
      'fx-cheap-harmful',
      0.0012,
      'text',
      profile('fx-cheap-harmful', {
        judgeMean: 0.08,
        winRate: 0.02,
        contributionScore: 0.1,
        harmRate: 0.7,
        harmScore: 0.6,
        zeroRate: 0.6,
        confidence: 0.8,
        qualityPerDollar: 50,
        recommendedRole: 'avoid',
        costMean: 0.0012,
      }),
    ),
  );
}

export function scoreMini(suffix: string): ContributionAwareScore {
  return scoreContributionAwareCandidate(
    candidate(
      `r-mini-${suffix}`,
      `fx-mini-${suffix}`,
      0.0008,
      'text',
      profile(`fx-mini-${suffix}`, {
        judgeMean: 0.05,
        winRate: 0,
        contributionScore: 0.05,
        harmRate: 0.8,
        harmScore: 0.7,
        zeroRate: 0.85,
        confidence: 0.85,
        recommendedRole: 'avoid',
        costMean: 0.0008,
      }),
    ),
  );
}

export function scoreModalityMismatchAudio(): ContributionAwareScore {
  return scoreContributionAwareCandidate(
    candidate(
      'r-audio-tts',
      'fx-audio-tts',
      0.001,
      'audio',
      profile('fx-audio-tts', {
        judgeMean: 0,
        harmRate: 1,
        harmScore: 0.9,
        recommendedRole: 'avoid',
      }),
    ),
  );
}

export function scoreModalityMismatchImage(): ContributionAwareScore {
  return scoreContributionAwareCandidate(
    candidate(
      'r-image-gen',
      'fx-image-gen',
      0.003,
      'image',
      profile('fx-image-gen', {
        judgeMean: 0,
        harmRate: 1,
        harmScore: 0.9,
        recommendedRole: 'avoid',
      }),
    ),
  );
}

export function scoreExpensiveNotPareto(): ContributionAwareScore {
  return scoreContributionAwareCandidate(
    candidate(
      'r-expensive-ok',
      'fx-expensive-ok',
      0.18,
      'text',
      profile('fx-expensive-ok', {
        judgeMean: 0.65,
        winRate: 0.45,
        contributionScore: 0.6,
        harmRate: 0.05,
        confidence: 0.9,
        qualityPerDollar: 4,
        recommendedRole: 'anchor',
        costMean: 0.18,
      }),
    ),
  );
}

export function scoreExpensiveAndBad(): ContributionAwareScore {
  return scoreContributionAwareCandidate(
    candidate(
      'r-expensive-bad',
      'fx-expensive-bad',
      0.22,
      'text',
      profile('fx-expensive-bad', {
        judgeMean: 0.32,
        winRate: 0.1,
        contributionScore: 0.25,
        harmRate: 0.3,
        confidence: 0.85,
        recommendedRole: 'support',
        costMean: 0.22,
      }),
    ),
  );
}

// ─── Standard baseline used across tests ────────────────────────────────

export const STANDARD_BASELINE = Object.freeze({
  singleModelJudge: 0.6,
  singleModelCostUsd: 0.022,
});
